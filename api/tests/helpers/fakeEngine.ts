import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export const ENGINE_KEY = 'e'.repeat(40);

export interface Reply {
  status: number;
  json: unknown;
}

type Body = any;

export interface FakeEngine {
  url: string;
  calls: { method: string; path: string; body: Body }[];
  models: string[];
  /** Replace the evaluate-case behaviour. Return undefined to use the default. */
  onEvaluate?: (body: Body) => Promise<Reply | undefined> | Reply | undefined;
  spendPerItem: number;
  stop(): Promise<void>;
}

function record(body: Body, config: string, sample: number, label: string) {
  const t = body.rubric_t ?? 0;
  return {
    run_id: `${body.experiment_id}:${body.case.id}:${config}:${body.rubric_t === null ? 'closed' : `t${t}`}:s${sample}`,
    experiment_id: body.experiment_id,
    test_case_id: body.case.id,
    config,
    threshold: t,
    sample_index: sample,
    model_id: body.model,
    prompt_version: 'test',
    rubric_version: body.rubric_t === null ? 'closed' : 'paper-v1',
    response_text: `answer from ${config}`,
    label,
    judge_decision: null,
    latency_ms: 10,
    tokens_in: 5,
    tokens_out: 5,
    cost_usd: 0.001,
    timestamp: '2026-11-12T12:00:00+00:00',
  };
}

function defaultEvaluate(body: Body, spend: number): Reply {
  const open = body.rubric_t !== null;
  const [base, mitigated] = open ? ['B', 'D'] : ['A', 'C'];
  return {
    status: 200,
    json: {
      status: 'ok',
      spend_usd: spend,
      paid_calls: 5,
      cached_calls: 0,
      records: [
        record(body, base!, 0, 'correct'),
        record(body, base!, 1, 'incorrect'),
        record(body, mitigated!, 0, 'abstained'),
      ],
    },
  };
}

async function readBody(req: IncomingMessage): Promise<Body> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf-8');
  return text ? JSON.parse(text) : undefined;
}

export async function startFakeEngine(): Promise<FakeEngine> {
  const engine: FakeEngine = {
    url: '',
    calls: [],
    models: ['gen', 'judge', 'grader'],
    spendPerItem: 0.01,
    stop: async () => {},
  };

  const server: Server = createServer(async (req, res) => {
    const send = (reply: Reply) => {
      res.writeHead(reply.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply.json));
    };
    try {
      if (req.headers['x-service-key'] !== ENGINE_KEY) {
        send({ status: 401, json: { detail: 'invalid service key' } });
        return;
      }
      const body = await readBody(req);
      const path = req.url ?? '';
      engine.calls.push({ method: req.method ?? '', path, body });

      if (path === '/v1/models') {
        send({ status: 200, json: { models: engine.models } });
      } else if (path === '/v1/evaluate-case') {
        const custom = await engine.onEvaluate?.(body);
        send(custom ?? defaultEvaluate(body, engine.spendPerItem));
      } else if (path === '/v1/report') {
        const questions = new Set(body.records.map((r: Body) => r.test_case_id));
        send({
          status: 200,
          json: {
            report: { n_questions: questions.size, n_failures: body.failures.length, rows: [], comparisons: [] },
            by_category: [],
            by_risk_level: [],
          },
        });
      } else {
        send({ status: 404, json: { detail: 'not found' } });
      }
    } catch (err) {
      send({ status: 500, json: { detail: String(err) } });
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  engine.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  engine.stop = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return engine;
}
