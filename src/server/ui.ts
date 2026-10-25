import { timingSafeEqual, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureConfig } from "../core/config.js";
import { fingerprintSnapshot } from "../core/fingerprint.js";
import { buildReportData, renderReportHtml, type ReportRedaction } from "../core/report.js";
import { diffSnapshots } from "../core/diff.js";
import { RealEnvironmentAdapter } from "../core/adapters.js";
import { applyRollbackPlan, buildRollbackPlan, parseOnly, preflightPlan } from "../core/rollback.js";
import { explainRun } from "../core/run.js";
import { createSnapshot } from "../core/snapshot.js";
import { Store } from "../core/store.js";
import type {
  BaselineRecord,
  CaseRecord,
  Change,
  Config,
  RollbackPlan,
  RollbackRecord,
  RunRecord,
  SnapshotMeta,
} from "../core/types.js";

export type UiServerOptions = {
  home: string;
  port?: number;
  token?: string;
  uiDir?: string;
};

export type UiServer = {
  server: Server;
  port: number;
  token: string;
  url: string;
  home: string;
  close: () => Promise<void>;
};

type PlanCacheEntry = {
  plan: RollbackPlan;
  at: number;
  used: boolean;
};

const PLAN_TTL_MS = 30 * 60_000;
const BODY_LIMIT = 64 * 1024;
const PACKAGE_VERSION = readPackageVersion();

export async function startUiServer(options: UiServerOptions): Promise<UiServer> {
  const home = path.resolve(options.home);
  const config = ensureConfig(home);
  const store = new Store(home);
  const token = options.token ?? randomBytes(24).toString("hex");
  const uiDir = path.resolve(options.uiDir ?? defaultUiDir());
  const plans = new Map<string, PlanCacheEntry>();

  let server: Server | null = null;
  let port = 0;
  const handler = createHandler({
    home,
    config,
    store,
    token,
    uiDir,
    plans,
    getPort: () => port,
  });
  server = createServer((request, response) => {
    handler(request, response).catch((error: unknown) => {
      if (!response.headersSent) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
      } else {
        response.end();
      }
    });
  });

  try {
    port = await listen(server, options.port ?? config.ui.port ?? 4317);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EADDRINUSE") {
      store.close();
      throw error;
    }
    port = await listen(server, 0);
  }

  const displayHost = "127.0.0.1";
  return {
    server,
    port,
    token,
    home,
    url: `http://${displayHost}:${port}/#token=${token}`,
    close: async () => {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      store.close();
    },
  };
}

function createHandler(context: {
  home: string;
  config: Config;
  store: Store;
  token: string;
  uiDir: string;
  plans: Map<string, PlanCacheEntry>;
  getPort: () => number;
}): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const { store, config, token, uiDir, plans } = context;

  return async (request, response) => {
    setSecurityHeaders(response);
    const method = request.method ?? "GET";
    const requestUrl = new URL(request.url ?? "/", `http://127.0.0.1:${context.getPort()}`);
    const host = request.headers.host ?? "";
    const expectedHost = `127.0.0.1:${context.getPort()}`;
    if (host !== expectedHost && host !== `localhost:${context.getPort()}`) {
      sendJson(response, 421, { error: "Unexpected host." });
      return;
    }

    let pathname: string;
    try {
      pathname = decodeURIComponent(requestUrl.pathname);
    } catch {
      sendJson(response, 400, { error: "Malformed path." });
      return;
    }
    if (pathname.includes("\0")) {
      sendJson(response, 400, { error: "Malformed path." });
      return;
    }

    if (pathname.startsWith("/api/")) {
      if (!tokenMatches(token, request.headers["x-envidence-token"])) {
        sendJson(response, 401, { error: "Missing or invalid session token." });
        return;
      }
      if (method === "POST") {
        const origin = request.headers.origin;
        const expectedOrigin = `http://127.0.0.1:${context.getPort()}`;
        if (!origin || (origin !== expectedOrigin && origin !== `http://localhost:${context.getPort()}`)) {
          sendJson(response, 403, { error: "POST requires a same-origin request." });
          return;
        }
      }
      await handleApi(context, request, response, pathname, requestUrl, method);
      return;
    }

    if (method !== "GET" && method !== "HEAD") {
      sendJson(response, 405, { error: "Method not allowed." });
      return;
    }
    if (pathname === "/favicon.ico") {
      response.writeHead(204).end();
      return;
    }
    const file =
      pathname === "/" || pathname === "/index.html"
        ? path.join(uiDir, "index.html")
        : safeStaticPath(uiDir, pathname);
    if (!file || !existsSync(file)) {
      if (pathname === "/" || pathname === "/index.html") {
        sendHtml(
          response,
          500,
          "<!doctype html><meta charset=utf-8><body style=\"font:16px system-ui;padding:40px;max-width:780px;margin:auto\"><h1>Envidence UI is not built</h1><p>Run <code>npm run build:ui</code> and restart <code>evd ui</code>.</p></body>",
        );
      } else {
        sendJson(response, 404, { error: "Not found." });
      }
      return;
    }
    const body = readFileSync(file);
    response.writeHead(200, {
      "Content-Type": contentType(file),
      "Content-Length": body.length,
      "Cache-Control": "no-store",
    });
    response.end(method === "HEAD" ? undefined : body);
  };
}

async function handleApi(
  context: {
    home: string;
    config: Config;
    store: Store;
    plans: Map<string, PlanCacheEntry>;
  },
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  url: URL,
  method: string,
): Promise<void> {
  const { store, config, plans } = context;
  if (method === "GET" && pathname === "/api/bootstrap") {
    sendJson(response, 200, bootstrap(store, config, context.home));
    return;
  }
  if (method === "GET" && pathname === "/api/baselines") {
    sendJson(response, 200, { baselines: store.listBaselines(100) });
    return;
  }
  if (method === "GET" && pathname === "/api/runs") {
    sendJson(response, 200, { runs: store.listRuns(100) });
    return;
  }
  if (method === "GET" && pathname.startsWith("/api/cases/")) {
    const ref = pathname.slice("/api/cases/".length);
    sendJson(response, 200, caseDetail(store, config, ref));
    return;
  }
  if (method === "GET" && pathname.startsWith("/api/snapshots/")) {
    const ref = pathname.slice("/api/snapshots/".length);
    sendJson(response, 200, snapshotDetail(store, ref));
    return;
  }
  if (method === "GET" && pathname === "/api/diff") {
    const a = store.getSnapshot(url.searchParams.get("a") ?? "");
    const b = store.getSnapshot(url.searchParams.get("b") ?? "");
    sendJson(response, 200, {
      a: a.id,
      b: b.id,
      changes: diffSnapshots(a, b, { config, origin: "observed-during" }),
    });
    return;
  }
  if (method === "GET" && pathname === "/api/report") {
    const redaction = parseReportRedaction(url.searchParams.get("redact"));
    const data = buildReportData(store, config, {
      caseRef: url.searchParams.get("case") ?? undefined,
      runRef: url.searchParams.get("run") ?? undefined,
      redaction,
      home: context.home,
    });
    const html = renderReportHtml(data);
    const name = `envidence-${(data.case?.id ?? data.run.id).replace(/[^A-Za-z0-9._-]/g, "-")}.html`;
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    });
    response.end(html);
    return;
  }
  if (method === "GET" && pathname === "/api/rollback/plan") {
    const plan = buildRollbackPlan(store, config, {
      caseRef: url.searchParams.get("case") ?? undefined,
      runRef: url.searchParams.get("run") ?? undefined,
      toRef: url.searchParams.get("to") ?? undefined,
      changeSignature: url.searchParams.get("change") ?? undefined,
      only: parseOnly(url.searchParams.get("only") ?? undefined),
    });
    cleanupPlans(plans);
    plans.set(plan.id, { plan, at: Date.now(), used: false });
    sendJson(response, 200, { plan });
    return;
  }
  if (method === "POST" && pathname === "/api/rollback/apply") {
    const body = await readJsonBody(request);
    const planId = typeof body.planId === "string" ? body.planId : "";
    const confirmation = typeof body.confirmation === "string" ? body.confirmation : "";
    if (confirmation !== "rollback") {
      sendJson(response, 400, {
        error: 'Confirmation is required. Send {"confirmation":"rollback"}.',
      });
      return;
    }
    const cached = plans.get(planId);
    if (!cached || cached.used) {
      sendJson(response, 409, {
        error: "Preview a rollback plan in this session before applying it.",
      });
      return;
    }
    cached.used = true;
    const plan = cached.plan;
    let safety: SnapshotMeta | null = null;
    if (config.rollback.safetySnapshot) {
      const snapshot = await createSnapshot({
        store,
        config,
        cwd: process.cwd(),
        profile: "full",
        trigger: "pre_rollback",
        label: `Before dashboard rollback ${plan.id}`,
      });
      safety = store.saveSnapshot(snapshot, { durationMs: 0, pinned: true });
    }
    const record: RollbackRecord = {
      id: plan.id,
      createdAt: plan.createdAt,
      caseId: plan.caseId,
      runId: plan.runId,
      plan,
      status: "planned",
      safetySnapshot: safety?.id ?? null,
      log: [],
    };
    const adapter = new RealEnvironmentAdapter(store);
    const conflicts = await preflightPlan(plan, adapter);
    if (conflicts.length > 0) {
      record.status = "failed";
      record.log = conflicts.map((conflict) => ({
        actionId: conflict.actionId,
        status: "failed" as const,
        message: conflict.message,
        at: Date.now(),
      }));
      store.saveRollback(record);
      if (plan.caseId) store.setCaseRollback(plan.caseId, record.id);
      store.logEvent("rollback.preflight_conflict", {
        rollback: record.id,
        conflicts: conflicts.map((conflict) => conflict.message),
      });
      sendJson(response, 409, { error: "Preconditions changed. No actions were applied.", conflicts, record });
      return;
    }
    store.saveRollback(record);
    const result = await applyRollbackPlan(plan, adapter);
    record.status = result.status;
    record.log = result.log;
    store.saveRollback(record);
    if (plan.caseId) store.setCaseRollback(plan.caseId, record.id);
    store.logEvent("rollback.apply", {
      rollback: record.id,
      caseId: plan.caseId,
      status: record.status,
      safetySnapshot: safety?.id ?? null,
      source: "ui",
    });
    sendJson(response, record.status === "applied" ? 200 : 500, { record });
    return;
  }
  sendJson(response, 404, { error: "Not found." });
}

function bootstrap(
  store: Store,
  config: Config,
  home: string,
): Record<string, unknown> {
  const cases = store.listCases(100);
  const runs = store.listRuns(100);
  const snapshots = store.listSnapshots(100);
  const baselines = store.listBaselines(100);
  const casesByRun = new Map(cases.map((record) => [record.runId, record]));
  const activeBaseline = store.getActiveBaseline();
  const latest = snapshots[0] ?? null;
  let baselineDrift: number | null = null;
  if (activeBaseline && latest) {
    try {
      const baselineSnapshot = store.getSnapshot(activeBaseline.snapshotId);
      const latestSnapshot = store.getSnapshot(latest.id);
      baselineDrift = diffSnapshots(baselineSnapshot, latestSnapshot, {
        config,
        origin: "pre-existing",
      }).filter((change) => !change.volatile).length;
    } catch {
      baselineDrift = null;
    }
  }
  const events: Array<Record<string, unknown>> = [];
  for (const snapshot of snapshots) {
    events.push({
      type: "snapshot",
      at: snapshot.createdAt,
      id: snapshot.id,
      label: snapshot.label,
      trigger: snapshot.trigger,
      profile: snapshot.profile,
      warnings: snapshot.warnings.length,
    });
  }
  for (const run of runs) {
    events.push({
      type: "run",
      at: run.startedAt,
      id: run.id,
      command: run.command,
      exitCode: run.exitCode,
      durationMs: run.durationMs,
      caseId: casesByRun.get(run.id)?.id ?? null,
    });
  }
  for (const record of cases) {
    events.push({
      type: "case",
      at: record.createdAt,
      id: record.id,
      title: record.title,
      status: record.status,
      topFinding: record.findings[0]?.title ?? null,
      score: record.findings[0]?.score ?? null,
    });
  }
  for (const baseline of baselines) {
    events.push({
      type: "baseline",
      at: baseline.createdAt,
      id: baseline.id,
      label: baseline.label,
      snapshotId: baseline.snapshotId,
      active: baseline.active,
    });
  }
  events.sort((a, b) => Number(b.at) - Number(a.at));
  return {
    product: {
      name: "Envidence",
      version: PACKAGE_VERSION,
      tagline: "The black box for your dev machine.",
      schemaVersion: 1,
    },
    store: {
      home,
      stats: store.getStats(),
      latestSnapshot: latest,
      activeBaseline,
      baselineDrift,
      config: publicConfig(config),
    },
    cases: cases.map((record) => caseSummary(record)),
    runs: runs.map((run) => runSummary(run, casesByRun.get(run.id) ?? null)),
    snapshots,
    baselines: baselines.map((record) => ({
      ...record,
      active: record.active || record.id === activeBaseline?.id,
    })),
    rollbacks: store.listRollbacks(30),
    events: events.slice(0, 150),
  };
}

function caseDetail(store: Store, config: Config, ref: string): Record<string, unknown> {
  const caseRecord = store.getCase(ref);
  if (!caseRecord) throw new Error(`Case not found: ${ref}`);
  const run = store.getRun(caseRecord.runId);
  if (!run) throw new Error(`Run for case ${caseRecord.id} is missing.`);
  const explanation = explainRun(store, config, run, { includeVolatile: true });
  const findings = caseRecord.findings.length > 0 ? caseRecord.findings : explanation.findings;
  return {
    case: caseRecord,
    run,
    reference: snapshotSummary(explanation.reference),
    referenceSource: explanation.referenceSource,
    pre: snapshotSummary(explanation.pre),
    post: snapshotSummary(explanation.post),
    changes: explanation.changes,
    nonVolatileChanges: explanation.nonVolatileChanges,
    findings,
    project: explanation.post.project,
    host: explanation.post.host,
    warnings: explanation.post.warnings,
    fingerprint: fingerprintSnapshot(explanation.post).fingerprint,
    rollbacks: store
      .listRollbacks(30)
      .filter((record) => record.caseId === caseRecord.id || record.runId === run.id),
  };
}

function snapshotDetail(store: Store, ref: string): Record<string, unknown> {
  const meta = store.getSnapshotMeta(ref);
  if (!meta) throw new Error(`Snapshot not found: ${ref}`);
  const snapshot = store.getSnapshot(meta.id);
  const all = store.listSnapshots(500);
  const index = all.findIndex((candidate) => candidate.id === meta.id);
  const previous = index >= 0 && index + 1 < all.length ? all[index + 1] : null;
  let changes: Change[] = [];
  if (previous) {
    try {
      changes = diffSnapshots(store.getSnapshot(previous.id), snapshot, {
        origin: "observed-during",
      });
    } catch {
      changes = [];
    }
  }
  return {
    meta,
    previous,
    changes,
    fingerprint: fingerprintSnapshot(snapshot).fingerprint,
    project: snapshot.project,
    host: snapshot.host,
    warnings: snapshot.warnings,
    inventory: {
      packages: snapshot.packages.length,
      services: snapshot.services.length,
      startup: snapshot.startup.length,
      tasks: snapshot.tasks.length,
      listeners: snapshot.listeners.length,
      tools: Object.keys(snapshot.tools).length,
      configs: snapshot.configs.length,
    },
  };
}

function caseSummary(record: CaseRecord): Record<string, unknown> {
  const top = record.findings[0] ?? null;
  return {
    id: record.id,
    title: record.title,
    status: record.status,
    createdAt: record.createdAt,
    closedAt: record.closedAt,
    runId: record.runId,
    summary: record.summary,
    findingCount: record.findings.length,
    topFinding: top
      ? {
          title: top.title,
          score: top.score,
          confidence: top.confidence,
          category: top.category,
          fix: top.fix,
        }
      : null,
    rollbackId: record.rollbackId,
  };
}

function runSummary(run: RunRecord, caseRecord: CaseRecord | null): Record<string, unknown> {
  return {
    id: run.id,
    command: run.command,
    cwd: run.cwd,
    exitCode: run.exitCode,
    signal: run.signal,
    startedAt: run.startedAt,
    durationMs: run.durationMs,
    preSnapshot: run.preSnapshot,
    postSnapshot: run.postSnapshot,
    caseId: caseRecord?.id ?? null,
    caseTitle: caseRecord?.title ?? null,
  };
}

function snapshotSummary(snapshot: {
  id: string;
  createdAt: string;
  label?: string;
  trigger: string;
  profile: string;
}): Record<string, unknown> {
  return {
    id: snapshot.id,
    createdAt: Date.parse(snapshot.createdAt),
    label: snapshot.label ?? null,
    trigger: snapshot.trigger,
    profile: snapshot.profile,
  };
}

function publicConfig(config: Config): Record<string, unknown> {
  const { salt: _salt, secretPatterns, ...rest } = config;
  return {
    ...rest,
    salt: "<redacted>",
    secretPatternCount: secretPatterns.length,
  };
}

function parseReportRedaction(input: string | null): ReportRedaction {
  if (input === "none" || input === "strict" || input === "standard") return input;
  return "standard";
}

function cleanupPlans(plans: Map<string, PlanCacheEntry>): void {
  const cutoff = Date.now() - PLAN_TTL_MS;
  for (const [id, entry] of plans) {
    if (entry.at < cutoff) plans.delete(id);
  }
}

function tokenMatches(expected: string, provided: string | string[] | undefined): boolean {
  const value = Array.isArray(provided) ? provided[0] : provided;
  if (!value) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(value);
  return a.length === b.length && timingSafeEqual(a, b);
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function sendHtml(response: ServerResponse, status: number, value: string): void {
  const body = Buffer.from(value, "utf8");
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  response.end(body);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > BODY_LIMIT) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function safeStaticPath(root: string, pathname: string): string | null {
  const relative = pathname.replace(/^\/+/, "");
  if (!relative || relative.includes("..") || relative.includes("\0")) return null;
  const resolved = path.resolve(root, relative);
  const prefix = `${path.resolve(root)}${path.sep}`;
  return resolved.startsWith(prefix) ? resolved : null;
}

function contentType(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".ico") return "image/x-icon";
  if (ext === ".woff2") return "font/woff2";
  return "application/octet-stream";
}

function defaultUiDir(): string {
  return fileURLToPath(new URL("../../dist/ui/", import.meta.url));
}

function readPackageVersion(): string {
  try {
    const raw = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "1.0.0";
  } catch {
    return "1.0.0";
  }
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}
