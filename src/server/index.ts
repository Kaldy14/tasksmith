import { loadConfig } from "./config.js";
import { FileStore } from "../storage/file-store.js";
import { EventHub } from "./event-hub.js";
import { RuntimeManager } from "../runtime/runtime-manager.js";
import { DeterministicVerifier } from "../verifier/deterministic-verifier.js";
import { createTaskSmithServer } from "./http.js";

const config = loadConfig();
const store = new FileStore(config);
await store.init();
await store.markActiveRunsFailedOnBoot();
const hub = new EventHub();
const verifier = new DeterministicVerifier(config.verificationCommands);
const runtime = new RuntimeManager(store, hub, verifier);
const server = createTaskSmithServer({ config, store, runtime, hub });

server.listen(config.port, config.host, () => {
  console.log(`TaskSmith listening on http://${config.host}:${config.port}`);
  console.log(`Data dir: ${config.dataDir}`);
});

function shutdown(): void {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
