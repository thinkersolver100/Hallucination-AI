import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EngineError, HttpEngineClient, type EvaluateCaseRequest } from '../src/engine/client.js';
import { ENGINE_KEY, startFakeEngine, type FakeEngine } from './helpers/fakeEngine.js';

let engine: FakeEngine;
beforeAll(async () => {
  engine = await startFakeEngine();
});
afterAll(async () => {
  await engine.stop();
});

const request: EvaluateCaseRequest = {
  experiment_id: 'exp',
  case: {
    id: 'Q1',
    question: 'Capital of France?',
    expected_answer: 'Paris',
    reference_doc_ids: [],
    abstention_allowed: false,
    risk_level: 'low',
    category: 'geo',
  },
  rubric_t: null,
  model: 'gen',
  grader_model: 'grader',
  grader: 'llm',
  temperature: 1,
  max_tokens: 100,
  policies: {},
  company_name: 'Acme',
  budget_usd: 1,
};

describe('HttpEngineClient', () => {
  it('lists models and parses evaluation results', async () => {
    const client = new HttpEngineClient(engine.url, ENGINE_KEY, 5000);
    expect(await client.models()).toEqual(['gen', 'judge', 'grader']);
    const result = await client.evaluateCase(request);
    expect(result.status).toBe('ok');
    expect(result.records).toHaveLength(3);
    expect(result.paid_calls).toBe(5);
  });

  it('treats a rejected service key as fatal', async () => {
    const client = new HttpEngineClient(engine.url, 'x'.repeat(40), 5000);
    const err = await client.models().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineError);
    expect((err as EngineError).fatal).toBe(true);
    expect((err as EngineError).retryable).toBe(false);
  });

  it('treats an unreachable engine as retryable', async () => {
    const client = new HttpEngineClient('http://127.0.0.1:1', ENGINE_KEY, 2000);
    const err = (await client.models().catch((e: unknown) => e)) as EngineError;
    expect(err).toBeInstanceOf(EngineError);
    expect(err.retryable).toBe(true);
    expect(err.message).not.toContain(ENGINE_KEY);
  });

  it('maps HTTP statuses: 5xx and 429 retry, other 4xx do not', async () => {
    const client = new HttpEngineClient(engine.url, ENGINE_KEY, 5000);
    for (const [status, retryable] of [
      [500, true],
      [503, true],
      [429, true],
      [422, false],
    ] as const) {
      engine.onEvaluate = () => ({ status, json: { detail: 'nope' } });
      const err = (await client.evaluateCase(request).catch((e: unknown) => e)) as EngineError;
      expect(err.status).toBe(status);
      expect(err.retryable).toBe(retryable);
    }
    delete engine.onEvaluate;
  });

  it('rejects responses with an unexpected shape', async () => {
    const client = new HttpEngineClient(engine.url, ENGINE_KEY, 5000);
    engine.onEvaluate = () => ({ status: 200, json: { status: 'ok' } });
    const err = (await client.evaluateCase(request).catch((e: unknown) => e)) as EngineError;
    expect(err).toBeInstanceOf(EngineError);
    expect(err.retryable).toBe(false);
    delete engine.onEvaluate;
  });
});
