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
  buildRollbackPlan,
  parseOnly,
  preflightPlan,
} from "../core/rollback.js";
import type { RollbackRecord } from "../core/types.js";

type RollbackOptions = {
  case?: string;
  run?: string;
  to?: string;
  change?: string;
  only?: string;
  dryRun?: boolean;
  apply?: boolean;
  yes?: boolean;
  script?: string;
  failFast?: boolean;
};

export function registerRollback(program: Command): void {
  program
    .command("rollback")
    .description("Plan or apply a reversal of machine changes")
    .option("--case <id>", "restore the reference snapshot for a case")
    .option("--run <id>", "restore the reference snapshot for a run")
    .option("--to <snapshot>", "restore a specific snapshot")
    .option("--change <signature>", "restore one change signature")
    .option("--only <categories>", "comma-separated categories to restore")
    .option("--dry-run", "print the plan without changing anything (default)")
    .option("--apply", "apply the plan")
    .option("--yes", "skip the interactive confirmation")
    .option("--script <file>", "write a PowerShell/POSIX script for the plan")
    .option("--fail-fast", "stop applying after the first failed action")
    .action(async (options: RollbackOptions, command: Command) => {
      if (options.dryRun && options.apply) {
        throw new Error("Use either --dry-run or --apply, not both.");
      }
      await withContext(command, async (context) => {
        const plan = buildRollbackPlan(context.store, context.config, {
          caseRef: options.case,
          runRef: options.run,
          toRef: options.to,
          changeSignature: options.change,
          only: parseOnly(options.only),
        });
        const scriptPath = writeScriptIfRequested(context, plan, options.script);
        const apply = options.apply === true;

        if (!apply) {
          if (context.json) {
            printJson({ plan, script: scriptPath });
          } else {
            printRollbackPlan(context, plan, { dryRun: true });
          }
          return;
        }

        if (context.json && !options.yes) {
          throw new Error("--json with --apply requires --yes so the prompt cannot corrupt JSON output.");
        }
        if (!context.json) {
          printRollbackPlan(context, plan, { dryRun: false });
        }
        await confirmWithWord("rollback", options.yes, "apply this rollback");
        const safety = await takeSafetySnapshot(context, `Before rollback ${plan.id}`);

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
        const preflightSpinner = context.logger.spinner("Checking rollback preconditions");
        let conflicts;
        try {
          conflicts = await preflightPlan(plan, adapter);
          if (conflicts.length === 0) preflightSpinner.succeed("Preconditions match");
          else preflightSpinner.stop();
        } catch (error) {
          preflightSpinner.fail("Precondition check failed");
          throw error;
        }
        if (conflicts.length > 0) {
          record.status = "failed";
          record.log = conflicts.map((conflict) => ({
            actionId: conflict.actionId,
            status: "failed" as const,
            message: conflict.message,
            at: Date.now(),
          }));
          context.store.saveRollback(record);
          if (plan.caseId) context.store.setCaseRollback(plan.caseId, record.id);
          context.store.logEvent("rollback.preflight_conflict", {
            rollback: record.id,
            conflicts: conflicts.map((conflict) => conflict.message),
          });
          if (context.json) {
            printJson({ plan, script: scriptPath, conflicts, record });
          } else {
            context.logger.header(`Preconditions changed · ${plan.id}`);
            context.logger.raw(
              "The machine no longer matches the recorded state. No actions were applied.",
            );
            for (const conflict of conflicts) {
              context.logger.raw(`  ${context.logger.coral("✗")} ${conflict.message}`);
            }
          }
          process.exitCode = 1;
          return;
        }

        context.store.saveRollback(record);
        const applySpinner = context.logger.spinner("Applying rollback actions");
        const result = await applyRollbackPlan(plan, adapter, {
          failFast: options.failFast,
          onProgress: (message) => applySpinner.update(message),
        });
        record.status = result.status;
        record.log = result.log;
        context.store.saveRollback(record);
        if (plan.caseId) context.store.setCaseRollback(plan.caseId, record.id);
        context.store.logEvent("rollback.apply", {
          rollback: record.id,
          caseId: plan.caseId,
          status: record.status,
          safetySnapshot: safety.id,
          failedActions: result.log.filter((entry) => entry.status === "failed").length,
        });
        applySpinner.succeed(
          result.status === "applied" ? "Rollback applied" : "Rollback completed with failures",
        );

        if (context.json) {
          printJson({ plan, script: scriptPath, conflicts: [], record });
        } else {
          printApplyResult(context, record);
        }
        if (record.status === "failed") process.exitCode = 1;
      });
    });
}
