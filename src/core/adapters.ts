import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { whichAll, runPowerShell, runProcess } from "./exec.js";
import type { Store } from "./store.js";
import { isWindows, sha256 } from "./util.js";

export type EnvScope = "user" | "machine";
export type RollbackPackageManager = "npm" | "pip" | "cargo" | "vscode";
export type StartupScope = "user" | "machine" | "startup-folder";

export type ServiceState = {
  state: string;
  startMode: string;
};

export type TaskState = {
  state: string;
};

export type StartupState = {
  command: string;
  enabled: boolean;
};

/**
 * All machine mutations go through this interface. Unit tests use the in-memory
 * fake below and never touch the real environment.
 */
export interface EnvironmentAdapter {
  readonly platform: "win32" | "posix";
  getEnv(name: string, scope: EnvScope): Promise<string | null>;
  setEnv(name: string, value: string, scope: EnvScope): Promise<void>;
  unsetEnv(name: string, scope: EnvScope): Promise<void>;
  getPath(scope: EnvScope): Promise<string[]>;
  setPath(scope: EnvScope, entries: string[]): Promise<void>;
  getPackageVersion(manager: RollbackPackageManager, name: string): Promise<string | null>;
  installPackage(
    manager: RollbackPackageManager,
    name: string,
    version: string | null,
  ): Promise<void>;
  uninstallPackage(manager: RollbackPackageManager, name: string): Promise<void>;
  getFileHash(filePath: string): Promise<string | null>;
  readBlob(hash: string): Buffer | null;
  writeFile(filePath: string, content: string): Promise<void>;
  deleteFile(filePath: string): Promise<void>;
  getService(name: string): Promise<ServiceState | null>;
  setService(name: string, state: string, startMode?: string): Promise<void>;
  getTask(taskPath: string, name: string): Promise<TaskState | null>;
  setTaskState(taskPath: string, name: string, enabled: boolean): Promise<void>;
  getStartup(scope: StartupScope, name: string): Promise<StartupState | null>;
  setStartup(scope: StartupScope, name: string, command: string, enabled: boolean): Promise<void>;
  removeStartup(scope: StartupScope, name: string): Promise<void>;
}

export class RealEnvironmentAdapter implements EnvironmentAdapter {
  readonly platform: "win32" | "posix" = isWindows ? "win32" : "posix";
  private readonly store: Store;
  private readonly commandCache = new Map<string, string>();
  private readonly packageCache = new Map<string, Map<string, string>>();

  constructor(store: Store) {
    this.store = store;
  }

  async getEnv(name: string, scope: EnvScope): Promise<string | null> {
    if (!isWindows) return process.env[name] ?? null;
    const value = await this.powerShellScalar(
      `[Environment]::GetEnvironmentVariable('${psQuote(name)}', '${scope === "user" ? "User" : "Machine"}')`,
    );
    return value || null;
  }

  async setEnv(name: string, value: string, scope: EnvScope): Promise<void> {
    if (!isWindows) {
      throw new Error(
        "Persistent environment changes are Windows-first in v1. Use the generated script in your shell profile.",
      );
    }
    await this.powerShell(
      `[Environment]::SetEnvironmentVariable('${psQuote(name)}', '${psQuote(value)}', '${scope === "user" ? "User" : "Machine"}')`,
    );
  }

  async unsetEnv(name: string, scope: EnvScope): Promise<void> {
    if (!isWindows) {
      throw new Error("Persistent environment changes are not supported on POSIX in v1.");
    }
    await this.powerShell(
      `[Environment]::SetEnvironmentVariable('${psQuote(name)}', $null, '${scope === "user" ? "User" : "Machine"}')`,
    );
  }

  async getPath(scope: EnvScope): Promise<string[]> {
    if (!isWindows) {
      return (process.env.PATH ?? "").split(":").filter(Boolean);
    }
    return splitPath(await this.getEnv("Path", scope));
  }

  async setPath(scope: EnvScope, entries: string[]): Promise<void> {
    await this.setEnv("Path", entries.join(";"), scope);
  }

  async getPackageVersion(
    manager: RollbackPackageManager,
    name: string,
  ): Promise<string | null> {
    const packages = await this.loadPackages(manager);
    return packages.get(name.toLowerCase()) ?? null;
  }

  async installPackage(
    manager: RollbackPackageManager,
    name: string,
    version: string | null,
  ): Promise<void> {
    const args =
      manager === "npm"
        ? ["install", "-g", `${name}${version ? `@${version}` : ""}`]
        : manager === "cargo"
          ? ["install", name, ...(version ? ["--version", version] : [])]
          : manager === "vscode"
            ? ["--install-extension", `${name}${version ? `@${version}` : ""}`]
            : ["-m", "pip", "install", `${name}${version ? `==${version}` : ""}`];
    const command = await this.resolvePackageCommand(manager);
    const result = await runProcess(command, args, { timeoutMs: 180_000 });
    if (result.code !== 0) {
      throw new Error(
        `${manager} install ${name} failed (${result.code ?? "error"}): ${(result.stderr || result.stdout).trim().slice(0, 400)}`,
      );
    }
    this.packageCache.delete(manager);
  }

  async uninstallPackage(manager: RollbackPackageManager, name: string): Promise<void> {
    const args =
      manager === "npm"
        ? ["uninstall", "-g", name]
        : manager === "cargo"
          ? ["uninstall", name]
          : manager === "vscode"
            ? ["--uninstall-extension", name]
            : ["-m", "pip", "uninstall", "-y", name];
    const command = await this.resolvePackageCommand(manager);
    const result = await runProcess(command, args, { timeoutMs: 180_000 });
    if (result.code !== 0) {
      throw new Error(
        `${manager} uninstall ${name} failed (${result.code ?? "error"}): ${(result.stderr || result.stdout).trim().slice(0, 400)}`,
      );
    }
    this.packageCache.delete(manager);
  }

  async getFileHash(filePath: string): Promise<string | null> {
    try {
      return sha256(readFileSync(filePath));
    } catch {
      return null;
    }
  }

  readBlob(hash: string): Buffer | null {
    try {
      return this.store.getBlob(hash);
    } catch {
      return null;
    }
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, "utf8");
  }

  async deleteFile(filePath: string): Promise<void> {
    if (existsSync(filePath)) rmSync(filePath, { force: true });
  }

  async getService(name: string): Promise<ServiceState | null> {
    if (!isWindows) return null;
    const output = await this.powerShell(
      `$s = Get-CimInstance Win32_Service -Filter "Name='${psQuote(name)}'" -ErrorAction SilentlyContinue; ` +
        `if ($s) { [pscustomobject]@{ state = [string]$s.State; startMode = [string]$s.StartMode } | ConvertTo-Json -Compress }`,
    );
    const value = parseJson<ServiceState | null>(output, null);
    return value;
  }

  async setService(name: string, state: string, startMode?: string): Promise<void> {
    if (!isWindows) throw new Error("Service changes are Windows-first in v1.");
    const commands: string[] = [];
    if (startMode) {
      const mode =
        startMode.toLowerCase() === "auto"
          ? "Automatic"
          : startMode.toLowerCase() === "disabled"
            ? "Disabled"
            : "Manual";
      commands.push(`Set-Service -Name '${psQuote(name)}' -StartupType ${mode}`);
    }
    if (state.toLowerCase() === "running") {
      commands.push(`Start-Service -Name '${psQuote(name)}'`);
    } else if (state.toLowerCase() === "stopped") {
      commands.push(`Stop-Service -Name '${psQuote(name)}' -Force`);
    }
    await this.powerShell(commands.join("; "));
  }

  async getTask(taskPath: string, name: string): Promise<TaskState | null> {
    if (!isWindows) return null;
    const output = await this.powerShell(
      `$t = Get-ScheduledTask -TaskPath '${psQuote(taskPath)}' -TaskName '${psQuote(name)}' -ErrorAction SilentlyContinue; ` +
        `if ($t) { [pscustomobject]@{ state = [string]$t.State } | ConvertTo-Json -Compress }`,
    );
    return parseJson<TaskState | null>(output, null);
  }

  async setTaskState(taskPath: string, name: string, enabled: boolean): Promise<void> {
    if (!isWindows) throw new Error("Scheduled task changes are Windows-first in v1.");
    await this.powerShell(
      `${enabled ? "Enable" : "Disable"}-ScheduledTask -TaskPath '${psQuote(taskPath)}' -TaskName '${psQuote(name)}'`,
    );
  }

  async getStartup(scope: StartupScope, name: string): Promise<StartupState | null> {
    if (!isWindows || scope === "startup-folder") return null;
    const key = startupRegistryKey(scope);
    const output = await this.powerShell(
      `$v = Get-ItemProperty -Path '${key}' -Name '${psQuote(name)}' -ErrorAction SilentlyContinue; ` +
        `if ($null -ne $v) { [pscustomobject]@{ command = [string]$v.'${psQuote(name)}'; enabled = $true } | ConvertTo-Json -Compress }`,
    );
    return parseJson<StartupState | null>(output, null);
  }

  async setStartup(
    scope: StartupScope,
    name: string,
    command: string,
    enabled: boolean,
  ): Promise<void> {
    if (!isWindows) throw new Error("Startup changes are Windows-first in v1.");
    if (scope === "startup-folder") {
      throw new Error("Startup-folder entries are manual in v1.");
    }
    if (!enabled) {
      await this.removeStartup(scope, name);
      return;
    }
    const key = startupRegistryKey(scope);
    await this.powerShell(
      `New-Item -Path '${key}' -Force | Out-Null; Set-ItemProperty -Path '${key}' -Name '${psQuote(name)}' -Value '${psQuote(command)}'`,
    );
  }

  async removeStartup(scope: StartupScope, name: string): Promise<void> {
    if (!isWindows) throw new Error("Startup changes are Windows-first in v1.");
    if (scope === "startup-folder") {
      throw new Error("Startup-folder entries are manual in v1.");
    }
    const key = startupRegistryKey(scope);
    await this.powerShell(
      `Remove-ItemProperty -Path '${key}' -Name '${psQuote(name)}' -ErrorAction SilentlyContinue`,
    );
  }

  private async loadPackages(manager: RollbackPackageManager): Promise<Map<string, string>> {
    const cached = this.packageCache.get(manager);
    if (cached) return cached;
    const result = new Map<string, string>();
    if (manager === "npm") {
      const command = await this.resolvePackageCommand("npm");
      const output = await runProcess(command, ["ls", "-g", "--depth=0", "--json"], {
        timeoutMs: 30_000,
      });
      const parsed = parseJson<{ dependencies?: Record<string, { version?: string }> }>(
        output.stdout,
        {},
      );
      for (const [name, info] of Object.entries(parsed.dependencies ?? {})) {
        if (info.version) result.set(name.toLowerCase(), info.version);
      }
    } else if (manager === "pip") {
      const command = await this.resolvePackageCommand("pip");
      const output = await runProcess(command, ["list", "--format=json"], { timeoutMs: 30_000 });
      for (const item of parseJson<Array<{ name?: string; version?: string }>>(output.stdout, [])) {
        if (item.name && item.version) result.set(item.name.toLowerCase(), item.version);
      }
    } else if (manager === "cargo") {
      const command = await this.resolvePackageCommand("cargo");
      const output = await runProcess(command, ["install", "--list"], { timeoutMs: 30_000 });
      for (const line of output.stdout.split(/\r?\n/)) {
        const match = line.match(/^(\S+)\s+v?([0-9][^\s:]*):/);
        if (match?.[1] && match[2]) result.set(match[1].toLowerCase(), match[2]);
      }
    } else {
      const command = await this.resolvePackageCommand("vscode");
      const output = await runProcess(command, ["--list-extensions", "--show-versions"], {
        timeoutMs: 30_000,
      });
      for (const line of output.stdout.split(/\r?\n/)) {
        const [name, version] = line.trim().split("@");
        if (name && version) result.set(name.toLowerCase(), version);
      }
    }
    this.packageCache.set(manager, result);
    return result;
  }

  private async resolvePackageCommand(manager: RollbackPackageManager): Promise<string> {
    const cached = this.commandCache.get(manager);
    if (cached) return cached;
    const lookup = manager === "vscode" ? "code" : manager === "pip" ? "pip" : manager;
    const paths = await whichAll([lookup]);
    const command = paths[lookup]?.[0];
    if (!command) throw new Error(`${lookup} was not found on PATH.`);
    this.commandCache.set(manager, command);
    return command;
  }

  private async powerShell(script: string): Promise<string> {
    const result = await runPowerShell(script, { timeoutMs: 30_000 });
    if (result.code !== 0 && result.stderr.trim()) {
      throw new Error(result.stderr.trim().slice(0, 500));
    }
    return result.stdout.replace(/^\uFEFF/, "").trim();
  }

  private async powerShellScalar(script: string): Promise<string> {
    return (await this.powerShell(script)).split(/\r?\n/, 1)[0] ?? "";
  }
}

export class FakeEnvironmentAdapter implements EnvironmentAdapter {
  readonly platform: "win32" | "posix" = "win32";
  readonly envs = new Map<string, string>();
  readonly paths = new Map<EnvScope, string[]>([
    ["user", []],
    ["machine", []],
  ]);
  readonly packages = new Map<string, string>();
  readonly files = new Map<string, string>();
  readonly blobs = new Map<string, Buffer>();
  readonly services = new Map<string, ServiceState>();
  readonly tasks = new Map<string, TaskState>();
  readonly startups = new Map<string, StartupState>();
  readonly calls: string[] = [];

  async getEnv(name: string, scope: EnvScope): Promise<string | null> {
    return this.envs.get(envKey(name, scope)) ?? null;
  }

  async setEnv(name: string, value: string, scope: EnvScope): Promise<void> {
    this.envs.set(envKey(name, scope), value);
    this.calls.push(`setEnv:${scope}:${name}`);
  }

  async unsetEnv(name: string, scope: EnvScope): Promise<void> {
    this.envs.delete(envKey(name, scope));
    this.calls.push(`unsetEnv:${scope}:${name}`);
  }

  async getPath(scope: EnvScope): Promise<string[]> {
    return [...(this.paths.get(scope) ?? [])];
  }

  async setPath(scope: EnvScope, entries: string[]): Promise<void> {
    this.paths.set(scope, [...entries]);
    this.calls.push(`setPath:${scope}`);
  }

  async getPackageVersion(
    manager: RollbackPackageManager,
    name: string,
  ): Promise<string | null> {
    return this.packages.get(`${manager}:${name}`) ?? null;
  }

  async installPackage(
    manager: RollbackPackageManager,
    name: string,
    version: string | null,
  ): Promise<void> {
    this.packages.set(`${manager}:${name}`, version ?? "latest");
    this.calls.push(`install:${manager}:${name}@${version ?? "latest"}`);
  }

  async uninstallPackage(manager: RollbackPackageManager, name: string): Promise<void> {
    this.packages.delete(`${manager}:${name}`);
    this.calls.push(`uninstall:${manager}:${name}`);
  }

  async getFileHash(filePath: string): Promise<string | null> {
    const content = this.files.get(filePath);
    return content === undefined ? null : sha256(content);
  }

  readBlob(hash: string): Buffer | null {
    return this.blobs.get(hash) ?? null;
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    this.files.set(filePath, content);
    this.calls.push(`writeFile:${filePath}`);
  }

  async deleteFile(filePath: string): Promise<void> {
    this.files.delete(filePath);
    this.calls.push(`deleteFile:${filePath}`);
  }

  async getService(name: string): Promise<ServiceState | null> {
    return this.services.get(name) ?? null;
  }

  async setService(name: string, state: string, startMode?: string): Promise<void> {
    this.services.set(name, { state, startMode: startMode ?? this.services.get(name)?.startMode ?? "" });
    this.calls.push(`setService:${name}:${state}`);
  }

  async getTask(taskPath: string, name: string): Promise<TaskState | null> {
    return this.tasks.get(`${taskPath}${name}`) ?? null;
  }

  async setTaskState(taskPath: string, name: string, enabled: boolean): Promise<void> {
    this.tasks.set(`${taskPath}${name}`, { state: enabled ? "Ready" : "Disabled" });
    this.calls.push(`setTask:${taskPath}${name}:${enabled}`);
  }

  async getStartup(scope: StartupScope, name: string): Promise<StartupState | null> {
    return this.startups.get(`${scope}:${name}`) ?? null;
  }

  async setStartup(
    scope: StartupScope,
    name: string,
    command: string,
    enabled: boolean,
  ): Promise<void> {
    this.startups.set(`${scope}:${name}`, { command, enabled });
    this.calls.push(`setStartup:${scope}:${name}`);
  }

  async removeStartup(scope: StartupScope, name: string): Promise<void> {
    this.startups.delete(`${scope}:${name}`);
    this.calls.push(`removeStartup:${scope}:${name}`);
  }
}

function envKey(name: string, scope: EnvScope): string {
  return `${scope}:${name}`;
}

function splitPath(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function startupRegistryKey(scope: "user" | "machine"): string {
  return scope === "user"
    ? "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run"
    : "HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
}

function psQuote(value: string): string {
  return value.replaceAll("'", "''");
}

function parseJson<T>(input: string, fallback: T): T {
  const trimmed = input.trim();
  if (!trimmed) return fallback;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return fallback;
  }
}

export function makeStartupKey(scope: StartupScope, name: string): string {
  return `${scope}:${name}`;
}
