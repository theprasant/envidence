import type { Command } from "commander";
import pc from "picocolors";
import { withContext, printJson } from "../cli/context.js";
import { printChanges } from "../cli/format.js";
import { diffSnapshots } from "../core/diff.js";
import type { Category, Change } from "../core/types.js";
import { formatRelativeTime } from "../core/util.js";

type DiffOptions = {
  category?: string;
  all?: boolean;
  search?: string;
  limit: string;
};

export function registerDiff(program: Command): void {
  program
    .command("diff")
    .description("Compare two snapshots (defaults to the last two)")
    .argument("[a]", "older snapshot ID, prefix, label, or latest")
    .argument("[b]", "newer snapshot ID, prefix, label, or latest")
    .option("--category <category>", "filter by category (comma-separated)")
    .option("--all", "include volatile/background changes")
    .option("--search <text>", "filter change labels, paths, and summaries")
    .option("--limit <n>", "maximum changes to print", "60")
    .action(async (a: string | undefined, b: string | undefined, options: DiffOptions, command: Command) => {
      await withContext(command, async (context) => {
        const { before, after } = resolvePair(context.store, a, b);
        const allChanges = diffSnapshots(before, after, {
          config: context.config,
          project: after.project ?? before.project,
        });
        let changes = allChanges;
        if (!options.all) changes = changes.filter((change) => !change.volatile);
        if (options.category) {
          const categories = options.category.split(",").map((item) => item.trim().toLowerCase());
          changes = changes.filter((change) => categories.includes(change.category));
        }
        if (options.search) {
          const needle = options.search.toLowerCase();
          changes = changes.filter((change) =>
            `${change.label} ${change.path} ${change.summary}`.toLowerCase().includes(needle),
          );
        }
        const summary = summarize(changes);
        if (context.json) {
          printJson({
            from: context.store.getSnapshotMeta(before.id),
            to: context.store.getSnapshotMeta(after.id),
            summary,
            changes,
          });
          return;
        }
        context.logger.header(
          `${before.id} ${pc.dim(formatRelativeTime(Date.parse(before.createdAt) || 0))} → ${after.id} ${pc.dim(formatRelativeTime(Date.parse(after.createdAt) || 0))}`,
        );
        const volatileHint = options.all ? "" : ` ${pc.dim("(volatile changes hidden; use --all)")}`;
        context.logger.raw(
          `  ${changes.length} change${changes.length === 1 ? "" : "s"}${volatileHint}`,
        );
        if (changes.length === 0) {
          context.logger.blank();
          context.logger.info("No machine changes detected between these snapshots.");
          context.logger.raw(pc.dim("  Git protects your code. Envidence protects the machine."));
          return;
        }
        context.logger.raw(
          `  ${Object.entries(summary)
            .map(([category, count]) => `${category} ${pc.dim(String(count))}`)
            .join(" · ")}`,
        );
        context.logger.blank();
        printChanges(context, changes, {
          limit: Number.parseInt(options.limit, 10) || 60,
          showOrigin: true,
          showVolatile: options.all,
        });
      });
    });
}

function resolvePair(
  store: {
    listSnapshots: (limit?: number) => Array<{ id: string }>;
    latestSnapshotId: () => string | null;
    getSnapshot: (ref: string) => import("../core/types.js").Snapshot;
  },
  a?: string,
  b?: string,
): { before: import("../core/types.js").Snapshot; after: import("../core/types.js").Snapshot } {
  if (a && b) {
    return { before: store.getSnapshot(a), after: store.getSnapshot(b) };
  }
  if (a) {
    const before = store.getSnapshot(a);
    const after = b ? store.getSnapshot(b) : store.getSnapshot("latest");
    if (before.id === after.id) {
      const previous = store.listSnapshots(2)[1];
      if (!previous) throw new Error("Need two snapshots to diff.");
      return { before: store.getSnapshot(previous.id), after };
    }
    return { before, after };
  }
  const snapshots = store.listSnapshots(2);
  if (snapshots.length < 2) {
    throw new Error("Need at least two snapshots. Run `evd snap` or `evd watch -- <command>` first.");
  }
  const latest = snapshots[0];
  const previous = snapshots[1];
  if (!latest || !previous) throw new Error("Need two snapshots to diff.");
  return { before: store.getSnapshot(previous.id), after: store.getSnapshot(latest.id) };
}

function summarize(changes: Change[]): Partial<Record<Category, number>> {
  const summary: Partial<Record<Category, number>> = {};
  for (const change of changes) {
    summary[change.category] = (summary[change.category] ?? 0) + 1;
  }
  return summary;
}
