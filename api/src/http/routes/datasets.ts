import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { DatasetDoc } from '../../db/models.js';
import type { Store } from '../../db/store.js';
import { conflict, notFound } from '../../errors.js';
import { getAuth, jsonBody } from '../middleware.js';
import { MAX_DATASETS_PER_ORG, createDatasetSchema, idSchema } from '../schemas.js';

function summary(d: DatasetDoc) {
  return {
    id: d._id,
    name: d.name,
    description: d.description,
    companyName: d.companyName,
    caseCount: d.caseCount,
    policyIds: Object.keys(d.policies).sort(),
    createdAt: d.createdAt,
  };
}

export function datasetsRouter(deps: { store: Store; now: () => Date }): Router {
  const { store, now } = deps;
  const router = Router();

  router.post('/', jsonBody('5mb'), async (req, res) => {
    const org = store.forOrg(getAuth(res).orgId);
    const input = createDatasetSchema.parse(req.body);
    if ((await org.countDatasets()) >= MAX_DATASETS_PER_ORG) {
      throw conflict('limit_reached', `an organization can hold at most ${MAX_DATASETS_PER_ORG} datasets`);
    }
    const id = randomUUID();
    await org.createDataset(
      {
        _id: id,
        name: input.name,
        description: input.description ?? null,
        companyName: input.companyName,
        policies: input.policies,
        caseCount: input.cases.length,
        createdAt: now(),
      },
      input.cases.map((c, position) => ({ _id: `${id}:${c.id}`, datasetId: id, position, case: c })),
    );
    const created = await org.getDataset(id);
    res.status(201).json(summary(created as DatasetDoc));
  });

  router.get('/', async (_req, res) => {
    const org = store.forOrg(getAuth(res).orgId);
    res.json({ datasets: (await org.listDatasets()).map(summary) });
  });

  router.get('/:id', async (req, res) => {
    const org = store.forOrg(getAuth(res).orgId);
    const id = idSchema.safeParse(req.params['id']);
    const dataset = id.success ? await org.getDataset(id.data) : null;
    if (!dataset) throw notFound('dataset');
    const cases = await org.getCases(dataset._id);
    res.json({ ...summary(dataset), policies: dataset.policies, cases: cases.map((c) => c.case) });
  });

  router.delete('/:id', async (req, res) => {
    const org = store.forOrg(getAuth(res).orgId);
    const id = idSchema.safeParse(req.params['id']);
    const dataset = id.success ? await org.getDataset(id.data) : null;
    if (!dataset) throw notFound('dataset');
    if ((await org.countExperimentsForDataset(dataset._id)) > 0) {
      throw conflict('in_use', 'delete the experiments that use this dataset first');
    }
    await org.deleteDataset(dataset._id);
    res.status(204).end();
  });

  return router;
}
