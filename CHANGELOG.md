# Changelog

All notable changes to Envidence are recorded here.

## 1.0.1 - 2026-10-26

Documentation and package metadata update.

- Rewrote the README and user guides around installation, daily use, safety, and limits.
- Added repository and issue links to the package metadata.
- Clarified dashboard rollback behavior and how to apply a plan.
- Clarified that real rollback apply and undo have not been validated on a real machine.

No command behavior changed.

## 1.0.0 - 2026-10-25

Initial release.

- Local snapshot store for the machine layer Git does not track.
- `evd init`, `evd snap`, `evd diff`, `evd log`, and `evd fingerprint`.
- `evd watch` for recording a command window and explaining failures.
- Ranked change hypotheses with case files and known-good baselines.
- Self-contained HTML reports with standard, strict, and none redaction levels.
- Local dashboard with session-token protection and rollback previews.
- Rollback plans, generated scripts, confirmation-gated apply, and `evd undo`.
- Store diagnostics, configuration commands, and protected pruning.
- Full Windows 10 and 11 collector set, with a smaller POSIX fallback.

### Notes

- Node.js 24 or newer is required.
- Windows has the broadest collector and rollback coverage.
- Real rollback apply and undo have not been validated on a real machine. Use a dry run and test on a disposable machine before relying on them.

See [Limitations](docs/LIMITATIONS.md) for the complete list.
