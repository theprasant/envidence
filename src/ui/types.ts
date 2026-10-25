import type {
  BaselineRecord,
  CaseRecord,
  Change,
  Config,
  Finding,
  HostInfo,
  JsonValue,
  ProjectContext,
  RollbackPlan,
  RollbackRecord,
  RunRecord,
  SnapshotMeta,
  SnapshotWarning,
} from "../core/types.js";

export type {
  BaselineRecord,
  CaseRecord,
  Change,
  Finding,
  HostInfo,
  JsonValue,
  ProjectContext,
  RollbackPlan,
  RollbackRecord,
  RunRecord,
  SnapshotMeta,
  SnapshotWarning,
};

export type PublicConfig = Omit<Config, "salt" | "secretPatterns"> & {
  salt: "<redacted>";
  secretPatternCount: number;
};

export type StoreStats = {
  snapshots: number;
  runs: number;
  cases: number;
  rollbacks: number;
  bytes: number;
};

export type SnapshotBrief = {
  id: string;
  createdAt: number;
  label: string | null;
  trigger: string;
  profile: string;
};

export type CaseSummary = {
  id: string;
  title: string;
  status: "open" | "closed";
  createdAt: number;
  closedAt: number | null;
  runId: string;
  summary: string;
  findingCount: number;
  topFinding: {
    title: string;
    score: number;
    confidence: "high" | "medium" | "low";
    category: string;
    fix: string;
  } | null;
  rollbackId: string | null;
};

export type RunSummary = {
  id: string;
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  startedAt: number;
  durationMs: number;
  preSnapshot: string;
  postSnapshot: string | null;
  caseId: string | null;
  caseTitle: string | null;
};

export type TimelineEvent = {
  type: "snapshot" | "run" | "case" | "baseline";
  at: number;
  id: string;
  label?: string | null;
  trigger?: string;
  profile?: string;
  warnings?: number;
  command?: string;
  exitCode?: number | null;
  durationMs?: number;
  caseId?: string | null;
  title?: string;
  status?: string;
  topFinding?: string | null;
  score?: number | null;
  snapshotId?: string;
  active?: boolean;
};

export type Bootstrap = {
  product: {
    name: string;
    version: string;
    tagline: string;
    schemaVersion: number;
  };
  store: {
    home: string;
    stats: StoreStats;
    latestSnapshot: SnapshotMeta | null;
    activeBaseline: BaselineRecord | null;
    baselineDrift: number | null;
    config: PublicConfig;
  };
  cases: CaseSummary[];
  runs: RunSummary[];
  snapshots: SnapshotMeta[];
  baselines: BaselineRecord[];
  rollbacks: RollbackRecord[];
  events: TimelineEvent[];
};

export type CaseDetail = {
  case: CaseRecord;
  run: RunRecord;
  reference: SnapshotBrief;
  referenceSource: string;
  pre: SnapshotBrief;
  post: SnapshotBrief;
  changes: Change[];
  nonVolatileChanges: Change[];
  findings: Finding[];
  project: ProjectContext | null;
  host: HostInfo;
  warnings: SnapshotWarning[];
  fingerprint: string;
  rollbacks: RollbackRecord[];
};

export type SnapshotDetail = {
  meta: SnapshotMeta;
  previous: SnapshotMeta | null;
  changes: Change[];
  fingerprint: string;
  project: ProjectContext | null;
  host: HostInfo;
  warnings: SnapshotWarning[];
  inventory: {
    packages: number;
    services: number;
    startup: number;
    tasks: number;
    listeners: number;
    tools: number;
    configs: number;
  };
};

export type Json = JsonValue;
