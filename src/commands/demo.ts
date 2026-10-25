import path from "node:path";
import type { Command } from "commander";
import pc from "picocolors";
import { withContext, printJson } from "../cli/context.js";
import { printChanges, printFindings } from "../cli/format.js";
import { ensureConfig } from "../core/config.js";
import {
  DEMO_CASE_ID,
  DEMO_RUN_ID,
  DEMO_TOP_TITLE,
  seedDemo,
  type DemoSeed,
} from "../core/demo.js";
import { openLocalFile } from "../core/open.js";
import { buildReportData, writeReport } from "../core/report.js";
import { Store } from "../core/store.js";
import { formatBytes } from "../core/util.js";
import { startUiServer, type UiServer } from "../server/ui.js";

type DemoOptions = {
  reset?: boolean;
  ui?: boolean;
  report?: boolean;
  out?: string;
  open?: boolean;
};

export function registerDemo(program: Command): void {
  program
    .command("demo")
    .description("Seed and print the deterministic Envidence story")
    .option("--reset", "rebuild the isolated demo store")
    .option("--ui", "open the demo in the local dashboard")
    .option("--report", "write a self-contained HTML case file")
    .option("--out <file>", "report output path (with --report)")
    .option("--no-open", "do not open the browser automatically")
    .action(async (options: DemoOptions, command: Command) => {
      await withContext(command, async (context) => {
        const seed = seedDemo(context.home, { reset: options.reset });
        const top = seed.findings[0];
        const report = options.report
          ? writeDemoReport(seed, options.out)
          : null;
        const ui = options.ui
          ? await startUiServer({ home: seed.home })
          : null;
        if (ui && options.open !== false) openLocalFile(ui.url);

        if (context.json) {
          printJson({
            store: seed.home,
            case: seed.caseRecord,
            findings: seed.findings,
            changes: seed.changes,
            snapshots: seed.snapshots,
            runs: seed.runs,
            report,
            ui: ui ? { url: ui.url, port: ui.port } : null,
          });
          if (ui) await waitForUi(ui);
          return;
        }

        context.logger.header("Envidence demo · the machine layer Git ignores");
        context.logger.raw(
          `  ${pc.dim("It worked yesterday. Envidence knows what changed.")}`,
        );
        context.logger.raw(
          `  ${pc.dim("Git protects your code. Envidence protects the machine.")}`,
        );
        context.logger.blank();
        context.logger.raw(`  ${pc.dim("Demo store")} ${seed.home}`);
        context.logger.raw(
          `  ${pc.dim("Baseline")}   Last known good · ${pc.green("npm test passed")} · 12 files, 48 tests`,
        );
        context.logger.raw(
          `  ${pc.dim("Failure")}    ${pc.red("npm test failed")} · ${pc.dim(DEMO_RUN_ID)}`,
        );
        context.logger.raw(
          `  ${pc.dim("Case")}       ${pc.bold(DEMO_CASE_ID)} · ${seed.caseRecord.title}`,
        );

        if (top) {
          context.logger.blank();
          context.logger.raw(
            `  ${pc.red("TOP SUSPECT")} ${pc.bold(top.title)} ${pc.dim(`${top.score}/100 · ${top.confidence} confidence`)}`,
          );
          context.logger.raw(`  ${top.description}`);
          context.logger.raw(`  ${pc.dim(top.fix)}`);
        }
        if (seed.nonVolatileChanges.length > 0) {
          context.logger.header("What changed since the last successful run");
          printChanges(context, seed.nonVolatileChanges, {
            limit: 16,
            showOrigin: true,
            showVolatile: false,
          });
          const hidden = seed.changes.length - seed.nonVolatileChanges.length;
          if (hidden > 0) {
            context.logger.raw(pc.dim(`  … ${hidden} volatile/background change${hidden === 1 ? "" : "s"} hidden.`));
          }
        }
        if (seed.findings.length > 0) {
          printFindings(context, seed.findings, { limit: 5 });
        }
        context.logger.blank();
        context.logger.raw(
          `  ${pc.dim("Next")} ${pc.cyan(`evd why --store "${seed.home}"`)} · ${pc.cyan(`evd case show ${DEMO_CASE_ID} --store "${seed.home}"`)}`,
        );
        context.logger.raw(
          `  ${pc.dim("Open")} ${pc.cyan(`evd ui --demo --store "${seed.home}"`)} · ${pc.dim("Report")} ${pc.cyan(`evd report --case ${DEMO_CASE_ID} --store "${seed.home}"`)}`,
        );
        if (report) {
          context.logger.blank();
          context.logger.success(`Report written to ${report.file} (${formatBytes(report.bytes)})`);
        }
        if (ui) {
          context.logger.blank();
          context.logger.header("Envidence dashboard");
          context.logger.raw(`  ${pc.dim("Local")}   ${pc.bold(ui.url)}`);
          context.logger.raw(`  ${pc.dim("Access")}  token-protected · 127.0.0.1 only`);
          context.logger.raw(pc.dim("  Press Ctrl+C to stop."));
        }
        if (top && top.title !== DEMO_TOP_TITLE) {
          context.logger.warn(
            `Demo regression: expected top finding "${DEMO_TOP_TITLE}", got "${top.title}".`,
          );
        }
        if (ui) await waitForUi(ui);
      });
    });
}

function writeDemoReport(
  seed: DemoSeed,
  out: string | undefined,
): { file: string; bytes: number } {
  const config = ensureConfig(seed.home);
  const store = new Store(seed.home);
  try {
    const data = buildReportData(store, config, {
      caseRef: seed.caseRecord.id,
      redaction: "standard",
      home: seed.home,
    });
    const file = path.resolve(out ?? `evd-${seed.caseRecord.id}.html`);
    return writeReport(file, data);
  } finally {
    store.close();
  }
}

async function waitForUi(ui: UiServer): Promise<void> {
  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      ui.close().finally(resolve);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
