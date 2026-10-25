import type { Category, Snapshot } from "./types.js";
import { factsFromSnapshot } from "./facts.js";
import { sha256, stableStringify } from "./util.js";

const IGNORED_FINGERPRINT_PATHS = new Set([
  "git.dirtyTracked",
  "git.untracked",
  "git.stashCount",
  "time.lastSync",
]);

const IGNORED_FINGERPRINT_CATEGORIES = new Set<Category>(["disks", "time"]);

export type FingerprintResult = {
  fingerprint: string;
  categories: Record<string, string>;
  factCount: number;
};

export function fingerprintSnapshot(snapshot: Snapshot): FingerprintResult {
  const facts = factsFromSnapshot(snapshot);
  const byCategory = new Map<Category, Array<{ path: string; value: unknown }>>();
  for (const fact of facts.values()) {
    if (fact.volatile) continue;
    if (IGNORED_FINGERPRINT_CATEGORIES.has(fact.category)) continue;
    if (IGNORED_FINGERPRINT_PATHS.has(fact.path)) continue;
    const list = byCategory.get(fact.category) ?? [];
    list.push({ path: fact.path, value: fact.value });
    byCategory.set(fact.category, list);
  }
  const categories: Record<string, string> = {};
  let factCount = 0;
  for (const [category, entries] of [...byCategory.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    entries.sort((a, b) => a.path.localeCompare(b.path));
    factCount += entries.length;
    categories[category] = sha256(stableStringify({ category, entries })).slice(0, 16).toUpperCase();
  }
  const digest = sha256(stableStringify(categories)).slice(0, 12).toUpperCase();
  return {
    fingerprint: `EV-${digest.slice(0, 4)}-${digest.slice(4, 8)}-${digest.slice(8, 12)}`,
    categories,
    factCount,
  };
}
