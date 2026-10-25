import path from "node:path";
import type {
  Config,
  ListenerInfo,
  NetworkInfo,
  Snapshot,
  SnapshotWarning,
  WslInfo,
} from "./types.js";
import { collectBasic, basicFallback, collectNtp } from "../collectors/basic.js";
import { collectTools } from "../collectors/tools.js";
import { collectPackages } from "../collectors/packages.js";
import { collectSystem, emptySystem } from "../collectors/system.js";
import { collectListeners } from "../collectors/listeners.js";
import { collectConfigs } from "../collectors/configs.js";
import { collectProject } from "../collectors/project.js";
import { runProcess } from "./exec.js";
import { redactEnvRecord, redactText } from "./redact.js";
import { hashFile, isWindows, nowIso, snapshotId } from "./util.js";
import type { Store } from "./store.js";

export type CreateSnapshotOptions = {
  store: Store;
  config: Config;
  cwd: string;
  profile: "fast" | "full";
  trigger: Snapshot["trigger"];
  label?: string;
  id?: string;
  createdAt?: string;
  onProgress?: (message: string) => void;
};

export async function createSnapshot(options: CreateSnapshotOptions): Promise<Snapshot> {
  const warnings: SnapshotWarning[] = [];
  const progress = options.onProgress ?? (() => {});
  const createdAt = options.createdAt ?? nowIso();
  const profile = options.profile;

  progress("Collecting host, environment, and PATH");
  const [basicResult, toolsResult, listenersResult, projectResult] = await Promise.all([
    safe("basic", collectBasic, basicFallback()),
    safe("tools", collectTools, {} as Awaited<ReturnType<typeof collectTools>>),
    safe("listeners", collectListeners, { listeners: [], warnings: [] }),
    safe("project", () => collectProject(options.cwd, options.config), {
      project: null,
      warnings: [],
    }),
  ]);
  const basic = basicResult.value;
  warnings.push(...basicResult.warnings);
  warnings.push(...listenersResult.value.warnings);
  warnings.push(...projectResult.value.warnings);
  warnings.push(...toolsResult.warnings);

  const profilePaths = basic.shell.profiles.map((item) => item.path);
  progress("Collecting config hashes and package inventory");
  const [packagesResult, configsResult, systemResult] = await Promise.all([
    safe(
      "packages",
      () =>
        collectPackages(toolsResult.value, {
          profile,
          vscodeExtensions: options.config.collectors.vscodeExtensions,
          cargo: options.config.collectors.cargo,
          dotnet: options.config.collectors.dotnet,
        }),
      { packages: [], warnings: [] },
    ),
    safe("configs", () => Promise.resolve(collectConfigs(options.store, profilePaths)), {
      configs: [],
      warnings: [],
    }),
    profile === "full"
      ? safe("system", collectSystem, emptySystem())
      : Promise.resolve({ value: emptySystem(), warnings: [] }),
  ]);
  warnings.push(...packagesResult.value.warnings);
  warnings.push(...configsResult.value.warnings);
  warnings.push(...systemResult.value.warnings);
  warnings.push(...systemResult.warnings);

  progress("Finishing snapshot");
  const [ntp, wsl] = await Promise.all([
    profile === "full" ? safe("time", collectNtp, {}) : Promise.resolve({ value: {}, warnings: [] }),
    profile === "full" && options.config.collectors.wsl
      ? safe("wsl", collectWsl, [] as WslInfo[])
      : Promise.resolve({ value: [] as WslInfo[], warnings: [] }),
  ]);
  warnings.push(...ntp.warnings);
  warnings.push(...wsl.warnings);

  const hostsPath = isWindows
    ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "drivers", "etc", "hosts")
    : "/etc/hosts";
  const hostsHash = await hashFile(hostsPath);
  const envProxies: Record<string, string> = {};
  for (const key of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
  ]) {
    if (process.env[key]) envProxies[key] = redactText(process.env[key] as string);
  }
  const network: NetworkInfo = {
    proxies: {
      winhttp: basic.network.winhttp,
      ie: basic.network.ie,
      env: envProxies,
    },
    dnsServers: basic.network.dnsServers,
    hostsHash,
  };
  const system = systemResult.value;
  if (options.config.collectors.services === false) system.services = [];
  if (options.config.collectors.startup === false) system.startup = [];
  if (options.config.collectors.tasks === false) system.tasks = [];
  if (options.config.collectors.programs === false) system.programs = [];
  if (options.config.collectors.hotfixes === false) system.hotfixes = [];

  const snapshot: Snapshot = {
    schemaVersion: 1,
    id: options.id ?? snapshotId(),
    createdAt,
    label: options.label,
    trigger: options.trigger,
    profile,
    host: basic.host,
    env: {
      user: redactEnvRecord(basic.env.user, options.config.salt),
      machine: redactEnvRecord(basic.env.machine, options.config.salt),
      effective: redactEnvRecord(process.env, options.config.salt),
    },
    path: basic.path,
    tools: toolsResult.value,
    packages: packagesResult.value.packages,
    services: system.services,
    startup: system.startup,
    tasks: system.tasks,
    listeners: listenersResult.value.listeners,
    programs: system.programs,
    hotfixes: system.hotfixes,
    network,
    configs: configsResult.value.configs,
    shell: basic.shell,
    time: {
      ...basic.time,
      ntpStatus: "ntpStatus" in ntp.value ? ntp.value.ntpStatus : undefined,
      lastSync: "lastSync" in ntp.value ? ntp.value.lastSync : undefined,
    },
    disks: basic.disks,
    wsl: wsl.value,
    project: projectResult.value.project,
    warnings,
  };
  return snapshot;
}

async function safe<T>(
  collector: string,
  fn: () => Promise<T>,
  fallback: T,
): Promise<{ value: T; warnings: SnapshotWarning[] }> {
  try {
    const value = await fn();
    return { value, warnings: [] };
  } catch (error) {
    return {
      value: fallback,
      warnings: [
        {
          collector,
          message: `${collector} failed: ${(error as Error).message}`,
        },
      ],
    };
  }
}

async function collectWsl(): Promise<WslInfo[]> {
  if (!isWindows) return [];
  const result = await runProcess("wsl.exe", ["-l", "-v"], { timeoutMs: 5000 });
  if (result.code !== 0) return [];
  const decoded = result.stdout.includes("\0")
    ? Buffer.from(result.stdout, "utf8").toString("utf16le")
    : result.stdout;
  const out: WslInfo[] = [];
  for (const line of decoded.split(/\r?\n/)) {
    const trimmed = line.replace(/^\*/, "").trim();
    if (!trimmed || /^name\s+/i.test(trimmed)) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 3) continue;
    const version = parts[parts.length - 1] ?? "";
    if (!/^\d+$/.test(version)) continue;
    const state = parts[parts.length - 2] ?? "";
    const name = parts.slice(0, -2).join(" ");
    if (name) out.push({ name, state, version });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function listenerKey(listener: ListenerInfo): string {
  return `${listener.protocol}:${listener.port}`;
}
