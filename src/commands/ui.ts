import { existsSync } from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import pc from "picocolors";
import { DEMO_CASE_ID, seedDemo } from "../core/demo.js";
import { ensureConfig, resolveHome } from "../core/config.js";
import { Logger } from "../core/logger.js";
import { openLocalFile } from "../core/open.js";
import { startUiServer } from "../server/ui.js";

type UiOptions = {
  port?: string;
  open?: boolean;
  demo?: boolean;
};

export function registerUi(program: Command): void {
  program
    .command("ui")
    .description("Serve the local case-file dashboard on 127.0.0.1")
    .option("--port <n>", "port to bind (default: config ui.port or 4317)")
    .option("--no-open", "do not open the browser automatically")
    .option("--demo", "open the deterministic demo case")
    .action(async (options: UiOptions, command: Command) => {
      const globals = command.optsWithGlobals() as {
        store?: string;
        json?: boolean;
        quiet?: boolean;
        verbose?: boolean;
      };
      const logger = new Logger({
        json: globals.json === true,
        quiet: globals.quiet === true,
        verbose: globals.verbose === true,
      });
      const requestedHome = resolveHome(globals.store);
      ensureConfig(requestedHome);
      let home = requestedHome;
      if (options.demo) {
        const alreadyDemo = existsSync(path.join(requestedHome, "demo.json"));
        if (!alreadyDemo) {
          const seed = seedDemo(requestedHome);
          home = seed.home;
          ensureConfig(home);
        }
        logger.info(`Demo case ${DEMO_CASE_ID}`);
      }
      const port = parsePort(options.port);
      const ui = await startUiServer({ home, port });
      if (globals.json) {
        process.stdout.write(
          `${JSON.stringify({ url: ui.url, port: ui.port, home: ui.home }, null, 2)}\n`,
        );
      } else {
        logger.header("Envidence dashboard");
        logger.raw(`  ${pc.dim("Local")}   ${pc.bold(ui.url)}`);
        logger.raw(`  ${pc.dim("Store")}   ${ui.home}`);
        logger.raw(
          `  ${pc.dim("Access")}  token-protected · bound to 127.0.0.1 · no network calls`,
        );
        logger.raw(pc.dim("  Press Ctrl+C to stop."));
        logger.blank();
      }
      if (options.open !== false) openLocalFile(ui.url);
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
    });
}

function parsePort(input: string | undefined): number | undefined {
  if (!input) return undefined;
  const value = Number(input);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error(`Invalid port: ${input}`);
  }
  return value;
}
