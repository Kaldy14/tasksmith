import { loadConfig } from "./config.js";
import { PullRequestDelivery } from "../delivery/pull-request-delivery.js";
import { FileStore } from "../storage/file-store.js";
import { EventHub } from "./event-hub.js";
import { FreshContextReviewer } from "../review/fresh-context-reviewer.js";
import { RuntimeManager } from "../runtime/runtime-manager.js";
import { DeterministicVerifier } from "../verifier/deterministic-verifier.js";
import { SourcePoller } from "../sources/source-poller.js";
import { createTaskSmithServer } from "./http.js";

const config = loadConfig();
const store = new FileStore(config);
await store.init();
await store.markActiveRunsFailedOnBoot();
const hub = new EventHub();
const verifier = new DeterministicVerifier(config.verification, config.repositories);
const reviewer = new FreshContextReviewer();
const delivery = new PullRequestDelivery(config, store);
const runtime = new RuntimeManager(store, hub, verifier, reviewer, delivery, config.repositories, config.workflow);
const sourcePoller = new SourcePoller(config, store, runtime);
if (process.env.TASKSMITH_SOURCE_POLLING === "1" || process.env.TASKSMITH_SOURCE_POLLING === "true") {
  startSourcePolling(sourcePoller, config.sourceFlow.pollIntervalSeconds);
}
const server = createTaskSmithServer({ config, store, runtime, sourcePoller, hub });

server.listen(config.port, config.host, () => {
  console.log(`TaskSmith listening on http://${config.host}:${config.port}`);
  console.log(`Data dir: ${config.dataDir}`);
});

function startSourcePolling(sourcePoller: SourcePoller, intervalSeconds: number): void {
  let inFlight = false;
  const poll = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      const result = await sourcePoller.pollOnce();
      if (result.errors.length > 0) console.error("TaskSmith source poll errors", JSON.stringify(result.errors));
    } catch (error: unknown) {
      console.error("TaskSmith source poll failed", error);
    } finally {
      inFlight = false;
    }
  };
  const interval = setInterval(() => void poll(), Math.max(5, intervalSeconds) * 1000);
  interval.unref();
  void poll();
}

function shutdown(): void {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
