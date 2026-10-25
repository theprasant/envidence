import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import spawn from "cross-spawn";
import { isWindows, normalizeVersion } from "./util.js";

export type ExecResult = {
  file: string;
  args: string[];
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  error?: string;
};

export type ExecOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string;
  capture?: boolean;
  windowsHide?: boolean;
  maxBuffer?: number;
};

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

export function runProcess(file: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const capture = options.capture !== false;
  const useCrossSpawn = isWindows && /\.(cmd|bat)$/i.test(file);
  const spawnFn = useCrossSpawn ? spawn : nodeSpawn;
  const child: ChildProcess = spawnFn(file, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    windowsHide: options.windowsHide ?? true,
    stdio: capture ? ["pipe", "pipe", "pipe"] : "inherit",
    shell: false,
  });

  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let settled = false;
  let timer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;

  const append = (current: string, chunk: Buffer): string => {
    const next = current + chunk.toString("utf8");
    if (next.length <= maxBuffer) return next;
    return next.slice(next.length - maxBuffer);
  };

  if (capture) {
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    if (options.input !== undefined) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(options.input, "utf8");
    } else {
      child.stdin?.end();
    }
  }

  const kill = () => {
    if (!child.pid) return;
    try {
      child.kill("SIGTERM");
    } catch {
      // Ignore.
    }
    killTimer = setTimeout(() => {
      if (settled || !child.pid) return;
      if (isWindows) {
        try {
          nodeSpawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
        } catch {
          // Ignore.
        }
      } else {
        try {
          child.kill("SIGKILL");
        } catch {
          // Ignore.
        }
      }
    }, 1500);
    killTimer.unref?.();
  };

  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    timer.unref?.();
  }

  return new Promise<ExecResult>((resolve) => {
    const finish = (code: number | null, signal: NodeJS.Signals | null, error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        file,
        args,
        code,
        signal: signal ?? null,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut,
        error: error?.message,
      });
    };

    child.on("error", (error) => finish(null, null, error));
    child.on("close", (code, signal) => finish(code, signal));
  });
}

export async function runProcessChecked(
  file: string,
  args: string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  const result = await runProcess(file, args, options);
  if (result.code !== 0 || result.error) {
    const detail = result.stderr.trim() || result.stdout.trim() || result.error || "no output";
    throw new Error(`${file} ${args.join(" ")} failed (${result.code ?? "error"}): ${detail.slice(0, 800)}`);
  }
  return result;
}

let powerShellPath: string | null = null;

export function getPowerShellPath(): string {
  if (powerShellPath) return powerShellPath;
  const candidates = isWindows ? ["pwsh.exe", "powershell.exe"] : ["pwsh", "powershell"];
  for (const candidate of candidates) {
    const result = isWindows
      ? spawnSync("where.exe", [candidate], { stdio: "ignore", windowsHide: true })
      : spawnSync("which", [candidate], { stdio: "ignore" });
    if (result.status === 0) {
      powerShellPath = candidate;
      return candidate;
    }
  }
  powerShellPath = isWindows ? "powershell.exe" : "pwsh";
  return powerShellPath;
}

const PS_PREAMBLE = `
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
`;

export function runPowerShell(script: string, options: ExecOptions = {}): Promise<ExecResult> {
  const ps = getPowerShellPath();
  return runProcess(
    ps,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"],
    {
      ...options,
      input: `${PS_PREAMBLE}\n${script}\n`,
      timeoutMs: options.timeoutMs ?? 20_000,
    },
  );
}

export async function runJsonPowerShell<T>(script: string, options: ExecOptions = {}): Promise<T> {
  const result = await runPowerShell(script, options);
  const stdout = result.stdout.replace(/^\uFEFF/, "").trim();
  if (!stdout) {
    throw new Error(
      `PowerShell returned no output${result.timedOut ? " (timeout)" : ""}: ${result.stderr.trim().slice(0, 500)}`,
    );
  }
  const firstBrace = stdout.indexOf("{");
  const firstBracket = stdout.indexOf("[");
  const start =
    firstBrace === -1
      ? firstBracket
      : firstBracket === -1
        ? firstBrace
        : Math.min(firstBrace, firstBracket);
  const candidate = start > 0 ? stdout.slice(start) : stdout;
  try {
    return JSON.parse(candidate) as T;
  } catch (error) {
    throw new Error(
      `Could not parse PowerShell JSON: ${(error as Error).message}\nOutput: ${candidate.slice(0, 500)}`,
    );
  }
}

export async function whichAll(names: string[]): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  await Promise.all(
    names.map(async (name) => {
      const result = isWindows
        ? await runProcess("where.exe", [name], { timeoutMs: 3000 })
        : await runProcess("sh", ["-c", `command -v -a ${shellQuote(name)} 2>/dev/null || true`], {
            timeoutMs: 3000,
          });
      const lines = result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      out[name] = sortExecutableCandidates(lines);
    }),
  );
  return out;
}

function sortExecutableCandidates(candidates: string[]): string[] {
  if (!isWindows) return candidates;
  const rank = (candidate: string): number => {
    const lower = candidate.toLowerCase();
    if (lower.endsWith(".exe")) return 0;
    if (lower.endsWith(".cmd")) return 1;
    if (lower.endsWith(".bat")) return 2;
    return 3;
  };
  return [...candidates].sort((a, b) => rank(a) - rank(b));
}

export async function getToolVersion(
  filePath: string,
  args: string[] = ["--version"],
  timeoutMs = 3000,
): Promise<string | null> {
  const result = await runProcess(filePath, args, { timeoutMs, capture: true });
  const output = `${result.stdout}\n${result.stderr}`.trim();
  if (!output) return null;
  return normalizeVersion(output.split(/\r?\n/, 1)[0] ?? output);
}

export async function commandExists(command: string): Promise<boolean> {
  const paths = await whichAll([command]);
  return (paths[command] ?? []).length > 0;
}

export async function runGit(
  args: string[],
  cwd: string,
  timeoutMs = 5000,
): Promise<ExecResult> {
  return runProcess("git", args, { cwd, timeoutMs });
}

export function shellQuote(value: string): string {
  if (isWindows) return `"${value.replaceAll('"', '\\"')}"`;
  return `'${value.replaceAll("'", "'\\''")}'`;
}
