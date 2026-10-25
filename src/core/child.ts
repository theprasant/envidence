import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import spawn from "cross-spawn";
import { isWindows } from "./util.js";

export type InteractiveResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  interrupted: boolean;
  error?: string;
};

export type InteractiveOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  captureLimit?: number;
  forwardSignals?: boolean;
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
};

/**
 * Run a child process with inherited stdin and live-teed stdout/stderr.
 * The last `captureLimit` characters of each stream are retained for the case file.
 */
export function runInteractive(
  file: string,
  args: string[],
  options: InteractiveOptions = {},
): Promise<InteractiveResult> {
  const started = Date.now();
  const captureLimit = options.captureLimit ?? 64 * 1024;
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let interrupted = false;
  let settled = false;
  let timer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  let child: ChildProcess;

  const append = (current: string, chunk: Buffer): string => {
    const next = current + chunk.toString("utf8");
    return next.length <= captureLimit ? next : next.slice(next.length - captureLimit);
  };

  try {
    child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["inherit", "pipe", "pipe"],
      windowsHide: false,
      shell: false,
    });
  } catch (error) {
    return Promise.resolve({
      code: null,
      signal: null,
      stdout: "",
      stderr: "",
      durationMs: Date.now() - started,
      timedOut: false,
      interrupted: false,
      error: (error as Error).message,
    });
  }

  child.stdout?.on("data", (chunk: Buffer) => {
    stdout = append(stdout, chunk);
    options.onStdout?.(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = append(stderr, chunk);
    options.onStderr?.(chunk);
  });

  const cleanup = (): void => {
    if (timer) clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  };

  const kill = (): void => {
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
          const killer = nodeSpawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
          killer.on("error", () => {});
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

  const onSigint = (): void => {
    interrupted = true;
    kill();
  };
  const onSigterm = (): void => {
    interrupted = true;
    kill();
  };

  if (options.forwardSignals !== false) {
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
  }

  if ((options.timeoutMs ?? 0) > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs);
    timer.unref?.();
  }

  return new Promise<InteractiveResult>((resolve) => {
    const finish = (code: number | null, signal: NodeJS.Signals | null, error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        code,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut,
        interrupted,
        error: error?.message,
      });
    };

    child.on("error", (error) => finish(null, null, error));
    child.on("close", (code, signal) => finish(code, signal));
  });
}
