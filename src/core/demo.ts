import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ensureConfig } from "./config.js";
import { explainRun } from "./run.js";
import { Store } from "./store.js";
import type {
  CaseRecord,
  Change,
  Finding,
  ListenerInfo,
  PackageInfo,
  ProjectContext,
  RunRecord,
  Snapshot,
  ToolInfo,
} from "./types.js";
import { isWindows } from "./util.js";

export const DEMO_CASE_ID = "CASE-20261023-7F3A";
export const DEMO_RUN_ID = "RUN-11A00002";
export const DEMO_GOOD_SNAPSHOT = "SNAP-11A00001";
export const DEMO_PRE_SNAPSHOT = "SNAP-11A00002";
export const DEMO_POST_SNAPSHOT = "SNAP-11A00003";
export const DEMO_TOP_RULE = "package.global_changed";
export const DEMO_TOP_TITLE = "Global npm package typescript changed";

const GOOD_AT = Date.parse("2026-10-22T09:00:00.000Z");
const BAD_AT = Date.parse("2026-10-23T04:30:00.000Z");
const BAD_POST_AT = Date.parse("2026-10-23T04:31:00.000Z");
const SUCCESS_RUN_AT = Date.parse("2026-10-22T09:01:00.000Z");
const FAILED_RUN_AT = Date.parse("2026-10-23T04:30:05.000Z");
const DEMO_MARKER = "demo.json";

export type DemoSeed = {
  home: string;
  caseRecord: CaseRecord;
  findings: Finding[];
  changes: Change[];
  nonVolatileChanges: Change[];
  snapshots: Snapshot[];
  runs: RunRecord[];
};

export function demoHomeFor(home: string): string {
  return path.join(path.resolve(home), "demo");
}

export function seedDemo(home: string, options: { reset?: boolean } = {}): DemoSeed {
  const demoHome = demoHomeFor(home);
  const marker = path.join(demoHome, DEMO_MARKER);
  const seeded = existsSync(marker) && !options.reset;
  if (!seeded) {
    if (existsSync(demoHome)) rmSync(demoHome, { recursive: true, force: true });
    mkdirSync(demoHome, { recursive: true });
    ensureConfig(demoHome);
  }
  const store = new Store(demoHome);
  try {
    if (!seeded) {
      seedStore(store);
      writeFileSync(
        marker,
        `${JSON.stringify({ schemaVersion: 1, seededFor: DEMO_CASE_ID }, null, 2)}\n`,
        "utf8",
      );
    }
    const caseRecord = store.getCase(DEMO_CASE_ID);
    if (!caseRecord) {
      throw new Error("Demo case is missing from the demo store. Run `evd demo --reset`.");
    }
    const run = store.getRun(caseRecord.runId);
    if (!run) throw new Error("Demo run is missing from the demo store.");
    const config = ensureConfig(demoHome);
    const explanation = explainRun(store, config, run);
    const snapshots = [DEMO_GOOD_SNAPSHOT, DEMO_PRE_SNAPSHOT, DEMO_POST_SNAPSHOT]
      .map((id) => store.findSnapshot(id))
      .filter((snapshot): snapshot is Snapshot => snapshot !== null);
    const runs = [store.getRun("RUN-11A00001"), store.getRun(DEMO_RUN_ID)].filter(
      (record): record is RunRecord => record !== null,
    );
    return {
      home: demoHome,
      caseRecord,
      findings: caseRecord.findings.length > 0 ? caseRecord.findings : explanation.findings,
      changes: explanation.changes,
      nonVolatileChanges: explanation.nonVolatileChanges,
      snapshots,
      runs,
    };
  } finally {
    store.close();
  }
}

function seedStore(store: Store): void {
  const good = fixtureSnapshot("good", DEMO_GOOD_SNAPSHOT, GOOD_AT, "Last known good");
  const bad = fixtureSnapshot("bad", DEMO_PRE_SNAPSHOT, BAD_AT, "Before npm test");
  const post = fixtureSnapshot("bad", DEMO_POST_SNAPSHOT, BAD_POST_AT, "After npm test");
  post.time = { ...post.time, utc: new Date(BAD_POST_AT).toISOString() };

  store.saveSnapshot(good, { durationMs: 1810 });
  store.saveSnapshot(bad, { durationMs: 1930 });
  store.saveSnapshot(post, { durationMs: 1740 });
  store.setBaseline(good.id, "Last known good", GOOD_AT);

  const success: RunRecord = {
    id: "RUN-11A00001",
    command: "npm test",
    commandSignature: "CMD-DEMO-SUCCESS",
    cwd: demoRoot(),
    projectId: demoProject().id,
    preSnapshot: good.id,
    postSnapshot: good.id,
    exitCode: 0,
    signal: null,
    startedAt: SUCCESS_RUN_AT,
    durationMs: 4820,
    stderrTail: "",
    stdoutTail: "Test Files  12 passed (12)\n     Tests  48 passed (48)",
    referenceSnapshot: null,
    changeSignatures: [],
  };
  store.saveRun(success);

  const failed: RunRecord = {
    id: DEMO_RUN_ID,
    command: "npm test",
    commandSignature: "CMD-DEMO-SUCCESS",
    cwd: demoRoot(),
    projectId: demoProject().id,
    preSnapshot: bad.id,
    postSnapshot: post.id,
    exitCode: 1,
    signal: null,
    startedAt: FAILED_RUN_AT,
    durationMs: 5011,
    stderrTail:
      "src/math.test.ts(12,7): error TS2345: Argument of type 'number' is not assignable to parameter of type 'string'.\n" +
      "Test Files  1 failed (1)\n     Tests  1 failed | 47 passed (48)",
    stdoutTail: "",
    referenceSnapshot: good.id,
    changeSignatures: [],
  };
  store.saveRun(failed);
  const stored = store.getRun(failed.id);
  if (!stored) throw new Error("Could not seed demo run.");
  const config = ensureConfig(store.home);
  const explanation = explainRun(store, config, stored);
  const caseRecord: CaseRecord = {
    id: DEMO_CASE_ID,
    title: "npm test failed after TypeScript prerelease install",
    status: "open",
    createdAt: BAD_POST_AT,
    closedAt: null,
    runId: failed.id,
    referenceSnapshot: good.id,
    findings: explanation.findings,
    summary: explanation.findings[0]
      ? `Top suspect: ${explanation.findings[0].title}. The change happened before the failing test run; the evidence is shown as a pre-existing difference from the last successful run.`
      : "No machine changes were observed between the last successful run and this failure.",
    rollbackId: null,
  };
  store.saveCase(caseRecord);
  store.updateRun(failed.id, {
    changeSignatures: explanation.changes.map((change) => change.signature),
  });
  store.logEvent("demo.seed", {
    caseId: caseRecord.id,
    topFinding: explanation.findings[0]?.signature ?? null,
  });
}

function fixtureSnapshot(
  state: "good" | "bad",
  id: string,
  at: number,
  label: string,
): Snapshot {
  const good = state === "good";
  const root = demoRoot();
  const typescript = good ? "5.9.2" : "6.0.0-dev";
  const userPath = good
    ? [
        demoPath("Program Files", "nodejs"),
        demoPath("Users", "demo", "AppData", "Roaming", "npm"),
        demoPath("Program Files", "Git", "cmd"),
        demoPath("Users", "demo", "AppData", "Local", "Programs", "Microsoft VS Code", "bin"),
      ]
    : [
        demoPath("Program Files", "nodejs"),
        demoPath("Program Files", "Git", "cmd"),
        demoPath("Users", "demo", "AppData", "Local", "Programs", "Microsoft VS Code", "bin"),
        demoPath("Users", "demo", "AppData", "Roaming", "npm"),
      ];
  const tools: Record<string, ToolInfo> = {
    node: tool("node", demoPath("Program Files", "nodejs", isWindows ? "node.exe" : "node"), "24.16.0"),
    npm: tool("npm", demoPath("Program Files", "nodejs", isWindows ? "npm.cmd" : "npm"), "11.6.2"),
    npx: tool("npx", demoPath("Program Files", "nodejs", isWindows ? "npx.cmd" : "npx"), "11.6.2"),
    git: tool("git", demoPath("Program Files", "Git", "cmd", isWindows ? "git.exe" : "git"), "2.51.1"),
    code: tool(
      "code",
      demoPath("Users", "demo", "AppData", "Local", "Programs", "Microsoft VS Code", "bin", isWindows ? "code.cmd" : "code"),
      "1.105.0",
    ),
  };
  const packages: PackageInfo[] = [
    { manager: "npm", name: "typescript", version: typescript, scope: "global" },
    { manager: "npm", name: "vite", version: "7.1.5", scope: "global" },
    { manager: "npm", name: "eslint", version: "9.37.0", scope: "global" },
    { manager: "pip", name: "ruff", version: "0.13.2", scope: "global" },
    { manager: "cargo", name: "ripgrep", version: "14.1.1", scope: "global" },
  ];
  const project = demoProject();
  const listeners: ListenerInfo[] = [
    {
      protocol: "tcp",
      address: "127.0.0.1",
      port: 5173,
      pid: 4242,
      processName: "node.exe",
    },
    {
      protocol: "tcp",
      address: "0.0.0.0",
      port: 5432,
      pid: 812,
      processName: "postgres.exe",
    },
  ];
  return {
    schemaVersion: 1,
    id,
    createdAt: new Date(at).toISOString(),
    label,
    trigger: "demo",
    profile: "full",
    host: {
      os: "Microsoft Windows 11 Pro",
      version: "10.0.22631",
      build: "22631",
      arch: "x64",
      hostname: "atlas-dev",
      username: "demo",
      timezone: "Asia/Kolkata",
      uptimeSec: 84_320,
      bootTime: new Date(at - 84_320_000).toISOString(),
      clockUtc: new Date(at).toISOString(),
    },
    env: {
      user: {
        NODE_ENV: { value: "development" },
        NPM_CONFIG_REGISTRY: { value: "https://registry.npmjs.org/" },
      },
      machine: {
        ComSpec: { value: demoPath("Windows", "System32", "cmd.exe") },
        PATHEXT: { value: ".COM;.EXE;.BAT;.CMD" },
      },
      effective: {
        NODE_ENV: { value: "development" },
        NPM_CONFIG_REGISTRY: { value: "https://registry.npmjs.org/" },
      },
    },
    path: {
      user: userPath,
      machine: [
        demoPath("Windows", "System32"),
        demoPath("Windows"),
        demoPath("Windows", "System32", "Wbem"),
      ],
      effective: [
        demoPath("Program Files", "nodejs"),
        demoPath("Users", "demo", "AppData", "Roaming", "npm"),
        demoPath("Program Files", "Git", "cmd"),
        demoPath("Users", "demo", "AppData", "Local", "Programs", "Microsoft VS Code", "bin"),
        demoPath("Windows", "System32"),
      ],
      duplicates: [],
      missing: [],
    },
    tools,
    packages,
    services: [
      {
        name: "com.docker.service",
        displayName: "Docker Desktop Service",
        state: "Running",
        startMode: "Auto",
      },
      {
        name: "postgresql-x64-16",
        displayName: "PostgreSQL Server 16",
        state: "Running",
        startMode: "Auto",
      },
    ],
    startup: [
      {
        scope: "user",
        name: "Docker Desktop",
        command: demoPath("Program Files", "Docker", "Docker", "Docker Desktop.exe"),
        enabled: true,
      },
    ],
    tasks: [
      {
        path: "\\Microsoft\\Windows\\Defrag\\",
        name: "ScheduledDefrag",
        state: "Ready",
        triggerSummary: "Weekly",
      },
    ],
    listeners,
    programs: [
      { name: "Git", version: "2.51.1", publisher: "The Git Development Community" },
      { name: "Microsoft Visual Studio Code", version: "1.105.0", publisher: "Microsoft Corporation" },
      { name: "Docker Desktop", version: "4.47.0", publisher: "Docker Inc." },
    ],
    hotfixes: [{ id: "KB5065789", installedOn: "2026-10-14" }],
    network: {
      proxies: { env: {} },
      dnsServers: ["1.1.1.1", "8.8.8.8"],
      hostsHash: "7B9A0F4B27C226E8E7E9F0F7A9A6F6C2A0D2D2B7D5A28D3C6A2D5C7B8E9F0A11",
    },
    configs: [
      {
        path: demoPath("Users", "demo", ".npmrc"),
        scope: "user",
        hash: "4F7D1A5E7D3C9B2A0F6E8C1D4A7B9F2E6C8D0A1B3D5F7E9A2C4B6D8F0E1A3C5B",
        size: 78,
        redacted: true,
        restorable: true,
        missing: false,
      },
      {
        path: demoPath("Users", "demo", ".gitconfig"),
        scope: "user",
        hash: "9A1B3C5D7E9F0A2B4C6D8E0F1A3B5C7D9E1F3A5B7C9D0E2F4A6B8C0D1E3F5A7B",
        size: 210,
        redacted: true,
        restorable: true,
        missing: false,
      },
    ],
    shell: {
      current: "pwsh",
      psVersion: "7.5.3",
      executionPolicy: "RemoteSigned",
      profiles: [
        {
          path: demoPath("Users", "demo", "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1"),
          hash: "2A4C6E8F0A1B3C5D7E9F1A3B5C7D9E0F2A4B6C8D0E1F3A5B7C9D1E3F5A7B9C0D2",
        },
      ],
    },
    time: {
      utc: new Date(at).toISOString(),
      timezone: "Asia/Kolkata",
      ntpStatus: "Normal",
      lastSync: "2026-10-23T04:10:00.000Z",
    },
    disks: [
      {
        mount: isWindows ? "C:" : "/",
        totalBytes: 1_000_204_886_016,
        freeBytes: good ? 221_237_182_464 : 219_902_623_744,
      },
    ],
    wsl: [{ name: "Ubuntu-24.04", state: "Running", version: "2" }],
    project,
    warnings: [],
  };
}

function demoProject(): ProjectContext {
  return {
    id: "PRJ-7A3F19C2",
    root: demoRoot(),
    kind: "node",
    manifests: [{ path: "package.json", hash: "A9F2D5C8B1E4A7D0C3F6B9E2A5D8C1F4B7E0A3D6C9F2B5E8A1D4C7F0B3E6A9D2" }],
    lockfiles: [{ path: "package-lock.json", hash: "C4E7A0D3B6F9C2E5A8D1B4F7C0E3A6D9B2F5C8E1A4D7B0F3C6E9A2D5B8F1C4E7" }],
    git: {
      branch: "main",
      commit: "7c1e9a4b2d8f6035a7c9e1b3d5f7081a2c4e6b8d",
      dirtyTracked: 0,
      untracked: 0,
      stashCount: 0,
    },
    scripts: {
      dev: "vite",
      test: "vitest run",
      build: "tsc && vite build",
    },
    dependencies: ["react", "react-dom"],
    devDependencies: ["typescript", "vite", "vitest", "@types/node"],
    toolNames: ["node", "npm", "vite", "vitest", "tsc"],
    envKeys: ["NODE_ENV", "VITE_API_URL"],
    envReferences: [{ name: "VITE_API_URL", file: "src/api.ts", line: 12 }],
    ports: [3000, 5173],
    services: ["postgresql-x64-16"],
    dockerServices: [{ name: "db", image: "postgres:16", ports: [5432] }],
    configFiles: [{ path: ".env.example", hash: "D4F7A0C3B6E9D2F5A8C1B4E7D0F3A6C9B2E5D8F1A4C7B0E3D6F9A2C5B8E1D4F7" }],
  };
}

function demoRoot(): string {
  return isWindows ? "C:\\Users\\demo\\projects\\atlas" : "/home/demo/projects/atlas";
}

function demoPath(...parts: string[]): string {
  return isWindows ? `C:\\${parts.join("\\")}` : `/${parts.join("/")}`;
}

function tool(name: string, resolvedPath: string, version: string): ToolInfo {
  return {
    name,
    paths: [resolvedPath],
    resolvedPath,
    version,
    versionSource: "exec",
  };
}
