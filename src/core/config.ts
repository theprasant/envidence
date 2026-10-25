import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { Config } from "./types.js";
import { isWindows } from "./util.js";

export const CONFIG_FILENAME = "config.json";

export function defaultConfig(): Config {
  return {
    schemaVersion: 1,
    profile: "full",
    salt: randomBytes(32).toString("hex"),
    retention: {
      keep: 50,
      olderThanDays: 30,
    },
    redaction: "standard",
    collectors: {
      services: true,
      startup: true,
      tasks: true,
      programs: true,
      hotfixes: true,
      vscodeExtensions: true,
      wsl: true,
      winget: false,
      cargo: true,
      dotnet: true,
    },
    noise: {
      ignore: [],
      ignoreServices: [
        "WaaSMedicSvc",
        "TrustedInstaller",
        "wuauserv",
        "UsoSvc",
        "BITS",
        "DoSvc",
      ],
      ephemeralPorts: true,
    },
    project: {
      scan: true,
      maxFiles: 200,
      maxBytes: 524_288,
    },
    ui: {
      port: 4317,
    },
    rollback: {
      requireConfirmation: true,
      safetySnapshot: true,
    },
    secretPatterns: [],
  };
}

export function defaultHome(): string {
  if (isWindows) {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, "Envidence");
  }
  const dataHome = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "envidence");
}

export function resolveHome(flag?: string): string {
  if (flag) return path.resolve(flag);
  const envHome = process.env.ENVIDENCE_HOME;
  if (envHome) return path.resolve(envHome);
  return defaultHome();
}

export function configPath(home: string): string {
  return path.join(home, CONFIG_FILENAME);
}

export function ensureHome(home: string): void {
  mkdirSync(home, { recursive: true });
  mkdirSync(path.join(home, "objects"), { recursive: true });
  mkdirSync(path.join(home, "logs"), { recursive: true });
}

export function loadConfig(home: string): Config {
  const file = configPath(home);
  const defaults = defaultConfig();
  if (!existsSync(file)) return defaults;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Could not read config at ${file}: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid config at ${file}: expected a JSON object.`);
  }
  const merged = deepMerge(defaults, parsed as Record<string, unknown>) as Config;
  if (merged.schemaVersion !== 1) {
    throw new Error(`Unsupported config schema version ${String(merged.schemaVersion)}.`);
  }
  if (!merged.salt) merged.salt = defaults.salt;
  return merged;
}

export function ensureConfig(home: string): Config {
  ensureHome(home);
  const file = configPath(home);
  if (!existsSync(file)) {
    const config = defaultConfig();
    saveConfig(home, config);
    return config;
  }
  return loadConfig(home);
}

export function saveConfig(home: string, config: Config): void {
  ensureHome(home);
  writeFileSync(configPath(home), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function getDotPath(config: Config, dotPath: string): unknown {
  const parts = dotPath.split(".").filter(Boolean);
  let current: unknown = config;
  for (const part of parts) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function setDotPath(config: Config, dotPath: string, rawValue: string): Config {
  const parts = dotPath.split(".").filter(Boolean);
  if (parts.length === 0) throw new Error("Config path cannot be empty.");
  const clone = structuredClone(config) as Record<string, unknown>;
  let current = clone;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index] as string;
    const next = current[part];
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1] as string;
  current[last] = parseConfigValue(rawValue);
  return clone as unknown as Config;
}

function parseConfigValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return raw;
    }
  }
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && trimmed !== "") return numeric;
  return raw;
}

function deepMerge(base: unknown, override: Record<string, unknown>): unknown {
  if (!base || typeof base !== "object" || Array.isArray(base)) {
    return override;
  }
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const existing = result[key];
    if (
      existing &&
      typeof existing === "object" &&
      !Array.isArray(existing) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      result[key] = deepMerge(existing, value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}
