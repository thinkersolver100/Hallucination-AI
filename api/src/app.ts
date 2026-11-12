import express, { type Express } from 'express';
import helmet from 'helmet';
import type { Config } from './config.js';
import type { Store } from './db/store.js';
import type { EngineClient } from './engine/client.js';
import { authRouter, type AuthLimiters } from './http/routes/auth.js';
import { datasetsRouter } from './http/routes/datasets.js';
import { experimentsRouter } from './http/routes/experiments.js';
import {
  authenticate,
  clientIp,
  errorHandler,
  limitBy,
  notFoundHandler,
  requireAllowedOrigin,
} from './http/middleware.js';
import type { JobRunner } from './jobs/runner.js';
import type { Logger } from './logger.js';
import type { PasswordHasher } from './security/password.js';
import { RateLimiter } from './security/rateLimit.js';

export interface AppDeps {
  config: Config;
  store: Store;
  engine: EngineClient;
  runner: JobRunner;
  hasher: PasswordHasher;
  log: Logger;
  now?: () => Date;
  limiters?: Partial<AuthLimiters> & { general?: RateLimiter };
}

const FIFTEEN_MINUTES = 15 * 60 * 1000;

export function createApp(deps: AppDeps): Express {
  const { config, store, engine, runner, hasher, log } = deps;
  const now = deps.now ?? (() => new Date());

  const limiters: AuthLimiters & { general: RateLimiter } = {
    register: deps.limiters?.register ?? new RateLimiter(5, 60 * 60 * 1000),
    loginByIp: deps.limiters?.loginByIp ?? new RateLimiter(50, FIFTEEN_MINUTES),
    loginByAccount: deps.limiters?.loginByAccount ?? new RateLimiter(10, FIFTEEN_MINUTES),
    general: deps.limiters?.general ?? new RateLimiter(600, 60 * 1000),
  };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY);
  app.use(helmet());
  app.use(limitBy(limiters.general, clientIp));
  app.use(requireAllowedOrigin(config.ALLOWED_ORIGINS));

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use('/auth', authRouter({ config, store, hasher, limiters, now }));

  const requireLogin = authenticate(store, now);
  app.use('/datasets', requireLogin, datasetsRouter({ store, now }));
  app.use('/experiments', requireLogin, experimentsRouter({ config, store, engine, runner, now }));

  app.use(notFoundHandler);
  app.use(errorHandler(log));
  return app;
}
