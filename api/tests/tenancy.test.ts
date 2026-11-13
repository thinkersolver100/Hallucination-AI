/**
 * The gate for Phase 6B: one organization must never see, change, delete or run anything that
 * belongs to another. Organization A owns a dataset and a finished experiment; organization B
 * tries every endpoint against A's ids. Every attempt must look as if the object does not exist.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, sampleDataset, sampleExperiment, type TestApp } from './helpers/testApp.js';

type Agent = Awaited<ReturnType<TestApp['signUp']>>;

let t: TestApp;
let a: Agent;
let b: Agent;
let datasetId: string;
let experimentId: string;
let runId: string;

beforeAll(async () => {
  t = await buildTestApp();
  a = await t.signUp('alice@org-a.example');
  b = await t.signUp('bob@org-b.example');

  datasetId = (await a.post('/datasets').send(sampleDataset({ name: 'A confidential set' }))).body.id;
  experimentId = (await a.post('/experiments').send(sampleExperiment(datasetId, { name: 'A secret run' }))).body.id;
  await t.runner.whenIdle();
  runId = (await a.get(`/experiments/${experimentId}/records?limit=1`)).body.records[0].run_id;
});
afterAll(async () => {
  await t.close();
});

describe('organization B cannot reach organization A\u2019s data', () => {
  it('sees nothing in its own lists', async () => {
    expect((await b.get('/datasets')).body.datasets).toEqual([]);
    expect((await b.get('/experiments')).body.experiments).toEqual([]);
  });

  it('gets 404, never 403, for every read of A\u2019s objects', async () => {
    const reads = [
      `/datasets/${datasetId}`,
      `/experiments/${experimentId}`,
      `/experiments/${experimentId}/report`,
      `/experiments/${experimentId}/records`,
      `/experiments/${experimentId}/failures`,
    ];
    for (const path of reads) {
      const res = await b.get(path);
      expect(res.status, path).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain('confidential');
      expect(JSON.stringify(res.body)).not.toContain('secret');
    }
  });

  it('answers a real id and an invented id in exactly the same way', async () => {
    const real = await b.get(`/experiments/${experimentId}`);
    const invented = await b.get('/experiments/00000000-0000-4000-8000-000000000000');
    expect(real.status).toBe(invented.status);
    expect(real.body).toEqual(invented.body);
  });

  it('cannot change or destroy A\u2019s data', async () => {
    expect((await b.post(`/experiments/${experimentId}/cancel`)).status).toBe(404);
    expect((await b.delete(`/experiments/${experimentId}`)).status).toBe(404);
    expect((await b.delete(`/datasets/${datasetId}`)).status).toBe(404);

    // ...and A's data is still all there.
    expect((await a.get(`/datasets/${datasetId}`)).body.caseCount).toBe(3);
    expect((await a.get(`/experiments/${experimentId}`)).body.status).toBe('completed');
    expect((await a.get(`/experiments/${experimentId}/records?limit=1`)).body.records).toHaveLength(1);
    expect((await a.get(`/experiments/${experimentId}/report`)).status).toBe(200);
  });

  it('cannot start an experiment on A\u2019s dataset, and nothing is sent to the engine', async () => {
    const before = t.engine.calls.length;
    const res = await b.post('/experiments').send(sampleExperiment(datasetId));
    expect(res.status).toBe(404);
    expect(t.engine.calls.length).toBe(before);
    expect((await b.get('/experiments')).body.experiments).toEqual([]);
  });

  it('cannot reach records by guessing a run id or using it as a cursor', async () => {
    const mine = (await b.post('/datasets').send(sampleDataset({ name: 'B set' }))).body.id;
    const bExperiment = (await b.post('/experiments').send(sampleExperiment(mine))).body.id;
    await t.runner.whenIdle();

    const res = await b.get(`/experiments/${bExperiment}/records?limit=200&after=${encodeURIComponent(runId)}`);
    expect(res.status).toBe(200);
    for (const record of res.body.records) {
      expect(record.experiment_id).toBe(bExperiment);
      expect(record.run_id).not.toContain(experimentId);
    }
  });

  it('keeps each organization\u2019s list limited to its own objects', async () => {
    const listA = (await a.get('/experiments')).body.experiments.map((e: { id: string }) => e.id);
    const listB = (await b.get('/experiments')).body.experiments.map((e: { id: string }) => e.id);
    expect(listA).toContain(experimentId);
    expect(listB).not.toContain(experimentId);
    expect(listA.filter((id: string) => listB.includes(id))).toEqual([]);
  });
});

describe('injection attempts', () => {
  it('rejects operator objects and arrays where ids or cursors are expected', async () => {
    const attempts = [
      `/experiments/${experimentId}/records?after[$ne]=x`,
      `/experiments/${experimentId}/records?after=a&after=b`,
      `/experiments/${experimentId}/records?limit[$gt]=0`,
      `/experiments/${experimentId}/records?limit=abc`,
    ];
    for (const path of attempts) {
      const res = await a.get(path);
      expect([200, 400], path).toContain(res.status);
      if (res.status === 200) expect(res.body.records.length).toBeLessThanOrEqual(50);
    }
    expect((await a.get(`/experiments/${experimentId}/records?after=a&after=b`)).status).toBe(400);
    expect((await a.get(`/experiments/${experimentId}/records?limit=abc`)).status).toBe(400);
  });

  it('rejects operator objects in request bodies', async () => {
    const asObject = await a.post('/experiments').send({ ...sampleExperiment(datasetId), datasetId: { $ne: null } });
    expect(asObject.status).toBe(400);
    const nameObject = await a.post('/datasets').send({ ...sampleDataset(), name: { $gt: '' } });
    expect(nameObject.status).toBe(400);
    const login = await request(t.app).post('/auth/login').send({ email: { $ne: null }, password: { $ne: null } });
    expect(login.status).toBe(400);
  });

  it('ignores an orgId smuggled into a request', async () => {
    const bOrg = (await b.get('/auth/me')).body.organization.id;
    const res = await a.post('/datasets').send({ ...sampleDataset({ name: 'smuggle' }), orgId: bOrg });
    expect(res.status).toBe(400); // strict schemas refuse unknown fields outright
    expect((await b.get('/datasets')).body.datasets.every((d: { name: string }) => d.name !== 'smuggle')).toBe(true);
  });
});

describe('authentication is required everywhere', () => {
  const endpoints: [string, string][] = [
    ['get', '/datasets'],
    ['post', '/datasets'],
    ['get', '/datasets/00000000-0000-4000-8000-000000000000'],
    ['delete', '/datasets/00000000-0000-4000-8000-000000000000'],
    ['get', '/experiments'],
    ['post', '/experiments'],
    ['get', '/experiments/00000000-0000-4000-8000-000000000000'],
    ['post', '/experiments/00000000-0000-4000-8000-000000000000/cancel'],
    ['delete', '/experiments/00000000-0000-4000-8000-000000000000'],
    ['get', '/experiments/00000000-0000-4000-8000-000000000000/report'],
    ['get', '/experiments/00000000-0000-4000-8000-000000000000/records'],
    ['get', '/experiments/00000000-0000-4000-8000-000000000000/failures'],
    ['get', '/auth/me'],
  ];

  it.each(endpoints)('%s %s returns 401 without a session', async (method, path) => {
    const res = await (request(t.app) as unknown as Record<string, (p: string) => request.Test>)[method]!(path);
    expect(res.status).toBe(401);
  });
});

describe('sessions belong to their organization', () => {
  it('a session from one organization never grants access to another', async () => {
    const aOrg = (await a.get('/auth/me')).body.organization.id;
    const bOrg = (await b.get('/auth/me')).body.organization.id;
    expect(aOrg).not.toBe(bOrg);
    expect((await a.get('/datasets')).body.datasets).toHaveLength(1);
    expect((await b.get('/datasets')).body.datasets).toHaveLength(1);
  });
});
