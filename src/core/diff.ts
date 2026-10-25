import type {
  Category,
  Change,
  ChangeKind,
  ChangeOrigin,
  Config,
  Fact,
  JsonValue,
  ProjectContext,
  Snapshot,
} from "./types.js";
import { factsFromSnapshot, unstableCategoryForProfile } from "./facts.js";
import { sha256, stableStringify, truncate } from "./util.js";

export type DiffOptions = {
  config?: Config;
  project?: ProjectContext | null;
  origin?: ChangeOrigin;
};

const PATH_LABELS: Record<string, string> = {
  user: "User PATH",
  machine: "Machine PATH",
  effective: "Effective PATH",
  duplicates: "PATH duplicates",
  missing: "Missing PATH entries",
};

const SET_ARRAY_PATHS = new Set(["duplicates", "missing"]);

export function diffSnapshots(before: Snapshot, after: Snapshot, options: DiffOptions = {}): Change[] {
  const beforeFacts = factsFromSnapshot(before);
  const afterFacts = factsFromSnapshot(after);
  const keys = new Set([...beforeFacts.keys(), ...afterFacts.keys()]);
  const project = options.project ?? after.project ?? before.project;
  const origin = options.origin ?? "observed-during";
  const changes: Change[] = [];

  for (const key of keys) {
    const beforeFact = beforeFacts.get(key);
    const afterFact = afterFacts.get(key);
    const fact = afterFact ?? beforeFact;
    if (!fact) continue;
    if (unstableCategoryForProfile(before.profile, fact.category)) continue;
    if (unstableCategoryForProfile(after.profile, fact.category)) continue;
    if (
      fact.category === "time" &&
      (fact.path === "ntpStatus" || fact.path === "lastSync") &&
      before.profile !== after.profile
    ) {
      continue;
    }

    if (fact.category === "path" && Array.isArray(fact.value)) {
      const beforeArray = Array.isArray(beforeFact?.value) ? beforeFact.value.map(String) : [];
      const afterArray = Array.isArray(afterFact?.value) ? afterFact.value.map(String) : [];
      changes.push(
        ...sequenceChanges({
          category: "path",
          path: fact.path,
          before: beforeArray,
          after: afterArray,
          origin,
          allowReorder: !SET_ARRAY_PATHS.has(fact.path),
          volatile: fact.volatile,
        }),
      );
      continue;
    }

    const beforeValue = beforeFact?.value ?? null;
    const afterValue = afterFact?.value ?? null;
    if (stableStringify(beforeValue) === stableStringify(afterValue)) continue;

    const kind = !beforeFact ? "added" : !afterFact ? "removed" : "changed";
    if (kind === "changed" && fact.category === "disks" && !diskChangeSignificant(beforeValue, afterValue)) {
      continue;
    }
    if (noiseDrop(fact.category, fact.path, beforeValue, afterValue, project, options.config)) continue;
    changes.push(
      makeChange({
        category: fact.category,
        path: fact.path,
        kind,
        before: beforeValue,
        after: afterValue,
        origin,
        label: describeChange(fact.category, fact.path, "label"),
        summary: describeChange(fact.category, fact.path, "summary", beforeValue, afterValue, kind),
        volatile: fact.volatile || fact.category === "time" || fact.category === "disks",
      }),
    );
  }

  return changes.sort((a, b) => {
    const category = a.category.localeCompare(b.category);
    return category !== 0 ? category : a.path.localeCompare(b.path);
  });
}

export function buildCaseChanges(
  reference: Snapshot,
  pre: Snapshot,
  post: Snapshot,
  options: DiffOptions = {},
): Change[] {
  const referenceToPre = diffSnapshots(reference, pre, { ...options, origin: "pre-existing" });
  const preExistingPaths = new Set(referenceToPre.map((change) => changeKey(change)));
  const referenceToPost = diffSnapshots(reference, post, { ...options, origin: "observed-during" });
  const preToPost = diffSnapshots(pre, post, { ...options, origin: "observed-during" });
  const merged = new Map<string, Change>();
  for (const change of referenceToPost) {
    if (preExistingPaths.has(changeKey(change))) change.origin = "pre-existing";
    merged.set(change.signature, change);
  }
  for (const change of preToPost) {
    if (!merged.has(change.signature)) merged.set(change.signature, change);
  }
  return [...merged.values()];
}

export function changeKey(change: Pick<Change, "category" | "path">): string {
  return `${change.category}:${change.path}`;
}

type SequenceInput = {
  category: Category;
  path: string;
  before: string[];
  after: string[];
  origin: ChangeOrigin;
  allowReorder: boolean;
  volatile?: boolean;
};

function sequenceChanges(input: SequenceInput): Change[] {
  const beforeCounts = countEntries(input.before);
  const afterCounts = countEntries(input.after);
  const label = PATH_LABELS[input.path] ?? `${input.path} PATH`;
  const changes: Change[] = [];
  const allEntries = new Set([...beforeCounts.keys(), ...afterCounts.keys()]);
  for (const entry of allEntries) {
    const beforeCount = beforeCounts.get(entry) ?? 0;
    const afterCount = afterCounts.get(entry) ?? 0;
    if (afterCount > beforeCount) {
      for (let occurrence = beforeCount; occurrence < afterCount; occurrence += 1) {
        changes.push(
          makeChange({
            category: input.category,
            path: `${input.path}.added.${entry}.${occurrence}`,
            kind: "added",
            before: null,
            after: entry,
            origin: input.origin,
            label: `${label} entry added`,
            summary: `+ ${entry}`,
            volatile: input.volatile,
          }),
        );
      }
    } else if (beforeCount > afterCount) {
      for (let occurrence = afterCount; occurrence < beforeCount; occurrence += 1) {
        changes.push(
          makeChange({
            category: input.category,
            path: `${input.path}.removed.${entry}.${occurrence}`,
            kind: "removed",
            before: entry,
            after: null,
            origin: input.origin,
            label: `${label} entry removed`,
            summary: `- ${entry}`,
            volatile: input.volatile,
          }),
        );
      }
    }
  }

  if (input.allowReorder && input.before.length > 0 && input.after.length > 0) {
    const common = lcs(input.before, input.after);
    const lcsCounts = countEntries(common);
    const beforeIndex = indexOf(input.before);
    const afterIndex = indexOf(input.after);
    const candidates = new Set<string>();
    for (const [entry, afterCount] of afterCounts) {
      const commonCount = Math.min(beforeCounts.get(entry) ?? 0, afterCount);
      if (commonCount <= 0) continue;
      if ((lcsCounts.get(entry) ?? 0) < commonCount) candidates.add(entry);
    }
    for (const entry of candidates) {
      changes.push(
        makeChange({
          category: input.category,
          path: `${input.path}.moved.${entry}`,
          kind: "reordered",
          before: beforeIndex.get(entry) ?? null,
          after: afterIndex.get(entry) ?? null,
          origin: input.origin,
          label: `${label} order changed`,
          summary: `moved ${entry} from position ${(beforeIndex.get(entry) ?? 0) + 1} to ${(afterIndex.get(entry) ?? 0) + 1}`,
          volatile: input.volatile,
        }),
      );
    }
  }
  return changes;
}

function makeChange(input: {
  category: Category;
  path: string;
  kind: ChangeKind;
  before: JsonValue;
  after: JsonValue;
  origin: ChangeOrigin;
  label: string;
  summary: string;
  volatile?: boolean;
}): Change {
  const signature = `CHG-${sha256(
    stableStringify({
      category: input.category,
      path: input.path,
      kind: input.kind,
      before: input.before,
      after: input.after,
    }),
  )
    .slice(0, 20)
    .toUpperCase()}`;
  return {
    signature,
    category: input.category,
    path: input.path,
    kind: input.kind,
    before: input.before,
    after: input.after,
    origin: input.origin,
    label: input.label,
    summary: input.summary,
    volatile: input.volatile,
  };
}

function noiseDrop(
  category: Category,
  factPath: string,
  before: JsonValue,
  after: JsonValue,
  project: ProjectContext | null | undefined,
  config: Config | undefined,
): boolean {
  if (category === "env") {
    const name = factPath.split(".").slice(1).join(".");
    if (["_", "SHLVL", "PWD", "OLDPWD", "RANDOM", "SECONDS"].includes(name)) return true;
  }
  if (category === "listeners") {
    const port = Number(factPath.split(".")[1] ?? 0);
    if (port >= 49152 && !(project?.ports ?? []).includes(port)) return true;
  }
  if (category === "services") {
    if ((config?.noise.ignoreServices ?? []).includes(factPath)) return true;
  }
  if (category === "disks") {
    if (!diskChangeSignificant(before, after)) return true;
  }
  for (const pattern of config?.noise.ignore ?? []) {
    try {
      if (new RegExp(pattern, "i").test(`${category}:${factPath}`)) return true;
    } catch {
      // Ignore invalid user patterns rather than failing a diff.
    }
  }
  return false;
}

function diskChangeSignificant(before: JsonValue, after: JsonValue): boolean {
  if (!isRecord(before) || !isRecord(after)) return true;
  const beforeTotal = Number(before.totalBytes ?? 0);
  const afterTotal = Number(after.totalBytes ?? 0);
  if (beforeTotal !== afterTotal) return true;
  const beforeFree = Number(before.freeBytes ?? 0);
  const afterFree = Number(after.freeBytes ?? 0);
  const delta = Math.abs(afterFree - beforeFree);
  if (delta < 500 * 1024 * 1024) return false;
  const beforePct = beforeTotal > 0 ? (beforeFree / beforeTotal) * 100 : 100;
  const afterPct = afterTotal > 0 ? (afterFree / afterTotal) * 100 : 100;
  const beforeBucket = diskBucket(beforeFree, beforePct);
  const afterBucket = diskBucket(afterFree, afterPct);
  return beforeBucket !== afterBucket || delta >= 500 * 1024 * 1024;
}

function diskBucket(freeBytes: number, freePercent: number): number {
  if (freePercent < 5 || freeBytes < 2 * 1024 ** 3) return 2;
  if (freePercent < 10) return 1;
  return 0;
}

function describeChange(
  category: Category,
  path: string,
  mode: "label" | "summary",
  before?: JsonValue,
  after?: JsonValue,
  kind?: ChangeKind,
): string {
  if (mode === "summary") {
    if (kind === "added") return `added ${formatValue(after)}`;
    if (kind === "removed") return `removed ${formatValue(before)}`;
    return `${formatValue(before)} → ${formatValue(after)}`;
  }
  switch (category) {
    case "env": {
      const [scope, ...rest] = path.split(".");
      return `${scope === "effective" ? "Effective" : scope === "machine" ? "Machine" : "User"} environment variable ${rest.join(".")}`;
    }
    case "path": {
      const parts = path.split(".");
      const base = PATH_LABELS[parts[0] ?? ""] ?? "PATH";
      return parts[1] === "added"
        ? `${base} entry added`
        : parts[1] === "removed"
          ? `${base} entry removed`
          : parts[1] === "moved"
            ? `${base} order changed`
            : base;
    }
    case "runtimes":
    case "tools": {
      const [name, field] = path.split(".");
      return `${humanName(name ?? "Tool")} ${field === "version" ? "version" : "path"}`;
    }
    case "packages": {
      const [manager, ...name] = path.split(".");
      return `${manager} package ${name.join(".")}`;
    }
    case "services":
      return `Service ${path}`;
    case "startup":
      return `Startup item ${path.split(".").slice(1).join(".")}`;
    case "tasks":
      return `Scheduled task ${path.split("\\").pop() ?? path}`;
    case "listeners": {
      const [protocol, port] = path.split(".");
      return `Listener ${protocol?.toUpperCase()}:${port}`;
    }
    case "programs":
      return `Program ${path}`;
    case "hotfixes":
      return `Hotfix ${path}`;
    case "network":
      return `Network ${path.replaceAll(".", " ")}`;
    case "configs":
      return `Config ${fileName(path.replace(/\.(hash|missing)$/, ""))}`;
    case "shell":
      return path.startsWith("profiles.")
        ? `PowerShell profile ${fileName(path.slice("profiles.".length))}`
        : `Shell ${path}`;
    case "time":
      return `Time ${path}`;
    case "disks":
      return `Disk ${path}`;
    case "wsl":
      return `WSL ${path.split(".")[0]}`;
    case "project":
      if (path.startsWith("manifest.")) return `Project manifest ${fileName(path.slice("manifest.".length))}`;
      if (path.startsWith("lockfile.")) return `Lockfile ${fileName(path.slice("lockfile.".length))}`;
      if (path.startsWith("config.")) return `Project config ${fileName(path.slice("config.".length))}`;
      if (path.startsWith("git.")) return `Project git ${path.slice("git.".length)}`;
      return `Project ${path}`;
    case "host":
      return `Host ${path}`;
    default:
      return `${category} ${path}`;
  }
}

function formatValue(value: JsonValue | undefined): string {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const shown = value.slice(0, 5).map((item) => formatValue(item)).join(", ");
    return `[${shown}${value.length > 5 ? `, +${value.length - 5} more` : ""}]`;
  }
  if (typeof value === "object") {
    if ("secret" in value && value.secret) {
      return `secret ${String(value.preview ?? "••••")}`;
    }
    return truncate(JSON.stringify(value), 180);
  }
  return truncate(String(value), 180);
}

function humanName(input: string): string {
  if (!input) return input;
  const known = ["npm", "npx", "pnpm", "pip", "uv", "git", "gh", "wsl", "aws", "az", "php"];
  if (known.includes(input)) return input;
  if (input === "node") return "Node.js";
  return input.charAt(0).toUpperCase() + input.slice(1);
}

function fileName(input: string): string {
  return input.replaceAll("\\", "/").split("/").pop() ?? input;
}

function countEntries(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function indexOf(values: string[]): Map<string, number> {
  const out = new Map<string, number>();
  values.forEach((value, index) => {
    if (!out.has(value)) out.set(value, index);
  });
  return out;
}

function lcs(left: string[], right: string[]): string[] {
  const rows = left.length + 1;
  const cols = right.length + 1;
  const table: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      if (left[i - 1] === right[j - 1]) {
        table[i]![j] = (table[i - 1]![j - 1] ?? 0) + 1;
      } else {
        table[i]![j] = Math.max(table[i - 1]![j] ?? 0, table[i]![j - 1] ?? 0);
      }
    }
  }
  const out: string[] = [];
  let i = left.length;
  let j = right.length;
  while (i > 0 && j > 0) {
    if (left[i - 1] === right[j - 1]) {
      out.push(left[i - 1] as string);
      i -= 1;
      j -= 1;
    } else if ((table[i - 1]![j] ?? 0) >= (table[i]![j - 1] ?? 0)) {
      i -= 1;
    } else {
      j -= 1;
    }
  }
  return out.reverse();
}

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
