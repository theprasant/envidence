import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import pc from "picocolors";
import type { CliContext } from "./context.js";
import { createSnapshot } from "../core/snapshot.js";
import { generateRollbackScript } from "../core/rollback.js";
import type { RollbackAction, RollbackPlan, RollbackRecord, Snapshot } from "../core/types.js";
import { formatDuration, truncate } from "../core/util.js";

export async function confirmWithWord(
  word: string,
  yes: boolean | undefined,
  action: string,
): Promise<void> {
  if (yes) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      `Refusing to ${action} without --yes in a non-interactive terminal. Review the plan, then rerun with --yes.`,
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `${pc.yellow("?")} Type ${pc.bold(word)} to ${action}, or anything else to abort: `,
    );
    if (answer.trim().toLowerCase() !== word) {
      throw new Error("Aborted. No changes were made.");
    }
  } finally {
    rl.close();
  }
}

export async function takeSafetySnapshot(
  context: CliContext,
  label: string,
): Promise<Snapshot> {
  const spinner = context.logger.spinner("Taking a safety snapshot before applying changes");
  const started = Date.now();
  try {
    const snapshot = await createSnapshot({
      store: context.store,
      config: context.config,
      cwd: process.cwd(),
      profile: "full",
      trigger: "pre_rollback",
      label,
      onProgress: (message) => spinner.update(message),
    });
    const duration = Date.now() - started;
    context.store.saveSnapshot(snapshot, { durationMs: duration, pinned: true });
    spinner.succeed(`Safety snapshot ${snapshot.id} captured in ${formatDuration(duration)}`);
    return snapshot;
  } catch (error) {
    spinner.fail("Safety snapshot failed; refusing to mutate the machine");
    throw error;
  }
}

export function writeScriptIfRequested(
  context: CliContext,
  plan: RollbackPlan,
  target: string | undefined,
  label = "Rollback script",
): string | null {
  if (!target) return null;
  const file = path.resolve(target);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, generateRollbackScript(plan, context.store), "utf8");
  if (!context.json) {
    context.logger.success(`${label} written to ${file}`);
  }
  return file;
}

export function printRollbackPlan(
  context: CliContext,
  plan: RollbackPlan,
  options: { title?: string; dryRun?: boolean } = {},
): void {
  context.logger.header(options.title ?? `Rollback plan · ${plan.id}`);
  context.logger.raw(
    `  ${pc.dim("Target")}   ${plan.targetSnapshot ?? "none"} ${pc.dim("→")} ${pc.dim("Current")} ${plan.currentSnapshot ?? "none"}`,
  );
  if (plan.caseId) context.logger.raw(`  ${pc.dim("Case")}     ${plan.caseId}`);
  if (plan.runId) context.logger.raw(`  ${pc.dim("Run")}      ${plan.runId}`);
  context.logger.raw(
    `  ${pc.dim("Actions")}  ${plan.actions.length} automatic · ${plan.manual.length} manual`,
  );

  if (plan.actions.length > 0) {
    context.logger.header("Automatic actions");
    for (const action of plan.actions) {
      const flags = [
        action.requiresAdmin ? pc.yellow("admin") : "",
        action.reversible ? "" : pc.red("not reversible"),
      ]
        .filter(Boolean)
        .join(" · ");
      context.logger.raw(
        `  ${pc.bold(action.id)}  ${pc.cyan(action.category)}  ${action.title}${flags ? `  ${pc.dim(`[${flags}]`)}` : ""}`,
      );
      context.logger.raw(`      ${pc.dim("before")} ${formatActionValue(action, "from")}`);
      context.logger.raw(`      ${pc.dim("after")}  ${formatActionValue(action, "to")}`);
    }
  } else {
    context.logger.info("No automatic actions are available for this selection.");
  }

  if (plan.manual.length > 0) {
    context.logger.header("Manual steps");
    for (const step of plan.manual) {
      context.logger.raw(`  ${pc.yellow("·")} ${step}`);
    }
  }
  if (plan.warnings.length > 0) {
    context.logger.header("Warnings");
    for (const warning of plan.warnings) {
      context.logger.raw(`  ${pc.yellow("!")} ${warning}`);
    }
  }
  if (options.dryRun) {
    context.logger.blank();
    context.logger.raw(
      pc.dim("Dry run only. Nothing was changed. Review, then rerun with --apply --yes."),
    );
  }
}

export function printApplyResult(context: CliContext, record: RollbackRecord): void {
  const title =
    record.status === "applied"
      ? `Rollback applied · ${record.id}`
      : `Rollback failed · ${record.id}`;
  context.logger.header(title);
  if (record.safetySnapshot) {
    context.logger.raw(`  ${pc.dim("Safety")} ${record.safetySnapshot}`);
  }
  for (const entry of record.log) {
    const icon =
      entry.status === "ok"
        ? pc.green("✓")
        : entry.status === "failed"
          ? pc.red("✗")
          : pc.dim("·");
    const duration =
      entry.durationMs === undefined ? "" : ` ${pc.dim(formatDuration(entry.durationMs))}`;
    context.logger.raw(`  ${icon} ${entry.message}${duration}`);
  }
  if (record.status === "applied") {
    context.logger.blank();
    context.logger.raw(
      `  ${pc.dim("Undo")} ${context.logger.cyan(`evd undo ${record.id} --yes`)}`,
    );
  } else {
    context.logger.blank();
    context.logger.raw(
      pc.yellow("Some actions failed. Review the output and the safety snapshot before retrying."),
    );
  }
}

function formatActionValue(action: RollbackAction, key: "from" | "to"): string {
  const value = action.payload[key];
  if (value === undefined || value === null) return pc.dim("(unset)");
  if (Array.isArray(value)) {
    if (value.length <= 4) return truncate(value.map(String).join(" ; "), 180);
    return `${value.length} entries · ${truncate(String(value[0]), 70)} … ${truncate(String(value[value.length - 1]), 70)}`;
  }
  if (typeof value === "object") {
    return truncate(JSON.stringify(value), 180);
  }
  return truncate(String(value), 180);
}
