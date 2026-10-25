import type { Command } from "commander";
import Table from "cli-table3";
import pc from "picocolors";
import { withContext, printJson } from "../cli/context.js";
import type { CliContext } from "../cli/context.js";
import { printChanges, printFindings } from "../cli/format.js";
import { explainRun } from "../core/run.js";
import type { CaseRecord } from "../core/types.js";
import { formatDuration, formatRelativeTime, truncate } from "../core/util.js";

type CaseListOptions = {
  open?: boolean;
  limit: string;
};

type CaseCloseOptions = {
  summary?: string;
};

export function registerCase(program: Command): void {
  const caseCommand = program
    .command("case")
    .description("List, inspect, or close investigation cases");

  caseCommand
    .command("list")
    .description("List cases")
    .option("--open", "only show open cases")
    .option("--limit <n>", "number of cases", "20")
    .action(async (options: CaseListOptions, command: Command) => {
      await withContext(command, async (context) => {
        const limit = Math.max(1, Number.parseInt(options.limit, 10) || 20);
        const cases = options.open
          ? context.store.openCases().slice(0, limit)
          : context.store.listCases(limit);
        if (context.json) {
          printJson({ cases });
          return;
        }
        printCaseTable(context, cases);
      });
    });

  caseCommand
    .command("show")
    .description("Show a case, its hypotheses, and the recorded changes")
    .argument("<case>", "case ID or prefix")
    .action(async (caseRef: string, _options: unknown, command: Command) => {
      await withContext(command, async (context) => {
        const caseRecord = requireCase(context, caseRef);
        const run = context.store.getRun(caseRecord.runId);
        if (!run) throw new Error(`Run for case ${caseRecord.id} is missing.`);
        const explanation = run.postSnapshot
          ? explainRun(context.store, context.config, run, {
              includeVolatile: false,
            })
          : null;
        const findings =
          caseRecord.findings.length > 0
            ? caseRecord.findings
            : (explanation?.findings ?? []);
        if (context.json) {
          printJson({
            case: caseRecord,
            run,
            reference: explanation
              ? {
                  snapshot: explanation.reference.id,
                  source: explanation.referenceSource,
                }
              : null,
            changes: explanation?.changes ?? [],
            findings,
          });
          return;
        }
        printCaseHeader(context, caseRecord);
        context.logger.header("Command");
        context.logger.raw(`  ${pc.bold(run.command)}`);
        context.logger.raw(
          `  ${pc.dim("Exit")} ${run.exitCode === 0 ? pc.green("0") : pc.red(String(run.exitCode ?? "?"))} · ${formatDuration(run.durationMs)} · ${formatRelativeTime(run.startedAt)}`,
        );
        if (explanation) {
          context.logger.raw(
            `  ${pc.dim("Reference")} ${explanation.reference.id} ${pc.dim(`(${explanation.referenceSource === "pre" ? "before this run" : explanation.referenceSource})`)}`,
          );
        }
        if (findings.length > 0) {
          printFindings(context, findings, { limit: 8 });
        } else {
          context.logger.blank();
          context.logger.info(
            "No non-volatile machine changes were observed during this run.",
          );
        }
        if (explanation && explanation.changes.length > 0) {
          context.logger.header("Observed changes");
          printChanges(context, explanation.nonVolatileChanges, {
            limit: 24,
            showOrigin: true,
            showVolatile: false,
          });
          const hidden = explanation.changes.length - explanation.nonVolatileChanges.length;
          if (hidden > 0) {
            context.logger.raw(pc.dim(`  … ${hidden} volatile changes hidden.`));
          }
        }
        if (caseRecord.summary) {
          context.logger.header("Summary");
          context.logger.raw(`  ${caseRecord.summary}`);
        }
        const stderrTail = run.stderrTail?.trim();
        if (stderrTail) {
          context.logger.header("Last stderr lines");
          for (const line of stderrTail.split(/\r?\n/).filter(Boolean).slice(-8)) {
            context.logger.raw(`  ${pc.dim(truncate(line, 200))}`);
          }
        }
        context.logger.blank();
        context.logger.raw(
          `  ${pc.dim("Report")} ${context.logger.cyan(`evd report --case ${caseRecord.id}`)} · ${pc.dim("Rollback")} ${context.logger.cyan(`evd rollback --case ${caseRecord.id} --dry-run`)}`,
        );
      });
    });

  caseCommand
    .command("close")
    .description("Close a case with an optional summary")
    .argument("<case>", "case ID or prefix")
    .option("--summary <text>", "resolution summary")
    .action(async (caseRef: string, options: CaseCloseOptions, command: Command) => {
      await withContext(command, async (context) => {
        const caseRecord = requireCase(context, caseRef);
        context.store.closeCase(caseRecord.id, options.summary);
        context.store.logEvent("case.close", {
          caseId: caseRecord.id,
          summary: options.summary ?? null,
        });
        const updated = context.store.getCase(caseRecord.id);
        if (context.json) {
          printJson({ case: updated });
          return;
        }
        context.logger.success(
          `Closed ${caseRecord.id}${options.summary ? `: ${options.summary}` : ""}`,
        );
      });
    });
}

function requireCase(context: CliContext, ref: string): CaseRecord {
  const caseRecord = context.store.getCase(ref);
  if (!caseRecord) throw new Error(`Case not found: ${ref}`);
  return caseRecord;
}

function printCaseHeader(context: CliContext, caseRecord: CaseRecord): void {
  const status = caseRecord.status === "open" ? pc.yellow("open") : pc.dim("closed");
  context.logger.header(`Envidence case · ${caseRecord.id}`);
  context.logger.raw(`  ${pc.dim("Status")}  ${status} · ${formatRelativeTime(caseRecord.createdAt)}`);
  context.logger.raw(`  ${pc.dim("Title")}   ${pc.bold(caseRecord.title)}`);
}

function printCaseTable(context: CliContext, cases: CaseRecord[]): void {
  if (cases.length === 0) {
    context.logger.info("No cases yet. A failing `evd watch` opens one.");
    return;
  }
  const table = new Table({
    head: ["Case", "Status", "When", "Exit", "Title"],
    style: { head: [], border: [] },
    colWidths: [22, 8, 12, 6, 58],
    wordWrap: false,
  });
  for (const caseRecord of cases) {
    const run = context.store.getRun(caseRecord.runId);
    table.push([
      caseRecord.id,
      caseRecord.status === "open" ? pc.yellow("open") : pc.dim("closed"),
      formatRelativeTime(caseRecord.createdAt),
      run?.exitCode === 0 ? pc.green("0") : pc.red(String(run?.exitCode ?? "?")),
      truncate(caseRecord.title, 56),
    ]);
  }
  context.logger.raw(table.toString());
}
