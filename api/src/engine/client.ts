import { z } from 'zod';
import type { EngineCase } from '../db/models.js';

export class EngineError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    /** Worth retrying: network trouble, timeouts, 429 and 5xx. */
    readonly retryable: boolean,
    /** The whole experiment should stop: the engine rejected our credentials. */
    readonly fatal = false,
  ) {
    super(message);
  }
}

const recordSchema = z.object({
  run_id: z.string(),
  experiment_id: z.string(),
  test_case_id: z.string(),
  config: z.enum(['A', 'B', 'C', 'D']),
  threshold: z.number(),
  sample_index: z.number().int(),
  model_id: z.string(),
  prompt_version: z.string(),
  rubric_version: z.string(),
  response_text: z.string(),
  label: z.enum(['correct', 'abstained', 'incorrect']),
  judge_decision: z.boolean().nullable(),
  latency_ms: z.number(),
  tokens_in: z.number().int(),
  tokens_out: z.number().int(),
  cost_usd: z.number(),
  timestamp: z.string(),
});

const evaluateSchema = z.object({
  status: z.enum(['ok', 'failed', 'budget_exceeded']),
  spend_usd: z.number().nonnegative(),
  paid_calls: z.number().int().nonnegative(),
  cached_calls: z.number().int().nonnegative(),
  records: z.array(recordSchema).default([]),
  stage: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
});

const reportSchema = z.object({
  report: z.record(z.string(),z.unknown()),
  by_category: z.array(z.unknown()),
  by_risk_level: z.array(z.unknown()),
});

const modelsSchema = z.object({ models: z.array(z.string()) });

export type EvaluateCaseResult = z.infer<typeof evaluateSchema>;
export type ReportResult = z.infer<typeof reportSchema>;

export interface EvaluateCaseRequest {
  experiment_id: string;
  case: EngineCase;
  rubric_t: number | null;
  model: string;
  judge_model?: string;
  grader_model: string;
  grader: 'llm' | 'policy';
  temperature: number;
  max_tokens: number;
  policies: Record<string, string>;
  company_name: string;
  budget_usd: number;
}

export interface ReportRequest {
  cases: EngineCase[];
  records: Record<string, unknown>[];
  failures: { test_case_id: string; rubric_t: number | null; stage: string; error: string }[];
  thresholds: number[];
}

export interface EngineClient {
  models(): Promise<string[]>;
  evaluateCase(req: EvaluateCaseRequest): Promise<EvaluateCaseResult>;
  report(req: ReportRequest): Promise<ReportResult>;
}

const DETAIL_CHARS = 200;

export class HttpEngineClient implements EngineClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly serviceKey: string,
    private readonly timeoutMs: number,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async models(): Promise<string[]> {
    const body = await this.request('GET', '/v1/models', undefined, modelsSchema);
    return body.models;
  }

  evaluateCase(req: EvaluateCaseRequest): Promise<EvaluateCaseResult> {
    return this.request('POST', '/v1/evaluate-case', req, evaluateSchema);
  }

  report(req: ReportRequest): Promise<ReportResult> {
    return this.request('POST', '/v1/report', req, reportSchema);
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    schema: z.ZodType<T>,
  ): Promise<T> {
    let response: Response;
    try {
      const init: RequestInit = {
        method,
        headers: {
          'X-Service-Key': this.serviceKey,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    } catch (err) {
      const name = err instanceof Error ? err.name : 'error';
      throw new EngineError(`engine unreachable (${name})`, null, true);
    }

    if (response.status === 401 || response.status === 403) {
      throw new EngineError('engine rejected the service key', response.status, false, true);
    }
    if (response.status === 429 || response.status >= 500) {
      throw new EngineError(`engine error (HTTP ${response.status})`, response.status, true);
    }
    if (!response.ok) {
      const text = (await response.text().catch(() => '')).slice(0, DETAIL_CHARS);
      throw new EngineError(`engine rejected the request (HTTP ${response.status}): ${text}`, response.status, false);
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new EngineError('engine returned invalid JSON', response.status, false);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new EngineError('engine returned an unexpected response shape', response.status, false);
    }
    return parsed.data;
  }
}
