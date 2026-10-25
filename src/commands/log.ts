import type { Command } from "commander";
import { withContext, printJson } from "../cli/context.js";
import { printSnapshotTable, printRunTable } from "../cli/format.js";

type LogOptions = {
  limit: string;
  runs?: boolean;
  cases?: boolean;
};

export function registerLog(program: Command): void {
  program
    .command("log")
    .description("List recent snapshots, runs, or cases")
    .option("--limit <n>", "number of entries", "20")
    .option("--runs", "show runs instead of snapshots")
    .option("--cases", "show cases instead of snapshots")
    .action(async (options: LogOptions, command: Command) => {
      await withContext(command, async (context) => {
        const limit = Math.max(1, Number.parseInt(options.limit, 10) || 20);
        if (options.cases) {
          const cases = context.store.listCases(limit);
          if (context.json) {
            printJson({ cases });
            return;
          }
          if (cases.length === 0) {
            context.logger.info("No cases yet. A failing `evd watch` opens one.");
            return;
          }
          for (const caseRecord of cases) {
            context.logger.raw(
              `${caseRecord.id}  ${caseRecord.status === "open" ? "[open]" : "[closed]"}  ${caseRecord.title}`,
            );
          }
          return;
        }
        if (options.runs) {
          const runs = context.store.listRuns(limit);
          if (context.json) {
            printJson({ runs });
            return;
          }
          printRunTable(context, runs);
          return;
        }
        const snapshots = context.store.listSnapshots(limit);
        if (context.json) {
          printJson({ snapshots });
          return;
        }
        printSnapshotTable(context, snapshots);
      });
    });
}
