#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { Command } from "commander";
import pc from "picocolors";
import { registerBaseline } from "./commands/baseline.js";
import { registerCase } from "./commands/case.js";
import { registerConfig } from "./commands/config.js";
import { registerDemo } from "./commands/demo.js";
import { registerDiff } from "./commands/diff.js";
import { registerDoctor } from "./commands/doctor.js";
import { registerFingerprint } from "./commands/fingerprint.js";
import { registerInit } from "./commands/init.js";
import { registerLog } from "./commands/log.js";
import { registerPrune } from "./commands/prune.js";
import { registerReport } from "./commands/report.js";
import { registerRollback } from "./commands/rollback.js";
import { registerSnap } from "./commands/snap.js";
import { registerUi } from "./commands/ui.js";
import { registerUndo } from "./commands/undo.js";
import { registerWatch } from "./commands/watch.js";
import { registerWhy } from "./commands/why.js";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

const program = new Command();

program
  .name("evd")
  .description("The black box for your dev machine")
  .version(packageJson.version, "-v, --version", "print the version")
  .option("--store <path>", "store directory (default: ENVIDENCE_HOME or the platform data dir)")
  .option("--json", "machine-readable JSON output")
  .option("--quiet", "suppress status messages")
  .option("--verbose", "show extra diagnostics")
  .showHelpAfterError();

registerInit(program);
registerSnap(program);
registerWatch(program);
registerWhy(program);
registerDemo(program);
registerDiff(program);
registerLog(program);
registerCase(program);
registerReport(program);
registerRollback(program);
registerUi(program);
registerUndo(program);
registerBaseline(program);
registerFingerprint(program);
registerDoctor(program);
registerConfig(program);
registerPrune(program);

program.exitOverride();

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    const commanderError = error as { code?: string; exitCode?: number; message?: string };
    if (
      commanderError.code === "commander.helpDisplayed" ||
      commanderError.code === "commander.version" ||
      commanderError.code === "commander.help"
    ) {
      return;
    }
    const message = commanderError.message ?? (error as Error).message ?? String(error);
    process.stderr.write(`${pc.red("✗")} ${message}\n`);
    if (process.argv.includes("--verbose") && error instanceof Error && error.stack) {
      process.stderr.write(`${pc.dim(error.stack)}\n`);
    }
    process.exitCode = commanderError.exitCode && commanderError.exitCode > 0 ? commanderError.exitCode : 1;
  }
}

await main();

export { program };
