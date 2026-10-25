import type { Command } from "commander";
import pc from "picocolors";
import { withContext, printJson } from "../cli/context.js";
import { formatBytes, formatRelativeTime } from "../core/util.js";

type PruneOptions = {
  keep: string;
  days: string;
  yes?: boolean;
};

export function registerPrune(program: Command): void {
  program
    .command("prune")
    .description("Delete old unprotected snapshots (dry run by default)")
    .option("--keep <n>", "always keep the newest N snapshots", "50")
    .option("--days <n>", "only delete snapshots older than N days", "30")
    .option("--yes", "actually delete; without this flag prune is a dry run")
    .action(async (options: PruneOptions, command: Command) => {
      await withContext(command, async (context) => {
        const keep = Math.max(1, Number.parseInt(options.keep, 10) || context.config.retention.keep);
        const days = Math.max(
          0,
          Number.parseInt(options.days, 10) || context.config.retention.olderThanDays,
        );
        const dryRun = options.yes !== true;
        const result = context.store.prune({ keep, olderThanDays: days, dryRun });
        if (!dryRun) {
          context.store.logEvent("prune", {
            keep,
            days,
            deleted: result.snapshotsDeleted,
            bytesFreed: result.bytesFreed,
          });
        }
        if (context.json) {
          printJson(result);
          return;
        }
        context.logger.header("Prune");
        context.logger.raw(`  Mode       ${dryRun ? pc.yellow("dry run") : pc.green("delete")}`);
        context.logger.raw(`  Keep       newest ${keep}`);
        context.logger.raw(`  Older than ${days} days`);
        context.logger.raw(`  Protected  ${result.protectedCount} snapshots`);
        if (result.candidates.length === 0) {
          context.logger.raw(`  ${pc.dim("Nothing eligible for deletion.")}`);
          return;
        }
        context.logger.raw(`  Candidates ${result.candidates.length} · ${formatBytes(result.bytesFreed)}`);
        for (const candidate of result.candidates.slice(0, 20)) {
          context.logger.raw(
            `    ${candidate.id}  ${formatRelativeTime(candidate.createdAt)}  ${formatBytes(candidate.sizeBytes)}  ${candidate.label ?? ""}`,
          );
        }
        if (dryRun) {
          context.logger.blank();
          context.logger.raw(`  ${pc.dim("Re-run with --yes to delete these snapshots.")}`);
        } else {
          context.logger.success(
            `Deleted ${result.snapshotsDeleted} snapshots and freed ${formatBytes(result.bytesFreed)}.`,
          );
        }
      });
    });
}
