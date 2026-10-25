import type { Command } from "commander";
import pc from "picocolors";
import { withContext, printJson } from "../cli/context.js";
import { formatBytes, formatRelativeTime } from "../core/util.js";

type Check = {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
};

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description("Check store health, baselines, warnings, and collector configuration")
    .action(async (_options: unknown, command: Command) => {
      await withContext(command, async (context) => {
        const stats = context.store.getStats();
        const latest = context.store.latestSnapshotMeta();
        const baseline = context.store.getActiveBaseline();
        const openCases = context.store.openCases();
        const checks: Check[] = [];
        checks.push({
          name: "Store",
          status: stats.snapshots > 0 ? "ok" : "warn",
          detail: `${context.home} · ${stats.snapshots} snapshots · ${formatBytes(stats.bytes)}`,
        });
        if (!latest) {
          checks.push({
            name: "Latest snapshot",
            status: "warn",
            detail: "No snapshots yet. Run `evd init`.",
          });
        } else {
          const age = Date.now() - latest.createdAt;
          checks.push({
            name: "Latest snapshot",
            status: age > 7 * 86_400_000 ? "warn" : "ok",
            detail: `${latest.id} · ${formatRelativeTime(latest.createdAt)}${latest.warnings.length ? ` · ${latest.warnings.length} warnings` : ""}`,
          });
        }
        checks.push({
          name: "Baseline",
          status: baseline ? "ok" : "warn",
          detail: baseline
            ? `${baseline.id} · ${baseline.snapshotId} · ${formatRelativeTime(baseline.createdAt)}`
            : "No active baseline. Run `evd baseline set`.",
        });
        checks.push({
          name: "Open cases",
          status: openCases.length > 0 ? "warn" : "ok",
          detail:
            openCases.length > 0
              ? `${openCases.length} open · ${openCases[0]?.id ?? ""}`
              : "None",
        });
        checks.push({
          name: "Collectors",
          status: "ok",
          detail: `${context.config.profile} profile · services ${onOff(context.config.collectors.services)} · tasks ${onOff(context.config.collectors.tasks)} · programs ${onOff(context.config.collectors.programs)} · extensions ${onOff(context.config.collectors.vscodeExtensions)}`,
        });
        checks.push({
          name: "Redaction",
          status: "ok",
          detail: `${context.config.redaction} · secret salt present`,
        });
        checks.push({
          name: "Platform",
          status: "ok",
          detail: `${process.platform} ${process.arch} · Node ${process.version}`,
        });
        if (latest?.warnings.length) {
          checks.push({
            name: "Collector warnings",
            status: "warn",
            detail: latest.warnings
              .slice(0, 3)
              .map((warning) => `${warning.collector}: ${warning.message}`)
              .join(" | "),
          });
        }
        if (context.json) {
          printJson({
            store: context.home,
            stats,
            latest,
            baseline,
            openCases: openCases.length,
            checks,
          });
          return;
        }
        context.logger.header(`Envidence doctor · ${context.home}`);
        for (const check of checks) {
          const icon =
            check.status === "ok" ? pc.green("✓") : check.status === "warn" ? pc.yellow("!") : pc.red("✗");
          context.logger.raw(`${icon} ${check.name.padEnd(20)} ${check.detail}`);
        }
      });
    });
}

function onOff(value: boolean): string {
  return value ? "on" : "off";
}
