import { MongoClient } from 'mongodb';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { Store } from './db/store.js';
import { HttpEngineClient } from './engine/client.js';
import { JobRunner } from './jobs/runner.js';
import { consoleLogger as log } from './logger.js';
import { PasswordHasher } from './security/password.js';

const SHUTDOWN_GRACE_MS = 30_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new MongoClient(config.MONGODB_URI);
  await client.connect();
  const store = await Store.create(client.db(config.MONGODB_DB));

  const interrupted = await store.markInterrupted();
  if (interrupted > 0) log.info('marked interrupted experiments', { count: interrupted });

  const engine = new HttpEngineClient(config.ENGINE_URL, config.HALUDEC_SERVICE_KEY, config.ENGINE_TIMEOUT_MS);
  const runner = new JobRunner({ store, engine, config, log });
  const app = createApp({ config, store, engine, runner, hasher: new PasswordHasher(), log });

  const server = app.listen(config.PORT, config.HOST, () => {
    log.info('api listening', { host: config.HOST, port: config.PORT });
  });

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    log.info('shutting down', { signal });
    server.close();
    runner.cancelAll();
    await Promise.race([runner.whenIdle(), new Promise((r) => setTimeout(r, SHUTDOWN_GRACE_MS))]);
    await store.markInterrupted();
    await client.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  log.error('fatal startup error', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
