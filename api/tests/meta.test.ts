import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './helpers/testApp.js';

let t: TestApp;
beforeAll(async () => {
  t = await buildTestApp({ MAX_EXPERIMENT_BUDGET_USD: '7' });
});
afterAll(async () => {
  await t.close();
});

describe('GET /meta', () => {
  it('lists the allowed models, sorted, and the budget ceiling', async () => {
    const agent = await t.signUp('meta@example.com');
    const res = await agent.get('/meta');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ models: ['gen', 'grader', 'judge'], maxExperimentBudgetUsd: 7 });
  });

  it('requires a session', async () => {
    expect((await request(t.app).get('/meta')).status).toBe(401);
  });

  it('reports an unreachable engine as a gateway problem', async () => {
    const down = await buildTestApp({ ENGINE_URL: 'http://127.0.0.1:1' });
    try {
      const agent = await down.signUp('meta-down@example.com');
      const res = await agent.get('/meta');
      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('engine_unavailable');
    } finally {
      await down.close();
    }
  });
});
