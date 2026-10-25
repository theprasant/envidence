import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { seedDemo, DEMO_CASE_ID } from "../src/core/demo.js";
import { startUiServer, type UiServer } from "../src/server/ui.js";

const roots: string[] = [];
const servers: UiServer[] = [];

function fixture(): { root: string; home: string; uiDir: string } {
  const root = mkdtempSync(path.join(process.cwd(), ".envidence", "vitest-ui-"));
  roots.push(root);
  const seed = seedDemo(root, { reset: true });
  const uiDir = path.join(root, "ui");
  mkdirSync(uiDir, { recursive: true });
  writeFileSync(
    path.join(uiDir, "index.html"),
    '<!doctype html><html><body><div id="root"></div><script>/* fixture */</script></body></html>',
    "utf8",
  );
  return { root, home: seed.home, uiDir };
}

async function start(): Promise<{ ui: UiServer; home: string; root: string }> {
  const data = fixture();
  const ui = await startUiServer({
    home: data.home,
    port: 0,
    token: "test-session-token",
    uiDir: data.uiDir,
  });
  servers.push(ui);
  return { ui, home: data.home, root: data.root };
}

function headers(ui: UiServer, extra: Record<string, string> = {}): Record<string, string> {
  return { "X-Envidence-Token": ui.token, ...extra };
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("local dashboard server", () => {
  it("serves the UI shell and token-protected API on 127.0.0.1", async () => {
    const { ui } = await start();
    const base = `http://127.0.0.1:${ui.port}`;

    const shell = await fetch(`${base}/`);
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain('<div id="root">');
    expect(shell.headers.get("content-security-policy")).toContain("default-src 'self'");

    const rejected = await fetch(`${base}/api/bootstrap`);
    expect(rejected.status).toBe(401);

    const accepted = await fetch(`${base}/api/bootstrap`, { headers: headers(ui) });
    expect(accepted.status).toBe(200);
    const bootstrap = (await accepted.json()) as {
      cases: Array<{ id: string; topFinding: { title: string } | null }>;
      store: { home: string };
      product: { name: string };
    };
    expect(bootstrap.product.name).toBe("Envidence");
    expect(bootstrap.store.home).toBe(ui.home);
    expect(bootstrap.cases.some((record) => record.id === DEMO_CASE_ID)).toBe(true);

    const detailResponse = await fetch(
      `${base}/api/cases/${encodeURIComponent(DEMO_CASE_ID)}`,
      { headers: headers(ui) },
    );
    expect(detailResponse.status).toBe(200);
    const detail = (await detailResponse.json()) as {
      case: { id: string };
      findings: Array<{ title: string; score: number }>;
      changes: unknown[];
      fingerprint: string;
    };
    expect(detail.case.id).toBe(DEMO_CASE_ID);
    expect(detail.findings[0]?.title).toBe("Global npm package typescript changed");
    expect(detail.findings[0]?.score).toBe(72);
    expect(detail.changes.length).toBeGreaterThan(0);
    expect(detail.fingerprint).toMatch(/^EV-/);
  });

  it("blocks traversal and POSTs from a foreign origin", async () => {
    const { ui } = await start();
    const base = `http://127.0.0.1:${ui.port}`;

    const traversal = await fetch(`${base}/..%2Fpackage.json`);
    expect(traversal.status).toBe(404);

    const noOrigin = await fetch(`${base}/api/rollback/apply`, {
      method: "POST",
      headers: { ...headers(ui), "Content-Type": "application/json" },
      body: JSON.stringify({ planId: "RB-X", confirmation: "rollback" }),
    });
    expect(noOrigin.status).toBe(403);

    const invalidConfirmation = await fetch(`${base}/api/rollback/apply`, {
      method: "POST",
      headers: {
        ...headers(ui),
        "Content-Type": "application/json",
        Origin: base,
      },
      body: JSON.stringify({ planId: "RB-X", confirmation: "nope" }),
    });
    expect(invalidConfirmation.status).toBe(400);
  });

  it("builds a read-only rollback plan and a redacted report", async () => {
    const { ui } = await start();
    const base = `http://127.0.0.1:${ui.port}`;

    const planResponse = await fetch(
      `${base}/api/rollback/plan?case=${encodeURIComponent(DEMO_CASE_ID)}`,
      { headers: headers(ui) },
    );
    expect(planResponse.status).toBe(200);
    const plan = (await planResponse.json()) as {
      plan: { actions: Array<{ title: string }>; manual: string[] };
    };
    expect(plan.plan.actions.map((action) => action.title)).toContain(
      "Install npm package typescript@5.9.2",
    );

    const reportResponse = await fetch(
      `${base}/api/report?case=${encodeURIComponent(DEMO_CASE_ID)}&redact=standard`,
      { headers: headers(ui) },
    );
    expect(reportResponse.status).toBe(200);
    expect(reportResponse.headers.get("content-disposition")).toContain("attachment");
    const html = await reportResponse.text();
    expect(html).toContain("<!doctype html>");
    expect(html).toContain(DEMO_CASE_ID);
    expect(html).toContain("Generated locally");
    expect(html).not.toContain("C:\\Users\\demo");
  });
});
