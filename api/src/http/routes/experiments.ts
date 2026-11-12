import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Config } from '../../config.js';
import type { ExperimentDoc } from '../../db/models.js';
import type { Store } from '../../db/store.js';
import type { EngineClient } from '../../engine/client.js';
import { HttpError, badRequest, conflict, notFound } from '../../errors.js';
import type { JobRunner } from '../../jobs/runner.js';
import { getAuth, jsonBody } from '../middleware.js';
import { createExperimentSchema, idSchema, recordsQuerySchema } from '../schemas.js';

function dto(e: ExperimentDoc) {
  return {
    id: e._id,
    datasetId: e.datasetId,
    name: e.name,
    status: e.status,
    config: e.config,
    budgetUsd: e.budgetUsd,
    spendUsd: e.spendUsd,
    paidCalls: e.paidCalls,
    cachedCalls: e.cachedCalls,
    progress: e.progress,
    error: e.error,
    hasReport: e.hasReport,
    createdAt: e.createdAt,
    finishedAt: e.finishedAt,
  };
}

export function experimentsRouter(deps: {
  config: Config;
  store: Store;
  engine: EngineClient;
  runner: JobRunner;
  now: () => Date;
}): Router {
  const { config, store, engine, runner, now } = deps;
  const router = Router();

  async function load(orgId: string, rawId: unknown) {
    const org = store.forOrg(orgId);
    const id = idSchema.safeParse(rawId);
    const experiment = id.success ? await org.getExperiment(id.data) : null;
    if (!experiment) throw notFound('experiment');
    return { org, experiment };
  }

  router.post('/', jsonBody('64kb'), async (req, res) => {
    const auth = getAuth(res);
    const org = store.forOrg(auth.orgId);
    const input = createExperimentSchema.parse(req.body);

    const dataset = await org.getDataset(input.datasetId);
    if (!dataset) throw notFound('dataset');
    if (input.budgetUsd > config.MAX_EXPERIMENT_BUDGET_USD) {
      throw badRequest(`budgetUsd may not exceed ${config.MAX_EXPERIMENT_BUDGET_USD}`);
    }
    if ((await org.countRunning()) >= config.MAX_ACTIVE_PER_ORG) {
      throw conflict('too_many_active', 'finish or cancel your running experiment first');
    }
    if (runner.activeCount >= config.MAX_ACTIVE_JOBS) {
      throw new HttpError(503, 'busy', 'the server is running its maximum number of experiments');
    }

    let allowed: string[];
    try {
      allowed = await engine.models();
    } catch {
      throw new HttpError(502, 'engine_unavailable', 'the evaluation engine is not reachable');
    }
    const unknown = [input.model, input.judgeModel ?? input.model, input.graderModel].filter(
      (m) => !allowed.includes(m),
    );
    if (unknown.length > 0) {
      throw new HttpError(422, 'model_not_allowed', `models not available: ${[...new Set(unknown)].join(', ')}`);
    }

    const id = randomUUID();
    const experiment: Omit<ExperimentDoc, 'orgId'> = {
      _id: id,
      datasetId: dataset._id,
      name: input.name,
      status: 'running',
      config: {
        model: input.model,
        judgeModel: input.judgeModel ?? null,
        graderModel: input.graderModel,
        grader: input.grader,
        thresholds: input.thresholds,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
      },
      budgetUsd: input.budgetUsd,
      spendUsd: 0,
      paidCalls: 0,
      cachedCalls: 0,
      progress: { total: dataset.caseCount * (1 + input.thresholds.length), done: 0, failed: 0 },
      error: null,
      hasReport: false,
      createdAt: now(),
      finishedAt: null,
    };
    await org.createExperiment(experiment);
    runner.start(auth.orgId, id);
    res.status(201).json(dto({ ...experiment, orgId: auth.orgId }));
  });

  router.get('/', async (_req, res) => {
    const org = store.forOrg(getAuth(res).orgId);
    res.json({ experiments: (await org.listExperiments()).map(dto) });
  });

  router.get('/:id', async (req, res) => {
    const { experiment } = await load(getAuth(res).orgId, req.params['id']);
    res.json(dto(experiment));
  });

  router.post('/:id/cancel', async (req, res) => {
    const { experiment } = await load(getAuth(res).orgId, req.params['id']);
    if (experiment.status !== 'running' || !runner.cancel(experiment._id)) {
      throw conflict('not_running', 'this experiment is not running');
    }
    res.status(202).json(dto(experiment));
  });

  router.delete('/:id', async (req, res) => {
    const { org, experiment } = await load(getAuth(res).orgId, req.params['id']);
    if (!(await org.deleteExperiment(experiment._id))) {
      throw conflict('running', 'cancel the experiment before deleting it');
    }
    res.status(204).end();
  });

  router.get('/:id/report', async (req, res) => {
    const { org, experiment } = await load(getAuth(res).orgId, req.params['id']);
    const report = await org.getReport(experiment._id);
    if (!report) throw notFound('report');
    res.json(report.data);
  });

  router.get('/:id/records', async (req, res) => {
    const { org, experiment } = await load(getAuth(res).orgId, req.params['id']);
    const query = recordsQuerySchema.parse(req.query);
    const docs = await org.listRecords(experiment._id, { after: query.after, limit: query.limit });
    const last = docs[docs.length - 1];
    res.json({
      records: docs.map(({ _id, orgId, ...record }) => {
        void _id;
        void orgId;
        return record;
      }),
      nextAfter: docs.length === query.limit && last ? last._id : null,
    });
  });

  router.get('/:id/failures', async (req, res) => {
    const { org, experiment } = await load(getAuth(res).orgId, req.params['id']);
    const failures = await org.listFailures(experiment._id);
    res.json({
      failures: failures.map((f) => ({
        testCaseId: f.testCaseId,
        rubricT: f.rubricT,
        stage: f.stage,
        error: f.error,
      })),
    });
  });

  return router;
}
