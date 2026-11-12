import { MongoClient, type Db } from "mongodb";
import { env } from "../config/env.js";

const client = new MongoClient(env.MONGODB_URI);

let database: Db;

export async function connectDatabase(): Promise<void> {
  await client.connect();
  database = client.db(env.MONGODB_DB);
  console.log(`MongoDB connected successfully: ${env.MONGODB_DB}`);
}

export function getDatabase(): Db {
  if (!database) {
    throw new Error("Database is not connected");
  }

  return database;
}

export async function closeDatabase(): Promise<void> {
  await client.close();
  console.log("MongoDB connection closed");
}
