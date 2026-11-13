import { MongoClient, type Db } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { ScopedCollection } from '../src/db/scoped.js';

interface Doc {
  _id: string;
  orgId: string;
  note: string;
  n: number;
}

let client: MongoClient;
let db: Db;
let a: ScopedCollection<Doc>;
let b: ScopedCollection<Doc>;

beforeAll(async () => {
  client = new MongoClient(inject('mongoUri'));
  await client.connect();
  db = client.db(`scoped_${Date.now()}`);
  const col = db.collection<Doc>('docs');
  a = new ScopedCollection(col, 'org-a');
  b = new ScopedCollection(col, 'org-b');
  await a.insertOne({ _id: 'a1', note: 'secret of A', n: 1 });
  await b.insertOne({ _id: 'b1', note: 'secret of B', n: 1 });
});
afterAll(async () => {
  await db.dropDatabase();
  await client.close();
});

describe('ScopedCollection', () => {
  it('reads only its own organization', async () => {
    expect((await a.find({})).map((d) => d._id)).toEqual(['a1']);
    expect(await a.findOne({ _id: 'b1' })).toBeNull();
    expect(await a.count({})).toBe(1);
  });

  it('cannot be widened by a filter naming another organization', async () => {
    expect(await a.find({ orgId: 'org-b' })).toEqual([]);
    expect(await a.find({ $or: [{ orgId: 'org-b' }, { n: 1 }] })).toHaveLength(1);
    expect(await a.find({ $or: [{ orgId: 'org-b' }, { orgId: 'org-a' }] })).toHaveLength(1);
    expect(await a.find({ orgId: { $ne: 'org-a' } })).toEqual([]);
  });

  it('cannot update or delete another organization\u2019s documents', async () => {
    expect(await a.updateOne({ _id: 'b1' }, { $set: { note: 'hacked' } })).toBe(0);
    expect(await a.deleteOne({ _id: 'b1' })).toBe(0);
    expect(await a.deleteMany({ n: 1, orgId: 'org-b' })).toBe(0);
    expect((await b.findOne({ _id: 'b1' }))?.note).toBe('secret of B');
  });

  it('stamps its own organization on inserts, whatever the document claims', async () => {
    await a.insertOne({ _id: 'a2', note: 'x', n: 2, orgId: 'org-b' } as unknown as Omit<Doc, 'orgId'>);
    expect(await b.findOne({ _id: 'a2' })).toBeNull();
    expect((await a.findOne({ _id: 'a2' }))?.orgId).toBe('org-a');
  });

  it('refuses updates that touch orgId', async () => {
    await expect(a.updateOne({ _id: 'a1' }, { $set: { orgId: 'org-b' } })).rejects.toThrow(/orgId/);
    await expect(a.updateOne({ _id: 'a1' }, { $unset: { orgId: '' } })).rejects.toThrow(/orgId/);
  });

  it('requires an organization id', () => {
    expect(() => new ScopedCollection(client.db('x').collection<Doc>('y'), '')).toThrow();
  });
});
