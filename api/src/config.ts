import { z } from 'zod';

const flag = z
  .enum(['0', '1', 'true', 'false'])
  .default('false')
  .transform((v) => v === '1' || v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  MONGODB_URI: z.string().min(1),
  MONGODB_DB: z.string().min(1).default('haludec'),
  ENGINE_URL: z.string().url(),
  HALUDEC_SERVICE_KEY: z.string().min(32, 'must be at least 32 characters'),
  ALLOWED_ORIGINS: z
    .string()
    .default('http://localhost:5173')
    .transform((s) =>
      s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  REGISTRATION_OPEN: flag,
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
  MAX_EXPERIMENT_BUDGET_USD: z.coerce.number().positive().max(10_000).default(20),
  ITEM_BUDGET_USD: z.coerce.number().positive().max(100).default(0.5),
  MAX_ACTIVE_JOBS: z.coerce.number().int().min(1).max(50).default(2),
  MAX_ACTIVE_PER_ORG: z.coerce.number().int().min(1).max(10).default(1),
  JOB_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  ENGINE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(300_000),
});

export type Config = z.infer<typeof schema>;

export class ConfigError extends Error {}

/** Error messages name the variable and the rule, never the value (values may be secrets). */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new ConfigError(`invalid configuration:\n${lines.join('\n')}`);
  }
  return parsed.data;
}
