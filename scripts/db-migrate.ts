#!/usr/bin/env tsx

import { loadConfig } from "../src/server/config.js";
import { PostgresMetadataIndex } from "../src/storage/postgres-metadata-index.js";

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.databaseUrl) {
    console.log("TASKSMITH_DATABASE_URL is not set; no Postgres app database to migrate.");
    return;
  }
  const index = new PostgresMetadataIndex(config.databaseUrl);
  try {
    await index.init();
    console.log("Postgres app database migrations applied.");
  } finally {
    await index.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
