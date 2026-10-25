import path from "node:path";
import { buildCaseChanges } from "./diff.js";
import { rankFindings } from "./rules.js";
import type { Store } from "./store.js";
import type {
  CaseRecord,
  Change,
  Config,
  Finding,
  ReferenceInfo,
  RunRecord,
  Snapshot,
} from "./types.js";
import { caseId, isWindows, pathKey, sha256, stableStringify, truncate } from "./util.js";

export type Explanation = {
  run: RunRecord;
  pre: Snapshot;
  post: Snapshot;
  reference: Snapshot;
  referenceSource: ReferenceInfo["source"] | "pre";
  changes: Change[];
  nonVolatileChanges: Change[];
  findings: Finding[];
};

export type ExplainOptions = {
  includeVolatile?: boolean;
  reference?: Snapshot | null;
};

export function commandToString(args: string[]): string {
  return args.map(quoteArg).join(" ");
}

export function commandSignature(command: string, cwd: string): string {
  return `CMD-${sha256(
    stableStringify({ command: command.trim(), cwd: pathKey(path.resolve(cwd)) }),
  )
    .slice(0, 16)
    .toUpperCase()}`;
}

export function explainRun(
  store: Store,
  config: Config,
  run: RunRecord,
  options: ExplainOptions = {},
): Explanation {
  const pre = store.getSnapshot(run.preSnapshot);
  if (!run.postSnapshot) {
    throw new Error(`Run ${run.id} has no post-command snapshot.`);
  }
  const post = store.getSnapshot(run.postSnapshot);
  let reference: Snapshot | null = options.reference ?? null;
  let referenceSource: Explanation["referenceSource"] = options.reference ? "latest" : "pre";
  if (!reference && run.referenceSnapshot) {
    try {
      reference = store.getSnapshot(run.referenceSnapshot);
      referenceSource =
        run.referenceSnapshot === run.preSnapshot ? "pre" : inferReferenceSource(store, run);
    } catch {
      reference = null;
    }
  }
  if (!reference) {
    reference = pre;
    referenceSource = "pre";
  }

  const changes = buildCaseChanges(reference, pre, post, {
    config,
    project: post.project ?? pre.project,
  }).sort((a, b) => {
    const category = a.category.localeCompare(b.category);
    return category !== 0 ? category : a.path.localeCompare(b.path);
  });
  const nonVolatileChanges = changes.filter((change) => !change.volatile);
  const rankable = options.includeVolatile ? changes : nonVolatileChanges;
  const findings = rankFindings({
    changes: rankable,
    run,
    project: post.project ?? pre.project,
    stderr: run.stderrTail,
    store,
  });
  return {
    run,
    pre,
    post,
    reference,
    referenceSource,
    changes,
    nonVolatileChanges,
    findings,
  };
}

export function openCaseForRun(
  store: Store,
  run: RunRecord,
  explanation: Explanation,
): CaseRecord {
  const existing = store.caseForRun(run.id);
  if (existing) return existing;
  const top = explanation.findings[0];
  const title = `Command failed: ${truncate(run.command, 72)}`;
  const summary = top
    ? `Top suspect: ${top.title} (${top.confidence} confidence, ${top.score}/100).`
    : explanation.changes.length === 0
      ? "No machine changes were observed during the command window."
      : "Only volatile or background machine changes were observed during the command window.";
  const record: CaseRecord = {
    id: caseId(),
    title,
    status: "open",
    createdAt: Date.now(),
    closedAt: null,
    runId: run.id,
    referenceSnapshot: explanation.reference.id,
    findings: explanation.findings,
    summary,
    rollbackId: null,
  };
  store.saveCase(record);
  store.logEvent("case.open", {
    caseId: record.id,
    runId: run.id,
    reference: explanation.reference.id,
    topFinding: top?.signature ?? null,
  });
  return record;
}

export function tailText(input: string | null | undefined, max = 8192): string | null {
  if (!input) return null;
  if (input.length <= max) return input;
  return input.slice(input.length - max);
}

function inferReferenceSource(store: Store, run: RunRecord): ReferenceInfo["source"] {
  const success = store.lastSuccess(run.projectId, run.commandSignature);
  if (success?.postSnapshot === run.referenceSnapshot) return "last-success";
  const baseline = store.getActiveBaseline();
  if (baseline?.snapshotId === run.referenceSnapshot) return "baseline";
  return "latest";
}

function quoteArg(value: string): string {
  if (!value) return isWindows ? '""' : "''";
  const safe = /^[A-Za-z0-9_./:@%+=,-]+$/.test(value);
  if (safe) return value;
  if (isWindows) {
    return `"${value.replaceAll('"', '\\"')}"`;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
