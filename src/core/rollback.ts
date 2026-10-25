import type {
  EnvironmentAdapter,
  EnvScope,
  RollbackPackageManager,
  ServiceState,
  StartupScope,
  StartupState,
  TaskState,
} from "./adapters.js";
import { diffSnapshots } from "./diff.js";
import type { Store } from "./store.js";
import type {
  CaseRecord,
  Category,
  Change,
  Config,
  JsonObject,
  JsonValue,
  PackageInfo,
  RollbackAction,
  RollbackActionType,
  RollbackPlan,
  RollbackRecord,
  RunRecord,
  Snapshot,
} from "./types.js";
import { isWindows, pathKey, rollbackId, stableStringify, truncate } from "./util.js";

export type RollbackPlanOptions = {
  caseRef?: string;
  runRef?: string;
  toRef?: string;
  changeSignature?: string;
  only?: Category[];
  id?: string;
  createdAt?: number;
};

export type ApplyOptions = {
  failFast?: boolean;
  onProgress?: (message: string) => void;
};

export type ApplyResult = {
  status: "applied" | "failed";
  log: RollbackRecord["log"];
};

export type PreflightConflict = {
  actionId: string;
  title: string;
  expected: string;
  actual: string;
  message: string;
};

type DraftAction = Omit<RollbackAction, "id">;

type PlanSource = {
  caseRecord: CaseRecord | null;
  run: RunRecord | null;
  target: Snapshot;
  current: Snapshot;
};

const SUPPORTED_PACKAGE_MANAGERS = new Set<RollbackPackageManager>([
  "npm",
  "pip",
  "cargo",
  "vscode",
]);

const ACTION_ORDER: Partial<Record<RollbackActionType, number>> = {
  "config.restore": 0,
  "env.set": 1,
  "env.unset": 1,
  "path.set": 1,
  "npm.install": 2,
  "npm.uninstall": 2,
  "pip.install": 2,
  "pip.uninstall": 2,
  "cargo.install": 2,
  "cargo.uninstall": 2,
  "vscode.install": 2,
  "vscode.uninstall": 2,
  "service.set": 3,
  "startup.set": 3,
  "startup.remove": 3,
  "task.enable": 3,
  "task.disable": 3,
  manual: 9,
};

/**
 * Build a reviewable plan from a case, a run, a target snapshot, or one change.
 * Building a plan is read-only; nothing is applied until applyRollbackPlan().
 */
export function buildRollbackPlan(
  store: Store,
  config: Config,
  options: RollbackPlanOptions,
): RollbackPlan {
  const source = resolveSource(store, options);
  const changes = selectChanges(source, store, config, options);
  const drafts: DraftAction[] = [];
  const seen = new Set<string>();
  const manual: string[] = [];
  const manualSeen = new Set<string>();
  const warnings: string[] = [];

  const addAction = (key: string, action: DraftAction): void => {
    if (seen.has(key)) return;
    seen.add(key);
    drafts.push(action);
  };
  const addManual = (message: string): void => {
    const normalized = message.trim();
    if (!normalized || manualSeen.has(normalized)) return;
    manualSeen.add(normalized);
    manual.push(normalized);
  };

  const configChanges = changes.filter((change) => change.category === "configs");
  generateConfigActions(source, configChanges, addAction, addManual, warnings);

  const envChanges = changes.filter((change) => change.category === "env");
  generateEnvActions(source, envChanges, addAction, addManual);

  const pathChanges = changes.filter((change) => change.category === "path");
  generatePathActions(source, pathChanges, addAction, addManual);

  const packageChanges = changes.filter((change) => change.category === "packages");
  for (const change of packageChanges) {
    generatePackageAction(source, change, addAction, addManual);
  }

  for (const change of changes.filter((change) => change.category === "services")) {
    generateServiceAction(source, change, addAction, addManual);
  }
  for (const change of changes.filter((change) => change.category === "startup")) {
    generateStartupAction(source, change, addAction, addManual, warnings);
  }
  for (const change of changes.filter((change) => change.category === "tasks")) {
    generateTaskAction(source, change, addAction, addManual);
  }

  generateManualNotes(source, changes, warnings, addManual);

  drafts.sort((a, b) => {
    const order = (ACTION_ORDER[a.type] ?? 8) - (ACTION_ORDER[b.type] ?? 8);
    if (order !== 0) return order;
    return a.title.localeCompare(b.title);
  });
  const actions = drafts.map((draft, index) => ({
    ...draft,
    id: `ACT-${String(index + 1).padStart(2, "0")}`,
  }));

  if (actions.some((action) => action.requiresAdmin)) {
    warnings.push(
      "Some actions require an elevated shell. Envidence will not auto-elevate or show a surprise UAC prompt.",
    );
  }
  if (actions.length === 0) {
    warnings.push(
      manual.length > 0
        ? "No automatically reversible actions were found. Review the manual steps below."
        : "No machine changes need restoration for this selection.",
    );
  }

  return {
    id: options.id ?? rollbackId(),
    createdAt: options.createdAt ?? Date.now(),
    caseId: source.caseRecord?.id ?? null,
    runId: source.run?.id ?? null,
    targetSnapshot: source.target.id,
    currentSnapshot: source.current.id,
    actions,
    manual: manual.slice(0, 40),
    warnings: [...new Set(warnings)],
  };
}

function resolveSource(store: Store, options: RollbackPlanOptions): PlanSource {
  let caseRecord: CaseRecord | null = null;
  let run: RunRecord | null = null;

  if (options.caseRef) {
    caseRecord = store.getCase(options.caseRef);
    if (!caseRecord) throw new Error(`Case not found: ${options.caseRef}`);
    run = store.getRun(caseRecord.runId);
    if (!run) throw new Error(`Run for case ${caseRecord.id} is missing.`);
  }
  if (options.runRef) {
    const found = store.findRun(options.runRef);
    if (!found) throw new Error(`Run not found: ${options.runRef}`);
    run = found;
    caseRecord = store.caseForRun(found.id);
  }
  if (!caseRecord && !run && options.changeSignature) {
    const ownerCase = store
      .listCases(200)
      .find((candidate) => candidate.findings.some((finding) => finding.signature === options.changeSignature));
    if (ownerCase) {
      caseRecord = ownerCase;
      run = store.getRun(ownerCase.runId);
    } else {
      run =
        store
          .listRuns(200)
          .find((candidate) => candidate.changeSignatures.includes(options.changeSignature as string)) ??
        null;
    }
    if (!caseRecord && !run) {
      throw new Error(
        `Change ${options.changeSignature} is not linked to a recent run. Use --case or --run.`,
      );
    }
  }
  if (!caseRecord && !run && !options.toRef) {
    throw new Error("Rollback needs one of --case, --run, --to, or --change.");
  }

  const targetRef =
    options.toRef ??
    caseRecord?.referenceSnapshot ??
    run?.referenceSnapshot ??
    run?.preSnapshot ??
    null;
  if (!targetRef) throw new Error("Could not determine the target snapshot for this rollback.");
  const currentRef = run?.postSnapshot ?? store.latestSnapshotId();
  if (!currentRef) throw new Error("No current snapshot is available for this rollback.");

  return {
    caseRecord,
    run,
    target: store.getSnapshot(targetRef),
    current: store.getSnapshot(currentRef),
  };
}

function selectChanges(
  source: PlanSource,
  store: Store,
  config: Config,
  options: RollbackPlanOptions,
): Change[] {
  const all = diffSnapshots(source.target, source.current, {
    config,
    project: source.current.project ?? source.target.project,
  }).filter((change) => !change.volatile);

  let allowed: Set<string> | null = null;
  if (options.changeSignature) {
    allowed = new Set([options.changeSignature]);
  } else if (source.caseRecord && source.caseRecord.findings.length > 0) {
    allowed = new Set(source.caseRecord.findings.map((finding) => finding.signature));
  } else if (source.run && source.run.changeSignatures.length > 0) {
    allowed = new Set(source.run.changeSignatures);
  } else if (source.run) {
    const caseRecord = store.caseForRun(source.run.id);
    if (caseRecord && caseRecord.findings.length > 0) {
      allowed = new Set(caseRecord.findings.map((finding) => finding.signature));
    }
  }

  return all.filter((change) => {
    if (allowed && !allowed.has(change.signature)) return false;
    if (options.only && options.only.length > 0 && !options.only.includes(change.category)) {
      return false;
    }
    return true;
  });
}

function generateConfigActions(
  source: PlanSource,
  changes: Change[],
  addAction: (key: string, action: DraftAction) => void,
  addManual: (message: string) => void,
  warnings: string[],
): void {
  for (const change of changes) {
    const configPath = change.path.replace(/\.(hash|missing)$/, "");
    const target = source.target.configs.find((entry) => entry.path === configPath);
    const current = source.current.configs.find((entry) => entry.path === configPath);
    const scope = target?.scope ?? current?.scope ?? "user";
    const toMissing = !target || target.missing;
    const fromMissing = !current || current.missing;
    if (toMissing && fromMissing) continue;
    if (!toMissing && (!target?.blob || target.restorable === false || target.redacted)) {
      addManual(
        `Restore config ${configPath} manually. Envidence did not keep restorable content for it.`,
      );
      continue;
    }
    if (toMissing && (!current?.blob || current.restorable === false || current.redacted)) {
      warnings.push(
        `Deleting ${configPath} cannot be undone from this store because its current content was not captured as restorable.`,
      );
    }
    if (!toMissing && target?.hash === current?.hash && !fromMissing) continue;

    addAction(`config:${configPath}`, {
      type: "config.restore",
      title: toMissing ? `Remove ${configPath}` : `Restore ${configPath}`,
      description: toMissing
        ? `Restore the missing state of ${configPath}.`
        : `Restore the captured content of ${configPath} to its target hash.`,
      category: "configs",
      reversible: toMissing
        ? Boolean(current?.blob) && current?.restorable !== false
        : Boolean(target?.blob),
      requiresAdmin: scope === "machine",
      signature: change.signature,
      payload: {
        path: configPath,
        scope,
        fromHash: current?.hash ?? null,
        fromBlob: current?.blob ?? null,
        fromMissing,
        toHash: target?.hash ?? null,
        toBlob: target?.blob ?? null,
        toMissing,
      },
    });
  }
}

function generateEnvActions(
  source: PlanSource,
  changes: Change[],
  addAction: (key: string, action: DraftAction) => void,
  addManual: (message: string) => void,
): void {
  const effectiveNames = new Set<string>();
  for (const change of changes) {
    const [scopeValue, ...rest] = change.path.split(".");
    const name = rest.join(".");
    if (!name) continue;
    if (scopeValue === "effective") {
      effectiveNames.add(name);
      continue;
    }
    if (scopeValue !== "user" && scopeValue !== "machine") continue;
    const scope = scopeValue as EnvScope;
    const target = source.target.env[scope][name];
    const current = source.current.env[scope][name];
    if (target?.secret || current?.secret) {
      addManual(
        `Restore ${scope} environment variable ${name} from your secret manager. Envidence stores only a redacted hash.`,
      );
      continue;
    }
    const from = current?.value ?? null;
    const to = target?.value ?? null;
    if (from === to) continue;

    if (to === null) {
      addAction(`env:${scope}:${name}`, {
        type: "env.unset",
        title: `Unset ${scope} environment variable ${name}`,
        description: `${name} was added after the target snapshot.`,
        category: "env",
        reversible: current?.secret !== true,
        requiresAdmin: scope === "machine",
        signature: change.signature,
        payload: { scope, name, from, to: null },
      });
    } else {
      addAction(`env:${scope}:${name}`, {
        type: "env.set",
        title: `Restore ${scope} environment variable ${name}`,
        description: `Restore ${name} to its value in the target snapshot.`,
        category: "env",
        reversible: current?.secret !== true,
        requiresAdmin: scope === "machine",
        signature: change.signature,
        payload: { scope, name, from, to },
      });
    }
  }

  for (const name of effectiveNames) {
    const hasPersistentChange = changes.some(
      (change) =>
        (change.path.startsWith("user.") || change.path.startsWith("machine.")) &&
        change.path.slice(change.path.indexOf(".") + 1) === name,
    );
    if (!hasPersistentChange) {
      addManual(
        `Effective environment variable ${name} is process-scoped. Restart the parent shell or restore the user/machine value manually.`,
      );
    }
  }
}

function generatePathActions(
  source: PlanSource,
  changes: Change[],
  addAction: (key: string, action: DraftAction) => void,
  addManual: (message: string) => void,
): void {
  const scopes = new Set<EnvScope>();
  let effectiveChanged = false;
  for (const change of changes) {
    const first = change.path.split(".")[0];
    if (first === "user" || first === "machine") scopes.add(first);
    else if (first === "effective") effectiveChanged = true;
  }
  for (const scope of scopes) {
    const from = scope === "user" ? source.current.path.user : source.current.path.machine;
    const to = scope === "user" ? source.target.path.user : source.target.path.machine;
    if (pathsEqual(from, to)) continue;
    addAction(`path:${scope}`, {
      type: "path.set",
      title: `Restore ${scope === "user" ? "user" : "machine"} PATH order`,
      description: `Restore ${to.length} PATH entries to the target snapshot's sequence.`,
      category: "path",
      reversible: true,
      requiresAdmin: scope === "machine",
      signature: changes.find((change) => change.path.startsWith(`${scope}.`))?.signature,
      payload: { scope, from, to },
    });
  }
  if (effectiveChanged && scopes.size === 0) {
    addManual(
      "Effective PATH changed in the recorded process. Restart the shell after restoring user/machine PATH.",
    );
  }
}

function generatePackageAction(
  source: PlanSource,
  change: Change,
  addAction: (key: string, action: DraftAction) => void,
  addManual: (message: string) => void,
): void {
  const dot = change.path.indexOf(".");
  if (dot < 0) return;
  const manager = change.path.slice(0, dot);
  const name = change.path.slice(dot + 1);
  if (!manager || !name) return;
  if (!SUPPORTED_PACKAGE_MANAGERS.has(manager as RollbackPackageManager)) {
    addManual(
      `Restore ${manager} package ${name} manually${manager === "dotnet" ? " with `dotnet tool install --global`" : ""}.`,
    );
    return;
  }
  const packageManager = manager as RollbackPackageManager;
  const target = source.target.packages.find(
    (pkg) => pkg.manager === packageManager && pkg.name === name,
  );
  const current = source.current.packages.find(
    (pkg) => pkg.manager === packageManager && pkg.name === name,
  );
  if (target?.version === current?.version) return;
  if (!target && !current) return;

  if (target) {
    addAction(`package:${manager}:${name}`, {
      type: `${packageManager}.install` as RollbackActionType,
      title: `Install ${manager} package ${name}@${target.version}`,
      description: `Restore ${name} from ${current?.version ?? "not installed"} to ${target.version}.`,
      category: "packages",
      reversible: true,
      requiresAdmin: false,
      signature: change.signature,
      payload: {
        name,
        from: current?.version ?? null,
        to: target.version,
        version: target.version,
      },
    });
  } else {
    addAction(`package:${manager}:${name}`, {
      type: `${packageManager}.uninstall` as RollbackActionType,
      title: `Uninstall ${manager} package ${name}`,
      description: `${name} was not present in the target snapshot.`,
      category: "packages",
      reversible: true,
      requiresAdmin: false,
      signature: change.signature,
      payload: { name, from: current?.version ?? null, to: null },
    });
  }
}

function generateServiceAction(
  source: PlanSource,
  change: Change,
  addAction: (key: string, action: DraftAction) => void,
  addManual: (message: string) => void,
): void {
  const target = source.target.services.find((service) => service.name === change.path);
  const current = source.current.services.find((service) => service.name === change.path);
  if (!target) {
    addManual(`Recreate or reinstall service ${change.path}; it did not exist in the target snapshot.`);
    return;
  }
  if (!current) {
    addManual(`Service ${change.path} is not currently present; restore it with its installer.`);
    return;
  }
  if (target.state === current.state && target.startMode === current.startMode) return;
  addAction(`service:${change.path}`, {
    type: "service.set",
    title: `Restore service ${target.displayName || change.path}`,
    description: `Restore state ${target.state} and start mode ${target.startMode}.`,
    category: "services",
    reversible: true,
    requiresAdmin: true,
    signature: change.signature,
    payload: {
      name: change.path,
      from: { state: current.state, startMode: current.startMode },
      to: { state: target.state, startMode: target.startMode },
    },
  });
}

function generateStartupAction(
  source: PlanSource,
  change: Change,
  addAction: (key: string, action: DraftAction) => void,
  addManual: (message: string) => void,
  warnings: string[],
): void {
  const firstDot = change.path.indexOf(".");
  if (firstDot < 0) return;
  const scope = change.path.slice(0, firstDot) as StartupScope;
  const name = change.path.slice(firstDot + 1);
  if (!name) return;
  const target = source.target.startup.find(
    (item) => item.scope === scope && item.name === name,
  );
  const current = source.current.startup.find(
    (item) => item.scope === scope && item.name === name,
  );
  if (scope === "startup-folder") {
    addManual(`Restore startup-folder item ${name} manually.`);
    return;
  }
  if (!target) {
    if (!current) return;
    addAction(`startup:${scope}:${name}`, {
      type: "startup.remove",
      title: `Remove startup item ${name}`,
      description: `${name} was added after the target snapshot.`,
      category: "startup",
      reversible: true,
      requiresAdmin: scope === "machine",
      signature: change.signature,
      payload: {
        scope,
        name,
        from: { command: current.command, enabled: current.enabled },
        to: null,
      },
    });
    return;
  }
  if (!target.enabled) {
    if (!current?.enabled) return;
    addAction(`startup:${scope}:${name}`, {
      type: "startup.remove",
      title: `Disable startup item ${name}`,
      description: `Remove the enabled startup entry for ${name}.`,
      category: "startup",
      reversible: true,
      requiresAdmin: scope === "machine",
      signature: change.signature,
      payload: {
        scope,
        name,
        from: { command: current.command, enabled: current.enabled },
        to: null,
      },
    });
    return;
  }
  if (current?.command === target.command && current.enabled === target.enabled) return;
  if (scope === "machine") {
    warnings.push(`Restoring machine startup item ${name} requires administrator rights.`);
  }
  addAction(`startup:${scope}:${name}`, {
    type: "startup.set",
    title: `Restore startup item ${name}`,
    description: `Restore its command and enabled state for ${scope}.`,
    category: "startup",
    reversible: true,
    requiresAdmin: scope === "machine",
    signature: change.signature,
    payload: {
      scope,
      name,
      command: target.command,
      enabled: target.enabled,
      from: current ? { command: current.command, enabled: current.enabled } : null,
      to: { command: target.command, enabled: target.enabled },
    },
  });
}

function generateTaskAction(
  source: PlanSource,
  change: Change,
  addAction: (key: string, action: DraftAction) => void,
  addManual: (message: string) => void,
): void {
  const target = source.target.tasks.find((task) => `${task.path}${task.name}` === change.path);
  const current = source.current.tasks.find((task) => `${task.path}${task.name}` === change.path);
  if (!target) {
    addManual(`Recreate scheduled task ${change.path}; it was not present in the target snapshot.`);
    return;
  }
  const targetEnabled = target.state.toLowerCase() !== "disabled";
  const currentEnabled = current ? current.state.toLowerCase() !== "disabled" : null;
  if (currentEnabled === targetEnabled) return;
  addAction(`task:${change.path}`, {
    type: targetEnabled ? "task.enable" : "task.disable",
    title: `${targetEnabled ? "Enable" : "Disable"} scheduled task ${target.name}`,
    description: `Restore task state to ${target.state}.`,
    category: "tasks",
    reversible: true,
    requiresAdmin: true,
    signature: change.signature,
    payload: {
      path: target.path,
      name: target.name,
      from: current ? { state: current.state } : null,
      to: { state: target.state },
    },
  });
}

function generateManualNotes(
  source: PlanSource,
  changes: Change[],
  warnings: string[],
  addManual: (message: string) => void,
): void {
  const tools = changes.filter(
    (change) => change.category === "tools" || change.category === "runtimes",
  );
  for (const change of tools) {
    const name = change.path.split(".")[0] ?? change.path;
    const target = source.target.tools[name];
    addManual(
      `Restore tool ${name}${target?.version ? ` ${target.version}` : ""} manually${target?.resolvedPath ? ` (target path: ${target.resolvedPath})` : ""}.`,
    );
  }

  for (const change of changes.filter((item) => item.category === "programs")) {
    const target = source.target.programs.find((program) => program.name === change.path);
    if (target?.wingetId) {
      addManual(
        `Reinstall ${target.name} ${target.version}: winget install --id ${target.wingetId} --version ${target.version}`,
      );
    } else {
      addManual(`Reinstall ${change.path} from Apps & Features or the vendor installer.`);
    }
  }

  if (changes.some((change) => change.category === "network")) {
    addManual(
      "Restore proxy, DNS, or hosts settings manually. Envidence does not edit network or system files.",
    );
  }
  if (changes.some((change) => change.category === "shell")) {
    addManual(
      "Restore PowerShell profile or execution-policy changes manually with a copy you trust.",
    );
  }
  if (changes.some((change) => change.category === "listeners")) {
    addManual(
      "Review listeners that appeared or disappeared. Stop the process, change its port, or restart the owning service.",
    );
  }
  if (changes.some((change) => change.category === "hotfixes")) {
    addManual("Windows updates cannot be rolled back by Envidence. Use Windows Update history.");
  }
  if (changes.some((change) => change.category === "wsl")) {
    addManual("Restore WSL distribution state manually with the WSL CLI.");
  }
  if (changes.some((change) => change.category === "project")) {
    addManual("Project files are outside rollback scope. Use Git to restore code.");
  }
  if (changes.some((change) => change.category === "host")) {
    addManual("Host identity or OS changes cannot be rolled back automatically.");
  }
  if (changes.some((change) => change.category === "time")) {
    addManual("Restore time zone or time synchronization settings manually.");
  }
  if (changes.some((change) => change.category === "disks")) {
    addManual("Disk usage changes are informative; free space manually if needed.");
  }

  if (source.target.id !== source.current.id) {
    warnings.push(
      `Plan compares ${source.target.id} to ${source.current.id}. Preconditions are checked again immediately before apply.`,
    );
  }
}

export async function preflightPlan(
  plan: RollbackPlan,
  adapter: EnvironmentAdapter,
): Promise<PreflightConflict[]> {
  const conflicts: PreflightConflict[] = [];
  for (const action of plan.actions) {
    let expected = "";
    let actual = "";
    try {
      const result = await checkPrecondition(action, adapter);
      if (!result) continue;
      expected = result.expected;
      actual = result.actual;
    } catch (error) {
      expected = "readable machine state";
      actual = `error: ${(error as Error).message}`;
    }
    conflicts.push({
      actionId: action.id,
      title: action.title,
      expected,
      actual,
      message: `${action.title}: expected ${expected}, found ${actual}.`,
    });
  }
  return conflicts;
}

async function checkPrecondition(
  action: RollbackAction,
  adapter: EnvironmentAdapter,
): Promise<{ expected: string; actual: string } | null> {
  const payload = action.payload;
  switch (action.type) {
    case "env.set":
    case "env.unset": {
      const scope = payloadScope(payload.scope);
      const name = payloadString(payload.name);
      if (!scope || !name) return null;
      const expected = payloadValue(payload.from);
      const actual = await adapter.getEnv(name, scope);
      return valuesDiffer(expected, actual)
        ? { expected: displayValue(expected), actual: displayValue(actual) }
        : null;
    }
    case "path.set": {
      const scope = payloadScope(payload.scope);
      if (!scope) return null;
      const expected = payloadArray(payload.from);
      const actual = await adapter.getPath(scope);
      return pathsEqual(expected, actual)
        ? null
        : { expected: displayValue(expected), actual: displayValue(actual) };
    }
    case "npm.install":
    case "npm.uninstall":
    case "pip.install":
    case "pip.uninstall":
    case "cargo.install":
    case "cargo.uninstall":
    case "vscode.install":
    case "vscode.uninstall": {
      const manager = action.type.split(".")[0] as RollbackPackageManager;
      const name = payloadString(payload.name);
      if (!name) return null;
      const expected = payloadValue(payload.from);
      const actual = await adapter.getPackageVersion(manager, name);
      return valuesDiffer(expected, actual)
        ? { expected: displayValue(expected), actual: displayValue(actual) }
        : null;
    }
    case "config.restore": {
      const filePath = payloadString(payload.path);
      if (!filePath) return null;
      const expected = payloadBoolean(payload.fromMissing) ? null : payloadValue(payload.fromHash);
      const actual = await adapter.getFileHash(filePath);
      return valuesDiffer(expected, actual)
        ? { expected: displayValue(expected), actual: displayValue(actual) }
        : null;
    }
    case "service.set": {
      const name = payloadString(payload.name);
      if (!name) return null;
      const expected = payloadObject(payload.from);
      const actual = await adapter.getService(name);
      if (serviceEqual(expected, actual)) return null;
      return {
        expected: displayValue(expected),
        actual: displayValue(actual),
      };
    }
    case "startup.set":
    case "startup.remove": {
      const scope = payloadString(payload.scope) as StartupScope | null;
      const name = payloadString(payload.name);
      if (!scope || !name) return null;
      const expected = payloadObject(payload.from);
      const actual = await adapter.getStartup(scope, name);
      if (startupEqual(expected, actual)) return null;
      return {
        expected: displayValue(expected),
        actual: displayValue(actual),
      };
    }
    case "task.enable":
    case "task.disable": {
      const taskPath = payloadString(payload.path);
      const name = payloadString(payload.name);
      if (!taskPath || !name) return null;
      const expected = payloadObject(payload.from);
      const actual = await adapter.getTask(taskPath, name);
      if (taskEqual(expected, actual)) return null;
      return {
        expected: displayValue(expected),
        actual: displayValue(actual),
      };
    }
    case "manual":
      return null;
    default:
      return null;
  }
}

export async function applyRollbackPlan(
  plan: RollbackPlan,
  adapter: EnvironmentAdapter,
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  const log: RollbackRecord["log"] = [];
  let failed = false;
  for (const action of plan.actions) {
    if (action.type === "manual") {
      log.push({
        actionId: action.id,
        status: "skipped",
        message: action.title,
        at: Date.now(),
      });
      continue;
    }
    const started = Date.now();
    options.onProgress?.(action.title);
    try {
      const message = await executeAction(adapter, action);
      log.push({
        actionId: action.id,
        status: "ok",
        message,
        at: Date.now(),
        command: actionCommand(action),
        before: action.payload.from ?? null,
        after: action.payload.to ?? null,
        durationMs: Date.now() - started,
      });
    } catch (error) {
      failed = true;
      log.push({
        actionId: action.id,
        status: "failed",
        message: (error as Error).message,
        at: Date.now(),
        command: actionCommand(action),
        before: action.payload.from ?? null,
        after: action.payload.to ?? null,
        durationMs: Date.now() - started,
      });
      if (options.failFast) break;
    }
  }
  plan.manual.forEach((message, index) => {
    log.push({
      actionId: `MANUAL-${index + 1}`,
      status: "skipped",
      message,
      at: Date.now(),
    });
  });
  return { status: failed ? "failed" : "applied", log };
}

async function executeAction(
  adapter: EnvironmentAdapter,
  action: RollbackAction,
): Promise<string> {
  const payload = action.payload;
  switch (action.type) {
    case "env.set": {
      const scope = requireScope(payload.scope);
      const name = requireString(payload.name);
      const value = requireString(payload.to);
      await adapter.setEnv(name, value, scope);
      return `Set ${scope} environment variable ${name}.`;
    }
    case "env.unset": {
      const scope = requireScope(payload.scope);
      const name = requireString(payload.name);
      await adapter.unsetEnv(name, scope);
      return `Unset ${scope} environment variable ${name}.`;
    }
    case "path.set": {
      const scope = requireScope(payload.scope);
      const entries = payloadArray(payload.to);
      await adapter.setPath(scope, entries);
      return `Set ${scope} PATH to ${entries.length} entries.`;
    }
    case "npm.install":
    case "pip.install":
    case "cargo.install":
    case "vscode.install": {
      const manager = action.type.split(".")[0] as RollbackPackageManager;
      const name = requireString(payload.name);
      const version = payloadString(payload.to) ?? payloadString(payload.version);
      await adapter.installPackage(manager, name, version);
      return `Installed ${manager} package ${name}${version ? `@${version}` : ""}.`;
    }
    case "npm.uninstall":
    case "pip.uninstall":
    case "cargo.uninstall":
    case "vscode.uninstall": {
      const manager = action.type.split(".")[0] as RollbackPackageManager;
      const name = requireString(payload.name);
      await adapter.uninstallPackage(manager, name);
      return `Uninstalled ${manager} package ${name}.`;
    }
    case "config.restore": {
      const filePath = requireString(payload.path);
      if (payloadBoolean(payload.toMissing)) {
        await adapter.deleteFile(filePath);
        return `Removed ${filePath}.`;
      }
      const blob = requireString(payload.toBlob);
      const content = adapter.readBlob(blob);
      if (!content) throw new Error(`Missing content blob ${blob} for ${filePath}.`);
      await adapter.writeFile(filePath, content.toString("utf8"));
      return `Restored ${filePath}.`;
    }
    case "service.set": {
      const name = requireString(payload.name);
      const to = payloadObject(payload.to);
      if (!to) throw new Error(`Service target state is missing for ${name}.`);
      await adapter.setService(
        name,
        String(to.state ?? ""),
        to.startMode === undefined ? undefined : String(to.startMode),
      );
      return `Restored service ${name}.`;
    }
    case "startup.set": {
      const scope = requireStartupScope(payload.scope);
      const name = requireString(payload.name);
      const command = requireString(payload.command);
      await adapter.setStartup(scope, name, command, payloadBoolean(payload.enabled) !== false);
      return `Restored startup item ${name}.`;
    }
    case "startup.remove": {
      const scope = requireStartupScope(payload.scope);
      const name = requireString(payload.name);
      await adapter.removeStartup(scope, name);
      return `Removed startup item ${name}.`;
    }
    case "task.enable":
    case "task.disable": {
      const taskPath = requireString(payload.path);
      const name = requireString(payload.name);
      await adapter.setTaskState(taskPath, name, action.type === "task.enable");
      return `${action.type === "task.enable" ? "Enabled" : "Disabled"} scheduled task ${name}.`;
    }
    case "manual":
      return "Manual step.";
    default:
      throw new Error(`Unsupported action type: ${action.type}`);
  }
}

export function invertRollbackPlan(
  plan: RollbackPlan,
  options: { id?: string; createdAt?: number } = {},
): RollbackPlan {
  const drafts: DraftAction[] = [];
  const manual: string[] = ["Undo does not reverse manual steps recorded in the original plan."];
  const warnings = [
    ...plan.warnings,
    `Inverse of rollback ${plan.id}. Preconditions are checked before apply.`,
  ];
  for (const action of [...plan.actions].reverse()) {
    const inverse = invertAction(action);
    if (inverse) {
      drafts.push(inverse);
    } else {
      manual.push(`No automatic inverse for: ${action.title}`);
    }
  }
  for (const message of plan.manual) {
    manual.push(`Manual step from original plan (not reversed): ${message}`);
  }
  const actions = drafts.map((draft, index) => ({
    ...draft,
    id: `ACT-${String(index + 1).padStart(2, "0")}`,
  }));
  return {
    id: options.id ?? rollbackId(),
    createdAt: options.createdAt ?? Date.now(),
    caseId: plan.caseId,
    runId: plan.runId,
    targetSnapshot: plan.currentSnapshot,
    currentSnapshot: plan.targetSnapshot,
    actions,
    manual: manual.slice(0, 50),
    warnings: [...new Set(warnings)],
  };
}

function invertAction(action: RollbackAction): DraftAction | null {
  const payload = action.payload;
  switch (action.type) {
    case "env.set": {
      const from = payloadValue(payload.from);
      if (from === null) {
        return {
          ...baseInverse(action),
          type: "env.unset",
          title: `Unset ${payloadString(payload.scope) ?? "user"} environment variable ${payloadString(payload.name) ?? ""}`,
          payload: {
            scope: payload.scope ?? "user",
            name: payload.name ?? "",
            from: payload.to ?? null,
            to: null,
          },
        };
      }
      return {
        ...baseInverse(action),
        type: "env.set",
        title: action.title,
        payload: { ...payload, from: payload.to ?? null, to: from },
      };
    }
    case "env.unset": {
      const from = payloadValue(payload.from);
      if (from === null) return null;
      return {
        ...baseInverse(action),
        type: "env.set",
        title: `Restore ${payloadString(payload.scope) ?? "user"} environment variable ${payloadString(payload.name) ?? ""}`,
        payload: { ...payload, from: null, to: from },
      };
    }
    case "path.set":
      return {
        ...baseInverse(action),
        type: "path.set",
        title: action.title,
        payload: { ...payload, from: payload.to ?? null, to: payload.from ?? null },
      };
    case "npm.install":
    case "pip.install":
    case "cargo.install":
    case "vscode.install":
    case "npm.uninstall":
    case "pip.uninstall":
    case "cargo.uninstall":
    case "vscode.uninstall":
      return invertPackageAction(action);
    case "config.restore": {
      const fromBlob = payloadString(payload.fromBlob);
      const fromMissing = payloadBoolean(payload.fromMissing);
      if (!fromMissing && !fromBlob) {
        return {
          ...baseInverse(action),
          type: "manual",
          title: `Manual restore for ${payloadString(payload.path) ?? "config"}`,
          description: "The previous config content was not captured as restorable.",
          reversible: false,
          payload: {},
        };
      }
      return {
        ...baseInverse(action),
        type: "config.restore",
        title: action.title,
        payload: {
          ...payload,
          fromHash: payload.toHash ?? null,
          fromBlob: payload.toBlob ?? null,
          fromMissing: payloadBoolean(payload.toMissing),
          toHash: payload.fromHash ?? null,
          toBlob: payload.fromBlob ?? null,
          toMissing: fromMissing,
        },
      };
    }
    case "service.set":
      return {
        ...baseInverse(action),
        type: "service.set",
        title: action.title,
        payload: { ...payload, from: payload.to ?? null, to: payload.from ?? null },
      };
    case "startup.set": {
      const from = payloadObject(payload.from);
      const to = payloadObject(payload.to);
      if (!from) {
        if (!to) return null;
        return {
          ...baseInverse(action),
          type: "startup.remove",
          title: action.title,
          payload: {
            scope: payload.scope ?? "user",
            name: payload.name ?? "",
            from: to,
            to: null,
          },
        };
      }
      return {
        ...baseInverse(action),
        type: "startup.set",
        title: action.title,
        payload: {
          ...payload,
          command: from.command ?? "",
          enabled: from.enabled ?? true,
          from: to,
          to: from,
        },
      };
    }
    case "startup.remove": {
      const from = payloadObject(payload.from);
      if (!from) return null;
      return {
        ...baseInverse(action),
        type: "startup.set",
        title: action.title,
        payload: {
          scope: payload.scope ?? "user",
          name: payload.name ?? "",
          command: from.command ?? "",
          enabled: from.enabled ?? true,
          from: null,
          to: from,
        },
      };
    }
    case "task.enable":
    case "task.disable": {
      const from = payloadObject(payload.from);
      if (!from) return null;
      const enabled = String(from.state ?? "").toLowerCase() !== "disabled";
      return {
        ...baseInverse(action),
        type: enabled ? "task.enable" : "task.disable",
        title: action.title,
        payload: { ...payload, from: payload.to ?? null, to: from },
      };
    }
    case "manual":
      return null;
    default:
      return null;
  }
}

function invertPackageAction(action: RollbackAction): DraftAction | null {
  const manager = action.type.split(".")[0] as RollbackPackageManager;
  const payload = action.payload;
  const from = payloadValue(payload.from);
  const to = payloadValue(payload.to);
  if (to === null) {
    if (from === null) return null;
    return {
      ...baseInverse(action),
      type: `${manager}.install`,
      title: `Install ${manager} package ${payloadString(payload.name) ?? ""}`,
      payload: { ...payload, from: null, to: from },
    };
  }
  if (from === null) {
    return {
      ...baseInverse(action),
      type: `${manager}.uninstall`,
      title: `Uninstall ${manager} package ${payloadString(payload.name) ?? ""}`,
      payload: { ...payload, from: payload.to ?? null, to: null },
    };
  }
  return {
    ...baseInverse(action),
    type: `${manager}.install`,
    title: action.title,
    payload: { ...payload, from: payload.to ?? null, to: from },
  };
}

function baseInverse(action: RollbackAction): Omit<DraftAction, "type" | "title" | "payload"> {
  return {
    description: action.description,
    category: action.category,
    reversible: action.reversible,
    requiresAdmin: action.requiresAdmin,
    signature: action.signature,
  };
}

export function generateRollbackScript(
  plan: RollbackPlan,
  store: Store,
  platform: "powershell" | "bash" = isWindows ? "powershell" : "bash",
): string {
  const lines: string[] = [];
  const comment = (line: string): void => {
    lines.push(platform === "powershell" ? `# ${line}` : `# ${line}`);
  };
  comment("Envidence remediation plan");
  comment(`Plan: ${plan.id}`);
  if (plan.caseId) comment(`Case: ${plan.caseId}`);
  if (plan.runId) comment(`Run: ${plan.runId}`);
  comment(`Generated: ${new Date(plan.createdAt).toISOString()}`);
  comment("Review before running. `evd rollback --apply` takes a safety snapshot first.");
  if (plan.targetSnapshot) comment(`Target snapshot: ${plan.targetSnapshot}`);
  if (plan.currentSnapshot) comment(`Current snapshot: ${plan.currentSnapshot}`);
  for (const warning of plan.warnings) comment(`WARNING: ${warning}`);
  lines.push("");

  plan.actions.forEach((action, index) => {
    comment(`${index + 1}. ${action.title}`);
    comment(action.description);
    if (action.requiresAdmin) comment("Requires an elevated shell.");
    const commandLines = scriptForAction(action, store, platform);
    if (commandLines.length === 0) {
      comment("No automatic command generated.");
    } else {
      lines.push(...commandLines);
    }
    lines.push("");
  });

  if (plan.manual.length > 0) {
    comment("Manual steps");
    plan.manual.forEach((step, index) => comment(`${index + 1}. ${step}`));
    lines.push("");
  }
  comment("End of plan.");
  return `${lines.join(platform === "powershell" ? "\r\n" : "\n")}\n`;
}

function scriptForAction(
  action: RollbackAction,
  store: Store,
  platform: "powershell" | "bash",
): string[] {
  const payload = action.payload;
  const ps = platform === "powershell";
  switch (action.type) {
    case "env.set":
      return ps
        ? [
            `[Environment]::SetEnvironmentVariable('${psQuote(payloadString(payload.name) ?? "")}', '${psQuote(payloadString(payload.to) ?? "")}', '${scopeLabel(payload.scope)}')`,
          ]
        : [
            `# Persist this in your shell profile:`,
            `export ${shellIdentifier(payloadString(payload.name) ?? "")}='${bashQuote(payloadString(payload.to) ?? "")}'`,
          ];
    case "env.unset":
      return ps
        ? [
            `[Environment]::SetEnvironmentVariable('${psQuote(payloadString(payload.name) ?? "")}', $null, '${scopeLabel(payload.scope)}')`,
          ]
        : [`# Unset ${payloadString(payload.name) ?? ""} in your shell profile.`];
    case "path.set": {
      const separator = ps ? ";" : ":";
      return ps
        ? [
            `[Environment]::SetEnvironmentVariable('Path', '${psQuote(payloadArray(payload.to).join(separator))}', '${scopeLabel(payload.scope)}')`,
          ]
        : [`export PATH='${bashQuote(payloadArray(payload.to).join(separator))}'`];
    }
    case "npm.install":
    case "pip.install":
    case "cargo.install":
    case "vscode.install": {
      const manager = action.type.split(".")[0] as RollbackPackageManager;
      return [packageCommand(manager, "install", payload, ps)];
    }
    case "npm.uninstall":
    case "pip.uninstall":
    case "cargo.uninstall":
    case "vscode.uninstall": {
      const manager = action.type.split(".")[0] as RollbackPackageManager;
      return [packageCommand(manager, "uninstall", payload, ps)];
    }
    case "config.restore": {
      const filePath = payloadString(payload.path) ?? "";
      if (payloadBoolean(payload.toMissing)) {
        return ps
          ? [`Remove-Item -LiteralPath '${psQuote(filePath)}' -Force -ErrorAction SilentlyContinue`]
          : [`rm -f -- '${bashQuote(filePath)}'`];
      }
      const blob = payloadString(payload.toBlob);
      if (!blob || !store.blobExists(blob)) {
        return [`# Missing captured content for ${filePath}; restore it from a backup.`];
      }
      const base64 = store.getBlob(blob).toString("base64");
      return ps
        ? [
            `[IO.File]::WriteAllBytes('${psQuote(filePath)}', [Convert]::FromBase64String('${base64}'))`,
          ]
        : [
            `mkdir -p -- '${bashQuote(pathDirName(filePath))}'`,
            `printf '%s' '${base64}' | base64 -d > '${bashQuote(filePath)}'`,
          ];
    }
    case "service.set": {
      const to = payloadObject(payload.to);
      const name = payloadString(payload.name) ?? "";
      if (!ps) return [`# Restore service ${name} with your service manager.`];
      const mode = startModeLabel(to?.startMode);
      const state = String(to?.state ?? "");
      const status = state.toLowerCase() === "running" ? "Running" : state.toLowerCase() === "stopped" ? "Stopped" : "";
      return [
        `Set-Service -Name '${psQuote(name)}' -StartupType ${mode}`,
        ...(status ? [`Set-Service -Name '${psQuote(name)}' -Status ${status}`] : []),
      ];
    }
    case "startup.set": {
      const scope = payloadString(payload.scope) ?? "user";
      if (!ps) return [`# Restore startup item ${payloadString(payload.name) ?? ""} manually.`];
      const key = startupKey(scope);
      const name = payloadString(payload.name) ?? "";
      const command = payloadString(payload.command) ?? "";
      return [
        `New-Item -Path '${key}' -Force | Out-Null`,
        `Set-ItemProperty -Path '${key}' -Name '${psQuote(name)}' -Value '${psQuote(command)}'`,
      ];
    }
    case "startup.remove": {
      const scope = payloadString(payload.scope) ?? "user";
      if (!ps) return [`# Remove startup item ${payloadString(payload.name) ?? ""} manually.`];
      return [
        `Remove-ItemProperty -Path '${startupKey(scope)}' -Name '${psQuote(payloadString(payload.name) ?? "")}' -ErrorAction SilentlyContinue`,
      ];
    }
    case "task.enable":
    case "task.disable": {
      const taskPath = payloadString(payload.path) ?? "";
      const name = payloadString(payload.name) ?? "";
      if (!ps) return [`# ${action.type === "task.enable" ? "Enable" : "Disable"} task ${name} with your scheduler.`];
      return [
        `${action.type === "task.enable" ? "Enable" : "Disable"}-ScheduledTask -TaskPath '${psQuote(taskPath)}' -TaskName '${psQuote(name)}'`,
      ];
    }
    case "manual":
      return [];
    default:
      return [];
  }
}

function packageCommand(
  manager: RollbackPackageManager,
  operation: "install" | "uninstall",
  payload: JsonObject,
  ps: boolean,
): string {
  const name = payloadString(payload.name) ?? "";
  const version = payloadString(payload.to) ?? payloadString(payload.version);
  if (manager === "npm") {
    return operation === "install"
      ? `npm install -g '${psQuote(`${name}${version ? `@${version}` : ""}`)}'`
      : `npm uninstall -g '${psQuote(name)}'`;
  }
  if (manager === "pip") {
    return operation === "install"
      ? `python -m pip install '${psQuote(`${name}${version ? `==${version}` : ""}`)}'`
      : `python -m pip uninstall -y '${psQuote(name)}'`;
  }
  if (manager === "cargo") {
    return operation === "install"
      ? `cargo install '${psQuote(name)}'${version ? ` --version '${psQuote(version)}'` : ""}`
      : `cargo uninstall '${psQuote(name)}'`;
  }
  return operation === "install"
    ? `code --install-extension '${psQuote(`${name}${version ? `@${version}` : ""}`)}'`
    : `code --uninstall-extension '${psQuote(name)}'`;
}

export function actionCommand(action: RollbackAction): string {
  const payload = action.payload;
  switch (action.type) {
    case "env.set":
      return `set ${payloadString(payload.scope) ?? "user"} env ${payloadString(payload.name) ?? ""}`;
    case "env.unset":
      return `unset ${payloadString(payload.scope) ?? "user"} env ${payloadString(payload.name) ?? ""}`;
    case "path.set":
      return `set ${payloadString(payload.scope) ?? "user"} PATH (${payloadArray(payload.to).length} entries)`;
    case "npm.install":
    case "pip.install":
    case "cargo.install":
    case "vscode.install":
      return `${action.type} ${payloadString(payload.name) ?? ""}@${payloadString(payload.to) ?? ""}`;
    case "npm.uninstall":
    case "pip.uninstall":
    case "cargo.uninstall":
    case "vscode.uninstall":
      return `${action.type} ${payloadString(payload.name) ?? ""}`;
    case "config.restore":
      return payloadBoolean(payload.toMissing)
        ? `delete ${payloadString(payload.path) ?? ""}`
        : `restore ${payloadString(payload.path) ?? ""}`;
    case "service.set":
      return `set service ${payloadString(payload.name) ?? ""}`;
    case "startup.set":
      return `set startup ${payloadString(payload.scope) ?? ""}/${payloadString(payload.name) ?? ""}`;
    case "startup.remove":
      return `remove startup ${payloadString(payload.scope) ?? ""}/${payloadString(payload.name) ?? ""}`;
    case "task.enable":
    case "task.disable":
      return `${action.type} ${payloadString(payload.path) ?? ""}${payloadString(payload.name) ?? ""}`;
    case "manual":
      return "manual";
    default:
      return String(action.type);
  }
}

export function parseOnly(input: string | undefined): Category[] | undefined {
  if (!input) return undefined;
  const values = input
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const valid = new Set<Category>([
    "host",
    "env",
    "path",
    "tools",
    "runtimes",
    "packages",
    "services",
    "startup",
    "tasks",
    "listeners",
    "programs",
    "hotfixes",
    "network",
    "configs",
    "shell",
    "time",
    "disks",
    "wsl",
    "project",
  ]);
  const categories = values.filter((value): value is Category => valid.has(value as Category));
  if (categories.length === 0) throw new Error(`No valid categories in --only ${input}.`);
  return categories;
}

function payloadScope(value: JsonValue | undefined): EnvScope | null {
  return value === "user" || value === "machine" ? value : null;
}

function requireScope(value: JsonValue | undefined): EnvScope {
  const scope = payloadScope(value);
  if (!scope) throw new Error("Action payload has an invalid environment scope.");
  return scope;
}

function requireStartupScope(value: JsonValue | undefined): StartupScope {
  if (value === "user" || value === "machine" || value === "startup-folder") return value;
  return "user";
}

function requireString(value: JsonValue | undefined): string {
  if (typeof value !== "string") throw new Error("Action payload is missing a required string.");
  return value;
}

function payloadString(value: JsonValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function payloadBoolean(value: JsonValue | undefined): boolean {
  return value === true;
}

function payloadArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function payloadObject(value: JsonValue | undefined): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function payloadValue(value: JsonValue | undefined): JsonValue {
  return value === undefined ? null : value;
}

function valuesDiffer(expected: JsonValue, actual: JsonValue): boolean {
  return stableStringify(expected) !== stableStringify(actual);
}

function displayValue(value: JsonValue): string {
  if (value === null || value === undefined) return "(unset)";
  if (typeof value === "string") return truncate(value, 120);
  return truncate(stableStringify(value), 120);
}

function pathsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((entry, index) => pathKey(entry) === pathKey(b[index] ?? ""));
}

function serviceEqual(
  expected: JsonObject | null,
  actual: ServiceState | null,
): boolean {
  if (!expected && !actual) return true;
  if (!expected || !actual) return false;
  return (
    String(expected.state ?? "").toLowerCase() === actual.state.toLowerCase() &&
    String(expected.startMode ?? "").toLowerCase() === actual.startMode.toLowerCase()
  );
}

function startupEqual(
  expected: JsonObject | null,
  actual: StartupState | null,
): boolean {
  if (!expected && !actual) return true;
  if (!expected || !actual) return false;
  return (
    expected.command === actual.command && Boolean(expected.enabled) === actual.enabled
  );
}

function taskEqual(expected: JsonObject | null, actual: TaskState | null): boolean {
  if (!expected && !actual) return true;
  if (!expected || !actual) return false;
  const expectedEnabled = String(expected.state ?? "").toLowerCase() !== "disabled";
  const actualEnabled = actual.state.toLowerCase() !== "disabled";
  return expectedEnabled === actualEnabled;
}

function scopeLabel(value: JsonValue | undefined): string {
  return value === "machine" ? "Machine" : "User";
}

function startModeLabel(value: JsonValue | undefined): string {
  const text = String(value ?? "").toLowerCase();
  if (text === "auto" || text === "automatic") return "Automatic";
  if (text === "disabled") return "Disabled";
  return "Manual";
}

function startupKey(scope: string): string {
  return scope === "machine"
    ? "HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run"
    : "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
}

function psQuote(value: string): string {
  return value.replaceAll("'", "''");
}

function bashQuote(value: string): string {
  return value.replaceAll("'", "'\\''");
}

function shellIdentifier(value: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) ? value : `"${value.replaceAll('"', '\\"')}"`;
}

function pathDirName(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/");
  const index = normalized.lastIndexOf("/");
  return index > 0 ? filePath.slice(0, index) : ".";
}
