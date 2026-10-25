import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fingerprintSnapshot } from "./fingerprint.js";
import { redactText } from "./redact.js";
import { buildRollbackPlan } from "./rollback.js";
import { explainRun } from "./run.js";
import type { Store } from "./store.js";
import type {
  CaseRecord,
  Change,
  Config,
  Finding,
  JsonValue,
  RollbackPlan,
  RunRecord,
  SnapshotMeta,
} from "./types.js";
import {
  formatDuration,
  formatRelativeTime,
  formatTimestamp,
  stripAnsi,
  truncate,
} from "./util.js";

export type ReportRedaction = "none" | "standard" | "strict";

export type ReportData = {
  schemaVersion: 1;
  generatedAt: string;
  envidenceVersion: string;
  redaction: ReportRedaction;
  store: string;
  fingerprint: string | null;
  case: CaseRecord | null;
  run: {
    id: string;
    command: string;
    cwd: string;
    exitCode: number | null;
    signal: string | null;
    startedAt: number;
    durationMs: number;
    errorLine: string | null;
  };
  reference: {
    id: string;
    source: string;
    label: string | null;
  };
  findings: Finding[];
  changes: Change[];
  snapshots: Array<{
    id: string;
    label: string | null;
    profile: string;
    createdAt: number;
    trigger: string;
  }>;
  rollbackPlan: RollbackPlan | null;
};

export type ReportOptions = {
  caseRef?: string;
  runRef?: string;
  redaction?: ReportRedaction;
  home: string;
};

export function buildReportData(
  store: Store,
  config: Config,
  options: ReportOptions,
): ReportData {
  const caseRecord = options.caseRef ? store.getCase(options.caseRef) : null;
  if (options.caseRef && !caseRecord) throw new Error(`Case not found: ${options.caseRef}`);
  let run: RunRecord | null = null;
  if (options.runRef) {
    run = store.findRun(options.runRef);
    if (!run) throw new Error(`Run not found: ${options.runRef}`);
  } else if (caseRecord) {
    run = store.getRun(caseRecord.runId);
    if (!run) throw new Error(`Run for case ${caseRecord.id} is missing.`);
  } else {
    const latestCase = store.listCases(1)[0];
    if (latestCase) {
      run = store.getRun(latestCase.runId);
      if (run) return buildReportData(store, config, { ...options, caseRef: latestCase.id });
    }
    run = store.listRuns(1)[0] ?? null;
  }
  if (!run) throw new Error("No cases or runs to report. Use `evd watch -- <command>` first.");

  const explanation = explainRun(store, config, run, {
    includeVolatile: true,
  });
  const effectiveCase = caseRecord ?? store.caseForRun(run.id);
  const findings =
    effectiveCase && effectiveCase.findings.length > 0
      ? effectiveCase.findings
      : explanation.findings;
  const post = explanation.post;
  const snapshotIds = [explanation.reference.id, explanation.pre.id, explanation.post.id];
  const snapshots = [...new Set(snapshotIds)]
    .map((id) => store.getSnapshotMeta(id))
    .filter((meta): meta is SnapshotMeta => meta !== null)
    .map((meta) => ({
      id: meta.id,
      label: meta.label,
      profile: meta.profile,
      createdAt: meta.createdAt,
      trigger: meta.trigger,
    }));
  let rollbackPlan: RollbackPlan | null = null;
  try {
    rollbackPlan = buildRollbackPlan(store, config, {
      caseRef: effectiveCase?.id,
      runRef: effectiveCase ? undefined : run.id,
    });
  } catch {
    rollbackPlan = null;
  }
  const data: ReportData = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    envidenceVersion: envidenceVersion(),
    redaction: options.redaction ?? "standard",
    store: store.home,
    fingerprint: fingerprintSnapshot(post).fingerprint,
    case: effectiveCase,
    run: {
      id: run.id,
      command: run.command,
      cwd: run.cwd,
      exitCode: run.exitCode,
      signal: run.signal,
      startedAt: run.startedAt,
      durationMs: run.durationMs,
      errorLine: errorLine(run),
    },
    reference: {
      id: explanation.reference.id,
      source: explanation.referenceSource,
      label: explanation.reference.label ?? null,
    },
    findings,
    changes: explanation.changes,
    snapshots,
    rollbackPlan,
  };
  return redactReportData(data, options.redaction ?? "standard", post);
}

export function renderReportHtml(data: ReportData): string {
  const top = data.findings[0];
  const findingsHtml =
    data.findings.length > 0
      ? data.findings.map((finding) => renderFinding(finding)).join("\n")
      : `<div class="empty"><strong>No machine changes were observed.</strong><p>That is still useful evidence. Check Git, the lockfile, network services, and credentials next.</p></div>`;
  const changesHtml =
    data.changes.length > 0
      ? data.changes
          .map(
            (change) => `<tr>
              <td><span class="tag">${esc(change.category)}</span></td>
              <td>${esc(change.label)}<div class="muted">${esc(change.path)}</div></td>
              <td>${esc(change.origin)}</td>
              <td class="value">${renderValue(change.before)}</td>
              <td class="value">${renderValue(change.after)}</td>
            </tr>`,
          )
          .join("\n")
      : `<tr><td colspan="5" class="muted">No changes recorded.</td></tr>`;
  const rollbackHtml = data.rollbackPlan
    ? `<section class="card"><h2>Reversible remediation</h2>
        <p class="muted">Dry-run plan only. Apply with the CLI after review.</p>
        ${
          data.rollbackPlan.actions.length > 0
            ? `<ol class="actions">${data.rollbackPlan.actions
                .map(
                  (action) =>
                    `<li><strong>${esc(action.title)}</strong><div class="muted">${esc(action.description)}</div>${action.requiresAdmin ? `<span class="warn">requires admin</span>` : ""}</li>`,
                )
                .join("")}</ol>`
            : `<p class="muted">No automatic actions.</p>`
        }
        ${
          data.rollbackPlan.manual.length > 0
            ? `<h3>Manual steps</h3><ul class="manual">${data.rollbackPlan.manual.map((step) => `<li>${esc(step)}</li>`).join("")}</ul>`
            : ""
        }
        <pre class="command">evd rollback --case ${esc(data.case?.id ?? "")} --dry-run --script rollback.ps1</pre>
      </section>`
    : "";
  const timelineHtml = `<ol class="timeline">${data.snapshots
    .map(
      (snapshot) =>
        `<li><span class="mono">${esc(snapshot.id)}</span><span>${esc(snapshot.label ?? snapshot.trigger)}</span><span class="muted">${esc(formatRelativeTime(snapshot.createdAt))}</span></li>`,
    )
    .join("")}</ol>`;
  const repro = data.case
    ? `evd why --case ${data.case.id}`
    : `evd why --run ${data.run.id}`;
  const redactionWarning =
    data.redaction === "none"
      ? `<div class="warning"><strong>Unredacted local report.</strong> Review before sharing. Machine values may identify this device.</div>`
      : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Envidence ${esc(data.case?.id ?? data.run.id)}</title>
<style>
:root{--bg:#f5f3ee;--paper:#fff;--ink:#17201d;--muted:#68716d;--line:#ddd8ce;--green:#0b6b4f;--amber:#9a6500;--red:#9d2f2f;--navy:#102d30}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
header{background:var(--navy);color:#fff;padding:34px clamp(20px,5vw,64px)}header .eyebrow{text-transform:uppercase;letter-spacing:.16em;font-size:11px;color:#9dd8c7}
h1{font-size:clamp(26px,4vw,42px);line-height:1.05;margin:10px 0 8px;letter-spacing:-.03em}h2{font-size:20px;margin:0 0 10px}h3{font-size:15px;margin:18px 0 8px}
main{max-width:1180px;margin:0 auto;padding:28px 20px 60px}.meta{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px;color:#c8d9d4;font-size:12px}
.pill{border:1px solid #3a5c5b;border-radius:999px;padding:4px 9px}.card{background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:22px;margin:18px 0;box-shadow:0 8px 24px #17302a0a}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:18px 0}.stat{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:14px}.stat span{display:block;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.1em}.stat strong{font-size:20px}
.top{border-left:5px solid var(--red);background:#fff8f4}.score{font-size:12px;color:var(--muted)}.bar{height:8px;background:#e8e2d8;border-radius:99px;overflow:hidden;margin:8px 0 14px}.bar i{display:block;height:100%;background:linear-gradient(90deg,#1b7f5f,#b7791f)}
.finding{border-top:1px solid var(--line);padding:18px 0}.finding:first-child{border-top:0}.finding h3{margin:0;font-size:17px}.finding .fix{background:#f1f8f4;border:1px solid #cfe7da;border-radius:10px;padding:10px 12px;margin:12px 0}
.evidence{margin:8px 0 0;padding-left:18px;color:var(--muted)}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;vertical-align:top;padding:9px 8px;border-bottom:1px solid var(--line)}th{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.08em}
.tag{display:inline-block;background:#eef4f1;border:1px solid #d8e5df;border-radius:6px;padding:2px 6px;font-size:11px}.mono,code,pre{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.value{font-family:ui-monospace,Consolas,monospace;font-size:12px;max-width:280px;word-break:break-word}
.muted{color:var(--muted)}.warning{background:#fff5d9;border:1px solid #e7c76e;padding:12px 14px;border-radius:10px;margin:14px 0}.warn{color:var(--red);font-size:12px}
.timeline{list-style:none;padding:0;margin:0}.timeline li{display:grid;grid-template-columns:160px 1fr auto;gap:12px;padding:10px 0;border-bottom:1px solid var(--line)}
.actions, .manual{padding-left:22px}.actions li{margin:10px 0}.command{background:#102d30;color:#d7f2e8;padding:12px;border-radius:8px;overflow:auto;font-size:12px}
footer{max-width:1180px;margin:0 auto;padding:20px;color:var(--muted);font-size:12px;border-top:1px solid var(--line)}a{color:var(--green)}
@media print{body{background:#fff}header{background:#fff;color:#000;border-bottom:2px solid #000}header .eyebrow,.pill{color:#333}.card{box-shadow:none;break-inside:avoid}.top{border-left-color:#000}.warning{border:1px solid #000}footer{break-before:page}}
</style>
</head>
<body>
<header>
  <div class="eyebrow">Envidence case file · generated locally</div>
  <h1>${esc(data.case?.title ?? `Run ${data.run.id}`)}</h1>
  <div class="muted">${esc(data.case?.summary ?? "Machine change evidence and ranked hypotheses.")}</div>
  <div class="meta">
    <span class="pill">${esc(data.case?.id ?? data.run.id)}</span>
    <span class="pill">${esc(data.fingerprint ?? "no fingerprint")}</span>
    <span class="pill">redaction: ${esc(data.redaction)}</span>
    <span class="pill">${esc(data.envidenceVersion)}</span>
    <span class="pill">${esc(formatTimestamp(Date.parse(data.generatedAt)))}</span>
  </div>
</header>
<main>
  ${redactionWarning}
  <div class="grid">
    <div class="stat"><span>Command</span><strong class="mono">${esc(truncate(data.run.command, 80))}</strong></div>
    <div class="stat"><span>Exit</span><strong>${esc(String(data.run.exitCode ?? "?"))}</strong></div>
    <div class="stat"><span>Duration</span><strong>${esc(formatDuration(data.run.durationMs))}</strong></div>
    <div class="stat"><span>Changes</span><strong>${data.changes.length}</strong></div>
    <div class="stat"><span>Reference</span><strong class="mono">${esc(data.reference.id)}</strong></div>
  </div>
  <section class="card top">
    <div class="score">TOP SUSPECT · ${esc(top?.confidence ?? "none")} confidence · ${top?.score ?? 0}/100</div>
    <h2>${esc(top?.title ?? "No ranked hypothesis")}</h2>
    <p>${esc(top?.description ?? "No non-volatile machine changes were observed during the command window.")}</p>
    <div class="bar"><i style="width:${Math.max(2, top?.score ?? 0)}%"></i></div>
    ${top ? `<p class="muted">${esc(top.fix)}</p>` : ""}
  </section>
  <section class="card"><h2>Ranked hypotheses</h2><p class="muted">Hypotheses, not proof. Evidence is shown so you can verify it.</p>${findingsHtml}</section>
  <section class="card"><h2>Observed changes</h2><p class="muted">Pre-existing means the difference existed before the command window; observed-during means it appeared inside it.</p><div style="overflow:auto"><table><thead><tr><th>Category</th><th>Change</th><th>Origin</th><th>Before</th><th>After</th></tr></thead><tbody>${changesHtml}</tbody></table></div></section>
  ${rollbackHtml}
  <section class="card"><h2>Timeline</h2>${timelineHtml}</section>
  <section class="card"><h2>Run</h2><table><tbody>
    <tr><th>Command</th><td class="mono">${esc(data.run.command)}</td></tr>
    <tr><th>Exit</th><td>${esc(String(data.run.exitCode ?? "?"))} ${esc(data.run.signal ?? "")}</td></tr>
    <tr><th>Started</th><td>${esc(formatTimestamp(data.run.startedAt))}</td></tr>
    <tr><th>Reference</th><td class="mono">${esc(data.reference.id)} (${esc(data.reference.source)})</td></tr>
    ${data.run.errorLine ? `<tr><th>Error</th><td class="mono">${esc(data.run.errorLine)}</td></tr>` : ""}
  </tbody></table></section>
  <p class="muted">Generated locally. No data left this machine. Envidence does not make network calls, collect telemetry, or use an LLM.</p>
</main>
<footer>
  <div><strong>Reproduce:</strong> <code>${esc(repro)}</code></div>
  <div>Envidence ${esc(data.envidenceVersion)} · schema ${data.schemaVersion} · store ${esc(data.store)}</div>
</footer>
<script id="envidence-data" type="application/json">${jsonForHtml(data)}</script>
<script>
(function(){const el=document.getElementById('envidence-data');if(!el)return;try{const d=JSON.parse(el.textContent);document.documentElement.dataset.case=d.case?.id||d.run.id;}catch(e){}})();
</script>
</body>
</html>`;
}

export function writeReport(
  file: string,
  data: ReportData,
): { file: string; bytes: number } {
  const html = renderReportHtml(data);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, html, "utf8");
  return { file, bytes: Buffer.byteLength(html) };
}

function renderFinding(finding: Finding): string {
  return `<article class="finding">
    <div class="score">#${finding.rank} · ${esc(finding.confidence)} confidence · ${finding.score}/100 · ${esc(finding.rule)}</div>
    <h3>${esc(finding.title)}</h3>
    <p>${esc(finding.description)}</p>
    <div class="mono value">before ${renderValue(finding.before)} &nbsp; → &nbsp; after ${renderValue(finding.after)}</div>
    <div class="fix"><strong>Fix:</strong> ${esc(finding.fix)}</div>
    <ul class="evidence">${finding.evidence.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>
  </article>`;
}

function renderValue(value: JsonValue | undefined): string {
  if (value === null || value === undefined) return `<span class="muted">(unset)</span>`;
  if (typeof value === "object" && !Array.isArray(value) && value.secret === true) {
    return `<span class="muted">&lt;redacted&gt;</span>`;
  }
  if (typeof value === "string") return esc(value);
  return esc(truncate(JSON.stringify(value), 220));
}

function errorLine(run: RunRecord): string | null {
  const lines = stripAnsi(run.stderrTail ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  const matched = lines.find((line) => /error|exception|failed|fatal|TS\d+/i.test(line));
  return truncate(matched ?? (lines[lines.length - 1] as string), 300);
}

function redactReportData(
  data: ReportData,
  level: ReportRedaction,
  post: ReturnType<typeof explainRun>["post"],
): ReportData {
  const home = process.env.USERPROFILE ?? os.homedir();
  const username = post.host.username;
  const replacements: Array<[string, string]> = [
    [post.project?.root ?? "", "<project>"],
    [process.cwd(), "<project>"],
    [home, "~"],
    [path.join(home, username), "~"],
    [`C:\\Users\\${username}`, "<home>"],
    [`/home/${username}`, "<home>"],
    [`/Users/${username}`, "<home>"],
    [post.host.hostname, "<host>"],
  ].filter(([value]) => Boolean(value)) as Array<[string, string]>;
  if (level === "strict") {
    if (post.project) {
      replacements.push([post.project.id, "<project-id>"]);
      replacements.push([path.basename(post.project.root), "<project-name>"]);
      if (post.project.git) {
        replacements.push([post.project.git.branch, "<branch>"]);
        replacements.push([post.project.git.commit, "<commit>"]);
      }
    }
    for (const service of post.services) {
      if (service.name.length > 3) replacements.push([service.name, "<service>"]);
    }
  }
  replacements.sort((a, b) => b[0].length - a[0].length);

  const walk = (value: unknown, key = ""): unknown => {
    if (typeof value === "string") {
      if (key === "category" || key === "rule" || key === "confidence" || key === "type" || key === "status") {
        return value;
      }
      let out = value;
      if (level !== "none") {
        for (const [from, to] of replacements) {
          if (!from) continue;
          out = out.split(from).join(to);
        }
      }
      if (level === "standard" || level === "strict") {
        out = out.replace(
          /\b(?!(?:10|127|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.)(?:\d{1,3}\.){3}\d{1,3}\b/g,
          "<ip>",
        );
      }
      if (level === "strict") {
        out = out
          .replace(/[A-Za-z]:\\[^\s"'<>]+/g, "<path>")
          .replace(/\/(?:Users|home|var|etc|opt|private)\/[^\s"'<>]+/g, "<path>")
          .replace(/\b[0-9a-f]{40}\b/g, "<commit>");
      }
      return redactText(out);
    }
    if (Array.isArray(value)) return value.map((item) => walk(item, key));
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (record.secret === true) return { secret: true, redacted: "<redacted>" };
      const out: Record<string, unknown> = {};
      for (const [childKey, childValue] of Object.entries(record)) {
        out[childKey] = walk(childValue, childKey);
      }
      return out;
    }
    return value;
  };
  return walk(data) as ReportData;
}

function envidenceVersion(): string {
  try {
    const raw = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "1.0.0";
  } catch {
    return "1.0.0";
  }
}

function jsonForHtml(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll("</script", "<\\/script");
}

function esc(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
