import Table from "cli-table3";
import pc from "picocolors";
import type { CliContext } from "./context.js";
import type { Change, Finding, RunRecord, Snapshot, SnapshotMeta } from "../core/types.js";
import { formatBytes, formatDuration, formatRelativeTime, formatTimestamp, truncate } from "../core/util.js";

export function snapshotCounts(snapshot: Snapshot): Record<string, number> {
  return {
    tools: Object.keys(snapshot.tools).length,
    packages: snapshot.packages.length,
    services: snapshot.services.length,
    startup: snapshot.startup.length,
    tasks: snapshot.tasks.length,
    listeners: snapshot.listeners.length,
    programs: snapshot.programs.length,
    configs: snapshot.configs.length,
  };
}

export function printSnapshotSummary(
  context: CliContext,
  snapshot: Snapshot,
  meta: SnapshotMeta,
  options: { storePath?: string; durationMs?: number } = {},
): void {
  const { logger } = context;
  const counts = snapshotCounts(snapshot);
  logger.success(
    `Snapshot ${pc.bold(snapshot.id)} ${pc.dim(`(${snapshot.profile}, ${formatDuration(options.durationMs ?? meta.durationMs)})`)}`,
  );
  logger.raw(
    `  ${pc.dim("Host")}      ${snapshot.host.os} ${snapshot.host.build} ${pc.dim(`(${snapshot.host.arch})`)}`,
  );
  logger.raw(`  ${pc.dim("Captured")}  ${formatTimestamp(meta.createdAt)}`);
  if (snapshot.project) {
    logger.raw(
      `  ${pc.dim("Project")}   ${snapshot.project.kind} ${pc.dim(snapshot.project.root)}${snapshot.project.git ? pc.dim(` · ${snapshot.project.git.branch}@${snapshot.project.git.commit.slice(0, 8)}`) : ""}`,
    );
  }
  logger.raw(
    `  ${pc.dim("Data")}      ${counts.tools} tools · ${counts.packages} packages · ${counts.services} services · ${counts.listeners} listeners · ${counts.configs} configs`,
  );
  if (options.storePath) {
    logger.raw(`  ${pc.dim("Store")}     ${options.storePath}`);
  }
  if (meta.sizeBytes) {
    logger.raw(`  ${pc.dim("Size")}      ${formatBytes(meta.sizeBytes)} compressed`);
  }
  if (snapshot.warnings.length > 0) {
    logger.raw(`  ${pc.yellow("Warnings")}  ${snapshot.warnings.length}`);
    for (const warning of snapshot.warnings.slice(0, 5)) {
      logger.raw(`    ${pc.yellow("!")} ${warning.collector}: ${truncate(warning.message, 160)}`);
    }
  }
}

export function printWarnings(context: CliContext, warnings: Snapshot["warnings"]): void {
  if (warnings.length === 0) return;
  context.logger.header("Collector warnings");
  for (const warning of warnings) {
    context.logger.raw(`  ${pc.yellow("!")} ${pc.bold(warning.collector)} ${warning.message}`);
  }
}

export function printChanges(
  context: CliContext,
  changes: Change[],
  options: { limit?: number; showOrigin?: boolean; showVolatile?: boolean } = {},
): void {
  const { logger } = context;
  if (changes.length === 0) {
    logger.info("No machine changes detected.");
    return;
  }
  const shown = changes.slice(0, options.limit ?? 60);
  for (const change of shown) {
    const badge =
      change.kind === "added"
        ? pc.green("+")
        : change.kind === "removed"
          ? pc.red("-")
          : change.kind === "reordered"
            ? pc.yellow("↕")
            : pc.yellow("~");
    const volatile = change.volatile && !options.showVolatile ? pc.dim(" · volatile") : "";
    const origin =
      options.showOrigin && change.origin === "pre-existing" ? pc.dim(" · pre-existing") : "";
    logger.raw(
      `  ${badge} ${pc.bold(change.label)} ${pc.dim(`[${change.category}]`)}${volatile}${origin}\n    ${change.summary}`,
    );
  }
  if (changes.length > shown.length) {
    logger.raw(pc.dim(`  … ${changes.length - shown.length} more changes`));
  }
}

export function printFindings(context: CliContext, findings: Finding[], options: { limit?: number } = {}): void {
  const { logger } = context;
  if (findings.length === 0) return;
  logger.header("Ranked hypotheses");
  for (const finding of findings.slice(0, options.limit ?? 5)) {
    const color = finding.confidence === "high" ? pc.green : finding.confidence === "medium" ? pc.yellow : pc.dim;
    const marker = finding.rank === 1 ? `${pc.red("TOP SUSPECT")} · ` : "";
    logger.raw(
      `  ${pc.bold(String(finding.rank).padStart(2))}. ${marker}${pc.bold(finding.title)} ${color(`[${finding.confidence}]`)} ${pc.dim(`${finding.score}/100`)}`,
    );
    logger.raw(`      ${pc.dim(`[${finding.category}]`)} ${finding.description}`);
    const before = formatFactValue(finding.before);
    const after = formatFactValue(finding.after);
    if (before !== after) {
      logger.raw(`      ${pc.dim("before")} ${before}`);
      logger.raw(`      ${pc.dim("after")}  ${after}`);
    }
    logger.raw(`      ${pc.dim("Fix")}    ${finding.fix}`);
    for (const evidence of finding.evidence.slice(0, 4)) {
      logger.raw(`      ${pc.dim("·")} ${pc.dim(truncate(evidence, 220))}`);
    }
  }
}

function formatFactValue(value: unknown): string {
  if (value === null || value === undefined) return pc.dim("—");
  if (typeof value === "string") return truncate(value, 220);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (record.secret === true) {
      return pc.dim("<redacted>");
    }
  }
  try {
    return truncate(JSON.stringify(value), 220);
  } catch {
    return pc.dim("<unprintable>");
  }
}

export function printRun(context: CliContext, run: RunRecord): void {
  const { logger } = context;
  const exit = run.exitCode === 0 ? pc.green("0") : pc.red(String(run.exitCode ?? "?"));
  logger.raw(
    `${pc.bold(run.id)}  ${exit}  ${formatDuration(run.durationMs)}  ${formatRelativeTime(run.startedAt)}  ${truncate(run.command, 100)}`,
  );
}

export function printRunTable(context: CliContext, runs: RunRecord[]): void {
  if (runs.length === 0) {
    context.logger.info("No runs recorded yet. Use `evd watch -- <command>`.");
    return;
  }
  const table = new Table({
    head: ["Run", "Exit", "Duration", "When", "Command"],
    style: { head: [], border: [] },
    colWidths: [18, 6, 10, 12, 60],
    wordWrap: false,
  });
  for (const run of runs) {
    table.push([
      run.id,
      run.exitCode === 0 ? pc.green("0") : pc.red(String(run.exitCode ?? "?")),
      formatDuration(run.durationMs),
      formatRelativeTime(run.startedAt),
      truncate(run.command, 58),
    ]);
  }
  context.logger.raw(table.toString());
}

export function printSnapshotTable(context: CliContext, snapshots: SnapshotMeta[]): void {
  if (snapshots.length === 0) {
    context.logger.info("No snapshots yet. Run `evd init`.");
    return;
  }
  const table = new Table({
    head: ["Snapshot", "When", "Profile", "Trigger", "Label", "Size"],
    style: { head: [], border: [] },
    colWidths: [18, 14, 10, 10, 30, 10],
    wordWrap: false,
  });
  for (const snapshot of snapshots) {
    table.push([
      `${snapshot.id}${snapshot.pinned ? pc.yellow(" ★") : ""}`,
      formatRelativeTime(snapshot.createdAt),
      snapshot.profile,
      snapshot.trigger,
      truncate(snapshot.label ?? "", 28),
      formatBytes(snapshot.sizeBytes),
    ]);
  }
  context.logger.raw(table.toString());
}

export function printCase(context: CliContext, caseRecord: {
  id: string;
  title: string;
  status: string;
  createdAt: number;
  summary: string;
  findings: Finding[];
}): void {
  const { logger } = context;
  logger.raw(`${pc.bold(caseRecord.id)} ${pc.dim(`[${caseRecord.status}]`)} · ${formatRelativeTime(caseRecord.createdAt)}`);
  logger.raw(`  ${caseRecord.title}`);
  if (caseRecord.summary) logger.raw(`  ${caseRecord.summary}`);
  printFindings(context, caseRecord.findings, { limit: 3 });
}
