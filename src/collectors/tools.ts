import { getToolVersion, whichAll } from "../core/exec.js";
import type { ToolInfo } from "../core/types.js";

export const CURATED_TOOLS = [
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
  "git",
  "gh",
  "docker",
  "kubectl",
  "terraform",
  "aws",
  "az",
  "gcloud",
  "java",
  "javac",
  "dotnet",
  "go",
  "cargo",
  "rustc",
  "ruby",
  "php",
  "composer",
  "code",
  "pwsh",
  "powershell",
  "wsl",
  "make",
  "cmake",
  "ninja",
  "ffmpeg",
  "rg",
  "fd",
  "curl",
  "jq",
  "winget",
  "choco",
  "scoop",
] as const;

export const RUNTIME_TOOLS = new Set([
  "node",
  "npm",
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
  "dotnet",
  "go",
  "cargo",
  "rustc",
  "java",
  "ruby",
  "php",
]);

const VERSION_ARGS: Record<string, string[]> = {
  node: ["--version"],
  npm: ["--version"],
  npx: ["--version"],
  pnpm: ["--version"],
  yarn: ["--version"],
  bun: ["--version"],
  deno: ["--version"],
  python: ["--version"],
  python3: ["--version"],
  py: ["--version"],
  pip: ["--version"],
  pip3: ["--version"],
  uv: ["--version"],
  poetry: ["--version"],
  conda: ["--version"],
  git: ["--version"],
  gh: ["--version"],
  docker: ["--version"],
  kubectl: ["version", "--client"],
  terraform: ["version"],
  aws: ["--version"],
  az: ["--version"],
  gcloud: ["--version"],
  java: ["-version"],
  javac: ["-version"],
  dotnet: ["--version"],
  go: ["version"],
  cargo: ["--version"],
  rustc: ["--version"],
  ruby: ["--version"],
  php: ["--version"],
  composer: ["--version"],
  code: ["--version"],
  pwsh: ["--version"],
  powershell: ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"],
  wsl: ["--version"],
  make: ["--version"],
  cmake: ["--version"],
  ninja: ["--version"],
  ffmpeg: ["-version"],
  rg: ["--version"],
  fd: ["--version"],
  curl: ["--version"],
  jq: ["--version"],
  winget: ["--version"],
  choco: ["--version"],
  scoop: ["--version"],
};

type CacheEntry = {
  version: string | null;
  at: number;
};

const versionCache = new Map<string, CacheEntry>();
const VERSION_CACHE_TTL = 10 * 60_000;

export async function collectTools(): Promise<Record<string, ToolInfo>> {
  const paths = await whichAll([...CURATED_TOOLS]);
  const entries = await mapLimit([...CURATED_TOOLS], 8, async (name): Promise<[string, ToolInfo]> => {
    const candidates = (paths[name] ?? []).filter(Boolean);
    const resolvedPath = candidates[0] ?? null;
    let version: string | null = null;
    let versionSource: ToolInfo["versionSource"] = "unknown";
    if (resolvedPath) {
      const args = VERSION_ARGS[name];
      if (args) {
        const cached = versionCache.get(resolvedPath);
        if (cached && Date.now() - cached.at < VERSION_CACHE_TTL) {
          version = cached.version;
          versionSource = "cache";
        } else {
          version = await getToolVersion(resolvedPath, args, 3500);
          versionCache.set(resolvedPath, { version, at: Date.now() });
          versionSource = "exec";
        }
      }
    }
    return [
      name,
      {
        name,
        paths: candidates,
        resolvedPath,
        version,
        versionSource,
      },
    ];
  });
  return Object.fromEntries(entries);
}

export function invalidateToolVersionCache(): void {
  versionCache.clear();
}

export function toolVersions(tools: Record<string, ToolInfo>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [name, info] of Object.entries(tools)) {
    out[name] = info.version;
  }
  return out;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await fn(item);
    }
  });
  await Promise.all(workers);
  return results;
}
