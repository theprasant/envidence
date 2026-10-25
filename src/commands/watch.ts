import type { Command } from "commander";
import pc from "picocolors";
import { withContext, printJson } from "../cli/context.js";
import type { CliContext } from "../cli/context.js";
import { printChanges, printFindings } from "../cli/format.js";
import { runInteractive } from "../core/child.js";
import { invalidateToolVersionCache } from "../collectors/tools.js";
import { createSnapshot } from "../core/snapshot.js";
import {
  commandSignature,
  commandToString,
  explainRun,
  openCaseForRun,
  tailText,
} from "../core/run.js";
import type { CaseRecord, RunRecord, Snapshot } from "../core/types.js";
import { formatDuration, formatRelativeTime, runId, truncate } from "../core/util.js";

type WatchOptions = {
  label?: string;
  full?: boolean;
  why: boolean;
  captureOutput?: boolean;
  timeout: string;
};

export function registerWatch(program: Command): void {
  program
    .command("watch")
    .description("Run a command between two snapshots and explain any machine changes")
    .argument("[command...]", "command and arguments; put -- before the command")
    .option("--label <text>", "label this run")
    .option("--full", "use full snapshots before and after")
    .option("--no-why", "record the run but skip ranked hypotheses and case opening")
    .option("--capture-output", "keep more of the child stdout/stderr output")
    .option("--timeout <s>", "kill the command after N seconds (0 means no timeout)", "0")
    .allowUnknownOption(true)
    .action(async (rawArgs: string[] | undefined, options: WatchOptions, command: Command) => {
      let exitCode = 0;
      await withContext(command, async (context) => {
        const args = normalizeArgs(rawArgs ?? []);
        if (args.length === 0) {
          throw new Error("Usage: evd watch [options] -- <command...>");
        }
        const commandText = commandToString(args);
        const profile = options.full ? "full" : "fast";
        const baseLabel = truncate(options.label ?? `watch: ${commandText}`, 90);

        const preSpinner = context.logger.spinner(`Capturing pre-command state (${profile})`);
        const preStarted = Date.now();
        let pre: Snapshot;
        try {
          pre = await createSnapshot({
            store: context.store,
            config: context.config,
            cwd: process.cwd(),
            profile,
            trigger: "watch",
            label: `${baseLabel} (before)`,
            onProgress: (message) => preSpinner.update(message),
          });
          const preDuration = Date.now() - preStarted;
          context.store.saveSnapshot(pre, { durationMs: preDuration });
          preSpinner.succeed(`Before ${pre.id} captured in ${formatDuration(preDuration)}`);
        } catch (error) {
          preSpinner.fail("Pre-command snapshot failed");
          throw error;
        }

        const projectId = pre.project?.id ?? null;
        const signature = commandSignature(commandText, process.cwd());
        const cutoff = preStarted - 1;
        const reference = context.store.findReference(projectId, signature, cutoff);
        const startedAt = Date.now();
        const run: RunRecord = {
          id: runId(),
          command: commandText,
          commandSignature: signature,
          cwd: process.cwd(),
          projectId,
          preSnapshot: pre.id,
          postSnapshot: null,
          exitCode: null,
          signal: null,
          startedAt,
          durationMs: 0,
          stderrTail: null,
          stdoutTail: null,
          referenceSnapshot: reference.snapshotId,
          changeSignatures: [],
        };
        context.store.saveRun(run);

        if (!context.json) {
          context.logger.step(`Running ${pc.bold(commandText)}`);
        }
        const child = await runInteractive(args[0] as string, args.slice(1), {
          cwd: process.cwd(),
          env: process.env,
          timeoutMs: Math.max(0, Number.parseInt(options.timeout, 10) || 0) * 1000,
          captureLimit: options.captureOutput ? 256 * 1024 : 24 * 1024,
          onStdout: (chunk) => {
            if (context.json) process.stderr.write(chunk);
            else process.stdout.write(chunk);
          },
          onStderr: (chunk) => process.stderr.write(chunk),
        });

        const failed = child.code !== 0 || Boolean(child.error) || child.timedOut;
        const effectiveCode = child.timedOut
          ? 124
          : child.interrupted
            ? 130
            : child.code === null
              ? 1
              : child.code;
        exitCode = child.interrupted ? 130 : effectiveCode;

        if (!context.json) {
          const detail = child.error
            ? child.error
            : child.timedOut
              ? "timed out"
              : child.signal
                ? `signal ${child.signal}`
                : `exit ${child.code ?? "?"}`;
          const line = `${failed ? pc.red("✗") : pc.green("✓")} Command finished in ${formatDuration(child.durationMs)} · ${detail}`;
          process.stdout.write(`${line}\n`);
        }

        if (shouldRefreshToolVersions(commandText)) invalidateToolVersionCache();

        const postSpinner = context.logger.spinner(`Capturing post-command state (${profile})`);
        const postStarted = Date.now();
        let post: Snapshot | null = null;
        try {
          post = await createSnapshot({
            store: context.store,
            config: context.config,
            cwd: process.cwd(),
            profile,
            trigger: "watch",
            label: `${baseLabel} (after)`,
            onProgress: (message) => postSpinner.update(message),
          });
          const postDuration = Date.now() - postStarted;
          context.store.saveSnapshot(post, { durationMs: postDuration });
          postSpinner.succeed(`After ${post.id} captured in ${formatDuration(postDuration)}`);
        } catch (error) {
          postSpinner.fail("Post-command snapshot failed");
          context.store.updateRun(run.id, {
            exitCode: effectiveCode,
            signal: child.signal,
            durationMs: child.durationMs,
            stderrTail: tailText(child.stderr),
            stdoutTail: tailText(child.stdout),
          });
          context.store.logEvent("watch.post_failed", {
            runId: run.id,
            message: (error as Error).message,
          });
          throw error;
        }

        context.store.updateRun(run.id, {
          postSnapshot: post.id,
          exitCode: effectiveCode,
          signal: child.signal,
          durationMs: child.durationMs,
          stderrTail: tailText(child.stderr),
          stdoutTail: tailText(child.stdout),
          changeSignatures: [],
        });
        const updatedRun = context.store.getRun(run.id) ?? {
          ...run,
          postSnapshot: post.id,
          exitCode: effectiveCode,
          signal: child.signal,
          durationMs: child.durationMs,
          stderrTail: tailText(child.stderr),
          stdoutTail: tailText(child.stdout),
        };
        const explanation = explainRun(context.store, context.config, updatedRun);
        context.store.updateRun(run.id, {
          changeSignatures: explanation.changes.map((change) => change.signature),
        });
        updatedRun.changeSignatures = explanation.changes.map((change) => change.signature);
        context.store.recordChangeObservation(explanation.changes, failed);

        let caseRecord: CaseRecord | null = null;
        if (failed && options.why) {
          caseRecord = openCaseForRun(context.store, updatedRun, explanation);
        }
        context.store.logEvent("watch", {
          runId: updatedRun.id,
          exitCode: effectiveCode,
          durationMs: child.durationMs,
          changes: explanation.changes.length,
          caseId: caseRecord?.id ?? null,
        });

        if (context.json) {
          printJson({
            run: updatedRun,
            reference: {
              snapshot: reference.snapshotId,
              source: reference.snapshotId ? explanation.referenceSource : "none",
            },
            pre: context.store.getSnapshotMeta(pre.id),
            post: context.store.getSnapshotMeta(post.id),
            changes: explanation.changes,
            findings: explanation.findings,
            case: caseRecord,
          });
          return;
        }

        context.logger.header(`Run ${updatedRun.id}`);
        context.logger.raw(
          `  ${pc.dim("Command")}  ${commandText}\n  ${pc.dim("Exit")}     ${failed ? pc.red(String(effectiveCode)) : pc.green("0")} · ${formatDuration(child.durationMs)} · ${formatRelativeTime(updatedRun.startedAt)}`,
        );
        if (reference.snapshotId) {
          context.logger.raw(
            `  ${pc.dim("Reference")} ${reference.snapshotId} ${pc.dim(`(${explanation.referenceSource === "pre" ? "before this run" : explanation.referenceSource})`)}`,
          );
        }
        const volatileCount = explanation.changes.length - explanation.nonVolatileChanges.length;
        context.logger.blank();
        if (explanation.changes.length === 0) {
          context.logger.info("No machine changes were observed during the command window.");
          printNoChangeAdvice(context);
        } else {
          const hidden = volatileCount > 0 ? ` ${pc.dim(`(${volatileCount} volatile hidden)`)}` : "";
          context.logger.raw(
            `  ${explanation.nonVolatileChanges.length} relevant change${explanation.nonVolatileChanges.length === 1 ? "" : "s"}${hidden}`,
          );
          printChanges(context, explanation.nonVolatileChanges, {
            limit: 12,
            showOrigin: true,
            showVolatile: false,
          });
        }

        if (options.why) {
          if (explanation.findings.length > 0) {
            printFindings(context, explanation.findings, { limit: 5 });
          } else if (failed) {
            context.logger.header("Ranked hypotheses");
            context.logger.info("No non-volatile machine changes to rank.");
            printNoChangeAdvice(context);
          }
        } else {
          context.logger.blank();
          context.logger.info("Hypotheses skipped (--no-why).");
        }

        if (caseRecord) {
          context.logger.blank();
          context.logger.raw(
            `${pc.yellow("Case")} ${pc.bold(caseRecord.id)} · ${caseRecord.title}`,
          );
          if (!context.json) {
            context.logger.raw(
              `  ${pc.dim("Inspect")} ${context.logger.cyan(`evd case show ${caseRecord.id}`)} · ${pc.dim("Report")} ${context.logger.cyan(`evd report --case ${caseRecord.id}`)}`,
            );
          }
        } else if (!failed) {
          context.logger.blank();
          context.logger.raw(pc.dim("  No case opened: the command succeeded."));
        }
      });
      process.exitCode = exitCode;
    });
}

function normalizeArgs(raw: string[]): string[] {
  const args = [...raw];
  while (args[0] === "--") args.shift();
  return args;
}

function shouldRefreshToolVersions(command: string): boolean {
  return (
    /\b(npm|pnpm|yarn|bun|pip|pip3|uv|cargo|dotnet|code|winget|choco|scoop)\b.*\b(install|uninstall|update|upgrade|add|remove|use)\b/i.test(
      command,
    ) ||
    /\b(install|uninstall|update|upgrade|add|remove)\b.*\b(npm|pnpm|yarn|bun|pip|pip3|uv|cargo|dotnet|code|winget|choco|scoop)\b/i.test(
      command,
    )
  );
}

function printNoChangeAdvice(context: CliContext): void {
  context.logger.blank();
  context.logger.raw(`  ${pc.dim("Next checks:")}`);
  context.logger.raw(`    · git diff / git status`);
  context.logger.raw(`    · lockfile and dependency changes`);
  context.logger.raw(`    · network, external services, and credentials`);
}
