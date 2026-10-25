import type { Command } from "commander";
import { ensureConfig, resolveHome } from "../core/config.js";
import { Logger } from "../core/logger.js";
import { Store } from "../core/store.js";
import type { Config } from "../core/types.js";

export type GlobalOptions = {
  store?: string;
  json?: boolean;
  quiet?: boolean;
  verbose?: boolean;
};

export type CliContext = {
  home: string;
  config: Config;
  store: Store;
  logger: Logger;
  json: boolean;
};

export function createContext(command: Command): CliContext {
  const globals = command.optsWithGlobals() as GlobalOptions;
  const home = resolveHome(globals.store);
  const config = ensureConfig(home);
  const store = new Store(home);
  const logger = new Logger({
    json: globals.json === true,
    quiet: globals.quiet === true,
    verbose: globals.verbose === true,
  });
  return {
    home,
    config,
    store,
    logger,
    json: globals.json === true,
  };
}

export async function withContext<T>(
  command: Command,
  fn: (context: CliContext) => Promise<T> | T,
): Promise<T> {
  const context = createContext(command);
  try {
    return await fn(context);
  } finally {
    context.store.close();
  }
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function fail(message: string): never {
  throw new Error(message);
}
