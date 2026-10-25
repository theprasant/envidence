import { runProcess } from "../core/exec.js";
import type { PackageInfo, SnapshotWarning, ToolInfo } from "../core/types.js";
import { asArray } from "../core/util.js";

type RawPipPackage = { name?: string; version?: string };

export async function collectPackages(
  tools: Record<string, ToolInfo>,
  options: { profile: "fast" | "full"; vscodeExtensions: boolean; cargo: boolean; dotnet: boolean },
): Promise<{ packages: PackageInfo[]; warnings: SnapshotWarning[] }> {
  const warnings: SnapshotWarning[] = [];
  const packages: PackageInfo[] = [];
  const jobs: Array<Promise<void>> = [];

  const npm = tools.npm?.resolvedPath;
  if (npm) {
    jobs.push(
      (async () => {
        const result = await runProcess(npm, ["ls", "-g", "--depth=0", "--json"], {
          timeoutMs: 15_000,
        });
        const parsed = parseJson<{ dependencies?: Record<string, { version?: string }> }>(
          result.stdout,
          {},
        );
        for (const [name, info] of Object.entries(parsed.dependencies ?? {})) {
          if (!info?.version) continue;
          packages.push({ manager: "npm", name, version: info.version, scope: "global" });
        }
        if (!result.stdout.trim() && result.code !== 0) {
          warnings.push({ collector: "packages.npm", message: result.stderr.trim().slice(0, 300) });
        }
      })(),
    );
  }

  const pip = tools.pip?.resolvedPath ?? tools.pip3?.resolvedPath;
  const python = tools.python?.resolvedPath ?? tools.python3?.resolvedPath ?? tools.py?.resolvedPath;
  if (pip || python) {
    jobs.push(
      (async () => {
        const result = pip
          ? await runProcess(pip, ["list", "--format=json"], { timeoutMs: 15_000 })
          : await runProcess(python as string, ["-m", "pip", "list", "--format=json"], {
              timeoutMs: 15_000,
            });
        const parsed = asArray(parseJson<RawPipPackage | RawPipPackage[]>(result.stdout, []));
        for (const item of parsed) {
          if (!item?.name || !item.version) continue;
          packages.push({
            manager: "pip",
            name: item.name,
            version: item.version,
            scope: "global",
          });
        }
        if (!result.stdout.trim() && result.code !== 0) {
          warnings.push({ collector: "packages.pip", message: result.stderr.trim().slice(0, 300) });
        }
      })(),
    );
  }

  if (options.profile === "full" && options.cargo && tools.cargo?.resolvedPath) {
    const cargo = tools.cargo.resolvedPath;
    jobs.push(
      (async () => {
        const result = await runProcess(cargo, ["install", "--list"], { timeoutMs: 15_000 });
        for (const line of result.stdout.split(/\r?\n/)) {
          const match = line.match(/^(\S+)\s+v?([0-9][^\s:]*):/);
          if (!match) continue;
          packages.push({
            manager: "cargo",
            name: match[1] as string,
            version: match[2] as string,
            scope: "global",
          });
        }
        if (result.code !== 0 && result.stderr.trim()) {
          warnings.push({ collector: "packages.cargo", message: result.stderr.trim().slice(0, 300) });
        }
      })(),
    );
  }

  if (options.profile === "full" && options.dotnet && tools.dotnet?.resolvedPath) {
    const dotnet = tools.dotnet.resolvedPath;
    jobs.push(
      (async () => {
        const result = await runProcess(dotnet, ["tool", "list", "--global"], { timeoutMs: 15_000 });
        let started = false;
        for (const line of result.stdout.split(/\r?\n/)) {
          if (/^-+\s+-+/.test(line.trim())) {
            started = true;
            continue;
          }
          if (!started) continue;
          const parts = line.trim().split(/\s+/);
          if (parts.length < 2 || !parts[0] || !parts[1]) continue;
          if (!/^[0-9]/.test(parts[1])) continue;
          packages.push({
            manager: "dotnet",
            name: parts[0],
            version: parts[1],
            scope: "global",
          });
        }
      })(),
    );
  }

  if (options.profile === "full" && options.vscodeExtensions && tools.code?.resolvedPath) {
    const code = tools.code.resolvedPath;
    jobs.push(
      (async () => {
        const result = await runProcess(code, ["--list-extensions", "--show-versions"], {
          timeoutMs: 15_000,
        });
        for (const line of result.stdout.split(/\r?\n/)) {
          const trimmed = line.trim();
          const match = trimmed.match(/^(.+)@([0-9][^\s]*)$/);
          if (!match) continue;
          packages.push({
            manager: "vscode",
            name: match[1] as string,
            version: match[2] as string,
            scope: "user",
          });
        }
      })(),
    );
  }

  await Promise.all(jobs);
  packages.sort((a, b) =>
    `${a.manager}:${a.name}`.localeCompare(`${b.manager}:${b.name}`),
  );
  return { packages, warnings };
}

function parseJson<T>(input: string, fallback: T): T {
  try {
    const start = input.indexOf("{");
    const arrayStart = input.indexOf("[");
    const index =
      start === -1 ? arrayStart : arrayStart === -1 ? start : Math.min(start, arrayStart);
    return JSON.parse(index > 0 ? input.slice(index) : input) as T;
  } catch {
    return fallback;
  }
}
