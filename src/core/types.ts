export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export type EnvValue = {
  value?: string;
  hash?: string;
  preview?: string;
  secret?: boolean;
};

export type HostInfo = {
  os: string;
  version: string;
  build: string;
  arch: string;
  hostname: string;
  username: string;
  timezone: string;
  uptimeSec: number;
  bootTime: string;
  clockUtc: string;
};

export type PathInfo = {
  user: string[];
  machine: string[];
  effective: string[];
  duplicates: string[];
  missing: string[];
};

export type ToolInfo = {
  name: string;
  paths: string[];
  resolvedPath: string | null;
  version: string | null;
  versionSource: "exec" | "cache" | "unknown";
};

export type PackageManager =
  | "npm"
  | "pip"
  | "cargo"
  | "dotnet"
  | "winget"
  | "choco"
  | "scoop"
  | "vscode";

export type PackageInfo = {
  manager: PackageManager;
  name: string;
  version: string;
  scope?: string;
};

export type ServiceInfo = {
  name: string;
  displayName: string;
  state: string;
  startMode: string;
  startName?: string;
  pathName?: string;
};

export type StartupInfo = {
  scope: "user" | "machine" | "startup-folder";
  name: string;
  command: string;
  enabled: boolean;
};

export type TaskInfo = {
  path: string;
  name: string;
  state: string;
  triggerSummary: string;
};

export type ListenerInfo = {
  protocol: "tcp" | "udp";
  address: string;
  port: number;
  pid: number;
  processName: string;
  processPath?: string;
};

export type ProgramInfo = {
  name: string;
  version: string;
  publisher?: string;
  installDate?: string;
  uninstallString?: string;
  wingetId?: string;
};

export type HotfixInfo = {
  id: string;
  installedOn?: string;
};

export type NetworkInfo = {
  proxies: {
    winhttp?: string;
    ie?: string;
    env?: Record<string, string>;
  };
  dnsServers: string[];
  hostsHash: string | null;
};

export type ConfigFileInfo = {
  path: string;
  scope: "user" | "machine";
  hash: string | null;
  size: number | null;
  blob?: string;
  redacted: boolean;
  restorable?: boolean;
  missing: boolean;
  sensitive?: boolean;
};

export type ShellInfo = {
  current: string;
  psVersion?: string;
  executionPolicy?: string;
  profiles: Array<{ path: string; hash: string | null }>;
};

export type TimeInfo = {
  utc: string;
  timezone: string;
  ntpStatus?: string;
  lastSync?: string;
};

export type DiskInfo = {
  mount: string;
  totalBytes: number;
  freeBytes: number;
};

export type WslInfo = {
  name: string;
  state: string;
  version: string;
};

export type GitInfo = {
  branch: string;
  commit: string;
  dirtyTracked: number;
  untracked: number;
  stashCount: number;
  remote?: string;
};

export type ProjectContext = {
  id: string;
  root: string;
  kind: "node" | "python" | "rust" | "dotnet" | "go" | "unknown";
  manifests: Array<{ path: string; hash: string }>;
  lockfiles: Array<{ path: string; hash: string }>;
  git: GitInfo | null;
  scripts: Record<string, string>;
  dependencies: string[];
  devDependencies: string[];
  toolNames: string[];
  envKeys: string[];
  envReferences: Array<{ name: string; file: string; line: number }>;
  ports: number[];
  services: string[];
  dockerServices: Array<{ name: string; image: string; ports: number[] }>;
  configFiles: Array<{ path: string; hash: string }>;
};

export type SnapshotWarning = {
  collector: string;
  message: string;
};

export type Snapshot = {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  label?: string;
  trigger: "manual" | "watch" | "schedule" | "agent" | "baseline" | "pre_rollback" | "demo";
  profile: "fast" | "full";
  host: HostInfo;
  env: {
    user: Record<string, EnvValue>;
    machine: Record<string, EnvValue>;
    effective: Record<string, EnvValue>;
  };
  path: PathInfo;
  tools: Record<string, ToolInfo>;
  packages: PackageInfo[];
  services: ServiceInfo[];
  startup: StartupInfo[];
  tasks: TaskInfo[];
  listeners: ListenerInfo[];
  programs: ProgramInfo[];
  hotfixes: HotfixInfo[];
  network: NetworkInfo;
  configs: ConfigFileInfo[];
  shell: ShellInfo;
  time: TimeInfo;
  disks: DiskInfo[];
  wsl: WslInfo[];
  project: ProjectContext | null;
  warnings: SnapshotWarning[];
};

export type Category =
  | "host"
  | "env"
  | "path"
  | "tools"
  | "runtimes"
  | "packages"
  | "services"
  | "startup"
  | "tasks"
  | "listeners"
  | "programs"
  | "hotfixes"
  | "network"
  | "configs"
  | "shell"
  | "time"
  | "disks"
  | "wsl"
  | "project";

export type Fact = {
  category: Category;
  path: string;
  value: JsonValue;
  volatile?: boolean;
};

export type ChangeKind = "added" | "removed" | "changed" | "reordered";

export type ChangeOrigin = "pre-existing" | "observed-during" | "background";

export type Change = {
  signature: string;
  category: Category;
  path: string;
  kind: ChangeKind;
  before: JsonValue;
  after: JsonValue;
  origin: ChangeOrigin;
  label: string;
  summary: string;
  volatile?: boolean;
};

export type RunRecord = {
  id: string;
  command: string;
  commandSignature: string;
  cwd: string;
  projectId: string | null;
  preSnapshot: string;
  postSnapshot: string | null;
  exitCode: number | null;
  signal: string | null;
  startedAt: number;
  durationMs: number;
  stderrTail: string | null;
  stdoutTail: string | null;
  referenceSnapshot: string | null;
  changeSignatures: string[];
};

export type Confidence = "high" | "medium" | "low";

export type Finding = {
  rank: number;
  signature: string;
  rule: string;
  category: Category;
  title: string;
  description: string;
  confidence: Confidence;
  score: number;
  base: number;
  relevance: number;
  recency: number;
  correlationLift: number;
  before: JsonValue;
  after: JsonValue;
  evidence: string[];
  fix: string;
  actionable: boolean;
};

export type CaseRecord = {
  id: string;
  title: string;
  status: "open" | "closed";
  createdAt: number;
  closedAt: number | null;
  runId: string;
  referenceSnapshot: string;
  findings: Finding[];
  summary: string;
  rollbackId: string | null;
};

export type BaselineRecord = {
  id: string;
  label: string;
  snapshotId: string;
  createdAt: number;
  active: boolean;
};

export type RollbackActionType =
  | "env.set"
  | "env.unset"
  | "path.set"
  | "npm.install"
  | "npm.uninstall"
  | "pip.install"
  | "pip.uninstall"
  | "cargo.install"
  | "cargo.uninstall"
  | "vscode.install"
  | "vscode.uninstall"
  | "service.set"
  | "startup.set"
  | "startup.remove"
  | "task.enable"
  | "task.disable"
  | "config.restore"
  | "manual";

export type RollbackAction = {
  id: string;
  type: RollbackActionType;
  title: string;
  description: string;
  category: Category;
  reversible: boolean;
  requiresAdmin: boolean;
  signature?: string;
  payload: JsonObject;
};

export type RollbackPlan = {
  id: string;
  createdAt: number;
  caseId: string | null;
  runId: string | null;
  targetSnapshot: string | null;
  currentSnapshot: string | null;
  actions: RollbackAction[];
  manual: string[];
  warnings: string[];
};

export type RollbackRecord = {
  id: string;
  createdAt: number;
  caseId: string | null;
  runId: string | null;
  plan: RollbackPlan;
  status: "planned" | "applied" | "failed" | "undone";
  safetySnapshot: string | null;
  log: Array<{
    actionId: string;
    status: "ok" | "skipped" | "failed";
    message: string;
    at: number;
    command?: string;
    before?: JsonValue;
    after?: JsonValue;
    durationMs?: number;
  }>;
};

export type Config = {
  schemaVersion: 1;
  profile: "fast" | "full";
  salt: string;
  retention: {
    keep: number;
    olderThanDays: number;
  };
  redaction: "none" | "standard" | "strict";
  collectors: {
    services: boolean;
    startup: boolean;
    tasks: boolean;
    programs: boolean;
    hotfixes: boolean;
    vscodeExtensions: boolean;
    wsl: boolean;
    winget: boolean;
    cargo: boolean;
    dotnet: boolean;
  };
  noise: {
    ignore: string[];
    ignoreServices: string[];
    ephemeralPorts: boolean;
  };
  project: {
    scan: boolean;
    maxFiles: number;
    maxBytes: number;
  };
  ui: {
    port: number;
  };
  rollback: {
    requireConfirmation: boolean;
    safetySnapshot: boolean;
  };
  secretPatterns: string[];
};

export type SnapshotRow = {
  id: string;
  created_at: number;
  label: string | null;
  trigger: string;
  profile: string;
  data_hash: string;
  size_bytes: number;
  duration_ms: number;
  warnings_json: string;
  host_json?: string;
  pinned?: number;
};

export type SnapshotMeta = {
  id: string;
  createdAt: number;
  label: string | null;
  trigger: Snapshot["trigger"];
  profile: Snapshot["profile"];
  dataHash: string;
  sizeBytes: number;
  durationMs: number;
  warnings: SnapshotWarning[];
  pinned: boolean;
  host: Pick<HostInfo, "hostname" | "os" | "version" | "build">;
};

export type ReferenceInfo = {
  snapshotId: string | null;
  source: "last-success" | "baseline" | "latest" | "none";
  runId?: string;
  at?: number;
};

export type ChangeStats = {
  signature: string;
  category: Category;
  path: string;
  runsPresent: number;
  failsPresent: number;
  runsAbsent: number;
  failsAbsent: number;
  lastSeen: number;
};

export type PruneResult = {
  dryRun: boolean;
  candidates: SnapshotMeta[];
  snapshotsDeleted: number;
  bytesFreed: number;
  protectedCount: number;
};

export type StoreStats = {
  snapshots: number;
  runs: number;
  cases: number;
  rollbacks: number;
  bytes: number;
};
