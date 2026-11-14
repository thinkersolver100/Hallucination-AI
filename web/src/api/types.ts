import { z } from 'zod';

const iso = z.string();

export const sessionSchema = z.object({
  user: z.object({ id: z.string(), email: z.string(), role: z.enum(['admin', 'member']) }),
  organization: z.object({ id: z.string(), name: z.string() }),
});
export type Session = z.infer<typeof sessionSchema>;

export const metaSchema = z.object({
  models: z.array(z.string()),
  maxExperimentBudgetUsd: z.number(),
});
export type Meta = z.infer<typeof metaSchema>;

export const datasetSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  companyName: z.string(),
  caseCount: z.number().int(),
  policyIds: z.array(z.string()),
  createdAt: iso,
});
export type DatasetSummary = z.infer<typeof datasetSummarySchema>;
export const datasetListSchema = z.object({ datasets: z.array(datasetSummarySchema) });

export const experimentStatusSchema = z.enum([
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'budget_exhausted',
]);
export type ExperimentStatus = z.infer<typeof experimentStatusSchema>;

export const experimentSchema = z.object({
  id: z.string(),
  datasetId: z.string(),
  name: z.string(),
  status: experimentStatusSchema,
  config: z.object({
    model: z.string(),
    judgeModel: z.string().nullable(),
    graderModel: z.string(),
    grader: z.enum(['llm', 'policy']),
    thresholds: z.array(z.number()),
    temperature: z.number(),
    maxTokens: z.number(),
  }),
  budgetUsd: z.number(),
  spendUsd: z.number(),
  paidCalls: z.number(),
  cachedCalls: z.number(),
  progress: z.object({ total: z.number(), done: z.number(), failed: z.number() }),
  error: z.string().nullable(),
  hasReport: z.boolean(),
  createdAt: iso,
  finishedAt: iso.nullable(),
});
export type Experiment = z.infer<typeof experimentSchema>;
export const experimentListSchema = z.object({ experiments: z.array(experimentSchema) });

export const configIdSchema = z.enum(['A', 'B', 'C', 'D']);
export type ConfigId = z.infer<typeof configIdSchema>;
export const labelSchema = z.enum(['correct', 'abstained', 'incorrect']);

export const runRecordSchema = z.object({
  run_id: z.string(),
  test_case_id: z.string(),
  config: configIdSchema,
  threshold: z.number(),
  sample_index: z.number(),
  label: labelSchema,
  judge_decision: z.boolean().nullable(),
  cost_usd: z.number(),
  response_text: z.string(),
});
export type RunRecord = z.infer<typeof runRecordSchema>;
export const recordsPageSchema = z.object({
  records: z.array(runRecordSchema),
  nextAfter: z.string().nullable(),
});

export const failuresSchema = z.object({
  failures: z.array(
    z.object({
      testCaseId: z.string(),
      rubricT: z.number().nullable(),
      stage: z.string(),
      error: z.string(),
    }),
  ),
});

// ---- the engine's report, passed through by the API ---------------------------------

export const metricsSchema = z.object({
  threshold: z.number(),
  n_total: z.number(),
  n_correct: z.number(),
  n_abstained: z.number(),
  n_incorrect: z.number(),
  accuracy: z.number(),
  incorrect_rate: z.number(),
  abstention_rate: z.number(),
  coverage: z.number(),
  answered_accuracy: z.number().nullable(),
  selective_risk: z.number().nullable(),
  false_abstention_rate: z.number().nullable().optional(),
  mean_penalized_score: z.number(),
  overconfident: z.boolean(),
  total_cost_usd: z.number(),
  mean_latency_ms: z.number(),
});
export type Metrics = z.infer<typeof metricsSchema>;

const rubricSchema = z.enum(['closed', 'open']);

export const metricsRowSchema = z.object({
  config: configIdSchema,
  threshold: z.number(),
  rubric: rubricSchema,
  metrics: metricsSchema,
});
export type MetricsRow = z.infer<typeof metricsRowSchema>;

export const comparisonRowSchema = z.object({
  rubric: rubricSchema,
  baseline: configIdSchema,
  mitigation: configIdSchema,
  comparison: z.object({
    threshold: z.number(),
    n_questions: z.number(),
    mean_a: z.number(),
    mean_b: z.number(),
    mean_diff: z.number(),
    ci_low: z.number(),
    ci_high: z.number(),
    ci_level: z.number(),
    p_value: z.number(),
  }),
});
export type ComparisonRow = z.infer<typeof comparisonRowSchema>;

export const breakdownRowSchema = z.object({
  attribute: z.enum(['category', 'risk_level']),
  group: z.string(),
  config: configIdSchema,
  threshold: z.number(),
  rubric: rubricSchema,
  metrics: metricsSchema,
});
export type BreakdownRow = z.infer<typeof breakdownRowSchema>;

export const reportSchema = z.object({
  report: z.object({
    n_questions: z.number(),
    n_failures: z.number(),
    rows: z.array(metricsRowSchema),
    comparisons: z.array(comparisonRowSchema),
  }),
  by_category: z.array(breakdownRowSchema),
  by_risk_level: z.array(breakdownRowSchema),
});
export type Report = z.infer<typeof reportSchema>;
