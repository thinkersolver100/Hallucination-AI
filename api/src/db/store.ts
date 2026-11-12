import type { Collection, Db } from 'mongodb';
import { ScopedCollection } from './scoped.js';
import type {
  CaseDoc,
  DatasetDoc,
  EngineRecord,
  ExperimentDoc,
  ExperimentStatus,
  FailureDoc,
  OrgDoc,
  RecordDoc,
  ReportDoc,
  SessionDoc,
  UserDoc,
} from './models.js';

const DUPLICATE_KEY = 11000;

export function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === DUPLICATE_KEY;
}

export interface ProgressDelta {
  spendUsd: number;
  paidCalls: number;
  cachedCalls: number;
  done: number;
  failed: number;
}

/**
 * Entry point to the database. Identity data (organizations, users, sessions) lives here
 * because it is what establishes a tenant; everything a tenant owns is reachable only through
 * forOrg(), which scopes every query to one organization.
 */
export class Store {
  private readonly orgs: Collection<OrgDoc>;
  private readonly users: Collection<UserDoc>;
  private readonly sessions: Collection<SessionDoc>;

  constructor(private readonly db: Db) {
    this.orgs = db.collection<OrgDoc>('organizations');
    this.users = db.collection<UserDoc>('users');
    this.sessions = db.collection<SessionDoc>('sessions');
  }

  static async create(db: Db): Promise<Store> {
    const store = new Store(db);
    await store.ensureIndexes();
    return store;
  }

  async ensureIndexes(): Promise<void> {
    const { db } = this;
    await this.users.createIndex({ email: 1 }, { unique: true });
    await this.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await db.collection('datasets').createIndex({ orgId: 1, createdAt: -1 });
    await db.collection('cases').createIndex({ orgId: 1, datasetId: 1, position: 1 });
    await db.collection('experiments').createIndex({ orgId: 1, createdAt: -1 });
    await db.collection('experiments').createIndex({ orgId: 1, datasetId: 1 });
    await db.collection('records').createIndex({ orgId: 1, experimentId: 1, _id: 1 });
    await db.collection('failures').createIndex({ orgId: 1, experimentId: 1 });
  }

  // ---- identity -------------------------------------------------------------

  /** Returns false when the email is already registered. */
  async createOrganizationWithAdmin(input: {
    orgId: string;
    orgName: string;
    userId: string;
    email: string;
    passwordHash: string;
    now: Date;
  }): Promise<boolean> {
    try {
      // The user goes first: the unique email index rejects duplicates before an
      // organization exists, so there is nothing to clean up in that case.
      await this.users.insertOne({
        _id: input.userId,
        orgId: input.orgId,
        email: input.email,
        passwordHash: input.passwordHash,
        role: 'admin',
        createdAt: input.now,
      });
    } catch (err) {
      if (isDuplicateKey(err)) return false;
      throw err;
    }
    try {
      await this.orgs.insertOne({ _id: input.orgId, name: input.orgName, createdAt: input.now });
    } catch (err) {
      await this.users.deleteOne({ _id: input.userId });
      throw err;
    }
    return true;
  }

  findUserByEmail(email: string): Promise<UserDoc | null> {
    return this.users.findOne({ email });
  }

  findUserById(id: string): Promise<UserDoc | null> {
    return this.users.findOne({ _id: id });
  }

  findOrganization(id: string): Promise<OrgDoc | null> {
    return this.orgs.findOne({ _id: id });
  }

  async createSession(doc: SessionDoc): Promise<void> {
    await this.sessions.insertOne(doc);
  }

  findSession(tokenHash: string): Promise<SessionDoc | null> {
    return this.sessions.findOne({ _id: tokenHash });
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.sessions.deleteOne({ _id: tokenHash });
  }

  // ---- maintenance (deliberately not tenant-scoped) -----------------------------

  /** Called once at startup: no job survives a restart, so running experiments are interrupted. */
  async markInterrupted(now: Date = new Date()): Promise<number> {
    const result = await this.db.collection('experiments').updateMany(
      { status: 'running' },
      {
        $set: {
          status: 'interrupted',
          error: 'the server restarted while this experiment was running',
          finishedAt: now,
        },
      },
    );
    return result.modifiedCount;
  }

  forOrg(orgId: string): OrgStore {
    return new OrgStore(this.db, orgId);
  }
}

export class OrgStore {
  private readonly datasets: ScopedCollection<DatasetDoc>;
  private readonly cases: ScopedCollection<CaseDoc>;
  private readonly experiments: ScopedCollection<ExperimentDoc>;
  private readonly records: ScopedCollection<RecordDoc>;
  private readonly failures: ScopedCollection<FailureDoc>;
  private readonly reports: ScopedCollection<ReportDoc>;

  constructor(db: Db, readonly orgId: string) {
    this.datasets = new ScopedCollection(db.collection<DatasetDoc>('datasets'), orgId);
    this.cases = new ScopedCollection(db.collection<CaseDoc>('cases'), orgId);
    this.experiments = new ScopedCollection(db.collection<ExperimentDoc>('experiments'), orgId);
    this.records = new ScopedCollection(db.collection<RecordDoc>('records'), orgId);
    this.failures = new ScopedCollection(db.collection<FailureDoc>('failures'), orgId);
    this.reports = new ScopedCollection(db.collection<ReportDoc>('reports'), orgId);
  }

  // ---- datasets -------------------------------------------------------------

  async createDataset(dataset: Omit<DatasetDoc, 'orgId'>, cases: Omit<CaseDoc, 'orgId'>[]): Promise<void> {
    await this.datasets.insertOne(dataset);
    try {
      await this.cases.insertMany(cases);
    } catch (err) {
      await this.datasets.deleteOne({ _id: dataset._id });
      await this.cases.deleteMany({ datasetId: dataset._id });
      throw err;
    }
  }

  countDatasets(): Promise<number> {
    return this.datasets.count();
  }

  listDatasets(): Promise<DatasetDoc[]> {
    return this.datasets.find({}, { sort: { createdAt: -1 }, limit: 200 });
  }

  getDataset(id: string): Promise<DatasetDoc | null> {
    return this.datasets.findOne({ _id: id });
  }

  getCases(datasetId: string): Promise<CaseDoc[]> {
    return this.cases.find({ datasetId }, { sort: { position: 1 } });
  }

  async deleteDataset(id: string): Promise<boolean> {
    const deleted = await this.datasets.deleteOne({ _id: id });
    if (deleted > 0) await this.cases.deleteMany({ datasetId: id });
    return deleted > 0;
  }

  countExperimentsForDataset(datasetId: string): Promise<number> {
    return this.experiments.count({ datasetId });
  }

  // ---- experiments ------------------------------------------------------------

  createExperiment(doc: Omit<ExperimentDoc, 'orgId'>): Promise<void> {
    return this.experiments.insertOne(doc);
  }

  listExperiments(): Promise<ExperimentDoc[]> {
    return this.experiments.find({}, { sort: { createdAt: -1 }, limit: 200 });
  }

  getExperiment(id: string): Promise<ExperimentDoc | null> {
    return this.experiments.findOne({ _id: id });
  }

  countRunning(): Promise<number> {
    return this.experiments.count({ status: 'running' });
  }

  async addProgress(id: string, delta: ProgressDelta): Promise<void> {
    await this.experiments.updateOne(
      { _id: id },
      {
        $inc: {
          spendUsd: delta.spendUsd,
          paidCalls: delta.paidCalls,
          cachedCalls: delta.cachedCalls,
          'progress.done': delta.done,
          'progress.failed': delta.failed,
        },
      },
    );
  }

  /** Only a running experiment can be finished, so a late write cannot overwrite a final state. */
  async finishExperiment(
    id: string,
    status: Exclude<ExperimentStatus, 'running'>,
    error: string | null,
    now: Date = new Date(),
    hasReport = false,
  ): Promise<boolean> {
    const matched = await this.experiments.updateOne(
      { _id: id, status: 'running' },
      { $set: { status, error, hasReport, finishedAt: now } },
    );
    return matched > 0;
  }

  /** Deletes the experiment and everything derived from it. Refuses while it is running. */
  async deleteExperiment(id: string): Promise<boolean> {
    const deleted = await this.experiments.deleteOne({ _id: id, status: { $ne: 'running' } });
    if (deleted === 0) return false;
    await this.records.deleteMany({ experimentId: id });
    await this.failures.deleteMany({ experimentId: id });
    await this.reports.deleteOne({ _id: id });
    return true;
  }

  // ---- results -------------------------------------------------------------------

  insertRecords(experimentId: string, records: EngineRecord[]): Promise<void> {
    return this.records.insertMany(
      records.map((r) => ({ ...r, _id: r.run_id, experimentId })),
    );
  }

  async listRecords(
    experimentId: string,
    page: { after?: string | undefined; limit: number },
  ): Promise<RecordDoc[]> {
    return this.records.find(
      page.after ? { experimentId, _id: { $gt: page.after } } : { experimentId },
      { sort: { _id: 1 }, limit: page.limit },
    );
  }

  allRecords(experimentId: string): Promise<RecordDoc[]> {
    return this.records.find({ experimentId }, { sort: { _id: 1 } });
  }

  countRecords(experimentId: string): Promise<number> {
    return this.records.count({ experimentId });
  }

  insertFailure(doc: Omit<FailureDoc, 'orgId'>): Promise<void> {
    return this.failures.insertOne(doc);
  }

  listFailures(experimentId: string): Promise<FailureDoc[]> {
    return this.failures.find({ experimentId }, { sort: { _id: 1 }, limit: 5000 });
  }

  saveReport(experimentId: string, data: Record<string, unknown>, now: Date = new Date()): Promise<void> {
    return this.reports.insertOne({ _id: experimentId, createdAt: now, data });
  }

  getReport(experimentId: string): Promise<ReportDoc | null> {
    return this.reports.findOne({ _id: experimentId });
  }
}
