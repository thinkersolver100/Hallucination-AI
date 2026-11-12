import { z } from 'zod';

/** Engine limits that the API mirrors so a bad request fails here, not halfway through a run. */
export const MAX_POLICY_CHARS = 200_000;
export const MAX_CASES_PER_DATASET = 1000;
export const MAX_THRESHOLDS = 8;
export const MAX_DATASETS_PER_ORG = 50;
export const MAX_THRESHOLD = 0.9;

const POLICY_ID = /^[A-Za-z0-9_-]{1,128}$/;
const CASE_ID = /^[A-Za-z0-9_.-]{1,64}$/;
const noNewlines = /^[^\r\n]+$/;

export const idSchema = z.string().uuid();

export const registerSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    password: z.string().min(12).max(128),
    organizationName: z.string().trim().min(1).max(120).regex(noNewlines),
  })
  .strict();

export const loginSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    password: z.string().min(1).max(128),
  })
  .strict();

const caseSchema = z
  .object({
    id: z.string().regex(CASE_ID),
    question: z.string().trim().min(1).max(2000),
    expected_answer: z.string().trim().min(1).max(2000),
    reference_doc_ids: z.array(z.string().regex(POLICY_ID)).max(20).default([]),
    abstention_allowed: z.boolean(),
    risk_level: z.enum(['low', 'medium', 'high']),
    category: z.string().trim().min(1).max(64),
  })
  .strict();

export const createDatasetSchema = z
  .object({
    name: z.string().trim().min(1).max(120).regex(noNewlines),
    description: z.string().trim().max(1000).optional(),
    companyName: z.string().trim().min(1).max(120).regex(noNewlines).default('the company'),
    policies: z
      .record(z.string().regex(POLICY_ID), z.string().min(1).max(MAX_POLICY_CHARS))
      .default({}),
    cases: z.array(caseSchema).min(1).max(MAX_CASES_PER_DATASET),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (Object.values(data.policies).reduce((sum, text) => sum + text.length, 0) > MAX_POLICY_CHARS) {
      ctx.addIssue({ code: 'custom', path: ['policies'], message: 'policy documents are too large' });
    }
    const seen = new Set<string>();
    data.cases.forEach((c, i) => {
      if (seen.has(c.id)) {
        ctx.addIssue({ code: 'custom', path: ['cases', i, 'id'], message: `duplicate case id ${c.id}` });
      }
      seen.add(c.id);
      for (const ref of c.reference_doc_ids) {
        if (!(ref in data.policies)) {
          ctx.addIssue({
            code: 'custom',
            path: ['cases', i, 'reference_doc_ids'],
            message: `unknown policy document ${ref}`,
          });
        }
      }
    });
  });

export const createExperimentSchema = z
  .object({
    datasetId: idSchema,
    name: z.string().trim().min(1).max(120).regex(noNewlines),
    model: z.string().min(1).max(200),
    judgeModel: z.string().min(1).max(200).optional(),
    graderModel: z.string().min(1).max(200),
    grader: z.enum(['llm', 'policy']).default('policy'),
    thresholds: z
      .array(z.number().min(0).max(MAX_THRESHOLD))
      .min(1)
      .max(MAX_THRESHOLDS)
      .default([0, 0.5, 0.75, 0.9]),
    temperature: z.number().min(0).max(2).default(1),
    maxTokens: z.number().int().min(1).max(8192).default(1024),
    budgetUsd: z.number().positive(),
  })
  .strict()
  .refine((d) => new Set(d.thresholds).size === d.thresholds.length, {
    path: ['thresholds'],
    message: 'thresholds must be unique',
  });

export const recordsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  after: z.string().min(1).max(300).optional(),
});
