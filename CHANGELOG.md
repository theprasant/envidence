# Changelog

All notable changes to Envidence are recorded here.

## 1.0.0 - 2026-10-25

First public npm release.

- Published the `envidence` package with the `envidence` and `evd` CLI entry points.
- Added an explicit npm file allowlist so the package contains the compiled CLI/server,
  single-file dashboard, launchers, and user-facing documentation without tests or build
  configuration.
- Added `prepack` and `prepublishOnly` release checks so a published tarball is always built
  and tested from the current source.
- Added npm metadata and public package metadata.
- Added Windows CI for clean install, typecheck, tests, build, and package dry-run.
- Documented npm installation, `npx` usage, and the public 1.0.0 support status.

### Known limitations

- Windows 10/11 is the primary supported platform. macOS/Linux use a smaller POSIX
  collector set.
- Node.js 24 or newer is required.
- Automated rollback tests use a fake environment adapter and a sandboxed config. Real
  machine apply/undo is not validated by the test suite. Use `--dry-run` and review the plan
  before applying changes.
- The dashboard is local-only, loopback-bound, and token-protected. There is no remote or
  multi-user access.
- No telemetry, cloud dependency, account, or LLM integration is included.

See [docs/LIMITATIONS.md](docs/LIMITATIONS.md) for the complete list.
