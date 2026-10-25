import type { Command } from "commander";
import { withContext, printJson } from "../cli/context.js";
import {
  confirmWithWord,
  printApplyResult,
  printRollbackPlan,
  takeSafetySnapshot,
  writeScriptIfRequested,
} from "../cli/rollback.js";
import { RealEnvironmentAdapter } from "../core/adapters.js";
import {
  applyRollbackPlan,
  invertRollbackPlan,
  preflightPlan,
} from "../core/rollback.js";
import type { RollbackRecord } from "../core/types.js";

type UndoOptions = {
  yes?: boolean;
  script?: string;
  failFast?: boolean;
};

export function registerUndo(program: Command): void {
  program
    .command("undo")
    .description("Undo a previously applied rollback")
    .argument("[rollback]", "rollback ID or prefix (default: latest applied)")
    .option("--yes", "skip the interactive confirmation")
    .option("--script <file>", "write a PowerShell/POSIX script for the inverse plan")
    .option("--fail-fast", "stop applying after the first failed action")
    .action(async (rollbackRef: string | undefined, options: UndoOptions, command: Command) => {
      await withContext(command, async (context) => {
        const original = resolveRollback(context.store, rollbackRef);
        const plan = invertRollbackPlan(original.plan);
        const scriptPath = writeScriptIfRequested(context, plan, options.script, "Undo script");

        if (!context.json) {
          context.logger.raw(
            `  ${context.logger.dim(`Undoing ${original.id} · original safety snapshot ${original.safetySnapshot ?? "none"}`)}`,
          );
          printRollbackPlan(context, plan, { title: `Undo plan · ${original.id}`, dryRun: false });
        }
        if (context.json && !options.yes) {
          throw new Error("--json with undo requires --yes so the prompt cannot corrupt JSON output.");
        }
        await confirmWithWord("undo", options.yes, "undo this rollback");
        const safety = await takeSafetySnapshot(context, `Before undo ${original.id}`);

        const record: RollbackRecord = {
          id: plan.id,
          createdAt: plan.createdAt,
          caseId: plan.caseId,
          runId: plan.runId,
          plan,
          status: "planned",
          safetySnapshot: safety.id,
          log: [],
        };
        const adapter = new RealEnvironmentAdapter(context.store);
        const preflightSpinner = context.logger.spinner("Checking undo preconditions");
        const conflicts = await preflightPlan(plan, adapter);
        if (conflicts.length === 0) preflightSpinner.succeed("Preconditions match");
        else preflightSpinner.stop();
        if (conflicts.length > 0) {
          record.status = "failed";
          record.log = conflicts.map((conflict) => ({
            actionId: conflict.actionId,
            status: "failed" as const,
            message: conflict.message,
            at: Date.now(),
          }));
          context.store.saveRollback(record);
          context.store.logEvent("rollback.undo_conflict", {
            rollback: record.id,
            original: original.id,
            conflicts: conflicts.map((conflict) => conflict.message),
          });
          if (context.json) {
            printJson({ original: original.id, plan, script: scriptPath, conflicts, record });
          } else {
            context.logger.header(`Undo preconditions changed · ${original.id}`);
            context.logger.raw("No actions were applied.");
            for (const conflict of conflicts) {
              context.logger.raw(`  ${context.logger.coral("✗")} ${conflict.message}`);
            }
          }
          process.exitCode = 1;
          return;
        }

        context.store.saveRollback(record);
        const applySpinner = context.logger.spinner("Applying undo actions");
        const result = await applyRollbackPlan(plan, adapter, {
          failFast: options.failFast,
          onProgress: (message) => applySpinner.update(message),
        });
        record.status = result.status;
        record.log = result.log;
        context.store.saveRollback(record);
        if (record.status === "applied") {
          context.store.saveRollback({ ...original, status: "undone" });
        }
        if (plan.caseId) context.store.setCaseRollback(plan.caseId, record.id);
        context.store.logEvent("rollback.undo", {
          rollback: record.id,
          original: original.id,
          status: record.status,
          safetySnapshot: safety.id,
        });
        applySpinner.succeed(
          record.status === "applied" ? "Undo applied" : "Undo completed with failures",
        );

        if (context.json) {
          printJson({
            original: original.id,
            plan,
            script: scriptPath,
            conflicts: [],
            record,
          });
        } else {
          printApplyResult(context, record);
        }
        if (record.status === "failed") process.exitCode = 1;
      });
    });
}

function resolveRollback(
  store: import("../core/store.js").Store,
  ref: string | undefined,
): RollbackRecord {
  const record = ref
    ? store.getRollback(ref)
    : store.listRollbacks(100).find((candidate) => candidate.status === "applied") ?? null;
  if (!record) {
    throw new Error(
      ref
        ? `Rollback not found: ${ref}`
        : "No applied rollback to undo. Use `evd rollback --case ... --apply --yes` first.",
    );
  }
  if (record.status === "undone") {
    throw new Error(`Rollback ${record.id} was already undone.`);
  }
  if (record.status !== "applied") {
    throw new Error(
      `Rollback ${record.id} has status ${record.status}; only an applied rollback can be undone.`,
    );
  }
  return record;
}
