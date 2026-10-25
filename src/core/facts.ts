import type { Category, Fact, JsonValue, Snapshot } from "./types.js";

const RUNTIME_TOOL_NAMES = new Set([
  "node",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "bun",
  "deno",
  "python",
  "python3",
  "py",
  "pip",
  "pip3",
  "uv",
  "poetry",
  "conda",
  "dotnet",
  "go",
  "cargo",
  "rustc",
  "java",
  "javac",
  "ruby",
  "php",
]);

const VOLATILE_ENV_KEYS = new Set([
  "_",
  "SHLVL",
  "PWD",
  "OLDPWD",
  "RANDOM",
  "SECONDS",
  "TMPDIR",
]);

const EPHEMERAL_PORT_MIN = 49152;

export function factsFromSnapshot(snapshot: Snapshot): Map<string, Fact> {
  const facts = new Map<string, Fact>();
  const add = (category: Category, factPath: string, value: JsonValue, volatile = false): void => {
    const key = factKey(category, factPath);
    facts.set(key, { category, path: factPath, value, volatile });
  };

  add("host", "os", snapshot.host.os);
  add("host", "version", snapshot.host.version);
  add("host", "build", snapshot.host.build);
  add("host", "arch", snapshot.host.arch);
  add("host", "timezone", snapshot.host.timezone);
  add("host", "hostname", snapshot.host.hostname);
  add("host", "username", snapshot.host.username);

  for (const [name, entry] of Object.entries(snapshot.env.user)) {
    if (isPathEnvKey(name)) continue;
    add("env", `user.${name}`, envFactValue(entry), VOLATILE_ENV_KEYS.has(name));
  }
  for (const [name, entry] of Object.entries(snapshot.env.machine)) {
    if (isPathEnvKey(name)) continue;
    add("env", `machine.${name}`, envFactValue(entry), VOLATILE_ENV_KEYS.has(name));
  }
  for (const [name, entry] of Object.entries(snapshot.env.effective)) {
    if (isPathEnvKey(name)) continue;
    const volatile = VOLATILE_ENV_KEYS.has(name) || /^(npm_|OPENCODE_|VSCODE_)/i.test(name);
    add("env", `effective.${name}`, envFactValue(entry), volatile);
  }

  add("path", "user", snapshot.path.user);
  add("path", "machine", snapshot.path.machine);
  add("path", "effective", snapshot.path.effective);
  add("path", "duplicates", snapshot.path.duplicates);
  add("path", "missing", snapshot.path.missing);

  for (const [name, tool] of Object.entries(snapshot.tools)) {
    const category: Category = RUNTIME_TOOL_NAMES.has(name) ? "runtimes" : "tools";
    add(category, `${name}.resolved`, tool.resolvedPath);
    add(category, `${name}.version`, tool.version);
  }

  for (const pkg of snapshot.packages) {
    add("packages", `${pkg.manager}.${pkg.name}`, pkg.version);
  }
  for (const service of snapshot.services) {
    add("services", service.name, {
      displayName: service.displayName,
      state: service.state,
      startMode: service.startMode,
    });
  }
  for (const item of snapshot.startup) {
    add("startup", `${item.scope}.${item.name}`, {
      command: item.command,
      enabled: item.enabled,
    });
  }
  for (const task of snapshot.tasks) {
    add("tasks", `${task.path}${task.name}`, {
      state: task.state,
      triggerSummary: task.triggerSummary,
    });
  }
  for (const listener of snapshot.listeners) {
    add(
      "listeners",
      `${listener.protocol}.${listener.port}`,
      {
        address: listener.address,
        processName: listener.processName,
      },
      listener.port >= EPHEMERAL_PORT_MIN,
    );
  }
  for (const program of snapshot.programs) {
    add("programs", program.name, program.version);
  }
  for (const hotfix of snapshot.hotfixes) {
    add("hotfixes", hotfix.id, true);
  }

  add("network", "proxies.winhttp", snapshot.network.proxies.winhttp ?? null);
  add("network", "proxies.ie", snapshot.network.proxies.ie ?? null);
  for (const [name, value] of Object.entries(snapshot.network.proxies.env ?? {})) {
    add("network", `proxies.env.${name}`, value);
  }
  add("network", "dnsServers", snapshot.network.dnsServers);
  add("network", "hostsHash", snapshot.network.hostsHash);

  for (const config of snapshot.configs) {
    add("configs", `${config.path}.hash`, config.hash);
    add("configs", `${config.path}.missing`, config.missing);
  }

  add("shell", "current", snapshot.shell.current);
  add("shell", "psVersion", snapshot.shell.psVersion ?? null);
  add("shell", "executionPolicy", snapshot.shell.executionPolicy ?? null);
  for (const profile of snapshot.shell.profiles) {
    add("shell", `profiles.${profile.path}`, profile.hash);
  }

  add("time", "timezone", snapshot.time.timezone);
  add("time", "ntpStatus", snapshot.time.ntpStatus ?? null);
  add("time", "lastSync", snapshot.time.lastSync ?? null, true);

  for (const disk of snapshot.disks) {
    add(
      "disks",
      disk.mount,
      {
        totalBytes: disk.totalBytes,
        freeBytes: disk.freeBytes,
      },
      true,
    );
  }

  for (const distro of snapshot.wsl) {
    add("wsl", `${distro.name}.version`, distro.version);
    add("wsl", `${distro.name}.state`, distro.state, true);
  }

  if (snapshot.project) {
    add("project", "id", snapshot.project.id);
    add("project", "kind", snapshot.project.kind);
    if (snapshot.project.git) {
      add("project", "git.branch", snapshot.project.git.branch);
      add("project", "git.commit", snapshot.project.git.commit);
      add("project", "git.dirtyTracked", snapshot.project.git.dirtyTracked);
      add("project", "git.untracked", snapshot.project.git.untracked);
      add("project", "git.stashCount", snapshot.project.git.stashCount);
    }
    for (const manifest of snapshot.project.manifests) {
      add("project", `manifest.${manifest.path}`, manifest.hash);
    }
    for (const lockfile of snapshot.project.lockfiles) {
      add("project", `lockfile.${lockfile.path}`, lockfile.hash);
    }
    for (const config of snapshot.project.configFiles) {
      add("project", `config.${config.path}`, config.hash);
    }
    add("project", "envKeys", snapshot.project.envKeys);
    add("project", "ports", snapshot.project.ports);
    add("project", "dockerServices", snapshot.project.services);
  }

  return facts;
}

export function factKey(category: Category, path: string): string {
  return `${category}:${path}`;
}

export function parseFactKey(key: string): { category: Category; path: string } {
  const index = key.indexOf(":");
  return {
    category: key.slice(0, index) as Category,
    path: key.slice(index + 1),
  };
}

function envFactValue(entry: { value?: string; hash?: string; preview?: string; secret?: boolean }): JsonValue {
  if (entry.secret) {
    return {
      secret: true,
      hash: entry.hash ?? null,
      preview: entry.preview ?? null,
    };
  }
  return entry.value ?? "";
}

function isPathEnvKey(name: string): boolean {
  return name === "PATH" || name === "Path";
}

export function unstableCategoryForProfile(profile: Snapshot["profile"], category: Category): boolean {
  if (profile === "full") return false;
  return ["services", "startup", "tasks", "programs", "hotfixes", "wsl"].includes(category);
}
