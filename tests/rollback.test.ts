import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureConfig } from "../src/core/config.js";
import { DEMO_CASE_ID, DEMO_POST_SNAPSHOT, seedDemo } from "../src/core/demo.js";
import { FakeEnvironmentAdapter, RealEnvironmentAdapter } from "../src/core/adapters.js";
import {
  applyRollbackPlan,
  buildRollbackPlan,
  generateRollbackScript,
  invertRollbackPlan,
  preflightPlan,
} from "../src/core/rollback.js";
import { Store } from "../src/core/store.js";
import type { Snapshot } from "../src/core/types.js";
import { sha256 } from "../src/core/util.js";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(path.join(process.cwd(), ".envidence", "vitest-rollback-"));
  roots.push(root);
  return root;
}

function seededStore(): { root: string; home: string; store: Store } {
  const root = makeRoot();
  const seed = seedDemo(root, { reset: true });
  const store = new Store(seed.home);
  ensureConfig(seed.home);
  return { root, home: seed.home, store };
}

function initializeFake(adapter: FakeEnvironmentAdapter, snapshot: Snapshot): void {
  adapter.paths.set("user", [...snapshot.path.user]);
  adapter.paths.set("machine", [...snapshot.path.machine]);
  for (const pkg of snapshot.packages) {
    adapter.packages.set(`${pkg.manager}:${pkg.name}`, pkg.version);
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("rollback planner", () => {
  it("plans PATH and TypeScript restoration for the demo case", () => {
    const { home, store } = seededStore();
    try {
      const plan = buildRollbackPlan(store, ensureConfig(home), { caseRef: DEMO_CASE_ID });
      expect(plan.caseId).toBe(DEMO_CASE_ID);
      expect(plan.targetSnapshot).toBe("SNAP-11A00001");
      expect(plan.currentSnapshot).toBe(DEMO_POST_SNAPSHOT);
      expect(plan.actions.map((action) => action.type)).toEqual([
        "path.set",
        "npm.install",
      ]);
      expect(plan.actions[0]?.reversible).toBe(true);
      expect(plan.actions[1]?.payload.to).toBe("5.9.2");

      const script = generateRollbackScript(plan, store, "powershell");
      expect(script).toContain("npm install -g 'typescript@5.9.2'");
      expect(script).toContain("[Environment]::SetEnvironmentVariable('Path'");
    } finally {
      store.close();
    }
  });

  it("applies and inverts automatically with the fake adapter", async () => {
    const { home, store } = seededStore();
    try {
      const config = ensureConfig(home);
      const plan = buildRollbackPlan(store, config, { caseRef: DEMO_CASE_ID });
      const current = store.getSnapshot(DEMO_POST_SNAPSHOT);
      const target = store.getSnapshot("SNAP-11A00001");
      const adapter = new FakeEnvironmentAdapter();
      initializeFake(adapter, current);

      expect(await preflightPlan(plan, adapter)).toEqual([]);
      const applied = await applyRollbackPlan(plan, adapter);
      expect(applied.status).toBe("applied");
      expect(adapter.calls).toContain("setPath:user");
      expect(adapter.calls).toContain("install:npm:typescript@5.9.2");
      expect(await adapter.getPath("user")).toEqual(target.path.user);
      expect(await adapter.getPackageVersion("npm", "typescript")).toBe("5.9.2");

      const inverse = invertRollbackPlan(plan);
      expect(await preflightPlan(inverse, adapter)).toEqual([]);
      const undone = await applyRollbackPlan(inverse, adapter);
      expect(undone.status).toBe("applied");
      expect(await adapter.getPath("user")).toEqual(current.path.user);
      expect(await adapter.getPackageVersion("npm", "typescript")).toBe("6.0.0-dev");
    } finally {
      store.close();
    }
  });

  it("refuses an apply when the current state drifted", async () => {
    const { home, store } = seededStore();
    try {
      const plan = buildRollbackPlan(store, ensureConfig(home), { caseRef: DEMO_CASE_ID });
      const current = store.getSnapshot(DEMO_POST_SNAPSHOT);
      const adapter = new FakeEnvironmentAdapter();
      initializeFake(adapter, current);
      adapter.packages.set("npm:typescript", "7.0.0");

      const conflicts = await preflightPlan(plan, adapter);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]?.actionId).toBe("ACT-02");
      expect(adapter.calls).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("restores and undoes a config file inside the sandbox", async () => {
    const { root, home, store } = seededStore();
    try {
      const config = ensureConfig(home);
      const base = store.getSnapshot(DEMO_POST_SNAPSHOT);
      const file = path.join(root, "sandbox", ".npmrc");
      mkdirSync(path.dirname(file), { recursive: true });
      const before = "registry=https://registry.npmjs.org/\n";
      const after = "registry=https://registry.example.test/\n";
      writeFileSync(file, after, "utf8");

      const target = cloneSnapshot(base, "SNAP-TESTCFG1", Date.now() - 3_600_000, {
        path: file,
        content: before,
      }, store);
      const current = cloneSnapshot(base, "SNAP-TESTCFG2", Date.now() - 1_000, {
        path: file,
        content: after,
      }, store);
      store.saveSnapshot(target);
      store.saveSnapshot(current);

      const plan = buildRollbackPlan(store, config, {
        toRef: target.id,
        only: ["configs"],
      });
      expect(plan.currentSnapshot).toBe(current.id);
      expect(plan.actions).toHaveLength(1);
      expect(plan.actions[0]?.type).toBe("config.restore");

      const adapter = new RealEnvironmentAdapter(store);
      expect(await preflightPlan(plan, adapter)).toEqual([]);
      const applied = await applyRollbackPlan(plan, adapter);
      expect(applied.status).toBe("applied");
      expect(readFileSync(file, "utf8")).toBe(before);

      const inverse = invertRollbackPlan(plan);
      expect(await preflightPlan(inverse, adapter)).toEqual([]);
      const undone = await applyRollbackPlan(inverse, adapter);
      expect(undone.status).toBe("applied");
      expect(readFileSync(file, "utf8")).toBe(after);
    } finally {
      store.close();
    }
  });
});

function cloneSnapshot(
  base: Snapshot,
  id: string,
  createdAt: number,
  configChange: { path: string; content: string },
  store: Store,
): Snapshot {
  const blob = store.putBlob(configChange.content).hash;
  return {
    ...base,
    id,
    createdAt: new Date(createdAt).toISOString(),
    label: id,
    trigger: "manual",
    configs: [
      ...base.configs.filter((entry) => entry.path !== configChange.path),
      {
        path: configChange.path,
        scope: "user",
        hash: sha256(configChange.content),
        size: Buffer.byteLength(configChange.content),
        blob,
        redacted: false,
        restorable: true,
        missing: false,
      },
    ],
  };
}
