import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildTestApp,
  sampleDataset,
  sampleExperiment,
  waitFor,
  type TestApp,
} from './helpers/testApp.js';

let t: TestApp;
let agent: Awaited<ReturnType<TestApp['signUp']>>;
let datasetId: string;

beforeEach(async () => {
  t = await buildTestApp();
  agent = await t.signUp('owner@example.com');
  datasetId = (await agent.post('/datasets').send(sampleDataset())).body.id;
});
afterEach(async () => {
  await t.close();
});

const status = async (id: string) => (await agent.get(`/experiments/${id}`)).body;

describe('running an experiment', () => {
  it('evaluates every question under every condition and stores a report', async () => {
    const created = await agent.post('/experiments').send(sampleExperiment(datasetId));
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('running');
    expect(created.body.progress.total).toBe(9); // 3 questions x (closed + 2 thresholds)

    await t.runner.whenIdle();
    const done = await status(created.body.id);

    expect(done.status).toBe('completed');
    expect(done.progress).toEqual({ total: 9, done: 9, failed: 0 });
    expect(done.paidCalls).toBe(45);
    expect(done.spendUsd).toBeCloseTo(0.09);
    expect(done.hasReport).toBe(true);
    expect(done.finishedAt).not.toBeNull();

    const report = await agent.get(`/experiments/${created.body.id}/report`);
    expect(report.status).toBe(200);
    expect(report.body.report.n_questions).toBe(3);
  });

  it('sends the engine what it needs and never the stored response text back', async () => {
    const created = await agent.post('/experiments').send(sampleExperiment(datasetId));
    await t.runner.whenIdle();

    const evaluate = t.engine.calls.filter((c) => c.path === '/v1/evaluate-case');
    expect(evaluate).toHaveLength(9);
    const first = evaluate[0]!.body;
    expect(first.experiment_id).toBe(created.body.id);
    expect(first.company_name).toBe('Acme Co');
    expect(first.policies['returns-v1']).toContain('30 days');
    expect(first.grader).toBe('policy');
    expect(first.budget_usd).toBeLessThanOrEqual(t.config.ITEM_BUDGET_USD);
    expect(Object.keys(first.case).sort()).toEqual(
      ['abstention_allowed', 'category', 'expected_answer', 'id', 'question', 'reference_doc_ids', 'risk_level'],
    );
    expect(evaluate.filter((c) => c.body.rubric_t === null)).toHaveLength(3);

    const report = t.engine.calls.find((c) => c.path === '/v1/report')!.body;
    expect(report.thresholds).toEqual([0, 0.5]);
    expect(report.records).toHaveLength(27);
    expect(report.records.every((r: { response_text: string }) => r.response_text === '')).toBe(true);
    expect(report.records[0]._id).toBeUndefined();
    expect(report.records[0].orgId).toBeUndefined();
  });

  it('pages through records without leaking internal fields', async () => {
    const created = (await agent.post('/experiments').send(sampleExperiment(datasetId))).body;
    await t.runner.whenIdle();

    const first = await agent.get(`/experiments/${created.id}/records?limit=10`);
    expect(first.status).toBe(200);
    expect(first.body.records).toHaveLength(10);
    expect(first.body.records[0]._id).toBeUndefined();
    expect(first.body.records[0].orgId).toBeUndefined();
    expect(first.body.records[0].response_text).toBe(`answer from ${first.body.records[0].config}`);

    const seen = new Set<string>(first.body.records.map((r: { run_id: string }) => r.run_id));
    let after: string | null = first.body.nextAfter;
    while (after) {
      const page = await agent.get(`/experiments/${created.id}/records?limit=10&after=${encodeURIComponent(after)}`);
      for (const r of page.body.records) seen.add(r.run_id);
      after = page.body.nextAfter;
    }
    expect(seen.size).toBe(27);
  });

  it('records per-question failures and still completes', async () => {
    t.engine.onEvaluate = (body) =>
      body.case.id === 'ECOM-002'
        ? {
            status: 200,
            json: { status: 'failed', stage: 'grade', error: 'empty response', spend_usd: 0.002, paid_calls: 2, cached_calls: 0, records: [] },
          }
        : undefined;
    const created = (await agent.post('/experiments').send(sampleExperiment(datasetId))).body;
    await t.runner.whenIdle();

    const done = await status(created.id);
    expect(done.status).toBe('completed');
    expect(done.progress).toEqual({ total: 9, done: 9, failed: 3 });

    const failures = (await agent.get(`/experiments/${created.id}/failures`)).body.failures;
    expect(failures).toHaveLength(3);
    expect(failures[0]).toMatchObject({ testCaseId: 'ECOM-002', stage: 'grade' });
    const reportCall = t.engine.calls.find((c) => c.path === '/v1/report')!.body;
    expect(reportCall.failures).toHaveLength(3);
  });

  it('fails the experiment when no question could be evaluated', async () => {
    t.engine.onEvaluate = () => ({
      status: 200,
      json: { status: 'failed', stage: 'generate', error: 'x', spend_usd: 0, paid_calls: 0, cached_calls: 0, records: [] },
    });
    const created = (await agent.post('/experiments').send(sampleExperiment(datasetId))).body;
    await t.runner.whenIdle();

    const done = await status(created.id);
    expect(done.status).toBe('failed');
    expect(done.error).toContain('no question could be evaluated');
    expect(done.hasReport).toBe(false);
  });
});

describe('budget, cancellation and failures of the engine', () => {
  it('stops when the experiment budget is reached', async () => {
    t.engine.spendPerItem = 0.4;
    const created = (await agent.post('/experiments').send(sampleExperiment(datasetId, { budgetUsd: 1 }))).body;
    await t.runner.whenIdle();

    const done = await status(created.id);
    expect(done.status).toBe('budget_exhausted');
    expect(done.progress.done).toBe(3); // 0.4 + 0.4 + 0.4 = 1.2, then no further call starts
    expect(done.spendUsd).toBeCloseTo(1.2);
    expect(done.hasReport).toBe(false);
    expect(t.engine.calls.filter((c) => c.path === '/v1/evaluate-case')).toHaveLength(3);
    expect(t.engine.calls.some((c) => c.path === '/v1/report')).toBe(false);
  });

  it('gives each engine call only what is left of the budget, capped per question', async () => {
    t.engine.spendPerItem = 0.4;
    await agent.post('/experiments').send(sampleExperiment(datasetId, { budgetUsd: 1 }));
    await t.runner.whenIdle();

    const budgets = t.engine.calls.filter((c) => c.path === '/v1/evaluate-case').map((c) => c.body.budget_usd);
    expect(budgets[0]).toBeCloseTo(0.5); // capped by ITEM_BUDGET_USD
    expect(budgets[1]).toBeCloseTo(0.5);
    expect(budgets[2]).toBeCloseTo(0.2); // only 0.2 left
  });

  it('treats a question that hits the per-question cap as a failure, not the end of the run', async () => {
    t.engine.onEvaluate = (body) =>
      body.case.id === 'ECOM-001'
        ? { status: 200, json: { status: 'budget_exceeded', spend_usd: 0.5, paid_calls: 3, cached_calls: 0, records: [] } }
        : undefined;
    const created = (await agent.post('/experiments').send(sampleExperiment(datasetId, { budgetUsd: 5 }))).body;
    await t.runner.whenIdle();

    const done = await status(created.id);
    expect(done.status).toBe('completed');
    const failures = (await agent.get(`/experiments/${created.id}/failures`)).body.failures;
    expect(failures.every((f: { stage: string }) => f.stage === 'item_budget')).toBe(true);
    expect(failures).toHaveLength(3);
  });

  it('cancels a running experiment and lets in-flight work finish', async () => {
    await t.close();
    t = await buildTestApp({ JOB_CONCURRENCY: '2' });
    agent = await t.signUp('cancel@example.com');
    datasetId = (await agent.post('/datasets').send(sampleDataset())).body.id;

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    t.engine.onEvaluate = async () => {
      await gate;
      return undefined;
    };

    const created = (await agent.post('/experiments').send(sampleExperiment(datasetId))).body;
    await waitFor(() => t.engine.calls.filter((c) => c.path === '/v1/evaluate-case').length >= 2);

    const cancel = await agent.post(`/experiments/${created.id}/cancel`);
    expect(cancel.status).toBe(202);
    release();
    await t.runner.whenIdle();

    const done = await status(created.id);
    expect(done.status).toBe('cancelled');
    expect(done.progress.done).toBe(2); // the two in-flight items finished, nothing new started
    expect((await agent.post(`/experiments/${created.id}/cancel`)).status).toBe(409);
  });

  it('cannot delete an experiment while it runs', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    t.engine.onEvaluate = async () => {
      await gate;
      return undefined;
    };
    const created = (await agent.post('/experiments').send(sampleExperiment(datasetId))).body;
    await waitFor(() => t.engine.calls.some((c) => c.path === '/v1/evaluate-case'));

    const blocked = await agent.delete(`/experiments/${created.id}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('running');
    release();
    await t.runner.whenIdle();
    expect((await agent.delete(`/experiments/${created.id}`)).status).toBe(204);
    expect(await t.store.forOrg((await agent.get('/auth/me')).body.organization.id).countRecords(created.id)).toBe(0);
  });

  it('retries transient engine errors without losing the item', async () => {
    let failuresLeft = 2;
    t.engine.onEvaluate = () => (failuresLeft-- > 0 ? { status: 503, json: { detail: 'busy' } } : undefined);
    const created = (await agent.post('/experiments').send(sampleExperiment(datasetId))).body;
    await t.runner.whenIdle();

    const done = await status(created.id);
    expect(done.status).toBe('completed');
    expect(done.progress).toEqual({ total: 9, done: 9, failed: 0 });
  });

  it('stops the experiment when the engine stays down', async () => {
    t.engine.onEvaluate = () => ({ status: 503, json: { detail: 'down' } });
    const created = (await agent.post('/experiments').send(sampleExperiment(datasetId))).body;
    await t.runner.whenIdle();

    const done = await status(created.id);
    expect(done.status).toBe('failed');
    expect(done.error).toContain('unavailable');
    const failures = (await agent.get(`/experiments/${created.id}/failures`)).body.failures;
    expect(failures.length).toBeGreaterThanOrEqual(5);
  });

  it('stops the experiment when the engine rejects the service key', async () => {
    t.engine.onEvaluate = () => ({ status: 401, json: { detail: 'invalid service key' } });
    const created = (await agent.post('/experiments').send(sampleExperiment(datasetId))).body;
    await t.runner.whenIdle();

    const done = await status(created.id);
    expect(done.status).toBe('failed');
    expect(done.error).toContain('service key');
    expect(t.engine.calls.filter((c) => c.path === '/v1/evaluate-case')).toHaveLength(1);
  });

  it('marks experiments that were running at a restart as interrupted', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    t.engine.onEvaluate = async () => {
      await gate;
      return undefined;
    };
    const created = (await agent.post('/experiments').send(sampleExperiment(datasetId))).body;
    await waitFor(() => t.engine.calls.some((c) => c.path === '/v1/evaluate-case'));

    expect(await t.store.markInterrupted()).toBe(1);
    const row = await status(created.id);
    expect(row.status).toBe('interrupted');
    expect(row.error).toContain('restarted');

    release();
    await t.runner.whenIdle();
    expect((await status(created.id)).status).toBe('interrupted'); // a late finish cannot overwrite it
  });
});

describe('creating experiments', () => {
  it('validates the request', async () => {
    const bad: Record<string, unknown>[] = [
      sampleExperiment(datasetId, { budgetUsd: 0 }),
      sampleExperiment(datasetId, { thresholds: [] }),
      sampleExperiment(datasetId, { thresholds: [0.5, 0.5] }),
      sampleExperiment(datasetId, { thresholds: [1] }),
      sampleExperiment(datasetId, { thresholds: [-0.1] }),
      sampleExperiment(datasetId, { temperature: 3 }),
      sampleExperiment(datasetId, { maxTokens: 100000 }),
      sampleExperiment(datasetId, { grader: 'magic' }),
      sampleExperiment(datasetId, { surprise: true }),
      { ...sampleExperiment(datasetId), datasetId: 'not-a-uuid' },
    ];
    for (const body of bad) {
      const res = await agent.post('/experiments').send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('caps the budget a user may request', async () => {
    const res = await agent.post('/experiments').send(sampleExperiment(datasetId, { budgetUsd: 1000 }));
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('budgetUsd');
  });

  it('only allows models the engine offers', async () => {
    for (const field of ['model', 'judgeModel', 'graderModel']) {
      const res = await agent.post('/experiments').send(sampleExperiment(datasetId, { [field]: 'unlisted-model' }));
      expect(res.status, field).toBe(422);
      expect(res.body.error.code).toBe('model_not_allowed');
    }
    expect(t.engine.calls.some((c) => c.path === '/v1/evaluate-case')).toBe(false);
  });

  it('reports an unreachable engine as a gateway problem', async () => {
    const down = await buildTestApp({ ENGINE_URL: 'http://127.0.0.1:1' });
    try {
      const a = await down.signUp('down@example.com');
      const ds = (await a.post('/datasets').send(sampleDataset())).body.id;
      const res = await a.post('/experiments').send(sampleExperiment(ds));
      expect(res.status).toBe(502);
    } finally {
      await down.close();
    }
  });

  it('limits concurrent experiments per organization and per server', async () => {
    await t.close();
    t = await buildTestApp({ MAX_ACTIVE_PER_ORG: '1', MAX_ACTIVE_JOBS: '10' });
    agent = await t.signUp('limits@example.com');
    datasetId = (await agent.post('/datasets').send(sampleDataset())).body.id;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    t.engine.onEvaluate = async () => {
      await gate;
      return undefined;
    };

    expect((await agent.post('/experiments').send(sampleExperiment(datasetId))).status).toBe(201);
    const second = await agent.post('/experiments').send(sampleExperiment(datasetId));
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('too_many_active');
    release();
    await t.runner.whenIdle();
    expect((await agent.post('/experiments').send(sampleExperiment(datasetId))).status).toBe(201);
    await t.runner.whenIdle();
  });

  it('refuses new experiments when the server is at its job limit', async () => {
    await t.close();
    t = await buildTestApp({ MAX_ACTIVE_JOBS: '1', MAX_ACTIVE_PER_ORG: '5' });
    agent = await t.signUp('busy@example.com');
    datasetId = (await agent.post('/datasets').send(sampleDataset())).body.id;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    t.engine.onEvaluate = async () => {
      await gate;
      return undefined;
    };

    expect((await agent.post('/experiments').send(sampleExperiment(datasetId))).status).toBe(201);
    const busy = await agent.post('/experiments').send(sampleExperiment(datasetId));
    expect(busy.status).toBe(503);
    release();
    await t.runner.whenIdle();
  });
});
