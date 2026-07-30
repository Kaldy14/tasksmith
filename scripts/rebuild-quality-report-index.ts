import path from "node:path";
import { rebuildQualityReportIndex } from "../src/notifications/quality-report-index.js";

const directoryArgument = process.argv.slice(2).find((argument) => argument !== "--");
const reportsDir = path.resolve(
  directoryArgument ??
    process.env.TASKSMITH_QUALITY_REPORTS_DIR ??
    "/opt/tasksmith/data/quality-reports",
);
const count = await rebuildQualityReportIndex(reportsDir);
console.log(`quality report index rebuilt: ${count} reports`);
