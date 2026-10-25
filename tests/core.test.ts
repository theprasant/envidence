import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureConfig } from "../src/core/config.js";
import {
  DEMO_CASE_ID,
  DEMO_GOOD_SNAPSHOT,
  DEMO_POST_SNAPSHOT,
  DEMO_TOP_TITLE,
  seedDemo,
} from "../src/core/demo.js";
import { diffSnapshots } from "../src/core/diff.js";
import { fingerprintSnapshot } from "../src/core/fingerprint.js";
import {
  redactConfigContent,
  redactEnvRecord,
  redactEnvValue,
  redactText,
} from "../src/core/redact.js";
import { explainRun, openCaseForRun } from "../src/core/run.js";
import { Store } from "../src/core/store.js";
import type { RunRecord } from "../src/core/types.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(path.join(process.cwd(), ".envidence", "vitest-core-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("core evidence engine", () => {
  it("seeds a deterministic demo with the expected top hypothesis", () => {
    const root = tempRoot();
    const first = seedDemo(root, { reset: true });
    const config = ensureConfig(first.home);

    expect(first.caseRecord.id).toBe(DEMO_CASE_ID);
    expect(first.findings[0]?.title).toBe(DEMO_TOP_TITLE);
    expect(first.findings[0]?.score).toBe(72);
    expect(first.findings[0]?.confidence).toBe("high");
    expect(first.findings[1]?.score).toBe(38);
    expect(first.snapshots.map((snapshot) => snapshot.id)).toEqual([
      DEMO_GOOD_SNAPSHOT,
      "SNAP-11A00002",
      DEMO_POST_SNAPSHOT,
    ]);
    expect(first.changes.some((change) => change.path === "npm.typescript")).toBe(true);
    expect(first.changes.some((change) => change.kind === "reordered")).toBe(true);

    const second = seedDemo(root);
    expect(second.caseRecord.id).toBe(first.caseRecord.id);
    expect(second.findings.map((finding) => finding.signature)).toEqual(
      first.findings.map((finding) => finding.signature),
    );

    const store = new Store(second.home);
    try {
      expect(store.listSnapshots().length).toBe(3);
      expect(store.listRuns().length).toBe(2);
      expect(store.getActiveBaseline()?.snapshotId).toBe(DEMO_GOOD_SNAPSHOT);
      expect(config.redaction).toBe("standard");
    } finally {
      store.close();
    }
  });

  it("classifies pre-existing differences and sequence-aware PATH changes", () => {
    const seed = seedDemo(tempRoot(), { reset: true });
    const config = ensureConfig(seed.home);
    const good = seed.snapshots.find((snapshot) => snapshot.id === DEMO_GOOD_SNAPSHOT);
    const post = seed.snapshots.find((snapshot) => snapshot.id === DEMO_POST_SNAPSHOT);
    if (!good || !post) throw new Error("demo snapshots missing");

    const observed = diffSnapshots(good, post, { config, origin: "observed-during" });
    expect(observed.every((change) => change.origin === "observed-during")).toBe(true);
    expect(observed.some((change) => change.path === "npm.typescript")).toBe(true);
    expect(observed.some((change) => change.kind === "reordered")).toBe(true);

    const preExisting = diffSnapshots(good, post, { config, origin: "pre-existing" });
    expect(preExisting.every((change) => change.origin === "pre-existing")).toBe(true);

    const reordered = structuredClone(good);
    const original = reordered.path.user;
    reordered.path.user = [original[2] as string, original[0] as string, original[1] as string].filter(
      Boolean,
    );
    const pathChanges = diffSnapshots(good, reordered, { config });
    const move = pathChanges.find((change) => change.category === "path");
    expect(move?.kind).toBe("reordered");
    expect(move?.summary).toContain("position");
  });

  it("fingerprints ignore volatile time/disk facts but change with packages", () => {
    const seed = seedDemo(tempRoot(), { reset: true });
    const good = seed.snapshots.find((snapshot) => snapshot.id === DEMO_GOOD_SNAPSHOT);
    if (!good) throw new Error("demo snapshot missing");

    const base = fingerprintSnapshot(good);
    const quiet = structuredClone(good);
    quiet.time.utc = "2030-01-01T00:00:00.000Z";
    quiet.disks = [];
    quiet.host.uptimeSec = 1;
    expect(fingerprintSnapshot(quiet).fingerprint).toBe(base.fingerprint);

    const changed = structuredClone(good);
    const typescript = changed.packages.find((pkg) => pkg.name === "typescript");
    if (!typescript) throw new Error("typescript package missing");
    typescript.version = "9.9.9";
    expect(fingerprintSnapshot(changed).fingerprint).not.toBe(base.fingerprint);
  });

  it("hashes secret env values and redacts config tokens/urls", () => {
    const raw = "ghp_abcdefghijklmnopqrstuvwxyz012345";
    const secret = redactEnvValue("GITHUB_TOKEN", raw, "test-salt");
    expect(secret.secret).toBe(true);
    expect(secret.value).toBeUndefined();
    expect(secret.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(secret)).not.toContain(raw);
    expect(redactEnvValue("GITHUB_TOKEN", raw, "test-salt").hash).toBe(secret.hash);
    expect(redactEnvValue("GITHUB_TOKEN", raw, "other-salt").hash).not.toBe(secret.hash);

    const config = redactConfigContent(
      `GITHUB_TOKEN=${raw}\nregistry=https://user:password@example.com/\nstrict=true`,
    );
    expect(config.redacted).toBe(true);
    expect(config.content).not.toContain(raw);
    expect(config.content).not.toContain("password");
    expect(config.content).toContain("<redacted>");
    expect(config.content).toContain("strict=true");
    expect(redactText(`Authorization: Bearer ${raw}`)).not.toContain(raw);
  });

  it("does not persist raw secret env values in the database or blobs", () => {
    const seed = seedDemo(tempRoot(), { reset: true });
    const config = ensureConfig(seed.home);
    const raw = "ghp_abcdefghijklmnopqrstuvwxyz012345";
    const snapshot = structuredClone(seed.snapshots[0]);
    if (!snapshot) throw new Error("demo snapshot missing");
    snapshot.env.user = redactEnvRecord(
      { GITHUB_TOKEN: raw, ORDINARY_SETTING: "visible-value" },
      config.salt,
    );
    const store = new Store(seed.home);
    try {
      const meta = store.saveSnapshot(snapshot, { pinned: true });
      const loaded = store.getSnapshot(snapshot.id);
      expect(loaded?.env.user.GITHUB_TOKEN?.secret).toBe(true);
      expect(loaded?.env.user.ORDINARY_SETTING?.value).toBe("visible-value");
      expect(JSON.stringify(loaded)).not.toContain(raw);
      expect(store.getBlob(meta.dataHash).toString("utf8")).not.toContain(raw);
      expect(readFileSync(path.join(seed.home, "db.sqlite")).toString("latin1")).not.toContain(raw);
    } finally {
      store.close();
    }
  });

  it("handles a failed run with no machine changes without inventing a finding", () => {
    const seed = seedDemo(tempRoot(), { reset: true });
    const config = ensureConfig(seed.home);
    const source = seed.snapshots[0];
    if (!source) throw new Error("demo snapshot missing");
    const pre = structuredClone(source);
    const post = structuredClone(source);
    pre.id = "SNAP-NOCHANGE-A";
    post.id = "SNAP-NOCHANGE-B";
    const store = new Store(seed.home);
    store.saveSnapshot(pre, { pinned: true });
    store.saveSnapshot(post, { pinned: true });
    const run: RunRecord = {
      id: "RUN-NOCHANGE",
      command: "node -e \"process.exit(1)\"",
      commandSignature: "CMD-NOCHANGE",
      cwd: post.project?.root ?? process.cwd(),
      projectId: post.project?.id ?? null,
      preSnapshot: pre.id,
      postSnapshot: post.id,
      exitCode: 1,
      signal: null,
      startedAt: Date.now(),
      durationMs: 10,
      stderrTail: null,
      stdoutTail: null,
      referenceSnapshot: null,
      changeSignatures: [],
    };
    store.saveRun(run);

    try {
      const explanation = explainRun(store, config, run);
      expect(explanation.changes).toHaveLength(0);
      expect(explanation.findings).toHaveLength(0);
      const record = openCaseForRun(store, run, explanation);
      expect(record.summary).toBe("No machine changes were observed during the command window.");
      expect(record.findings).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("deduplicates content-addressed blobs in the local store", () => {
    const root = tempRoot();
    ensureConfig(root);
    const store = new Store(root);
    try {
      const first = store.putBlob("same evidence");
      const second = store.putBlob("same evidence");
      const third = store.putBlob("different evidence");
      expect(first.hash).toBe(second.hash);
      expect(first.hash).not.toBe(third.hash);
      expect(store.getBlob(first.hash).toString("utf8")).toBe("same evidence");
      expect(store.getStats().snapshots).toBe(0);
    } finally {
      store.close();
    }
  });
});
