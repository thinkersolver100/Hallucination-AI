import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
  }
}

/**
 * Starts one MongoDB for the whole run. Set TEST_MONGO_URI to use a MongoDB you already have
 * (for example in Docker); otherwise mongodb-memory-server downloads and starts one.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const existing = process.env['TEST_MONGO_URI'];
  if (existing) {
    project.provide('mongoUri', existing);
    return async () => {};
  }
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  const server = await MongoMemoryServer.create();
  project.provide('mongoUri', server.getUri());
  return async () => {
    await server.stop();
  };
}
