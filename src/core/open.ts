import { spawn } from "node:child_process";

export function openLocalFile(target: string): void {
  const platform = process.platform;
  const command =
    platform === "win32" ? "cmd.exe" : platform === "darwin" ? "open" : "xdg-open";
  const args =
    platform === "win32" ? ["/d", "/s", "/c", "start", "", target] : [target];
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}
