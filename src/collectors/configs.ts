import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConfigFileInfo, SnapshotWarning } from "../core/types.js";
import { redactConfigContent } from "../core/redact.js";
import { sha256 } from "../core/util.js";
import type { Store } from "../core/store.js";

const MAX_CONFIG_BYTES = 256 * 1024;

type Candidate = {
  path: string;
  scope: "user" | "machine";
};

export function configCandidates(profilePaths: string[] = []): Candidate[] {
  const home = process.env.USERPROFILE ?? os.homedir();
  const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
  const programData = process.env.ProgramData ?? "C:\\ProgramData";
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const candidates: Candidate[] = [
    { path: path.join(home, ".gitconfig"), scope: "user" },
    { path: path.join(home, ".config", "git", "config"), scope: "user" },
    { path: path.join(home, ".npmrc"), scope: "user" },
    { path: path.join(home, ".cargo", "config.toml"), scope: "user" },
    { path: path.join(home, ".cargo", "config"), scope: "user" },
    { path: path.join(home, ".bashrc"), scope: "user" },
    { path: path.join(home, ".bash_profile"), scope: "user" },
    { path: path.join(home, ".zshrc"), scope: "user" },
    { path: path.join(home, ".profile"), scope: "user" },
    { path: path.join(home, ".config", "fish", "config.fish"), scope: "user" },
    { path: path.join(home, ".editorconfig"), scope: "user" },
    { path: path.join(home, ".wslconfig"), scope: "user" },
    { path: path.join(home, ".config", "pip", "pip.conf"), scope: "user" },
    { path: path.join(appData, "pip", "pip.ini"), scope: "user" },
    { path: path.join(programData, "pip", "pip.ini"), scope: "machine" },
    { path: path.join(appData, "Code", "User", "settings.json"), scope: "user" },
    { path: path.join(appData, "Code", "User", "keybindings.json"), scope: "user" },
    { path: path.join(appData, "Code - Insiders", "User", "settings.json"), scope: "user" },
    { path: path.join(systemRoot, "System32", "drivers", "etc", "hosts"), scope: "machine" },
    { path: "/etc/hosts", scope: "machine" },
  ];
  for (const profilePath of profilePaths) {
    if (profilePath) candidates.push({ path: profilePath, scope: "user" });
  }
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = process.platform === "win32" ? candidate.path.toLowerCase() : candidate.path;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function collectConfigs(
  store: Store,
  profilePaths: string[] = [],
): { configs: ConfigFileInfo[]; warnings: SnapshotWarning[] } {
  const warnings: SnapshotWarning[] = [];
  const items: ConfigFileInfo[] = [];
  for (const candidate of configCandidates(profilePaths)) {
    const item = readConfig(store, candidate);
    if (item.warning) warnings.push({ collector: "configs", message: item.warning });
    items.push(item.info);
  }
  items.sort((a, b) => a.path.localeCompare(b.path));
  return { configs: items, warnings };
}

function readConfig(
  store: Store,
  candidate: Candidate,
): { info: ConfigFileInfo; warning?: string } {
  const base: ConfigFileInfo = {
    path: candidate.path,
    scope: candidate.scope,
    hash: null,
    size: null,
    redacted: false,
    restorable: true,
    missing: true,
  };
  if (!existsSync(candidate.path)) return { info: base };
  try {
    const stat = statSync(candidate.path);
    if (!stat.isFile()) {
      return { info: { ...base, missing: false, restorable: false } };
    }
    if (stat.size > MAX_CONFIG_BYTES) {
      const content = readFileSync(candidate.path);
      return {
        info: {
          ...base,
          hash: sha256(content),
          size: stat.size,
          missing: false,
          restorable: false,
        },
      };
    }
    const content = readFileSync(candidate.path);
    const hash = sha256(content);
    if (content.subarray(0, 8192).includes(0)) {
      return {
        info: {
          ...base,
          hash,
          size: stat.size,
          missing: false,
          restorable: false,
        },
      };
    }
    const text = content.toString("utf8");
    const redactedResult = redactConfigContent(text);
    const blob = store.putBlob(redactedResult.content).hash;
    return {
      info: {
        ...base,
        hash,
        size: stat.size,
        blob,
        redacted: redactedResult.redacted,
        restorable: !redactedResult.redacted,
        missing: false,
        sensitive: redactedResult.redacted,
      },
    };
  } catch (error) {
    return {
      info: { ...base, missing: false, restorable: false },
      warning: `Could not read ${candidate.path}: ${(error as Error).message}`,
    };
  }
}
