import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, sampleDataset, sampleExperiment, type TestApp } from './helpers/testApp.js';

let t: TestApp;
beforeAll(async () => {
  t = await buildTestApp();
});
afterAll(async () => {
  await t.close();
});

describe('datasets', () => {
  it('creates, lists, reads and deletes a dataset', async () => {
    const agent = await t.signUp('ds1@example.com');

    const created = await agent.post('/datasets').send(sampleDataset());
    expect(created.status).toBe(201);
    expect(created.body.caseCount).toBe(3);
    expect(created.body.policyIds).toEqual(['returns-v1']);
    expect(created.body.cases).toBeUndefined(); // summaries stay small

    const list = await agent.get('/datasets');
    expect(list.body.datasets.map((d: { id: string }) => d.id)).toEqual([created.body.id]);

    const full = await agent.get(`/datasets/${created.body.id}`);
    expect(full.status).toBe(200);
    expect(full.body.cases.map((c: { id: string }) => c.id)).toEqual(['ECOM-001', 'ECOM-002', 'ECOM-003']);
    expect(full.body.policies['returns-v1']).toContain('30 days');

    expect((await agent.delete(`/datasets/${created.body.id}`)).status).toBe(204);
    expect((await agent.get(`/datasets/${created.body.id}`)).status).toBe(404);
  });

  it('accepts lines of a cases.jsonl file as they are', async () => {
    const agent = await t.signUp('ds2@example.com');
    const line = {
      id: 'ECOM-010',
      question: 'Can I return it?',
      expected_answer: 'ABSTAIN: The item and delivery date are not stated.',
      reference_doc_ids: [],
      abstention_allowed: true,
      risk_level: 'medium',
      category: 'ambiguous',
    };
    const res = await agent.post('/datasets').send({ name: 'JSONL import', cases: [line] });
    expect(res.status).toBe(201);
  });

  it('rejects invalid datasets', async () => {
    const agent = await t.signUp('ds3@example.com');
    const good = sampleDataset();
    const firstCase = good.cases[0]!;
    const bad: Record<string, unknown>[] = [
      { ...good, cases: [] },
      { ...good, cases: [firstCase, firstCase] },
      { ...good, cases: [{ ...firstCase, reference_doc_ids: ['missing-doc'] }] },
      { ...good, cases: [{ ...firstCase, risk_level: 'extreme' }] },
      { ...good, cases: [{ ...firstCase, surprise: 1 }] },
      { ...good, cases: [{ ...firstCase, id: 'has spaces' }] },
      { ...good, policies: { 'bad id!': 'text' } },
      { ...good, policies: { ok: '   ' } },
      { ...good, extra: true },
      { ...good, name: '' },
    ];
    for (const body of bad) {
      const res = await agent.post('/datasets').send(body);
      expect(res.status, JSON.stringify(body).slice(0, 120)).toBe(400);
    }
    expect((await agent.get('/datasets')).body.datasets).toEqual([]);
  });

  it('refuses policy text beyond the engine limit', async () => {
    const agent = await t.signUp('ds4@example.com');
    const res = await agent
      .post('/datasets')
      .send(sampleDataset({ policies: { a: 'x'.repeat(150_000), b: 'y'.repeat(150_000) } }));
    expect(res.status).toBe(400);
  });

  it('treats malformed ids as not found', async () => {
    const agent = await t.signUp('ds5@example.com');
    for (const id of ['nope', '123', '%7B%22%24ne%22%3Anull%7D']) {
      expect((await agent.get(`/datasets/${id}`)).status).toBe(404);
    }
  });

  it('will not delete a dataset that experiments still use', async () => {
    const agent = await t.signUp('ds6@example.com');
    const ds = (await agent.post('/datasets').send(sampleDataset())).body;
    const exp = await agent.post('/experiments').send(sampleExperiment(ds.id));
    expect(exp.status).toBe(201);
    await t.runner.whenIdle();

    const blocked = await agent.delete(`/datasets/${ds.id}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('in_use');

    expect((await agent.delete(`/experiments/${exp.body.id}`)).status).toBe(204);
    expect((await agent.delete(`/datasets/${ds.id}`)).status).toBe(204);
  });
});
