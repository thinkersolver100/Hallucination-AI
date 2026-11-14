import { Router } from 'express';
import type { Config } from '../../config.js';
import type { EngineClient } from '../../engine/client.js';
import { HttpError } from '../../errors.js';

/** What the dashboard needs to build its forms: allowed models and the budget ceiling. */
export function metaRouter(deps: { config: Config; engine: EngineClient }): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    let models: string[];
    try {
      models = await deps.engine.models();
    } catch {
      throw new HttpError(502, 'engine_unavailable', 'the evaluation engine is not reachable');
    }
    res.json({
      models: [...models].sort(),
      maxExperimentBudgetUsd: deps.config.MAX_EXPERIMENT_BUDGET_USD,
    });
  });

  return router;
}
