import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureConfig } from "../src/core/config.js";
import { DEMO_CASE_ID, seedDemo } from "../src/core/demo.js";
import { buildReportData, renderReportHtml, writeReport } from "../src/core/report.js";
import { Store } from "../src/core/store.js";

const roots: string[] = [];

function makeStore(): { root: string; home: string; store: Store } {
  const root = mkdtempSync(path.join(process.cwd(), ".envidence", "vitest-report-"));
  roots.push(root);
  const seed = seedDemo(root, { reset: true });
  const store = new Store(seed.home);
  ensureConfig(seed.home);
  return { root, home: seed.home, store };
}

const FAKE_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz012345";

function withSecretFinding(store: Store): void {
  const record = store.getCase(DEMO_CASE_ID);
  if (!record) throw new Error("demo case missing");
  const first = record.findings[0];
  if (!first) throw new Error("demo finding missing");
  record.findings = [
    {
      ...first,
      before: { secret: true, preview: "raw-secret-preview", hash: "abc" },
      after: { secret: true, value: "raw-secret-value" },
    },
    ...record.findings.slice(1),
  ];
  record.summary = `${record.summary} leaked token ${FAKE_TOKEN}`;
  store.saveCase(record);

  const run = store.getRun(record.runId);
  if (run) {
    run.command = `${run.command} --token ${FAKE_TOKEN}`;
    run.stderrTail = `${run.stderrTail ?? ""}\nAuthorization: Bearer ${FAKE_TOKEN}`;
    store.saveRun(run);
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("HTML case report", () => {
  it("builds a self-contained, redacted report with no raw secrets", () => {
    const { home, store } = makeStore();
    try {
      withSecretFinding(store);
      const data = buildReportData(store, ensureConfig(home), {
        caseRef: DEMO_CASE_ID,
        redaction: "standard",
        home,
      });
      const html = renderReportHtml(data);
      const serialized = JSON.stringify(data);

      expect(data.case?.id).toBe(DEMO_CASE_ID);
      expect(data.findings).toHaveLength(2);
      expect(serialized).not.toContain("raw-secret-preview");
      expect(serialized).not.toContain("raw-secret-value");
      expect(serialized).not.toContain(FAKE_TOKEN);
      expect(html).not.toContain(FAKE_TOKEN);
      expect(serialized).not.toContain("C:\\\\Users\\\\demo");
      expect(serialized).not.toContain("atlas-dev");
      expect(serialized).toContain("<redacted>");
      expect(html).toContain("<!doctype html>");
      expect(html).toContain("Generated locally. No data left this machine.");
      expect(html).not.toContain("<script src=");
      expect(html).not.toContain("http://");
      expect(html).toContain("envidence-data");
    } finally {
      store.close();
    }
  });

  it("supports strict redaction and none with a warning", () => {
    const { home, store } = makeStore();
    try {
      withSecretFinding(store);
      const config = ensureConfig(home);
      const standard = buildReportData(store, config, {
        caseRef: DEMO_CASE_ID,
        redaction: "standard",
        home,
      });
      const strict = buildReportData(store, config, {
        caseRef: DEMO_CASE_ID,
        redaction: "strict",
        home,
      });
      const none = buildReportData(store, config, {
        caseRef: DEMO_CASE_ID,
        redaction: "none",
        home,
      });
      expect(JSON.stringify(standard)).toContain("<home>\\\\AppData");
      expect(JSON.stringify(strict)).not.toContain("C:\\\\Users\\\\demo");
      expect(JSON.stringify(strict)).not.toContain("atlas-dev");
      expect(JSON.stringify(none)).toContain("C:\\\\Users\\\\demo");
      expect(JSON.stringify(none)).not.toContain(FAKE_TOKEN);
      expect(renderReportHtml(none)).toContain("Unredacted local report");
      expect(renderReportHtml(none)).toContain("redaction: none");
    } finally {
      store.close();
    }
  });

  it("writes the report to disk", () => {
    const { root, home, store } = makeStore();
    try {
      const data = buildReportData(store, ensureConfig(home), {
        caseRef: DEMO_CASE_ID,
        redaction: "standard",
        home,
      });
      const file = path.join(root, "case.html");
      const result = writeReport(file, data);
      expect(result.bytes).toBeGreaterThan(2_000);
      const html = readFileSync(file, "utf8");
      expect(html).toContain("<!doctype html>");
      expect(html.length).toBeGreaterThan(2_000);
    } finally {
      store.close();
    }
  });
});
