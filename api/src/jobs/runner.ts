import type { Config } from '../config.js';
import type { CaseDoc, EngineCase, ExperimentDoc } from '../db/models.js';
import type { OrgStore, Store } from '../db/store.js';
import { EngineError, type EngineClient } from '../engine/client.js';
import type { Logger } from '../logger.js';

type Stop = 'cancel' | 'budget' | 'fatal';

interface ActiveJob {
  orgId: string;
  cancelled: boolean;
  promise: Promise<void>;
}

export interface RunnerDeps {
  store: Store;
  engine: EngineClient;
  config: Pick<Config, 'JOB_CONCURRENCY' | 'ITEM_BUDGET_USD'>;
  log: Logger;
  sleep?: (ms: number) => Promise<void>;
}

const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = 500;
const MAX_CONSECUTIVE_ENGINE_ERRORS = 5;
const MAX_ERROR_CHARS = 500;

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class JobRunner {
  private readonly jobs = new Map<string, ActiveJob>();
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: RunnerDeps) {
    this.sleep = deps.sleep ?? realSleep;
  }

  get activeCount(): number {
    return this.jobs.size;
  }

  /** Starts an experiment that is already stored as running. Returns immediately. */
  start(orgId: string, experimentId: string): void {
    const job: ActiveJob = { orgId, cancelled: false, promise: Promise.resolve() };
    this.jobs.set(experimentId, job);
    job.promise = this.run(orgId, experimentId, job)
      .catch((err: unknown) => {
        this.deps.log.error('experiment crashed', { experimentId, error: String(err) });
      })
      .finally(() => {
        this.jobs.delete(experimentId);
      });
  }

  /** Stops scheduling new items. Items already sent to the engine still finish. */
  cancel(experimentId: string): boolean {
    const job = this.jobs.get(experimentId);
    if (!job) return false;
    job.cancelled = true;
    return true;
  }

  cancelAll(): void {
    for (const job of this.jobs.values()) job.cancelled = true;
  }

  async whenIdle(): Promise<void> {
    while (this.jobs.size > 0) {
      await Promise.allSettled([...this.jobs.values()].map((j) => j.promise));
    }
  }

  private async run(orgId: string, experimentId: string, job: ActiveJob): Promise<void> {
    const org = this.deps.store.forOrg(orgId);
    try {
      const experiment = await org.getExperiment(experimentId);
      if (!experiment) return;
      const dataset = await org.getDataset(experiment.datasetId);
      if (!dataset) {
        await org.finishExperiment(experimentId, 'failed', 'the dataset no longer exists');
        return;
      }
      const cases = await org.getCases(experiment.datasetId);
      const stop = await this.process(org, experiment, dataset.policies, dataset.companyName, cases, job);
      await this.finish(org, experiment, cases, stop);
    } catch (err) {
      this.deps.log.error('experiment failed unexpectedly', { experimentId, error: String(err) });
      await org
        .finishExperiment(experimentId, 'failed', 'internal error while running the experiment')
        .catch(() => undefined);
    }
  }

  private async process(
    org: OrgStore,
    experiment: ExperimentDoc,
    policies: Record<string, string>,
    companyName: string,
    cases: CaseDoc[],
    job: ActiveJob,
  ): Promise<{ stop: Stop | null; fatalMessage: string }> {
    const conditions: (number | null)[] = [null, ...experiment.config.thresholds];
    const items = cases.flatMap((c) => conditions.map((t) => ({ case: c.case, rubricT: t })));

    const state = {
      spend: experiment.spendUsd,
      stop: null as Stop | null,
      fatalMessage: '',
      engineErrorsInARow: 0,
    };
    const halt = (reason: Stop, message = ''): void => {
      if (state.stop === null) {
        state.stop = reason;
        state.fatalMessage = message;
      }
    };

    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (job.cancelled) halt('cancel');
        if (state.stop) return;
        const item = items[next++];
        if (!item) return;
        const remaining = experiment.budgetUsd - state.spend;
        if (remaining <= 0) {
          halt('budget');
          return;
        }
        const itemBudget = Math.min(remaining, this.deps.config.ITEM_BUDGET_USD);

        let result;
        try {
          result = await this.withRetry(() =>
            this.deps.engine.evaluateCase({
              experiment_id: experiment._id,
              case: item.case,
              rubric_t: item.rubricT,
              model: experiment.config.model,
              ...(experiment.config.judgeModel ? { judge_model: experiment.config.judgeModel } : {}),
              grader_model: experiment.config.graderModel,
              grader: experiment.config.grader,
              temperature: experiment.config.temperature,
              max_tokens: experiment.config.maxTokens,
              policies,
              company_name: companyName,
              budget_usd: itemBudget,
            }),
          );
        } catch (err) {
          if (!(err instanceof EngineError)) throw err;
          if (err.fatal) {
            halt('fatal', err.message);
            return;
          }
          await this.recordFailure(org, experiment._id, item.case.id, item.rubricT, 'engine', err.message);
          if (err.retryable && ++state.engineErrorsInARow >= MAX_CONSECUTIVE_ENGINE_ERRORS) {
            halt('fatal', 'the engine service is unavailable');
          }
          continue;
        }
        state.engineErrorsInARow = 0;
        state.spend += result.spend_usd;

        const overItemCap = result.status === 'budget_exceeded' && remaining > itemBudget;
        const failed = result.status === 'failed' || overItemCap;
        const finishedItem = result.status === 'budget_exceeded' && !overItemCap ? 0 : 1;
        await org.addProgress(experiment._id, {
          spendUsd: result.spend_usd,
          paidCalls: result.paid_calls,
          cachedCalls: result.cached_calls,
          done: finishedItem,
          failed: failed ? 1 : 0,
        });

        if (result.status === 'ok') {
          await org.insertRecords(experiment._id, result.records);
        } else if (result.status === 'failed') {
          await this.recordFailure(
            org,
            experiment._id,
            item.case.id,
            item.rubricT,
            result.stage ?? 'unknown',
            result.error ?? 'evaluation failed',
          );
        } else if (overItemCap) {
          await this.recordFailure(
            org,
            experiment._id,
            item.case.id,
            item.rubricT,
            'item_budget',
            'this question exceeded the per-question spending cap',
          );
        } else {
          halt('budget');
        }
      }
    };

    const workers = Math.min(this.deps.config.JOB_CONCURRENCY, Math.max(items.length, 1));
    await Promise.all(Array.from({ length: workers }, worker));
    return { stop: state.stop, fatalMessage: state.fatalMessage };
  }

  private async finish(
    org: OrgStore,
    experiment: ExperimentDoc,
    cases: CaseDoc[],
    outcome: { stop: Stop | null; fatalMessage: string },
  ): Promise<void> {
    const id = experiment._id;
    if (outcome.stop === 'fatal') {
      await org.finishExperiment(id, 'failed', outcome.fatalMessage);
      return;
    }
    if (outcome.stop === 'cancel') {
      await org.finishExperiment(id, 'cancelled', null);
      return;
    }
    if (outcome.stop === 'budget') {
      await org.finishExperiment(id, 'budget_exhausted', 'the experiment budget was reached');
      return;
    }

    const records = await org.allRecords(id);
    if (records.length === 0) {
      await org.finishExperiment(id, 'failed', 'no question could be evaluated; see the failures');
      return;
    }
    const failures = await org.listFailures(id);
    try {
      const report = await this.withRetry(() =>
        this.deps.engine.report({
          cases: cases.map((c) => c.case as EngineCase),
          // The report does not use response text, so it is not sent back to the engine.
          records: records.map(({ _id, orgId, experimentId, ...record }) => {
            void _id;
            void orgId;
            void experimentId;
            return { ...record, response_text: '' };
          }),
          failures: failures.map((f) => ({
            test_case_id: f.testCaseId,
            rubric_t: f.rubricT,
            stage: f.stage,
            error: f.error,
          })),
          thresholds: experiment.config.thresholds,
        }),
      );
      await org.saveReport(id, report);
      await org.finishExperiment(id, 'completed', null, new Date(), true);
    } catch (err) {
      const message = err instanceof EngineError ? err.message : 'report generation failed';
      await org.finishExperiment(id, 'failed', `report failed: ${message}`.slice(0, MAX_ERROR_CHARS));
    }
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const retry = err instanceof EngineError && err.retryable && attempt < RETRY_ATTEMPTS;
        if (!retry) throw err;
        await this.sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
      }
    }
  }

  private recordFailure(
    org: OrgStore,
    experimentId: string,
    testCaseId: string,
    rubricT: number | null,
    stage: string,
    error: string,
  ): Promise<void> {
    return org.insertFailure({
      _id: crypto.randomUUID(),
      experimentId,
      testCaseId,
      rubricT,
      stage,
      error: error.slice(0, MAX_ERROR_CHARS),
    });
  }
}
