import type { Command } from "commander";
import pc from "picocolors";
import { withContext, printJson } from "../cli/context.js";
import type { CliContext } from "../cli/context.js";
import { diffSnapshots } from "../core/diff.js";
import { formatRelativeTime, formatTimestamp } from "../core/util.js";
import type { BaselineRecord } from "../core/types.js";

type BaselineOptions = {
  label?: string;
};

export function registerBaseline(program: Command): void {
  const baseline = program
    .command("baseline")
    .description("Manage known-good baselines");

  baseline
    .command("set")
    .description("Mark a snapshot as the active baseline")
    .argument("[snapshot]", "snapshot ID, prefix, label, or latest", "latest")
    .option("--label <label>", "baseline label")
    .action(async (snapshotRef: string, options: BaselineOptions, command: Command) => {
      await withContext(command, async (context) => {
        const snapshot = context.store.getSnapshot(snapshotRef);
        const record = context.store.setBaseline(
          snapshot.id,
          options.label ?? "Known good",
        );
        context.store.logEvent("baseline.set", { baseline: record.id, snapshot: snapshot.id });
        if (context.json) {
          printJson({ baseline: record, snapshot: context.store.getSnapshotMeta(snapshot.id) });
          return;
        }
        context.logger.success(
          `Baseline ${pc.bold(record.id)} set to ${pc.bold(snapshot.id)} (${formatRelativeTime(record.createdAt)})`,
        );
      });
    });

  baseline
    .command("accept")
    .description("Accept the current machine state as the baseline")
    .argument("[snapshot]", "snapshot ID, prefix, label, or latest", "latest")
    .option("--label <label>", "baseline label")
    .action(async (snapshotRef: string, options: BaselineOptions, command: Command) => {
      await withContext(command, async (context) => {
        const snapshot = context.store.getSnapshot(snapshotRef);
        const record = context.store.setBaseline(snapshot.id, options.label ?? "Accepted current state");
        context.store.logEvent("baseline.accept", { baseline: record.id, snapshot: snapshot.id });
        if (context.json) {
          printJson({ baseline: record, snapshot: context.store.getSnapshotMeta(snapshot.id) });
          return;
        }
        context.logger.success(`Accepted ${snapshot.id} as the active baseline.`);
      });
    });

  baseline
    .command("show")
    .description("Show the active baseline and its current drift")
    .action(async (_options: unknown, command: Command) => {
      await withContext(command, async (context) => {
        const active = context.store.getActiveBaseline();
        if (!active) {
          if (context.json) {
            printJson({ baseline: null });
            return;
          }
          context.logger.info("No active baseline. Run `evd baseline set` or `evd init`.");
          return;
        }
        const baselineSnapshot = context.store.getSnapshot(active.snapshotId);
        const latestMeta = context.store.latestSnapshotMeta();
        let drift = 0;
        let driftChanges: ReturnType<typeof diffSnapshots> = [];
        if (latestMeta && latestMeta.id !== baselineSnapshot.id) {
          const latest = context.store.getSnapshot(latestMeta.id);
          driftChanges = diffSnapshots(baselineSnapshot, latest, {
            config: context.config,
            project: latest.project,
          });
          drift = driftChanges.filter((change) => !change.volatile).length;
        }
        if (context.json) {
          printJson({
            baseline: active,
            snapshot: context.store.getSnapshotMeta(active.snapshotId),
            latest: latestMeta,
            drift,
            changes: driftChanges,
          });
          return;
        }
        context.logger.raw(`${pc.bold(active.id)}  ${active.label}`);
        context.logger.raw(`  Snapshot   ${active.snapshotId}`);
        context.logger.raw(`  Set        ${formatTimestamp(active.createdAt)} (${formatRelativeTime(active.createdAt)})`);
        context.logger.raw(`  Latest     ${latestMeta?.id ?? "none"}`);
        context.logger.raw(`  Drift      ${drift} non-volatile change${drift === 1 ? "" : "s"}`);
      });
    });

  baseline
    .command("list")
    .description("List baselines")
    .option("--json", "JSON output")
    .action(async (options: { json?: boolean }, command: Command) => {
      await withContext(command, async (context) => {
        const baselines = context.store.listBaselines(50);
        if (context.json || options.json) {
          printJson({ baselines });
          return;
        }
        if (baselines.length === 0) {
          context.logger.info("No baselines yet.");
          return;
        }
        for (const item of baselines) {
          printBaselineLine(context, item);
        }
      });
    });
}

function printBaselineLine(context: CliContext, item: BaselineRecord): void {
  context.logger.raw(
    `${item.active ? pc.green("●") : pc.dim("○")} ${pc.bold(item.id)}  ${item.snapshotId}  ${formatRelativeTime(item.createdAt)}  ${item.label}`,
  );
}
