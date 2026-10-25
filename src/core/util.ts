import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const isWindows = process.platform === "win32";

export function nowIso(): string {
  return new Date().toISOString();
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const entry = source[key];
      if (entry !== undefined) out[key] = sortValue(entry);
    }
    return out;
  }
  return value;
}

export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function shortHash(input: string | Buffer, length = 8): string {
  return sha256(input).slice(0, length).toUpperCase();
}

export function snapshotId(): string {
  return `SNAP-${randomBytes(4).toString("hex").toUpperCase()}`;
}

export function runId(): string {
  return `RUN-${randomBytes(4).toString("hex").toUpperCase()}`;
}

export function rollbackId(): string {
  return `RB-${randomBytes(4).toString("hex").toUpperCase()}`;
}

export function baselineId(seed?: string): string {
  const tail = seed ? shortHash(seed, 8) : randomBytes(4).toString("hex").toUpperCase();
  return `BASE-${tail}`;
}

export function caseId(at = new Date(), suffix?: string): string {
  const year = at.getFullYear();
  const month = String(at.getMonth() + 1).padStart(2, "0");
  const day = String(at.getDate()).padStart(2, "0");
  const tail = (suffix ?? randomBytes(2).toString("hex")).toUpperCase().slice(0, 4);
  return `CASE-${year}${month}${day}-${tail}`;
}

export function projectId(root: string): string {
  return `PRJ-${shortHash(pathKey(path.resolve(root)))}`;
}

export function pathKey(input: string): string {
  const normalized = input.replace(/[\\/]+$/, "");
  return isWindows ? normalized.toLowerCase() : normalized;
}

export function normalizePath(input: string): string {
  const trimmed = input.trim().replace(/^"(.*)"$/, "$1");
  if (!trimmed) return trimmed;
  const normalized = path.normalize(trimmed).replace(/[\\/]+$/, "");
  return normalized || trimmed;
}

export function splitPathList(value: string | undefined): string[] {
  if (!value) return [];
  const separator = isWindows ? ";" : ":";
  return value
    .split(separator)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function normalizeVersion(input: string | null | undefined): string | null {
  if (!input) return null;
  const match = input.match(/\d+(?:\.\d+){0,3}(?:[-+][0-9A-Za-z.-]+)?/);
  return match ? match[0] : input.trim();
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const digits = value >= 100 || index === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[index]}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours}h ${rest}m`;
}

export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  const delta = Math.max(0, now - timestamp);
  if (delta < 45_000) return "just now";
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

export function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function truncate(input: string, max = 200): string {
  if (input.length <= max) return input;
  return `${input.slice(0, Math.max(0, max - 1))}…`;
}

export function firstLine(input: string): string {
  return input.split(/\r?\n/, 1)[0]?.trim() ?? "";
}

export function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\u001b\[[0-9;]*m/g, "");
}

export function parseDuration(input: string): number {
  const match = input.trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d|w)$/i);
  if (!match) {
    const numeric = Number(input);
    if (Number.isFinite(numeric) && numeric >= 0) return numeric;
    throw new Error(`Invalid duration: ${input}. Use 30m, 12h, 7d, or a number of milliseconds.`);
  }
  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  const factors: Record<string, number> = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };
  return amount * (factors[unit ?? "m"] ?? 60_000);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

export function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export function groupBy<T, K extends string>(items: T[], key: (item: T) => K): Record<K, T[]> {
  const out = {} as Record<K, T[]>;
  for (const item of items) {
    const group = key(item);
    (out[group] ??= []).push(item);
  }
  return out;
}

export async function readFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

export async function fileStat(filePath: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const stat = await fs.stat(filePath);
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function hashFile(filePath: string): Promise<string | null> {
  try {
    const data = await fs.readFile(filePath);
    return sha256(data);
  } catch {
    return null;
  }
}

export function safeJsonParse<T>(input: string, fallback: T): T {
  try {
    return JSON.parse(input) as T;
  } catch {
    return fallback;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function homeRelative(input: string): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  if (!home) return input;
  const normalizedHome = path.normalize(home);
  const normalizedInput = path.normalize(input);
  if (isWindows) {
    if (normalizedInput.toLowerCase().startsWith(normalizedHome.toLowerCase())) {
      return `~${normalizedInput.slice(normalizedHome.length)}`;
    }
  } else if (normalizedInput.startsWith(normalizedHome)) {
    return `~${normalizedInput.slice(normalizedHome.length)}`;
  }
  return input;
}

export function parseJsonLines<T>(input: string): T[] {
  const out: T[] = [];
  for (const line of input.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // Ignore non-JSON lines from noisy tools.
    }
  }
  return out;
}

export function compareVersions(a: string, b: string): number {
  const left = a.split(/[.-]/).map((part) => Number(part) || 0);
  const right = b.split(/[.-]/).map((part) => Number(part) || 0);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function isMajorVersionChange(before: string | null, after: string | null): boolean {
  if (!before || !after) return false;
  const left = Number(before.split(".")[0]);
  const right = Number(after.split(".")[0]);
  return Number.isFinite(left) && Number.isFinite(right) && left !== right;
}
