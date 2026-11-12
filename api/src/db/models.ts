export type Role = 'admin' | 'member';
export type RiskLevel = 'low' | 'medium' | 'high';
export type ExperimentStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'budget_exhausted';

/** A question as the engine understands it (snake_case, same as the lines of a cases.jsonl file). */
export interface EngineCase {
  id: string;
  question: string;
  expected_answer: string;
  reference_doc_ids: string[];
  abstention_allowed: boolean;
  risk_level: RiskLevel;
  category: string;
}

/** A run record exactly as the engine returns it. */
export interface EngineRecord {
  run_id: string;
  experiment_id: string;
  test_case_id: string;
  config: 'A' | 'B' | 'C' | 'D';
  threshold: number;
  sample_index: number;
  model_id: string;
  prompt_version: string;
  rubric_version: string;
  response_text: string;
  label: 'correct' | 'abstained' | 'incorrect';
  judge_decision: boolean | null;
  latency_ms: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  timestamp: string;
}

export interface OrgDoc {
  _id: string;
  name: string;
  createdAt: Date;
}

export interface UserDoc {
  _id: string;
  orgId: string;
  email: string;
  passwordHash: string;
  role: Role;
  createdAt: Date;
}

export interface SessionDoc {
  _id: string; // SHA-256 of the session token: a database leak cannot be replayed as a login
  userId: string;
  orgId: string;
  role: Role;
  createdAt: Date;
  expiresAt: Date;
}

export interface DatasetDoc {
  _id: string;
  orgId: string;
  name: string;
  description: string | null;
  companyName: string;
  policies: Record<string, string>;
  caseCount: number;
  createdAt: Date;
}

export interface CaseDoc {
  _id: string; // `${datasetId}:${case.id}`
  orgId: string;
  datasetId: string;
  position: number;
  case: EngineCase;
}

export interface ExperimentConfig {
  model: string;
  judgeModel: string | null;
  graderModel: string;
  grader: 'llm' | 'policy';
  thresholds: number[];
  temperature: number;
  maxTokens: number;
}

export interface ExperimentDoc {
  _id: string;
  orgId: string;
  datasetId: string;
  name: string;
  status: ExperimentStatus;
  config: ExperimentConfig;
  budgetUsd: number;
  spendUsd: number;
  paidCalls: number;
  cachedCalls: number;
  progress: { total: number; done: number; failed: number };
  error: string | null;
  hasReport: boolean;
  createdAt: Date;
  finishedAt: Date | null;
}

export type RecordDoc = EngineRecord & { _id: string; orgId: string; experimentId: string };

export interface FailureDoc {
  _id: string;
  orgId: string;
  experimentId: string;
  testCaseId: string;
  rubricT: number | null;
  stage: string;
  error: string;
}

export interface ReportDoc {
  _id: string; // the experiment id: one report per experiment
  orgId: string;
  createdAt: Date;
  data: Record<string, unknown>;
}
