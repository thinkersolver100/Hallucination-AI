import type {
  Collection,
  Filter,
  OptionalUnlessRequiredId,
  Sort,
  UpdateFilter,
  WithId,
} from 'mongodb';

type Owned = { _id: string; orgId: string };

const UPDATE_OPERATORS = ['$set', '$unset', '$setOnInsert', '$inc', '$rename', '$min', '$max'];

function touchesOrgId(update: object): boolean {
  return Object.entries(update).some(
    ([op, fields]) =>
      UPDATE_OPERATORS.includes(op) &&
      typeof fields === 'object' &&
      fields !== null &&
      'orgId' in fields,
  );
}

/**
 * The only way application code reaches tenant data. Every read, update and delete is wrapped
 * as {$and: [filter, {orgId}]}, so a filter cannot widen the scope, not even with $or. Inserts
 * stamp the organization last, so a document cannot claim another organization.
 */
export class ScopedCollection<T extends Owned> {
  constructor(
    private readonly col: Collection<T>,
    readonly orgId: string,
  ) {
    if (!orgId) throw new Error('orgId is required');
  }

  private scope(filter: Filter<T> = {}): Filter<T> {
    return { $and: [filter, { orgId: this.orgId }] } as Filter<T>;
  }

  async insertOne(doc: Omit<T, 'orgId'>): Promise<void> {
    await this.col.insertOne({ ...doc, orgId: this.orgId } as OptionalUnlessRequiredId<T>);
  }

  async insertMany(docs: Omit<T, 'orgId'>[]): Promise<void> {
    if (docs.length === 0) return;
    await this.col.insertMany(
      docs.map((d) => ({ ...d, orgId: this.orgId })) as OptionalUnlessRequiredId<T>[],
    );
  }

  findOne(filter: Filter<T>): Promise<WithId<T> | null> {
    return this.col.findOne(this.scope(filter));
  }

  find(
    filter: Filter<T>,
    options: { sort?: Sort; limit?: number; skip?: number } = {},
  ): Promise<WithId<T>[]> {
    let cursor = this.col.find(this.scope(filter));
    if (options.sort) cursor = cursor.sort(options.sort);
    if (options.skip) cursor = cursor.skip(options.skip);
    if (options.limit) cursor = cursor.limit(options.limit);
    return cursor.toArray();
  }

  count(filter: Filter<T> = {}): Promise<number> {
    return this.col.countDocuments(this.scope(filter));
  }

  async updateOne(filter: Filter<T>, update: UpdateFilter<T>): Promise<number> {
    if (touchesOrgId(update)) throw new Error('updates may not change orgId');
    const result = await this.col.updateOne(this.scope(filter), update);
    return result.matchedCount;
  }

  async deleteOne(filter: Filter<T>): Promise<number> {
    return (await this.col.deleteOne(this.scope(filter))).deletedCount;
  }

  async deleteMany(filter: Filter<T>): Promise<number> {
    return (await this.col.deleteMany(this.scope(filter))).deletedCount;
  }
}
