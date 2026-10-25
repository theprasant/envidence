import { sha256, homeRelative, isWindows } from "./util.js";
import type { EnvValue, Snapshot } from "./types.js";

export const SECRET_KEY_PATTERN =
  /(token|secret|password|passwd|pwd|api[_-]?key|apikey|auth|credential|private[_-]?key|access[_-]?key|client[_-]?secret|session|cookie|bearer)/i;

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/gi,
  /(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi,
  /(Basic\s+)[A-Za-z0-9+/=]+/gi,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bnpm_[A-Za-z0-9]{20,}\b/g,
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g,
];

const CONFIG_SECRET_LINE =
  /^(\s*(?:[^=:#\s]*(?:token|secret|password|passwd|pwd|api[_-]?key|apikey|auth|credential|private[_-]?key|access[_-]?key|client[_-]?secret|session|cookie)[^=:#\s]*)\s*[=:]\s*)(.+)$/i;

export function isSecretKey(name: string): boolean {
  return SECRET_KEY_PATTERN.test(name);
}

export function secretHash(value: string, salt: string): string {
  return sha256(`${salt}:${value}`);
}

export function secretPreview(value: string): string {
  if (value.length <= 4) return "••••";
  return `${value.slice(0, 2)}…${value.slice(-2)}`;
}

export function redactEnvValue(name: string, value: string, salt: string): EnvValue {
  if (!value) return { value: "" };
  if (isSecretKey(name)) {
    return {
      hash: secretHash(value, salt),
      preview: secretPreview(value),
      secret: true,
    };
  }
  return { value };
}

export function redactEnvRecord(
  env: Record<string, string | undefined>,
  salt: string,
): Record<string, EnvValue> {
  const out: Record<string, EnvValue> = {};
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    out[name] = redactEnvValue(name, value, salt);
  }
  return out;
}

export function redactText(input: string): string {
  let output = input;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    output = output.replace(pattern, (match, prefix?: string) => {
      if (match.includes("PRIVATE KEY")) return "<redacted-private-key>";
      if (/^https?:\/\//i.test(match)) return `${prefix ?? ""}<redacted>@`;
      if (prefix) return `${prefix}<redacted>`;
      return "<redacted>";
    });
  }
  return output;
}

export function redactConfigContent(input: string): { content: string; redacted: boolean } {
  let redacted = false;
  const lines = input.split(/\r?\n/);
  const output = lines.map((line) => {
    if (CONFIG_SECRET_LINE.test(line)) {
      redacted = true;
      return line.replace(CONFIG_SECRET_LINE, "$1<redacted>");
    }
    const cleaned = redactText(line);
    if (cleaned !== line) redacted = true;
    return cleaned;
  });
  return { content: output.join("\n"), redacted };
}

export function redactUrlCredentials(input: string): string {
  return input.replace(/(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, "$1<redacted>@");
}

export function redactHostValue(input: string): string {
  const hostname = process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? "";
  const username = process.env.USERNAME ?? process.env.USER ?? "";
  let output = input;
  if (username) {
    output = output.replace(new RegExp(escapeRegExp(username), "gi"), "<user>");
  }
  if (hostname) {
    output = output.replace(new RegExp(escapeRegExp(hostname), "gi"), "<host>");
  }
  return output;
}

export type RedactionLevel = "none" | "standard" | "strict";

export function redactPathForReport(input: string, level: RedactionLevel): string {
  if (level === "none") return input;
  let output = homeRelative(input);
  output = redactHostValue(output);
  if (level === "strict") {
    const normalized = output.replaceAll("\\", "/");
    const parts = normalized.split("/").filter(Boolean);
    if (parts.length > 2) {
      output = `<path>/…/${parts.slice(-1)[0]}`;
    }
  }
  return output;
}

export function redactSnapshot(snapshot: Snapshot, level: RedactionLevel): Snapshot {
  if (level === "none") return snapshot;
  const clone = structuredClone(snapshot) as Snapshot;
  clone.host.hostname = level === "strict" ? "<host>" : redactHostValue(clone.host.hostname);
  clone.host.username = level === "strict" ? "<user>" : redactHostValue(clone.host.username);
  if (clone.project) {
    clone.project.root = redactPathForReport(clone.project.root, level);
    if (clone.project.git?.remote) {
      clone.project.git.remote = redactUrlCredentials(clone.project.git.remote);
      if (level === "strict") clone.project.git.remote = "<remote>";
    }
    clone.project.envReferences = clone.project.envReferences.map((ref) => ({
      ...ref,
      file: redactPathForReport(ref.file, level),
    }));
    clone.project.configFiles = clone.project.configFiles.map((file) => ({
      ...file,
      path: redactPathForReport(file.path, level),
    }));
    clone.project.manifests = clone.project.manifests.map((file) => ({
      ...file,
      path: redactPathForReport(file.path, level),
    }));
    clone.project.lockfiles = clone.project.lockfiles.map((file) => ({
      ...file,
      path: redactPathForReport(file.path, level),
    }));
  }
  clone.configs = clone.configs.map((file) => ({
    ...file,
    path: redactPathForReport(file.path, level),
  }));
  clone.shell.profiles = clone.shell.profiles.map((profile) => ({
    ...profile,
    path: redactPathForReport(profile.path, level),
  }));
  clone.startup = clone.startup.map((item) => ({
    ...item,
    command: redactPathForReport(redactText(item.command), level),
  }));
  clone.listeners = clone.listeners.map((item) => ({
    ...item,
    processPath: item.processPath ? redactPathForReport(item.processPath, level) : undefined,
  }));
  clone.tasks = clone.tasks.map((item) => ({
    ...item,
    path: redactPathForReport(item.path, level),
  }));
  clone.services = clone.services.map((item) => ({
    ...item,
    pathName: item.pathName ? redactPathForReport(item.pathName, level) : undefined,
  }));
  clone.packages = clone.packages.map((item) => ({ ...item }));
  return clone;
}

export function assertNoSecrets(input: string, level: RedactionLevel): string[] {
  if (level === "none") return [];
  const findings: string[] = [];
  for (const pattern of SECRET_VALUE_PATTERNS) {
    const matches = input.match(pattern);
    if (matches) findings.push(...matches.slice(0, 3));
  }
  return findings;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactCommandForDisplay(command: string): string {
  return redactText(command);
}

export function sanitizeTail(input: string, maxBytes = 16_384): string {
  const redacted = redactText(input);
  if (Buffer.byteLength(redacted, "utf8") <= maxBytes) return redacted;
  const buffer = Buffer.from(redacted, "utf8");
  return buffer.subarray(buffer.length - maxBytes).toString("utf8");
}

export function isProbablySensitivePath(input: string): boolean {
  const normalized = input.replaceAll("\\", "/").toLowerCase();
  return [
    "/.ssh/",
    "/.gnupg/",
    "/.aws/",
    "/.azure/",
    "/.kube/",
    "/.docker/config.json",
    "/cookies",
    "/login data",
    "/keychain",
    "/credentials",
  ].some((fragment) => normalized.includes(fragment));
}

export function isWindowsPath(input: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(input) || isWindows;
}
