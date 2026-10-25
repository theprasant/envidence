import type { Command } from "commander";
import { createSnapshot } from "../core/snapshot.js";
import { withContext, printJson } from "../cli/context.js";
import { printSnapshotSummary, printWarnings, snapshotCounts } from "../cli/format.js";
import { formatDuration } from "../core/util.js";

type InitOptions = {
  label?: string;
  fast?: boolean;
  baseline: boolean;
};

export function registerInit(program: Command): void {
  program
    .command("init")
    .description("Initialize the local store and take the first full snapshot")
    .option("--label <label>", "label for the baseline snapshot")
    .option("--fast", "use the fast collector profile")
    .option("--no-baseline", "do not mark the snapshot as the active baseline")
    .action(async (options: InitOptions, command: Command) => {
      await withContext(command, async (context) => {
        const profile = options.fast ? "fast" : context.config.profile;
        const spinner = context.logger.spinner(`Taking ${profile} snapshot of this machine`);
        const started = Date.now();
        try {
          const snapshot = await createSnapshot({
            store: context.store,
            config: context.config,
            cwd: process.cwd(),
            profile,
            trigger: "manual",
            label: options.label ?? "Initial baseline",
            onProgress: (message) => spinner.update(message),
          });
          const durationMs = Date.now() - started;
          const meta = context.store.saveSnapshot(snapshot, { durationMs });
          if (options.baseline) {
            context.store.setBaseline(snapshot.id, options.label ?? "Initial baseline");
          }
          context.store.logEvent("init", {
            snapshotId: snapshot.id,
            baseline: options.baseline,
            durationMs,
          });
          spinner.succeed(
            `Initialized ${context.home} in ${formatDuration(durationMs)}`,
          );
          if (context.json) {
            printJson({
              store: context.home,
              snapshot: meta,
              baseline: options.baseline
                ? context.store.getActiveBaseline()
                : null,
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
          context.logger.blank();
          context.logger.raw(
            `Next: ${context.logger.cyan("evd watch -- <command>")} to capture a change, or ${context.logger.cyan("evd diff")}.`,
          );
        } catch (error) {
          spinner.fail("Snapshot failed");
          throw error;
        }
      });
    });
}
