import type { Command } from "commander";
import { createSnapshot } from "../core/snapshot.js";
import { withContext, printJson } from "../cli/context.js";
import { printSnapshotSummary, printWarnings, snapshotCounts } from "../cli/format.js";
import { formatDuration } from "../core/util.js";

type SnapOptions = {
  fast?: boolean;
  full?: boolean;
  profile?: "fast" | "full";
  label?: string;
  pin?: boolean;
};

export function registerSnap(program: Command): void {
  program
    .command("snap")
    .description("Take a snapshot without running a command")
    .option("--fast", "use the fast collector profile")
    .option("--full", "use the full collector profile")
    .option("--profile <profile>", "collector profile: fast or full")
    .option("--label <label>", "attach a label to this snapshot")
    .option("--pin", "keep this snapshot during pruning")
    .action(async (options: SnapOptions, command: Command) => {
      await withContext(command, async (context) => {
        const profile = resolveProfile(options, context.config.profile);
        const spinner = context.logger.spinner(`Taking ${profile} snapshot`);
        const started = Date.now();
        try {
          const snapshot = await createSnapshot({
            store: context.store,
            config: context.config,
            cwd: process.cwd(),
            profile,
            trigger: "manual",
            label: options.label,
            onProgress: (message) => spinner.update(message),
          });
          const durationMs = Date.now() - started;
          const meta = context.store.saveSnapshot(snapshot, {
            durationMs,
            pinned: options.pin,
          });
          context.store.logEvent("snap", { snapshotId: snapshot.id, profile, durationMs });
          spinner.succeed(`Snapshot ${snapshot.id} saved in ${formatDuration(durationMs)}`);
          if (context.json) {
            printJson({
              store: context.home,
              snapshot: meta,
              counts: snapshotCounts(snapshot),
              durationMs,
            });
            return;
          }
          printSnapshotSummary(context, snapshot, meta, {
            storePath: context.home,
            durationMs,
          });
          printWarnings(context, snapshot.warnings);
        } catch (error) {
          spinner.fail("Snapshot failed");
          throw error;
        }
      });
    });
}

function resolveProfile(
  options: SnapOptions,
  fallback: "fast" | "full",
): "fast" | "full" {
  if (options.profile === "fast" || options.profile === "full") return options.profile;
  if (options.fast) return "fast";
  if (options.full) return "full";
  return fallback;
}
