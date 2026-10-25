import type {
  Change,
  Confidence,
  Finding,
  JsonValue,
  ProjectContext,
  RunRecord,
} from "./types.js";
import type { Store } from "./store.js";
import { clamp, stripAnsi, truncate } from "./util.js";

export type RankInput = {
  changes: Change[];
  run: RunRecord;
  project: ProjectContext | null;
  stderr?: string | null;
  store?: Store;
};

export function rankFindings(input: RankInput): Finding[] {
  const project = input.project;
  const command = input.run.command;
  const toolPathsChanged = input.changes.some(
    (change) =>
      (change.category === "tools" || change.category === "runtimes") &&
      change.path.endsWith(".resolved") &&
      change.kind !== "added",
  );
  const signals = parseStderrSignals(input.stderr ?? "");

  const findings = input.changes.map((change) => {
    const classified = classifyChange(change, project, command, toolPathsChanged);
    const correlation = input.store?.correlationFor(change.signature) ?? {
      runsPresent: 0,
      failsPresent: 0,
      runsAbsent: 0,
      failsAbsent: 0,
      lift: 0,
      eligible: false,
    };
    const boost = signalBoost(classified.rule, signals);
    const recency = change.origin === "pre-existing" ? 0.9 : 1;
    const raw = classified.base * classified.relevance * recency * (1 + 0.5 * correlation.lift) * boost;
    const score = Math.round(clamp(raw * 100, 0, 100));
    const evidence: string[] = [
      `${change.label}: ${change.summary}`,
      change.origin === "pre-existing"
        ? "Present before the command window."
        : "Observed during the command window.",
    ];
    if (classified.relevance >= 0.9) {
      evidence.push(classified.relevanceReason);
    } else if (classified.relevance > 0.5) {
      evidence.push(classified.relevanceReason);
    }
    if (correlation.eligible) {
      evidence.push(
        `Present in ${correlation.failsPresent} of ${correlation.runsPresent} failed runs, but ${correlation.failsAbsent} of ${correlation.runsAbsent} successful runs.`,
      );
    }
    if (boost > 1) {
      const match = signalEvidence(classified.rule, signals);
      if (match) evidence.push(`stderr: ${truncate(match, 220)}`);
    }
    if (change.volatile) {
      evidence.push("Volatile/background value; treat this as a weak signal.");
    }
    return {
      finding: {
        rank: 0,
        signature: change.signature,
        rule: classified.rule,
        category: change.category,
        title: classified.title,
        description: classified.description,
        confidence: "low" as Confidence,
        score,
        base: classified.base,
        relevance: classified.relevance,
        recency,
        correlationLift: correlation.lift,
        before: change.before as JsonValue,
        after: change.after as JsonValue,
        evidence,
        fix: classified.fix,
        actionable: classified.actionable,
      },
      raw,
    };
  });

  findings.sort((a, b) => b.raw - a.raw || b.finding.score - a.finding.score);
  const topScore = findings[0]?.finding.score ?? 0;
  const secondScore = findings[1]?.finding.score ?? 0;
  const topConfidence: Confidence =
    topScore >= 70 && topScore - secondScore >= 15 ? "high" : topScore >= 45 ? "medium" : "low";
  return findings.map(({ finding }, index) => ({
    ...finding,
    rank: index + 1,
    confidence:
      index === 0
        ? topConfidence
        : finding.score >= 70
          ? "medium"
          : finding.score >= 45
            ? "medium"
            : "low",
  }));
}

type Classified = {
  rule: string;
  base: number;
  relevance: number;
  relevanceReason: string;
  title: string;
  description: string;
  fix: string;
  actionable: boolean;
};

function classifyChange(
  change: Change,
  project: ProjectContext | null,
  command: string,
  toolPathsChanged: boolean,
): Classified {
  const path = change.path;
  if (change.category === "runtimes" || change.category === "tools") {
    const [toolName = "", field = ""] = path.split(".");
    if (field === "version") {
      const before = typeof change.before === "string" ? change.before : null;
      const after = typeof change.after === "string" ? change.after : null;
      const used = projectUsesTool(project, command, toolName);
      const major = before && after ? before.split(".")[0] !== after.split(".")[0] : false;
      return {
        rule: major ? "tool.version_major" : "tool.version_minor",
        base: major ? 0.9 : 0.55,
        relevance: used ? 1 : 0.4,
        relevanceReason: used
          ? `The project or command uses ${toolName}.`
          : `${toolName} is not referenced by this project.`,
        title: `${humanToolName(toolName)} version ${major ? "jumped" : "changed"}`,
        description: `${humanToolName(toolName)} ${before ?? "not installed"} → ${after ?? "not installed"}.`,
        fix: before
          ? `Pin ${toolName} to ${before} or use the version this project expects.`
          : `Install the expected ${toolName} version.`,
        actionable: Boolean(before),
      };
    }
    const used = projectUsesTool(project, command, toolName);
    return {
      rule: "tool.path_changed",
      base: 0.95,
      relevance: used ? 1 : 0.4,
      relevanceReason: used
        ? `The project or command resolves ${toolName} through PATH.`
        : `${toolName} is not referenced by this project.`,
      title: `${humanToolName(toolName)} resolves to a different path`,
      description: `${humanToolName(toolName)} executable changed.`,
      fix: `Check which ${toolName} resolves first; reorder PATH or reinstall the expected version.`,
      actionable: true,
    };
  }

  if (change.category === "packages") {
    const index = path.indexOf(".");
    const manager = index >= 0 ? path.slice(0, index) : path;
    const name = index >= 0 ? path.slice(index + 1) : path;
    const used = projectUsesPackage(project, command, name);
    return {
      rule: "package.global_changed",
      base: 0.8,
      relevance: used ? 1 : 0.5,
      relevanceReason: used
        ? `The project or command uses package ${name}.`
        : `${name} is a global package not referenced by the project.`,
      title: `Global ${manager} package ${name} changed`,
      description:
        change.kind === "changed"
          ? `${name}: ${String(change.before ?? "—")} → ${String(change.after ?? "—")}.`
          : `${name} was ${change.kind}.`,
      fix: fixPackage(manager, name, change),
      actionable: true,
    };
  }

  if (change.category === "listeners") {
    const [protocol = "", portRaw = "0"] = path.split(".");
    const port = Number(portRaw);
    const expected = projectUsesPort(project, command, port);
    const added = change.kind === "added";
    return {
      rule: added ? "port.new_listener" : "port.listener_gone",
      base: added ? 0.9 : 0.75,
      relevance: expected ? 1 : 0.3,
      relevanceReason: expected
        ? `Port ${port} is referenced by the project.`
        : `Port ${port} is not referenced by the project.`,
      title: added
        ? `New ${protocol.toUpperCase()} listener on port ${port}`
        : `${protocol.toUpperCase()} listener on port ${port} disappeared`,
      description: added
        ? `Something started listening on port ${port}.`
        : `The listener on port ${port} is gone.`,
      fix: added
        ? `Stop the process listening on ${port} or change the project port.`
        : `Start the service that should listen on port ${port}.`,
      actionable: true,
    };
  }

  if (change.category === "services") {
    const used = projectUsesService(project, command, path);
    return {
      rule: "service.state_changed",
      base: 0.8,
      relevance: used ? 1 : 0.4,
      relevanceReason: used
        ? `Service ${path} is referenced by the project.`
        : `Service ${path} is not referenced by the project.`,
      title: `Service ${path} changed state`,
      description: `Service ${path}: ${change.summary}.`,
      fix: `Restore service ${path} to its previous state or start mode.`,
      actionable: true,
    };
  }

  if (change.category === "env") {
    const name = path.split(".").slice(1).join(".");
    const used = projectUsesEnv(project, name);
    return {
      rule: "env.changed",
      base: 0.7,
      relevance: used ? 1 : 0.35,
      relevanceReason: used
        ? `The project references environment variable ${name}.`
        : `${name} is not referenced by the project.`,
      title: `Environment variable ${name} changed`,
      description: `${name}: ${change.summary}.`,
      fix: `Set ${name} back to its previous value.`,
      actionable: true,
    };
  }

  if (change.category === "path") {
    return {
      rule: "path.order_changed",
      base: 0.85,
      relevance: toolPathsChanged ? 1 : 0.5,
      relevanceReason: toolPathsChanged
        ? "A tool resolution changed in the same window."
        : "PATH changed, but no tool resolution changed.",
      title: "PATH changed",
      description: `${change.label}: ${change.summary}.`,
      fix: "Restore the previous PATH order and remove duplicates.",
      actionable: true,
    };
  }

  if (change.category === "configs") {
    const lower = path.toLowerCase();
    if (lower.includes("hosts")) {
      const localDomainUse = projectUsesLocalDomains(project, command);
      return {
        rule: "config.hosts",
        base: 0.7,
        relevance: localDomainUse ? 0.8 : 0.4,
        relevanceReason: localDomainUse
          ? "The project references local hosts/ports."
          : "No local-domain usage was detected.",
        title: "Hosts file changed",
        description: `Hosts file: ${change.summary}.`,
        fix: "Review the hosts file change and restore the previous entry if needed.",
        actionable: true,
      };
    }
    if (lower.includes(".npmrc")) {
      const npmCommand = /\b(npm|pnpm|yarn|bun)\b/i.test(command);
      return {
        rule: "config.npmrc",
        base: 0.7,
        relevance: npmCommand ? 1 : 0.5,
        relevanceReason: npmCommand
          ? "The failing command uses npm."
          : "The command does not use npm.",
        title: "npm configuration changed",
        description: `npm config: ${change.summary}.`,
        fix: "Review .npmrc; restore the registry/proxy settings that worked.",
        actionable: true,
      };
    }
    return {
      rule: "config.changed",
      base: 0.5,
      relevance: 0.6,
      relevanceReason: "A tracked configuration file changed.",
      title: `Configuration ${fileName(path)} changed`,
      description: `${fileName(path)}: ${change.summary}.`,
      fix: "Review the configuration change and restore the previous version if needed.",
      actionable: true,
    };
  }

  if (change.category === "network") {
    const proxy = path.startsWith("proxies");
    const networkCommand = /\b(npm|pnpm|yarn|pip|curl|git|docker|winget|choco)\b/i.test(command);
    return {
      rule: proxy ? "config.proxy" : "network.changed",
      base: proxy ? 0.65 : 0.5,
      relevance: networkCommand ? 1 : 0.45,
      relevanceReason: networkCommand
        ? "The command performs network or package operations."
        : "The command does not obviously use the network.",
      title: proxy ? "Proxy configuration changed" : "Network configuration changed",
      description: `${change.label}: ${change.summary}.`,
      fix: "Check proxy, DNS, and hosts settings; restore the previous network configuration if needed.",
      actionable: proxy,
    };
  }

  if (change.category === "shell") {
    const profile = path.startsWith("profiles");
    return {
      rule: profile ? "config.shell_profile" : "shell.changed",
      base: profile ? 0.5 : 0.45,
      relevance: 0.7,
      relevanceReason: "The shell environment is inherited by commands.",
      title: profile ? "PowerShell profile changed" : "Shell configuration changed",
      description: `${change.label}: ${change.summary}.`,
      fix: "Review the shell configuration change and restore the previous profile if needed.",
      actionable: true,
    };
  }

  if (change.category === "disks") {
    return {
      rule: "disk.low",
      base: 0.7,
      relevance: 1,
      relevanceReason: "Low disk space can break installs and builds.",
      title: `Disk ${path} is low or changed`,
      description: `${change.label}: ${change.summary}.`,
      fix: `Free space on ${path}; clear caches and old build outputs.`,
      actionable: false,
    };
  }

  if (change.category === "hotfixes") {
    return {
      rule: "os.hotfix",
      base: 0.45,
      relevance: 0.6,
      relevanceReason: "Windows updates can change runtimes and drivers.",
      title: `Windows update ${path} ${change.kind}`,
      description: `Hotfix ${path} was ${change.kind}.`,
      fix: "Review the Windows update; uninstalling updates is a manual step.",
      actionable: false,
    };
  }

  if (change.category === "startup") {
    return {
      rule: change.kind === "added" ? "startup.added" : "startup.changed",
      base: change.kind === "added" ? 0.3 : 0.35,
      relevance: 0.4,
      relevanceReason: "Startup entries can change the environment of later processes.",
      title: `Startup item ${change.kind}`,
      description: `${change.label}: ${change.summary}.`,
      fix: "Review the startup entry; disable or remove it if unexpected.",
      actionable: true,
    };
  }

  if (change.category === "project") {
    if (path.startsWith("lockfile.")) {
      return {
        rule: "project.lockfile_changed",
        base: 0.6,
        relevance: 0.9,
        relevanceReason: "The project's dependency graph may have changed.",
        title: `Lockfile ${fileName(path)} changed`,
        description: `${change.label}: ${change.summary}.`,
        fix: "Restore the lockfile and reinstall dependencies.",
        actionable: true,
      };
    }
    if (path === "git.dirtyTracked" || path === "git.untracked") {
      return {
        rule: "project.git_dirty",
        base: 0.4,
        relevance: 0.6,
        relevanceReason: "Uncommitted project changes can explain failures.",
        title: "Project working tree changed",
        description: `${change.label}: ${change.summary}.`,
        fix: "Inspect `git diff` / `git status`; commit or stash unrelated changes.",
        actionable: false,
      };
    }
    return {
      rule: "project.changed",
      base: 0.35,
      relevance: 0.5,
      relevanceReason: "Project metadata changed.",
      title: `Project ${path} changed`,
      description: `${change.label}: ${change.summary}.`,
      fix: "Review the project change.",
      actionable: false,
    };
  }

  if (change.category === "time") {
    return {
      rule: "time.changed",
      base: 0.6,
      relevance: 0.5,
      relevanceReason: "Clock and timezone changes can break TLS and scheduling.",
      title: "System time configuration changed",
      description: `${change.label}: ${change.summary}.`,
      fix: "Check the timezone and resync the system clock.",
      actionable: false,
    };
  }

  return {
    rule: "machine.changed",
    base: 0.25,
    relevance: 0.4,
    relevanceReason: "A machine setting changed.",
    title: change.label,
    description: `${change.label}: ${change.summary}.`,
    fix: "Review this change in the All changes tab.",
    actionable: false,
  };
}

function projectUsesTool(project: ProjectContext | null, command: string, tool: string): boolean {
  if (!project) return wordIncludes(command, tool);
  if (project.kind === "node" && tool === "node") return true;
  if (project.kind === "python" && ["python", "python3", "pip", "uv"].includes(tool)) return true;
  if (project.kind === "rust" && ["cargo", "rustc"].includes(tool)) return true;
  if (project.toolNames.includes(tool)) return true;
  if (project.dependencies.includes(tool) || project.devDependencies.includes(tool)) return true;
  return wordIncludes(command, tool);
}

function projectUsesPackage(project: ProjectContext | null, command: string, name: string): boolean {
  if (!project) return wordIncludes(command, name);
  if (project.dependencies.includes(name) || project.devDependencies.includes(name)) return true;
  if (project.toolNames.includes(name)) return true;
  return wordIncludes(command, name);
}

function projectUsesEnv(project: ProjectContext | null, name: string): boolean {
  if (!project) return false;
  if (project.envKeys.includes(name)) return true;
  return project.envReferences.some((ref) => ref.name === name);
}

function projectUsesPort(project: ProjectContext | null, command: string, port: number): boolean {
  if (!project) return command.includes(`:${port}`);
  return project.ports.includes(port) || command.includes(`:${port}`);
}

function projectUsesService(project: ProjectContext | null, command: string, service: string): boolean {
  if (!project) return wordIncludes(command, service);
  return project.services.includes(service) || wordIncludes(command, service);
}

function projectUsesLocalDomains(project: ProjectContext | null, command: string): boolean {
  if (!project) return /localhost|127\.0\.0\.1/i.test(command);
  return project.ports.length > 0 || /localhost|127\.0\.0\.1/i.test(command);
}

function wordIncludes(input: string, word: string): boolean {
  if (!word) return false;
  return new RegExp(`(^|[^A-Za-z0-9_.-])${escapeRegExp(word)}([^A-Za-z0-9_.-]|$)`, "i").test(input);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function humanToolName(name: string): string {
  if (name === "node") return "Node.js";
  if (["npm", "npx", "pnpm", "git", "gh", "pip", "uv", "wsl", "aws", "az", "php"].includes(name)) {
    return name;
  }
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function fileName(input: string): string {
  return input.replaceAll("\\", "/").split("/").pop() ?? input;
}

function fixPackage(manager: string, name: string, change: Change): string {
  const before = typeof change.before === "string" ? change.before : null;
  if (change.kind === "removed") {
    if (manager === "vscode") return `code --install-extension ${name}${before ? `@${before}` : ""}`;
    if (manager === "cargo") return `cargo install ${name}${before ? ` --version ${before}` : ""}`;
    return `${manager} install -g ${name}${before ? `@${before}` : ""}`;
  }
  if (change.kind === "added") {
    if (manager === "vscode") return `code --uninstall-extension ${name}`;
    if (manager === "cargo") return `cargo uninstall ${name}`;
    return `${manager} uninstall -g ${name}`;
  }
  if (manager === "vscode") return `code --install-extension ${name}${before ? `@${before}` : ""}`;
  if (manager === "cargo") return `cargo install ${name}${before ? ` --version ${before}` : ""}`;
  return `${manager} install -g ${name}${before ? `@${before}` : ""}`;
}

type StderrSignal = {
  pattern: RegExp;
  boost: number;
  rules: RegExp;
  line: string;
};

const SIGNAL_DEFINITIONS: Array<{ pattern: RegExp; boost: number; rules: RegExp }> = [
  { pattern: /EADDRINUSE|address already in use|port already in use/i, boost: 1.5, rules: /^port\./ },
  {
    pattern: /ENOENT|command not found|is not recognized|cannot find module/i,
    boost: 1.5,
    rules: /^(tool\.|path\.|package\.)/,
  },
  { pattern: /EACCES|permission denied|access is denied/i, boost: 1.3, rules: /^(service\.|config\.|shell\.)/ },
  {
    pattern: /ETIMEDOUT|ENOTFOUND|ECONNREFUSED|getaddrinfo|network is unreachable/i,
    boost: 1.4,
    rules: /^(config\.proxy|network\.|service\.)/,
  },
  { pattern: /certificate|SSL|TLS|self signed/i, boost: 1.3, rules: /^(time\.|config\.proxy)/ },
  { pattern: /out of memory|heap|ENOMEM/i, boost: 1.2, rules: /^(disk\.|startup\.|service\.)/ },
  { pattern: /MODULE_NOT_FOUND/i, boost: 1.3, rules: /^(package\.|path\.|project\.lockfile)/ },
];

function parseStderrSignals(stderr: string): StderrSignal[] {
  if (!stderr) return [];
  const clean = stripAnsi(stderr);
  const lines = clean.split(/\r?\n/).filter(Boolean).slice(-300);
  const signals: StderrSignal[] = [];
  for (const definition of SIGNAL_DEFINITIONS) {
    const line = lines.find((candidate) => definition.pattern.test(candidate));
    if (line) signals.push({ ...definition, line: truncate(line.trim(), 300) });
  }
  return signals;
}

function signalBoost(rule: string, signals: StderrSignal[]): number {
  let boost = 1;
  for (const signal of signals) {
    if (signal.rules.test(rule)) boost = Math.max(boost, signal.boost);
  }
  return boost;
}

function signalEvidence(rule: string, signals: StderrSignal[]): string | null {
  const matches = signals.filter((signal) => signal.rules.test(rule));
  return matches.sort((a, b) => b.boost - a.boost)[0]?.line ?? null;
}
