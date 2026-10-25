import os from "node:os";
import { runProcess } from "../core/exec.js";
import type { ListenerInfo, SnapshotWarning } from "../core/types.js";
import { isWindows } from "../core/util.js";

export async function collectListeners(): Promise<{
  listeners: ListenerInfo[];
  warnings: SnapshotWarning[];
}> {
  if (isWindows) return collectWindowsListeners();
  if (os.platform() === "linux") return collectSsListeners();
  if (os.platform() === "darwin") return collectLsofListeners();
  return { listeners: [], warnings: [] };
}

async function collectWindowsListeners(): Promise<{
  listeners: ListenerInfo[];
  warnings: SnapshotWarning[];
}> {
  const warnings: SnapshotWarning[] = [];
  const [netstat, tasklist] = await Promise.all([
    runProcess("netstat.exe", ["-ano"], { timeoutMs: 6000 }),
    runProcess("tasklist.exe", ["/fo", "csv", "/nh"], { timeoutMs: 6000 }),
  ]);
  const processNames = new Map<number, string>();
  for (const line of tasklist.stdout.split(/\r?\n/)) {
    const match = line.match(/^"([^"]+)","(\d+)"/);
    if (!match) continue;
    processNames.set(Number(match[2]), match[1] as string);
  }
  const parsed: ListenerInfo[] = [];
  for (const line of netstat.stdout.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4) continue;
    const protocol = fields[0]?.toUpperCase();
    if (protocol !== "TCP" && protocol !== "UDP") continue;
    const local = fields[1] ?? "";
    const colon = local.lastIndexOf(":");
    if (colon <= 0) continue;
    const address = local.slice(0, colon).replace(/^\[|\]$/g, "");
    const port = Number(local.slice(colon + 1));
    if (!Number.isFinite(port) || port <= 0) continue;
    if (protocol === "TCP" && fields[3]?.toUpperCase() !== "LISTENING") continue;
    const pid = Number(fields[protocol === "TCP" ? 4 : 3] ?? 0);
    parsed.push({
      protocol: protocol === "TCP" ? "tcp" : "udp",
      address: address || "*",
      port,
      pid: Number.isFinite(pid) ? pid : 0,
      processName: processNames.get(pid) ?? (pid === 0 ? "System" : "Unknown"),
    });
  }
  if (netstat.code !== 0 && netstat.stderr.trim()) {
    warnings.push({ collector: "listeners", message: netstat.stderr.trim().slice(0, 300) });
  }
  return { listeners: aggregateListeners(parsed), warnings };
}

async function collectSsListeners(): Promise<{
  listeners: ListenerInfo[];
  warnings: SnapshotWarning[];
}> {
  const result = await runProcess("ss", ["-tulpn"], { timeoutMs: 6000 });
  if (result.code !== 0) {
    return {
      listeners: [],
      warnings: result.stderr.trim()
        ? [{ collector: "listeners", message: result.stderr.trim().slice(0, 300) }]
        : [],
    };
  }
  const parsed: ListenerInfo[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5) continue;
    const protocol = fields[0]?.toLowerCase().startsWith("tcp") ? "tcp" : "udp";
    const local = fields[4] ?? "";
    const colon = local.lastIndexOf(":");
    if (colon <= 0) continue;
    const address = local.slice(0, colon).replace(/^\[|\]$/g, "");
    const port = Number(local.slice(colon + 1));
    if (!Number.isFinite(port) || port <= 0) continue;
    const processMatch = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
    parsed.push({
      protocol,
      address,
      port,
      pid: processMatch ? Number(processMatch[2]) : 0,
      processName: processMatch?.[1] ?? "Unknown",
    });
  }
  return { listeners: aggregateListeners(parsed), warnings: [] };
}

async function collectLsofListeners(): Promise<{
  listeners: ListenerInfo[];
  warnings: SnapshotWarning[];
}> {
  const result = await runProcess("lsof", ["-iTCP", "-sTCP:LISTEN", "-P", "-n"], {
    timeoutMs: 6000,
  });
  if (result.code !== 0) {
    return {
      listeners: [],
      warnings: result.stderr.trim()
        ? [{ collector: "listeners", message: result.stderr.trim().slice(0, 300) }]
        : [],
    };
  }
  const parsed: ListenerInfo[] = [];
  for (const line of result.stdout.split(/\r?\n/).slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 9) continue;
    const name = fields[fields.length - 1] ?? "";
    const colon = name.lastIndexOf(":");
    if (colon <= 0) continue;
    const port = Number(name.slice(colon + 1));
    if (!Number.isFinite(port) || port <= 0) continue;
    parsed.push({
      protocol: "tcp",
      address: name.slice(0, colon).replace(/^\[|\]$/g, ""),
      port,
      pid: Number(fields[1] ?? 0),
      processName: fields[0] ?? "Unknown",
    });
  }
  return { listeners: aggregateListeners(parsed), warnings: [] };
}

function aggregateListeners(listeners: ListenerInfo[]): ListenerInfo[] {
  const byKey = new Map<string, ListenerInfo>();
  for (const listener of listeners) {
    const key = `${listener.protocol}:${listener.port}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, listener);
      continue;
    }
    if (existing.address.startsWith("127.") && !listener.address.startsWith("127.")) {
      byKey.set(key, listener);
    }
  }
  return [...byKey.values()].sort((a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol));
}
