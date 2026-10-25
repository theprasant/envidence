import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import { runJsonPowerShell, runProcess } from "../core/exec.js";
import { redactText } from "../core/redact.js";
import { asArray, isWindows, normalizePath, nowIso, splitPathList } from "../core/util.js";
import type { DiskInfo, HostInfo, PathInfo, ShellInfo, TimeInfo } from "../core/types.js";

type RawBasic = {
  host?: {
    os?: string;
    version?: string;
    build?: string;
    arch?: string;
    hostname?: string;
    username?: string;
    timezone?: string;
    uptimeSec?: number;
    bootTime?: string;
    clockUtc?: string;
  };
  env?: {
    user?: Record<string, unknown>;
    machine?: Record<string, unknown>;
  };
  path?: {
    user?: string;
    machine?: string;
    effective?: string;
  };
  shell?: {
    current?: string;
    executionPolicy?: string;
    profiles?: string[];
  };
  disks?: Array<{ mount?: string; totalBytes?: number; freeBytes?: number }>;
  dnsServers?: string[];
  winhttpRaw?: string;
  ieProxy?: {
    enabled?: boolean;
    server?: string;
    autoConfigUrl?: string;
  };
};

export type BasicData = {
  host: HostInfo;
  env: {
    user: Record<string, string>;
    machine: Record<string, string>;
  };
  path: PathInfo;
  shell: ShellInfo;
  time: TimeInfo;
  disks: DiskInfo[];
  network: {
    winhttp?: string;
    ie?: string;
    dnsServers: string[];
  };
};

const BASIC_SCRIPT = `
$os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
$userEnv = [Environment]::GetEnvironmentVariables('User')
$machineEnv = [Environment]::GetEnvironmentVariables('Machine')
$userPath = [Environment]::GetEnvironmentVariable('Path','User')
$machinePath = [Environment]::GetEnvironmentVariable('Path','Machine')
$profiles = @(
  $PROFILE.CurrentUserCurrentHost,
  $PROFILE.CurrentUserAllHosts,
  $PROFILE.AllUsersCurrentHost,
  $PROFILE.AllUsersAllHosts
) | Where-Object { $_ } | Select-Object -Unique
$disks = @(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" -ErrorAction SilentlyContinue | ForEach-Object {
  @{ mount = $_.DeviceID; totalBytes = [int64]$_.Size; freeBytes = [int64]$_.FreeSpace }
})
$dns = @(Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.ServerAddresses.Count -gt 0 } |
  ForEach-Object { $_.ServerAddresses }) | Select-Object -Unique
$winhttp = (netsh winhttp show proxy 2>$null) -join [Environment]::NewLine
$ie = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -ErrorAction SilentlyContinue
$tz = (Get-TimeZone -ErrorAction SilentlyContinue).Id
if (-not $tz) { $tz = [TimeZoneInfo]::Local.Id }
$now = Get-Date
$result = @{
  host = @{
    os = [string]$os.Caption
    version = [string]$os.Version
    build = [string]$os.BuildNumber
    arch = [string]$os.OSArchitecture
    hostname = [string]$env:COMPUTERNAME
    username = [string]$env:USERNAME
    timezone = [string]$tz
    uptimeSec = if ($os.LastBootUpTime) { [int64]($now - $os.LastBootUpTime).TotalSeconds } else { 0 }
    bootTime = if ($os.LastBootUpTime) { $os.LastBootUpTime.ToString('o') } else { '' }
    clockUtc = $now.ToUniversalTime().ToString('o')
  }
  env = @{ user = $userEnv; machine = $machineEnv }
  path = @{ user = [string]$userPath; machine = [string]$machinePath; effective = [string]$env:Path }
  shell = @{ current = $PSVersionTable.PSVersion.ToString(); executionPolicy = [string](Get-ExecutionPolicy); profiles = $profiles }
  disks = $disks
  dnsServers = $dns
  winhttpRaw = $winhttp
  ieProxy = @{
    enabled = if ($ie) { [bool]$ie.ProxyEnable } else { $false }
    server = if ($ie) { [string]$ie.ProxyServer } else { '' }
    autoConfigUrl = if ($ie) { [string]$ie.AutoConfigUrl } else { '' }
  }
}
$result | ConvertTo-Json -Depth 8 -Compress
`;

export async function collectBasic(): Promise<BasicData> {
  if (!isWindows) return collectPosixBasic();
  const raw = await runJsonPowerShell<RawBasic>(BASIC_SCRIPT, { timeoutMs: 9000 });
  return normalizeBasic(raw);
}

export function basicFallback(): BasicData {
  const envUser: Record<string, string> = {};
  const envMachine: Record<string, string> = {};
  const pathInfo = normalizePathInfo(
    process.env.PATH ?? "",
    process.env.PATH ?? "",
    process.env.PATH ?? "",
  );
  return {
    host: {
      os: `${os.type()} ${os.release()}`,
      version: os.release(),
      build: os.version(),
      arch: os.arch(),
      hostname: os.hostname(),
      username: process.env.USERNAME ?? process.env.USER ?? "unknown",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      uptimeSec: Math.round(os.uptime()),
      bootTime: new Date(Date.now() - os.uptime() * 1000).toISOString(),
      clockUtc: nowIso(),
    },
    env: { user: envUser, machine: envMachine },
    path: pathInfo,
    shell: {
      current: isWindows ? "powershell" : (process.env.SHELL ?? "sh"),
      psVersion: undefined,
      executionPolicy: undefined,
      profiles: [],
    },
    time: {
      utc: nowIso(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    disks: [],
    network: {
      winhttp: undefined,
      ie: undefined,
      dnsServers: [],
    },
  };
}

function normalizeBasic(raw: RawBasic): BasicData {
  const hostRaw = raw.host ?? {};
  const host: HostInfo = {
    os: hostRaw.os ?? (isWindows ? "Windows" : os.type()),
    version: hostRaw.version ?? os.release(),
    build: hostRaw.build ?? "",
    arch: hostRaw.arch ?? os.arch(),
    hostname: hostRaw.hostname ?? os.hostname(),
    username: hostRaw.username ?? process.env.USERNAME ?? "unknown",
    timezone: hostRaw.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    uptimeSec: Math.max(0, Math.round(Number(hostRaw.uptimeSec ?? 0))),
    bootTime: hostRaw.bootTime ?? "",
    clockUtc: hostRaw.clockUtc ?? nowIso(),
  };
  const profiles = asArray(raw.shell?.profiles).filter(Boolean);
  const profileHashes = profiles.map((profilePath) => ({
    path: profilePath,
    hash: hashFileSync(profilePath),
  }));
  const shell: ShellInfo = {
    current: raw.shell?.current ?? "powershell",
    psVersion: raw.shell?.current,
    executionPolicy: raw.shell?.executionPolicy,
    profiles: profileHashes,
  };
  const env = {
    user: toStringRecord(raw.env?.user),
    machine: toStringRecord(raw.env?.machine),
  };
  const pathInfo = normalizePathInfo(
    raw.path?.user ?? "",
    raw.path?.machine ?? "",
    raw.path?.effective ?? "",
  );
  const disks = asArray(raw.disks)
    .filter((disk) => disk.mount)
    .map((disk) => ({
      mount: String(disk.mount),
      totalBytes: Number(disk.totalBytes ?? 0),
      freeBytes: Number(disk.freeBytes ?? 0),
    }))
    .sort((a, b) => a.mount.localeCompare(b.mount));
  const winhttp = parseWinHttpProxy(raw.winhttpRaw);
  const ie = raw.ieProxy?.enabled
    ? [raw.ieProxy.server, raw.ieProxy.autoConfigUrl].filter(Boolean).join(" | ") || undefined
    : undefined;
  return {
    host,
    env,
    path: pathInfo,
    shell,
    time: {
      utc: host.clockUtc,
      timezone: host.timezone,
    },
    disks,
    network: {
      winhttp: winhttp ? redactText(winhttp) : undefined,
      ie: ie ? redactText(ie) : undefined,
      dnsServers: asArray(raw.dnsServers).map(String).filter(Boolean).sort(),
    },
  };
}

function toStringRecord(input: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input) return out;
  for (const [key, value] of Object.entries(input)) {
    if (value === null || value === undefined) continue;
    out[key] = String(value);
  }
  return out;
}

export function normalizePathInfo(userRaw: string, machineRaw: string, effectiveRaw: string): PathInfo {
  const user = splitPathList(userRaw).map(normalizePath);
  const machine = splitPathList(machineRaw).map(normalizePath);
  const effective = splitPathList(effectiveRaw).map(normalizePath);
  const seen = new Map<string, number>();
  const duplicates: string[] = [];
  for (const entry of effective) {
    const key = pathKey(entry);
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count === 2) duplicates.push(entry);
  }
  const missing = effective.filter((entry) => !existsSync(expandPath(entry)));
  return { user, machine, effective, duplicates, missing };
}

function pathKey(input: string): string {
  return isWindows ? input.toLowerCase() : input;
}

export function expandPath(input: string): string {
  let output = input;
  const variables: Record<string, string | undefined> = {
    ...process.env,
    USERPROFILE: process.env.USERPROFILE,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    APPDATA: process.env.APPDATA,
    SystemRoot: process.env.SystemRoot,
    ProgramFiles: process.env.ProgramFiles,
    "ProgramFiles(x86)": process.env["ProgramFiles(x86)"],
    ProgramData: process.env.ProgramData,
  };
  for (const [key, value] of Object.entries(variables)) {
    if (!value) continue;
    output = output.replace(new RegExp(`%${escapeRegExp(key)}%`, "gi"), value);
  }
  return output;
}

export function parseWinHttpProxy(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (/direct access/i.test(raw)) return undefined;
  const match = raw.match(/Proxy Server\(s\)\s*:\s*(.+)/i);
  if (match?.[1]) return match[1].trim();
  return undefined;
}

export async function collectNtp(): Promise<{ ntpStatus?: string; lastSync?: string }> {
  if (!isWindows) return {};
  const result = await runProcess("w32tm", ["/query", "/status"], { timeoutMs: 4000 });
  if (result.code !== 0) return {};
  const output = result.stdout;
  const source = output.match(/Source:\s*(.+)/i)?.[1]?.trim();
  const lastSync = output.match(/Last Successful Sync Time:\s*(.+)/i)?.[1]?.trim();
  return {
    ntpStatus: source,
    lastSync,
  };
}

function collectPosixBasic(): BasicData {
  const envPath = process.env.PATH ?? "";
  const profiles = ["~/.bashrc", "~/.zshrc", "~/.profile", "~/.bash_profile"]
    .map((item) => item.replace("~", process.env.HOME ?? ""))
    .filter((item) => existsSync(item));
  return {
    host: {
      os: `${os.type()} ${os.release()}`,
      version: os.release(),
      build: os.version(),
      arch: os.arch(),
      hostname: os.hostname(),
      username: process.env.USER ?? "unknown",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      uptimeSec: Math.round(os.uptime()),
      bootTime: new Date(Date.now() - os.uptime() * 1000).toISOString(),
      clockUtc: nowIso(),
    },
    env: {
      user: {},
      machine: {},
    },
    path: normalizePathInfo(envPath, envPath, envPath),
    shell: {
      current: process.env.SHELL ?? "sh",
      executionPolicy: undefined,
      profiles: profiles.map((profilePath) => ({ path: profilePath, hash: hashFileSync(profilePath) })),
    },
    time: {
      utc: nowIso(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    disks: [],
    network: {
      winhttp: undefined,
      ie: undefined,
      dnsServers: [],
    },
  };
}

function hashFileSync(filePath: string): string | null {
  try {
    if (!existsSync(filePath)) return null;
    return createHash("sha256").update(readFileSync(filePath)).digest("hex");
  } catch {
    return null;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
