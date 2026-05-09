#!/usr/bin/env tsx

import { loadConfig } from "../src/server/config.js";
import { FileStore } from "../src/storage/file-store.js";

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.databaseUrl) {
    console.log("TASKSMITH_DATABASE_URL is not set; no Postgres metadata index to sync.");
    return;
  }
  const store = new FileStore(config);
  try {
    await store.init();
    console.log("Postgres metadata index synced from file-backed TaskSmith state.");
  } finally {
    await store.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
