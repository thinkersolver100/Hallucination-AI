import type { BreakdownRow, ComparisonRow, DatasetSummary, Experiment, Metrics, MetricsRow, Report, RunRecord } from '../../src/api/types';

export const SESSION = {
  user: { id: 'u1', email: 'ada@example.com', role: 'admin' as const },
  organization: { id: 'o1', name: 'Acme' },
};

export const ID = '11111111-1111-4111-8111-111111111111';
export const DATASET_ID = '22222222-2222-4222-8222-222222222222';

export function dataset(overrides: Partial<DatasetSummary> = {}): DatasetSummary {
  return {
    id: DATASET_ID,
    name: 'Northwind starter',
    description: null,
    companyName: 'Northwind Home Goods',
    caseCount: 30,
    policyIds: ['returns-policy-v1', 'shipping-policy-v1'],
    createdAt: '2026-11-12T10:00:00.000Z',
    ...overrides,
  };
}

export function experiment(overrides: Partial<Experiment> = {}): Experiment {
  return {
    id: ID,
    datasetId: DATASET_ID,
    name: 'Pilot run',
    status: 'completed',
    config: {
      model: 'gen',
      judgeModel: null,
      graderModel: 'grader',
      grader: 'policy',
      thresholds: [0, 0.5],
      temperature: 1,
      maxTokens: 1024,
    },
    budgetUsd: 1,
    spendUsd: 0.1234,
    paidCalls: 40,
    cachedCalls: 5,
    progress: { total: 90, done: 90, failed: 0 },
    error: null,
    hasReport: true,
    createdAt: '2026-11-12T10:05:00.000Z',
    finishedAt: '2026-11-12T10:09:00.000Z',
    ...overrides,
  };
}

export function metrics(counts: { correct: number; abstained: number; incorrect: number }, overrides: Partial<Metrics> = {}): Metrics {
  const n = counts.correct + counts.abstained + counts.incorrect;
  const answered = counts.correct + counts.incorrect;
  return {
    threshold: 0.5,
    n_total: n,
    n_correct: counts.correct,
    n_abstained: counts.abstained,
    n_incorrect: counts.incorrect,
    accuracy: counts.correct / n,
    incorrect_rate: counts.incorrect / n,
    abstention_rate: counts.abstained / n,
    coverage: answered / n,
    answered_accuracy: answered ? counts.correct / answered : null,
    selective_risk: answered ? counts.incorrect / answered : null,
    false_abstention_rate: null,
    mean_penalized_score: (counts.correct - counts.incorrect) / n,
    overconfident: false,
    total_cost_usd: 0.05,
    mean_latency_ms: 800,
    ...overrides,
  };
}

export function row(config: MetricsRow['config'], threshold: number, m: Metrics): MetricsRow {
  return { config, threshold, rubric: config === 'A' || config === 'C' ? 'closed' : 'open', metrics: m };
}

export function comparison(overrides: Partial<ComparisonRow['comparison']> = {}, rubric: ComparisonRow['rubric'] = 'closed'): ComparisonRow {
  return {
    rubric,
    baseline: rubric === 'closed' ? 'A' : 'B',
    mitigation: rubric === 'closed' ? 'C' : 'D',
    comparison: {
      threshold: 0.5,
      n_questions: 30,
      mean_a: 0.2,
      mean_b: 0.1,
      mean_diff: 0.1,
      ci_low: 0.05,
      ci_high: 0.15,
      ci_level: 0.95,
      p_value: 0.012,
      ...overrides,
    },
  };
}

export function breakdown(group: string, config: BreakdownRow['config'], threshold: number, m: Metrics, attribute: BreakdownRow['attribute'] = 'category'): BreakdownRow {
  return { attribute, group, config, threshold, rubric: config === 'A' || config === 'C' ? 'closed' : 'open', metrics: m };
}

export function report(overrides: { nQuestions?: number } = {}): Report {
  const base = metrics({ correct: 12, abstained: 6, incorrect: 12 });
  return {
    report: {
      n_questions: overrides.nQuestions ?? 30,
      n_failures: 2,
      rows: [
        row('A', 0.5, base),
        row('C', 0.5, metrics({ correct: 10, abstained: 16, incorrect: 4 })),
        row('A', 0.75, metrics({ correct: 12, abstained: 0, incorrect: 18 }, { threshold: 0.75, mean_penalized_score: -1.5, overconfident: true })),
      ],
      comparisons: [comparison()],
    },
    by_category: [
      breakdown('answerable', 'A', 0.5, metrics({ correct: 8, abstained: 0, incorrect: 2 })),
      breakdown('conflicting', 'A', 0.5, metrics({ correct: 0, abstained: 1, incorrect: 5 })),
      breakdown('answerable', 'A', 0.75, metrics({ correct: 8, abstained: 0, incorrect: 2 }, { threshold: 0.75 })),
    ],
    by_risk_level: [breakdown('high', 'A', 0.5, metrics({ correct: 1, abstained: 1, incorrect: 2 }), 'risk_level')],
  };
}

export function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    run_id: 'r1',
    test_case_id: 'ECOM-001',
    config: 'A',
    threshold: 0,
    sample_index: 0,
    label: 'correct',
    judge_decision: null,
    cost_usd: 0.001,
    response_text: 'Yes, within 30 days.',
    ...overrides,
  };
}
