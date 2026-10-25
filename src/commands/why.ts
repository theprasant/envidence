import type { Command } from "commander";
import pc from "picocolors";
import { withContext, printJson } from "../cli/context.js";
import { printChanges, printFindings } from "../cli/format.js";
import type { CliContext } from "../cli/context.js";
import { explainRun } from "../core/run.js";
import type { CaseRecord, RunRecord, Snapshot } from "../core/types.js";
import {
  formatDuration,
  formatRelativeTime,
  parseDuration,
  truncate,
} from "../core/util.js";

type WhyOptions = {
  run?: string;
  since?: string;
  all?: boolean;
  failOnFindings?: boolean;
};

export function registerWhy(program: Command): void {
  program
    .command("why")
    .description("Explain a recorded run or case using machine changes and evidence")
    .argument("[target...]", "case ID, run ID, or command text")
    .option("--run <id>", "explain a specific run")
    .option("--since <snapshot|duration>", "use a snapshot or time window as the reference")
    .option("--all", "include volatile/background changes")
    .option("--fail-on-findings", "exit 1 when any hypotheses are found (CI)")
    .action(async (target: string[] | undefined, options: WhyOptions, command: Command) => {
      await withContext(command, async (context) => {
        const { run, caseRecord } = resolveTarget(context, target ?? [], options);
        const referenceOverride = options.since
          ? resolveSince(context, options.since)
          : null;
        const explanation = explainRun(context.store, context.config, run, {
          includeVolatile: options.all === true,
          reference: referenceOverride,
        });
        const findings =
          caseRecord && !options.all && !options.since
            ? caseRecord.findings
            : explanation.findings;

        if (context.json) {
          printJson({
            case: caseRecord,
            run,
            reference: {
              snapshot: explanation.reference.id,
              source: explanation.referenceSource,
            },
            summary: caseRecord?.summary ?? summarize(explanation, findings.length),
            changes: explanation.changes,
            findings,
          });
        } else {
          printWhy(context, caseRecord, run, explanation, findings, options);
        }
        if (options.failOnFindings && findings.length > 0) {
          process.exitCode = 1;
        }
      });
    });
}

function resolveTarget(
  context: CliContext,
  target: string[],
  options: WhyOptions,
): { run: RunRecord; caseRecord: CaseRecord | null } {
  if (options.run) {
    const run = context.store.findRun(options.run);
    if (!run) throw new Error(`Run not found: ${options.run}`);
    return { run, caseRecord: context.store.caseForRun(run.id) };
  }
  const query = target.join(" ").trim();
  if (query) {
    const caseRecord = context.store.getCase(query);
    if (caseRecord) {
      const run = context.store.getRun(caseRecord.runId);
      if (!run) throw new Error(`Run for case ${caseRecord.id} is missing.`);
      return { run, caseRecord };
    }
    const run = context.store.findRun(query);
    if (run) return { run, caseRecord: context.store.caseForRun(run.id) };
    const needle = query.toLowerCase();
    const match = context.store
      .listRuns(200)
      .find((candidate) => candidate.command.toLowerCase().includes(needle));
    if (match) return { run: match, caseRecord: context.store.caseForRun(match.id) };
    throw new Error(`No case or run matched: ${query}`);
  }

  const openCase = context.store.openCases()[0];
  if (openCase) {
    const run = context.store.getRun(openCase.runId);
    if (!run) throw new Error(`Run for case ${openCase.id} is missing.`);
    return { run, caseRecord: openCase };
  }
  const runs = context.store.listRuns(50);
  const run = runs.find((candidate) => candidate.exitCode !== 0) ?? runs[0];
  if (!run) {
    throw new Error("No runs recorded yet. Use `evd watch -- <command>` first.");
  }
  return { run, caseRecord: context.store.caseForRun(run.id) };
}

function resolveSince(context: CliContext, input: string): Snapshot {
  const direct = context.store.findSnapshot(input);
  if (direct) return direct;
  let durationMs: number;
  try {
    durationMs = parseDuration(input);
  } catch {
    throw new Error(
      `Reference not found: ${input}. Use a snapshot ID or a duration such as 30m, 12h, 7d.`,
    );
  }
  const cutoff = Date.now() - durationMs;
  const snapshots = context.store.listSnapshots(500);
  if (snapshots.length === 0) throw new Error("No snapshots available for --since.");
  const candidate =
    snapshots.find((snapshot) => snapshot.createdAt <= cutoff) ??
    snapshots[snapshots.length - 1];
  if (!candidate) throw new Error("No snapshots available for --since.");
  return context.store.getSnapshot(candidate.id);
}

function printWhy(
  context: CliContext,
  caseRecord: CaseRecord | null,
  run: RunRecord,
  explanation: ReturnType<typeof explainRun>,
  findings: ReturnType<typeof explainRun>["findings"],
  options: WhyOptions,
): void {
  const title = caseRecord ? `Case ${caseRecord.id}` : `Run ${run.id}`;
  context.logger.header(`Envidence why · ${title}`);
  context.logger.raw(`  ${pc.dim("Command")}    ${pc.bold(run.command)}`);
  context.logger.raw(
    `  ${pc.dim("Exit")}       ${run.exitCode === 0 ? pc.green("0") : pc.red(String(run.exitCode ?? "?"))} · ${formatDuration(run.durationMs)} · ${formatRelativeTime(run.startedAt)}`,
  );
  if (caseRecord) {
    context.logger.raw(
      `  ${pc.dim("Status")}     ${caseRecord.status === "open" ? pc.yellow("open") : pc.dim("closed")} · ${caseRecord.title}`,
    );
  }
  context.logger.raw(
    `  ${pc.dim("Reference")}  ${explanation.reference.id} ${pc.dim(`(${explanation.referenceSource === "pre" ? "before this run" : explanation.referenceSource})`)}`,
  );
  const preExisting = explanation.changes.filter((change) => change.origin === "pre-existing").length;
  const observed = explanation.changes.length - preExisting;
  context.logger.raw(
    `  ${pc.dim("Changes")}    ${observed} observed during the command window · ${preExisting} pre-existing`,
  );

  if (findings.length > 0) {
    context.logger.raw(pc.dim("  Hypotheses, not proof. The top item is the strongest current lead."));
    printFindings(context, findings, { limit: 8 });
  } else if (explanation.changes.length === 0) {
    context.logger.blank();
    context.logger.info("No machine changes were observed during this run.");
    printNextChecks(context);
  } else {
    context.logger.blank();
    context.logger.info("Changes were observed, but none are strong enough to rank as a hypothesis.");
    if (!options.all) {
      context.logger.raw(pc.dim("  Only volatile/background changes were found; use --all to inspect them."));
    }
  }

  if (explanation.changes.length > 0) {
    const shown = options.all ? explanation.changes : explanation.nonVolatileChanges;
    context.logger.header("Observed changes");
    printChanges(context, shown, {
      limit: 24,
      showOrigin: true,
      showVolatile: options.all === true,
    });
    const hidden = explanation.changes.length - shown.length;
    if (hidden > 0) {
      context.logger.raw(pc.dim(`  … ${hidden} volatile changes hidden; use --all to include them.`));
    }
  }

  const stderrTail = run.stderrTail?.trim();
  if (stderrTail) {
    const lines = stderrTail.split(/\r?\n/).filter(Boolean).slice(-6);
    context.logger.header("Last stderr lines");
    for (const line of lines) {
      context.logger.raw(`  ${pc.dim(truncate(line, 200))}`);
    }
  }

  if (caseRecord) {
    context.logger.blank();
    context.logger.raw(
      `  ${pc.dim("Next")} ${context.logger.cyan(`evd report --case ${caseRecord.id}`)} · ${context.logger.cyan(`evd rollback --case ${caseRecord.id} --dry-run`)}`,
    );
  } else if (run.exitCode !== 0) {
    context.logger.blank();
    context.logger.raw(
      pc.dim("  This run has no case because it was recorded with --no-why or predates cases."),
    );
  }
}

function summarize(explanation: ReturnType<typeof explainRun>, findingCount: number): string {
  if (findingCount > 0) {
    return `${findingCount} ranked hypothes${findingCount === 1 ? "is" : "es"} from ${explanation.nonVolatileChanges.length} relevant machine changes.`;
  }
  if (explanation.changes.length === 0) return "No machine changes were observed during this run.";
  return "Only volatile or background machine changes were observed during this run.";
}

function printNextChecks(context: CliContext): void {
  context.logger.raw(`  ${pc.dim("Next checks:")}`);
  context.logger.raw(`    · git diff / git status`);
  context.logger.raw(`    · lockfile and dependency changes`);
  context.logger.raw(`    · network, external services, and credentials`);
}
