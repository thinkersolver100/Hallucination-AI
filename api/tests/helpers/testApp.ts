import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import request from 'supertest';
import { inject } from 'vitest';
import { createApp } from '../../src/app.js';
import { loadConfig, type Config } from '../../src/config.js';
import { Store } from '../../src/db/store.js';
import { HttpEngineClient } from '../../src/engine/client.js';
import { JobRunner } from '../../src/jobs/runner.js';
import { silentLogger } from '../../src/logger.js';
import { PasswordHasher } from '../../src/security/password.js';
import { RateLimiter } from '../../src/security/rateLimit.js';
import { ENGINE_KEY, startFakeEngine, type FakeEngine } from './fakeEngine.js';

export const PASSWORD = 'correct horse battery staple';

export interface TestApp {
  app: ReturnType<typeof createApp>;
  config: Config;
  store: Store;
  runner: JobRunner;
  engine: FakeEngine;
  agent: () => ReturnType<typeof request.agent>;
  /** A new organization with its own logged-in agent. */
  signUp: (email: string) => Promise<ReturnType<typeof request.agent>>;
  close: () => Promise<void>;
}

export async function buildTestApp(
  overrides: Record<string, string> = {},
  limiters: Partial<Record<'register' | 'loginByIp' | 'loginByAccount' | 'general', RateLimiter>> = {},
): Promise<TestApp> {
  const engine = await startFakeEngine();
  const client = new MongoClient(inject('mongoUri'));
  await client.connect();
  const db = client.db(`test_${randomUUID().replaceAll('-', '')}`);
  const store = await Store.create(db);

  const config = loadConfig({
    NODE_ENV: 'test',
    MONGODB_URI: 'unused',
    ENGINE_URL: engine.url,
    HALUDEC_SERVICE_KEY: ENGINE_KEY,
    REGISTRATION_OPEN: '1',
    JOB_CONCURRENCY: '1',
    MAX_ACTIVE_PER_ORG: '3',
    MAX_ACTIVE_JOBS: '10',
    ...overrides,
  });
  const engineClient = new HttpEngineClient(config.ENGINE_URL, ENGINE_KEY, 10_000);
  const runner = new JobRunner({
    store,
    engine: engineClient,
    config,
    log: silentLogger,
    sleep: async () => {},
  });
  const hasher = new PasswordHasher({ N: 1024, r: 8, p: 1 }); // cheap: tests only
  const app = createApp({
    config,
    store,
    engine: engineClient,
    runner,
    hasher,
    log: silentLogger,
    limiters: {
      register: new RateLimiter(1000, 60_000),
      loginByIp: new RateLimiter(1000, 60_000),
      loginByAccount: new RateLimiter(1000, 60_000),
      general: new RateLimiter(100_000, 60_000),
      ...limiters,
    },
  });

  const agent = () => request.agent(app);
  return {
    app,
    config,
    store,
    runner,
    engine,
    agent,
    signUp: async (email) => {
      const a = agent();
      const res = await a
        .post('/auth/register')
        .send({ email, password: PASSWORD, organizationName: `Org of ${email}` });
      if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
      return a;
    },
    close: async () => {
      await runner.whenIdle();
      await db.dropDatabase();
      await client.close();
      await engine.stop();
    },
  };
}

export function sampleDataset(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Starter set',
    companyName: 'Acme Co',
    policies: { 'returns-v1': 'Items can be returned within 30 days.' },
    cases: [
      {
        id: 'ECOM-001',
        question: 'Can I return a vase after 20 days?',
        expected_answer: 'Yes. Within 30 days.',
        reference_doc_ids: ['returns-v1'],
        abstention_allowed: false,
        risk_level: 'low',
        category: 'answerable',
      },
      {
        id: 'ECOM-002',
        question: 'Where is your warehouse?',
        expected_answer: 'ABSTAIN: The policies do not say where the warehouse is.',
        reference_doc_ids: [],
        abstention_allowed: true,
        risk_level: 'medium',
        category: 'unanswerable',
      },
      {
        id: 'ECOM-003',
        question: 'Do gift cards expire?',
        expected_answer: 'No. They never expire.',
        reference_doc_ids: [],
        abstention_allowed: false,
        risk_level: 'low',
        category: 'answerable',
      },
    ],
    ...overrides,
  };
}

export function sampleExperiment(datasetId: string, overrides: Record<string, unknown> = {}) {
  return {
    datasetId,
    name: 'First run',
    model: 'gen',
    graderModel: 'grader',
    thresholds: [0, 0.5],
    budgetUsd: 5,
    ...overrides,
  };
}

export async function waitFor(check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('condition not met in time');
}
