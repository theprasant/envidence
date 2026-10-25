import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { parse as parseYaml } from "yaml";
import type { Config, GitInfo, ProjectContext, SnapshotWarning } from "../core/types.js";
import { runGit } from "../core/exec.js";
import { redactText, redactUrlCredentials } from "../core/redact.js";
import { hashFile, projectId, safeJsonParse } from "../core/util.js";

const MANIFEST_FILES = [
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "Pipfile",
  "Cargo.toml",
  "go.mod",
  "composer.json",
  "Gemfile",
];

const LOCKFILES = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "poetry.lock",
  "Pipfile.lock",
  "uv.lock",
  "Cargo.lock",
  "go.sum",
  "packages.lock.json",
  "composer.lock",
];

const CONFIG_CANDIDATES = [
  "vite.config.ts",
  "vite.config.js",
  "vite.config.mjs",
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "nuxt.config.ts",
  "tsconfig.json",
  "jsconfig.json",
  "biome.json",
  "eslint.config.js",
  "eslint.config.mjs",
  ".eslintrc",
  ".eslintrc.json",
  ".eslintrc.js",
  "prettier.config.js",
  "prettier.config.mjs",
  ".prettierrc",
  "postcss.config.js",
  "postcss.config.mjs",
  "tailwind.config.js",
  "tailwind.config.ts",
  "webpack.config.js",
  "rollup.config.js",
  "vitest.config.ts",
  "vitest.config.js",
  "jest.config.js",
  "playwright.config.ts",
  ".npmrc",
  ".nvmrc",
  ".node-version",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
  "makefile",
  "Makefile",
];

const IGNORE_GLOBS = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/coverage/**",
  "**/.envidence/**",
  "**/vendor/**",
  "**/target/**",
  "**/bin/**",
  "**/obj/**",
  "**/.venv/**",
  "**/venv/**",
  "**/__pycache__/**",
  "**/*.min.js",
  "**/*.map",
];

export async function collectProject(
  cwd: string,
  config: Config,
): Promise<{ project: ProjectContext | null; warnings: SnapshotWarning[] }> {
  const warnings: SnapshotWarning[] = [];
  const root = await findProjectRoot(cwd);
  if (!root) return { project: null, warnings };
  const kind = await detectKind(root);
  const manifestPaths = [...MANIFEST_FILES];
  const manifests = await hashCandidates(root, manifestPaths);
  const lockfiles = await hashCandidates(root, LOCKFILES);
  const git = await collectGit(root);
  const packageData = await readPackageJson(root);
  const scripts = packageData.scripts;
  const dependencies = Object.keys(packageData.dependencies).sort();
  const devDependencies = Object.keys(packageData.devDependencies).sort();
  const env = await collectEnv(root);
  const scan =
    config.project.scan
      ? await scanProjectSource(root, {
          maxFiles: config.project.maxFiles,
          maxBytes: config.project.maxBytes,
        })
      : { envReferences: [], ports: [] };
  const compose = await collectCompose(root);
  const configFiles = await hashCandidates(root, CONFIG_CANDIDATES);
  const ports = new Set<number>([
    ...scan.ports,
    ...env.ports,
    ...compose.ports,
    ...extractPortsFromScripts(scripts),
  ]);
  const toolNames = new Set<string>([
    ...extractScriptTools(scripts),
    ...(packageData.packageManager ? [packageData.packageManager.split("@")[0] as string] : []),
  ]);
  const project: ProjectContext = {
    id: projectId(root),
    root,
    kind,
    manifests,
    lockfiles,
    git,
    scripts,
    dependencies,
    devDependencies,
    toolNames: [...toolNames].filter(Boolean).sort(),
    envKeys: env.keys,
    envReferences: scan.envReferences,
    ports: [...ports].filter((port) => port > 0 && port < 65536).sort((a, b) => a - b).slice(0, 30),
    services: compose.services,
    dockerServices: compose.dockerServices,
    configFiles,
  };
  return { project, warnings };
}

async function findProjectRoot(cwd: string): Promise<string | null> {
  let current = path.resolve(cwd);
  let nearest: string | null = null;
  for (let depth = 0; depth < 16; depth += 1) {
    if (existsSync(path.join(current, ".git"))) return current;
    if (!nearest && (await hasManifest(current))) nearest = current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return nearest;
}

async function hasManifest(dir: string): Promise<boolean> {
  for (const file of MANIFEST_FILES) {
    if (existsSync(path.join(dir, file))) return true;
  }
  try {
    const entries = await readdir(dir);
    return entries.some((entry) => /\.(sln|csproj|fsproj|vbproj)$/i.test(entry));
  } catch {
    return false;
  }
}

async function detectKind(root: string): Promise<ProjectContext["kind"]> {
  if (existsSync(path.join(root, "package.json"))) return "node";
  if (
    existsSync(path.join(root, "pyproject.toml")) ||
    existsSync(path.join(root, "requirements.txt")) ||
    existsSync(path.join(root, "Pipfile"))
  ) {
    return "python";
  }
  if (existsSync(path.join(root, "Cargo.toml"))) return "rust";
  if (existsSync(path.join(root, "go.mod"))) return "go";
  try {
    const entries = await readdir(root);
    if (entries.some((entry) => /\.(sln|csproj|fsproj|vbproj)$/i.test(entry))) return "dotnet";
  } catch {
    // Ignore.
  }
  return "unknown";
}

async function hashCandidates(
  root: string,
  candidates: string[],
): Promise<Array<{ path: string; hash: string }>> {
  const out: Array<{ path: string; hash: string }> = [];
  for (const candidate of candidates) {
    const absolute = path.join(root, candidate);
    if (!existsSync(absolute)) continue;
    const hash = await hashFile(absolute);
    if (hash) out.push({ path: relativePath(root, absolute), hash });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

type PackageData = {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  packageManager: string | null;
};

async function readPackageJson(root: string): Promise<PackageData> {
  const file = path.join(root, "package.json");
  if (!existsSync(file)) {
    return { scripts: {}, dependencies: {}, devDependencies: {}, packageManager: null };
  }
  const parsed = safeJsonParse<Record<string, unknown>>(await readFile(file, "utf8"), {});
  const scripts = toStringRecord(parsed.scripts);
  return {
    scripts: Object.fromEntries(
      Object.entries(scripts).map(([name, command]) => [name, redactText(command)]),
    ),
    dependencies: toStringRecord(parsed.dependencies),
    devDependencies: toStringRecord(parsed.devDependencies),
    packageManager: typeof parsed.packageManager === "string" ? parsed.packageManager : null,
  };
}

async function collectGit(root: string): Promise<GitInfo | null> {
  const probe = await runGit(["rev-parse", "--show-toplevel"], root, 3000);
  if (probe.code !== 0) return null;
  const [branchResult, commitResult, statusResult, remoteResult, stashResult] = await Promise.all([
    runGit(["rev-parse", "--abbrev-ref", "HEAD"], root, 3000),
    runGit(["rev-parse", "HEAD"], root, 3000),
    runGit(["status", "--porcelain=v1"], root, 6000),
    runGit(["remote", "get-url", "origin"], root, 3000),
    runGit(["stash", "list"], root, 3000),
  ]);
  const statusLines = statusResult.stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  const remote = remoteResult.code === 0 ? remoteResult.stdout.trim() || undefined : undefined;
  return {
    branch: branchResult.stdout.trim() || "HEAD",
    commit: commitResult.stdout.trim(),
    dirtyTracked: statusLines.filter((line) => !line.startsWith("??")).length,
    untracked: statusLines.filter((line) => line.startsWith("??")).length,
    stashCount: stashResult.stdout.split(/\r?\n/).filter(Boolean).length,
    remote: remote ? redactUrlCredentials(remote) : undefined,
  };
}

async function collectEnv(
  root: string,
): Promise<{ keys: string[]; ports: number[] }> {
  const files = await fg([".env*"], {
    cwd: root,
    onlyFiles: true,
    dot: true,
    deep: 1,
    ignore: ["**/.envidence/**"],
  });
  const keys = new Set<string>();
  const ports = new Set<number>();
  for (const file of files.slice(0, 20)) {
    try {
      const absolute = path.join(root, file);
      const size = (await stat(absolute)).size;
      if (size > 64 * 1024) continue;
      const text = await readFile(absolute, "utf8");
      for (const line of text.split(/\r?\n/)) {
        const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!match) continue;
        keys.add(match[1] as string);
        if (/port$/i.test(match[1] as string)) {
          const port = Number((match[2] ?? "").replace(/["']/g, "").trim());
          if (Number.isInteger(port) && port > 0 && port < 65536) ports.add(port);
        }
      }
    } catch {
      // Ignore unreadable env files.
    }
  }
  return { keys: [...keys].sort(), ports: [...ports] };
}

async function scanProjectSource(
  root: string,
  options: { maxFiles: number; maxBytes: number },
): Promise<{ envReferences: Array<{ name: string; file: string; line: number }>; ports: number[] }> {
  const files = await fg("**/*.{ts,tsx,js,jsx,mjs,cjs,py,rs,go,cs,vue,svelte}", {
    cwd: root,
    onlyFiles: true,
    dot: true,
    followSymbolicLinks: false,
    ignore: IGNORE_GLOBS,
  });
  const envReferences: Array<{ name: string; file: string; line: number }> = [];
  const ports = new Set<number>();
  const seenRefs = new Set<string>();
  const selected = files.slice(0, Math.max(0, options.maxFiles));
  for (const file of selected) {
    const absolute = path.join(root, file);
    try {
      const size = (await stat(absolute)).size;
      if (size > options.maxBytes) continue;
      const text = await readFile(absolute, "utf8");
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        for (const name of extractEnvReferences(line)) {
          const key = `${name}:${file}:${index + 1}`;
          if (seenRefs.has(key)) continue;
          seenRefs.add(key);
          if (envReferences.length < 500) {
            envReferences.push({ name, file: relativePath(root, absolute), line: index + 1 });
          }
        }
        for (const port of extractPorts(line)) ports.add(port);
      }
    } catch {
      // Ignore unreadable or binary files.
    }
  }
  return { envReferences, ports: [...ports] };
}

function extractEnvReferences(line: string): string[] {
  const out: string[] = [];
  const patterns = [
    /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
    /process\.env\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\]/g,
    /import\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
    /os\.environ(?:\.get)?\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
    /os\.getenv\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
    /Deno\.env\.get\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
    /std::env::var\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g,
    /\$env:([A-Za-z_][A-Za-z0-9_]*)/g,
  ];
  for (const pattern of patterns) {
    for (const match of line.matchAll(pattern)) {
      if (match[1]) out.push(match[1]);
    }
  }
  return out;
}

function extractPorts(line: string): number[] {
  const out: number[] = [];
  const patterns = [
    /--port\s*[= ]\s*(\d{2,5})/g,
    /\bPORT\s*[:=]\s*['"]?(\d{2,5})/g,
    /(?:localhost|127\.0\.0\.1):(\d{2,5})/g,
    /\.listen\(\s*(\d{2,5})/g,
    /\bport\s*[:=]\s*(\d{2,5})/g,
  ];
  for (const pattern of patterns) {
    for (const match of line.matchAll(pattern)) {
      const port = Number(match[1]);
      if (Number.isInteger(port) && port > 0 && port < 65536) out.push(port);
    }
  }
  return out;
}

async function collectCompose(root: string): Promise<{
  services: string[];
  dockerServices: Array<{ name: string; image: string; ports: number[] }>;
  ports: number[];
}> {
  const candidates = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];
  for (const candidate of candidates) {
    const absolute = path.join(root, candidate);
    if (!existsSync(absolute)) continue;
    try {
      const parsed = parseYaml(await readFile(absolute, "utf8")) as unknown;
      if (!isRecord(parsed) || !isRecord(parsed.services)) continue;
      const dockerServices: Array<{ name: string; image: string; ports: number[] }> = [];
      const ports = new Set<number>();
      for (const [name, value] of Object.entries(parsed.services)) {
        if (!isRecord(value)) continue;
        const servicePorts = parseComposePorts(value.ports);
        for (const port of servicePorts) ports.add(port);
        dockerServices.push({
          name,
          image: typeof value.image === "string" ? value.image : "",
          ports: servicePorts,
        });
      }
      dockerServices.sort((a, b) => a.name.localeCompare(b.name));
      return {
        services: dockerServices.map((service) => service.name),
        dockerServices,
        ports: [...ports],
      };
    } catch {
      return { services: [], dockerServices: [], ports: [] };
    }
  }
  return { services: [], dockerServices: [], ports: [] };
}

function parseComposePorts(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const ports = new Set<number>();
  for (const entry of value) {
    if (typeof entry === "number") {
      if (entry > 0 && entry < 65536) ports.add(entry);
      continue;
    }
    if (typeof entry === "string") {
      const parts = entry.split("/")[0]?.split(":") ?? [];
      const candidate = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
      const match = candidate?.match(/(\d{2,5})/);
      if (match?.[1]) {
        const port = Number(match[1]);
        if (port > 0 && port < 65536) ports.add(port);
      }
      continue;
    }
    if (isRecord(entry) && "published" in entry) {
      const published = Number(entry.published);
      if (Number.isInteger(published) && published > 0 && published < 65536) ports.add(published);
    }
  }
  return [...ports];
}

function extractScriptTools(scripts: Record<string, string>): string[] {
  const tools = new Set<string>();
  for (const script of Object.values(scripts)) {
    for (const segment of script.split(/&&|\|\||;|\|/)) {
      let command = segment.trim().replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+/, "");
      while (true) {
        const match = command.match(/^([^\s]+)\s+(.*)$/);
        if (!match) break;
        const token = stripQuotes(match[1] ?? "");
        if (["cross-env", "npx", "bunx", "env"].includes(token)) {
          command = match[2] ?? "";
          continue;
        }
        break;
      }
      const first = stripQuotes(command.split(/\s+/, 1)[0] ?? "");
      if (!first || first.startsWith("-")) continue;
      if (/^[A-Za-z0-9_.:/\\-]+$/.test(first)) tools.add(path.basename(first).replace(/\.(exe|cmd|bat)$/i, ""));
    }
  }
  return [...tools].sort();
}

function extractPortsFromScripts(scripts: Record<string, string>): number[] {
  const ports = new Set<number>();
  for (const script of Object.values(scripts)) {
    for (const port of extractPorts(script)) ports.add(port);
  }
  return [...ports];
}

function relativePath(root: string, absolute: string): string {
  return path.relative(root, absolute).replaceAll("\\", "/");
}

function toStringRecord(input: unknown): Record<string, string> {
  if (!isRecord(input)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === "object" && !Array.isArray(input);
}

function stripQuotes(input: string): string {
  return input.replace(/^["']|["']$/g, "");
}
