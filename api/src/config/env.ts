import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(3000),

  MONGODB_URI: z.string().min(1),
  MONGODB_DB: z.string().min(1).default("haludec"),

  ENGINE_URL: z.string().url(),
  HALUDEC_SERVICE_KEY: z.string().min(1),

  ALLOWED_ORIGINS: z
    .string()
    .default("http://localhost:5173")
    .transform((value) =>
      value.split(",").map((origin) => origin.trim()).filter(Boolean),
    ),

  REGISTRATION_OPEN: z
    .enum(["0", "1"])
    .default("1")
    .transform((value) => value === "1"),

  MAX_EXPERIMENT_BUDGET_USD: z.coerce.number().positive().default(5),
  ITEM_BUDGET_USD: z.coerce.number().positive().default(0.5),

  MAX_ACTIVE_JOBS: z.coerce.number().int().positive().default(2),
  MAX_ACTIVE_PER_ORG: z.coerce.number().int().positive().default(1),
  JOB_CONCURRENCY: z.coerce.number().int().positive().default(4),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error("Invalid environment configuration:");
  console.error(parsedEnv.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsedEnv.data;
