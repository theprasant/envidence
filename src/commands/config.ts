import type { Command } from "commander";
import pc from "picocolors";
import { withContext, printJson } from "../cli/context.js";
import { configPath, getDotPath, saveConfig, setDotPath } from "../core/config.js";

export function registerConfig(program: Command): void {
  const config = program.command("config").description("Read or update Envidence configuration");

  config
    .command("path")
    .description("Print the configuration file path")
    .action(async (_options: unknown, command: Command) => {
      await withContext(command, async (context) => {
        if (context.json) {
          printJson({ path: configPath(context.home) });
          return;
        }
        context.logger.raw(configPath(context.home));
      });
    });

  config
    .command("get")
    .description("Print the configuration or a single value")
    .argument("[path]", "dot path, for example collectors.tasks")
    .action(async (dotPath: string | undefined, _options: unknown, command: Command) => {
      await withContext(command, async (context) => {
        const value = dotPath ? getDotPath(context.config, dotPath) : context.config;
        if (context.json) {
          printJson({ path: dotPath ?? null, value: value ?? null });
          return;
        }
        if (typeof value === "object" && value !== null) {
          context.logger.raw(JSON.stringify(value, null, 2));
          return;
        }
        context.logger.raw(value === undefined ? pc.dim("undefined") : String(value));
      });
    });

  config
    .command("list")
    .description("Print the full configuration")
    .action(async (_options: unknown, command: Command) => {
      await withContext(command, async (context) => {
        if (context.json) {
          printJson(context.config);
          return;
        }
        context.logger.raw(JSON.stringify(context.config, null, 2));
      });
    });

  config
    .command("set")
    .description("Set a configuration value")
    .argument("<path>", "dot path, for example profile or collectors.tasks")
    .argument("<value>", "value to set; booleans, numbers, arrays, and JSON are parsed")
    .action(async (dotPath: string, rawValue: string, _options: unknown, command: Command) => {
      await withContext(command, async (context) => {
        const updated = setDotPath(context.config, dotPath, rawValue);
        saveConfig(context.home, updated);
        const value = getDotPath(updated, dotPath);
        context.store.logEvent("config.set", { path: dotPath, value });
        if (context.json) {
          printJson({ path: dotPath, value: value ?? null });
          return;
        }
        context.logger.success(`${dotPath} = ${JSON.stringify(value ?? null)}`);
      });
    });
}
