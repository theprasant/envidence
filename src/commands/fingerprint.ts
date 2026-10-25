import type { Command } from "commander";
import pc from "picocolors";
import { withContext, printJson } from "../cli/context.js";
import { fingerprintSnapshot } from "../core/fingerprint.js";

export function registerFingerprint(program: Command): void {
  program
    .command("fingerprint")
    .description("Print a stable fingerprint of tracked machine state")
    .argument("[snapshot]", "snapshot ID, prefix, label, or latest", "latest")
    .action(async (snapshotRef: string, _options: unknown, command: Command) => {
      await withContext(command, async (context) => {
        const snapshot = context.store.getSnapshot(snapshotRef);
        const result = fingerprintSnapshot(snapshot);
        if (context.json) {
          printJson({ snapshot: snapshot.id, ...result });
          return;
        }
        context.logger.raw(`${pc.bold(result.fingerprint)}  ${pc.dim(`(${snapshot.id})`)}`);
        for (const [category, hash] of Object.entries(result.categories)) {
          context.logger.raw(`  ${category.padEnd(12)} ${hash}`);
        }
      });
    });
}
