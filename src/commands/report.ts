import path from "node:path";
import type { Command } from "commander";
import pc from "picocolors";
import { printJson, withContext } from "../cli/context.js";
import { openLocalFile } from "../core/open.js";
import {
  buildReportData,
  writeReport,
  type ReportRedaction,
} from "../core/report.js";
import { formatBytes } from "../core/util.js";

type ReportOptions = {
  case?: string;
  run?: string;
  out?: string;
  redact?: string;
  open?: boolean;
};

const REDACTION_LEVELS: ReportRedaction[] = ["none", "standard", "strict"];

export function registerReport(program: Command): void {
  program
    .command("report")
    .description("Write a self-contained HTML case file")
    .option("--case <id>", "case to report (default: latest case)")
    .option("--run <id>", "run to report instead of a case")
    .option("--out <file>", "output HTML path")
    .option("--redact <level>", "none, standard, or strict", "standard")
    .option("--open", "open the report in the default browser")
    .action(async (options: ReportOptions, command: Command) => {
      if (options.case && options.run) {
        throw new Error("Use either --case or --run, not both.");
      }
      const redaction = parseRedaction(options.redact);
      await withContext(command, async (context) => {
        const data = buildReportData(context.store, context.config, {
          caseRef: options.case,
          runRef: options.run,
          redaction,
          home: context.home,
        });
        const output = path.resolve(
          options.out ??
            `evd-${(data.case?.id ?? data.run.id).replace(/[^A-Za-z0-9._-]/g, "-")}.html`,
        );
        const result = writeReport(output, data);
        if (result.bytes > 3 * 1024 * 1024) {
          context.logger.warn(
            `Report is ${formatBytes(result.bytes)}. Consider --redact strict or a narrower run.`,
          );
        }
        if (context.json) {
          printJson({
            file: result.file,
            bytes: result.bytes,
            redaction,
            case: data.case?.id ?? null,
            run: data.run.id,
            findings: data.findings.length,
          });
        } else {
          context.logger.header("Envidence report");
          context.logger.raw(`  ${pc.dim("File")}       ${pc.bold(result.file)}`);
          context.logger.raw(
            `  ${pc.dim("Size")}       ${formatBytes(result.bytes)} · ${data.changes.length} changes · ${data.findings.length} hypotheses`,
          );
          context.logger.raw(
            `  ${pc.dim("Redaction")}  ${redaction}${redaction === "none" ? pc.yellow(" · local viewing only") : ""}`,
          );
          const next = data.case
            ? `evd rollback --case ${data.case.id} --dry-run`
            : `evd why --run ${data.run.id}`;
          context.logger.raw(
            `  ${pc.dim("Next")}       ${context.logger.cyan(next)}`,
          );
          context.logger.raw(
            pc.dim("Generated locally. No data left this machine."),
          );
        }
        if (options.open) openLocalFile(result.file);
      });
    });
}

function parseRedaction(input: string | undefined): ReportRedaction {
  const value = (input ?? "standard").toLowerCase() as ReportRedaction;
  if (!REDACTION_LEVELS.includes(value)) {
    throw new Error(`Invalid redaction level: ${input}. Use none, standard, or strict.`);
  }
  return value;
}
