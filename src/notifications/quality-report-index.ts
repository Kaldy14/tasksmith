import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const REPORT_ID_PATTERN = /^run-[1-9][0-9]*-[1-9][0-9]*$/;

interface ReportCard {
  id: string;
  generatedAt: string;
  functional: {
    status: "passed" | "failed" | "error";
    total: number;
    failed: number;
  };
  visual: {
    status: "unchanged" | "changed" | "error";
    total: number;
    changed: number;
    errors: number;
  };
  screenshots: string[];
}

export async function rebuildQualityReportIndex(
  reportsDir: string,
): Promise<number> {
  await mkdir(reportsDir, { recursive: true });
  const entries = await readdir(reportsDir, { withFileTypes: true });
  const reports = (
    await Promise.all(
      entries
        .filter(
          (entry) => entry.isDirectory() && REPORT_ID_PATTERN.test(entry.name),
        )
        .map((entry) => readReportCard(reportsDir, entry.name)),
    )
  )
    .filter((report): report is ReportCard => report !== undefined)
    .sort((left, right) => right.generatedAt.localeCompare(left.generatedAt));

  const tempPath = path.join(reportsDir, `.index-${randomUUID()}.html`);
  try {
    await writeFile(tempPath, renderIndex(reports), "utf8");
    await rename(tempPath, path.join(reportsDir, "index.html"));
  } finally {
    await rm(tempPath, { force: true });
  }
  return reports.length;
}

async function readReportCard(
  reportsDir: string,
  reportId: string,
): Promise<ReportCard | undefined> {
  try {
    const reportDir = path.join(reportsDir, reportId);
    const summary = parseSummary(
      JSON.parse(
        await readFile(path.join(reportDir, "summary.json"), "utf8"),
      ) as unknown,
    );
    const screenshotsDir = path.join(reportDir, "screenshots");
    let screenshots: string[] = [];
    try {
      screenshots = (await readdir(screenshotsDir, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith(".png"))
        .map((entry) => entry.name)
        .sort()
        .slice(0, 4);
    } catch {
      screenshots = [];
    }
    return { id: reportId, ...summary, screenshots };
  } catch {
    return undefined;
  }
}

function parseSummary(value: unknown): Omit<ReportCard, "id" | "screenshots"> {
  const record = expectRecord(value, "summary");
  const functional = expectRecord(record.functional, "functional");
  const visual = expectRecord(record.visual, "visual");
  const generatedAt = requiredString(record.generatedAt, "generatedAt");
  if (Number.isNaN(Date.parse(generatedAt))) {
    throw new Error("generatedAt must be an ISO date");
  }
  return {
    generatedAt,
    functional: {
      status: enumValue(
        functional.status,
        ["passed", "failed", "error"],
        "functional.status",
      ),
      total: nonNegativeInteger(functional.total, "functional.total"),
      failed: nonNegativeInteger(functional.failed, "functional.failed"),
    },
    visual: {
      status: enumValue(
        visual.status,
        ["unchanged", "changed", "error"],
        "visual.status",
      ),
      total: nonNegativeInteger(visual.total, "visual.total"),
      changed: nonNegativeInteger(visual.changed, "visual.changed"),
      errors: nonNegativeInteger(visual.errors, "visual.errors"),
    },
  };
}

function renderIndex(reports: ReportCard[]): string {
  const cards =
    reports.length > 0
      ? reports.map(renderReportCard).join("\n")
      : `<section class="empty">
  <h2>Zatím tu není žádný audit</h2>
  <p>První report se objeví po dokončení naplánovaného nebo ručního běhu.</p>
</section>`;

  return `<!doctype html>
<html lang="cs">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Hive Admin quality historie</title>
  <style>
    :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; background: #0c111b; color: #ecf2ff; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    main { width: min(1440px, calc(100% - 32px)); margin: 0 auto; padding: 48px 0 72px; }
    header { margin-bottom: 30px; }
    h1 { margin: 0 0 8px; font-size: clamp(32px, 5vw, 52px); letter-spacing: -0.045em; }
    h2 { margin: 0; font-size: 20px; }
    p { margin: 0; color: #98a8c2; }
    .reports { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 22px; }
    .report { overflow: hidden; background: #151d2b; border: 1px solid #26344a; border-radius: 18px; }
    .preview { display: grid; grid-template-columns: repeat(2, 1fr); height: 300px; background: #fff; }
    .preview img { display: block; width: 100%; height: 150px; object-fit: contain; border: 1px solid #e7e9ee; background: #fff; }
    .placeholder { display: grid; place-items: center; height: 300px; color: #61708a; background: #101724; }
    .body { padding: 20px; }
    .heading { display: flex; justify-content: space-between; gap: 16px; align-items: start; margin-bottom: 18px; }
    .meta { margin-top: 5px; font-size: 14px; }
    .badge { flex: none; padding: 6px 10px; border-radius: 999px; font-size: 12px; font-weight: 800; }
    .ok { color: #58d68d; background: #163a2a; }
    .warning { color: #ffca5c; background: #443516; }
    .danger { color: #ff8585; background: #461f25; }
    .stats { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 18px; }
    .stat { padding: 12px; border: 1px solid #26344a; border-radius: 12px; }
    .stat strong { display: block; margin-bottom: 3px; }
    .actions { display: flex; flex-wrap: wrap; gap: 10px; }
    .actions a { padding: 10px 13px; border-radius: 9px; color: #0c111b; background: #dce8ff; text-decoration: none; font-weight: 800; }
    .actions a.secondary { color: #dce8ff; background: #26344a; }
    .empty { padding: 32px; border: 1px solid #26344a; border-radius: 18px; }
    .empty h2 { margin-bottom: 8px; }
    @media (max-width: 520px) { .reports { grid-template-columns: 1fr; } .preview { height: 220px; } .preview img { height: 110px; } .stats { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Hive Admin quality historie</h1>
      <p>Posledních 7 dní · ${reports.length} ${reports.length === 1 ? "audit" : "auditů"} · nejnovější první</p>
    </header>
    <section class="reports">${cards}</section>
  </main>
</body>
</html>
`;
}

function renderReportCard(report: ReportCard): string {
  const attention =
    report.functional.status !== "passed" ||
    report.visual.status !== "unchanged";
  const badgeTone =
    report.functional.status !== "passed"
      ? "danger"
      : report.visual.status === "changed"
        ? "warning"
        : report.visual.status === "error"
          ? "danger"
          : "ok";
  const badgeText = attention ? "Prověřit" : "Beze změn";
  const reportPath = `./${encodeURIComponent(report.id)}`;
  const previews =
    report.screenshots.length > 0
      ? `<div class="preview">${report.screenshots
          .map(
            (filename) =>
              `<img src="${reportPath}/screenshots/${encodeURIComponent(filename)}" alt="" loading="lazy">`,
          )
          .join("")}</div>`
      : '<div class="placeholder">Tento starší běh nemá náhledy</div>';
  const screenshotsAction =
    report.screenshots.length > 0
      ? `<a href="${reportPath}/screenshots/index.html">Screenshoty</a>`
      : "";

  return `<article class="report">
  ${previews}
  <div class="body">
    <div class="heading">
      <div>
        <h2>${escapeHtml(formatDate(report.generatedAt))}</h2>
        <p class="meta">${escapeHtml(report.id)}</p>
      </div>
      <span class="badge ${badgeTone}">${badgeText}</span>
    </div>
    <div class="stats">
      <div class="stat"><strong>Funkční E2E</strong><p>${escapeHtml(report.functional.status)} · ${report.functional.failed}/${report.functional.total} selhalo</p></div>
      <div class="stat"><strong>Vizuální kontrola</strong><p>${escapeHtml(report.visual.status)} · ${report.visual.changed} změn · ${report.visual.errors} chyb</p></div>
    </div>
    <nav class="actions">
      ${screenshotsAction}
      <a class="secondary" href="${reportPath}/index.html">Celý report</a>
    </nav>
  </div>
</article>`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("cs-CZ", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Prague",
  }).format(new Date(value));
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${label} has an unsupported value`);
  }
  return value;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character] ?? character,
  );
}
