# Envidence

> **It worked yesterday. Envidence knows what changed.**
>
> Git protects your code. Envidence protects the machine.

Envidence is a local-first **black box for your development machine**. It snapshots the
layer Git ignores — PATH, environment variables, global packages, runtimes, services,
startup entries, listening ports, shell profiles, editor configs, and project metadata —
records what a command changed, ranks the most plausible causes of a failure, and builds a
reviewable, reversible remediation plan.

Everything stays on the machine. There is no cloud, no telemetry, no account, and no LLM.
Reports are self-contained HTML files you can attach to an issue.

```text
                  snapshots + runs + cases
                           │
   evd snap ───────────────┤
   evd watch -- npm test ──┤──> ranked evidence ──> HTML case file
   evd why ────────────────┤                         │
   evd rollback --dry-run ─┘                         └──> reversible plan
```

## Status

Envidence **v1.0.0** is the first public npm release. It is a local-first tool for
Windows 11, with a basic POSIX fallback. The CLI, collectors, SQLite store, diff/ranking
engine, dashboard, report, rollback engine, deterministic demo, and test suite are
implemented. See [Limitations](docs/LIMITATIONS.md) for the honest edges, including the
fact that real-machine rollback apply/undo is not exercised by the automated test suite.

The OpenCode plugin/agent integration was intentionally **not** built. The complete
product works without an editor integration.

## Install

Requirements:

- Node.js **24 or newer** (the store uses `node:sqlite`)
- npm
- Windows 10/11 for the full collector set; macOS/Linux run a smaller subset

Install the CLI globally:

```powershell
npm install -g envidence
envidence --help
# short alias
evd --help
```

Or run it without a global install:

```powershell
npx envidence --help
npx envidence demo
```

The npm package includes the compiled CLI, server, and single-file dashboard. It does not
need a build step after installation. It contains no telemetry, makes no runtime network
calls, and has no account or cloud dependency.

## Quick start

With the installed package, run the deterministic demo in an isolated project-local store:

```powershell
$env:ENVIDENCE_HOME = "./.envidence"
evd demo
evd demo --report --out .envidence/demo-report.html
evd demo --ui
```

On macOS/Linux:

```sh
export ENVIDENCE_HOME="./.envidence"
evd demo
```

### From this repository

For development, build from source in PowerShell:

```powershell
npm install
npm run build

# Keep all evidence inside the project while trying it out.
$env:ENVIDENCE_HOME = "./.envidence"

.\bin\evd.cmd demo
```

On macOS/Linux:

```sh
npm install
npm run build
export ENVIDENCE_HOME="./.envidence"
./bin/evd demo
```

`npm run build` compiles the CLI/server and builds the single-file dashboard. If you only
need the CLI, `npm run build:cli` is enough; `npm run build:ui` rebuilds the dashboard.

Expected demo result:

- Store: `.envidence/demo` (isolated fixture store)
- Case: `CASE-20261023-7F3A` — *npm test failed after TypeScript prerelease install*
- Top finding: **Global npm package typescript changed** — score **72/100**, high confidence
- Second finding: **PATH changed** — score **38/100**, low confidence
- Three snapshots, two runs, one baseline
- No real machine state is read while seeding the demo

The dashboard prints a `http://127.0.0.1:<port>/#token=...` link. The URL fragment contains
a per-session token; the server binds only to loopback. `Ctrl+C` stops it.

See [docs/DEMO.md](docs/DEMO.md) for the full transcript and reset instructions.

## Everyday use

Use a project-local store while evaluating:

```powershell
$env:ENVIDENCE_HOME = "./.envidence"

# Initialize and capture the first full snapshot.
.\bin\evd.cmd init

# Mark a known-good reference.
.\bin\evd.cmd baseline set latest --label "Known good"

# Wrap a command. Exit code is preserved exactly.
.\bin\evd.cmd watch -- npm test

# Explain the newest case, a specific run, or a command.
.\bin\evd.cmd why
.\bin\evd.cmd why --run RUN-...
.\bin\evd.cmd why --case CASE-...
.\bin\evd.cmd why --since 2h

# Inspect and close cases.
.\bin\evd.cmd case list
.\bin\evd.cmd case show CASE-...
.\bin\evd.cmd case close CASE-... --summary "Fixed by restoring TypeScript"

# Share a redacted, offline case file.
.\bin\evd.cmd report --case CASE-... --out case.html --open

# Preview remediation. This changes nothing.
.\bin\evd.cmd rollback --case CASE-... --dry-run --script rollback.ps1
```

From an npm install, use `evd` / `envidence`, or `npx envidence` without a global install.
From a checkout, the launchers in `bin/` are the supported local entry points, and
`node dist/cli.js ...` works too. For production, set `ENVIDENCE_HOME` to a directory you
control or use the default platform data directory
(`%LOCALAPPDATA%\Envidence` on Windows, `$XDG_DATA_HOME/envidence` elsewhere).

### Command reference

| Command | Purpose |
|---|---|
| `evd init` | Create the store/config and take a first full snapshot |
| `evd snap [--fast\|--full] [--label] [--pin]` | Capture machine state without running a command |
| `evd watch -- <command>` | Snapshot → run → snapshot; preserve the exit code; explain failures |
| `evd why [target]` | Rank hypotheses for a run or case; `--fail-on-findings` for CI |
| `evd diff [a] [b]` | Categorized snapshot diff, including PATH ordering |
| `evd log` | Recent snapshots, runs, or cases |
| `evd case list/show/close` | Case lifecycle |
| `evd baseline set/accept/show/list` | Known-good references and drift |
| `evd fingerprint` | Stable digest of tracked machine facts |
| `evd report --case <id>` | Self-contained HTML case file |
| `evd rollback --case/--run/--to` | Dry-run plan, apply, or write a script |
| `evd undo [rollback]` | Invert the last applied rollback |
| `evd ui [--port] [--demo]` | Token-protected local dashboard |
| `evd demo [--reset] [--ui] [--report]` | Deterministic story and isolated store |
| `evd doctor` | Store health, baselines, warnings, collector configuration |
| `evd config get/set/path` | Read or update configuration |
| `evd prune` | Remove old unprotected snapshots, dry-run by default |

Run `.\bin\evd.cmd --help` or `.\bin\evd.cmd <command> --help` for every option. Global
flags: `--store <path>`, `--json`, `--quiet`, `--verbose`.

`watch` uses the fast profile by default. Add `--full` when you want the full collector
set on both sides of the command. `--no-why` records the run without opening a case.
Captured stdout/stderr tails are bounded and redacted; `--capture-output` keeps more of
them for the case file.

## What it collects

Envidence uses read-only system queries. A full snapshot can include:

- host OS/build/architecture, hostname, username, timezone, uptime, clock
- user, machine, and effective environment values; PATH order, duplicates, missing dirs
- resolved tools and versions (Node, npm, Python, Rust, .NET, Go, and more)
- global packages from npm, pip, cargo, dotnet, VS Code, and optionally winget/choco/scoop
- services, startup entries, scheduled tasks, installed programs, hotfixes
- listening ports and owning processes, proxy/hosts/DNS state
- selected config files (Git, npm, Cargo, shell profiles, VS Code settings, hosts, and
  project-local tool configs), with secret-like values redacted and hashes recorded
- shell profile hashes, time/NTP, disks, WSL distributions
- bounded project metadata: manifests, lockfiles, scripts, dependencies, env key names,
  env references, likely ports, Compose services, and Git branch/commit/dirty counts

It does **not** read personal documents, browser history or cookies, SSH/GPG/AWS/Azure/
Kubernetes credentials, or keychains. Project scanning is bounded and skips
`node_modules`, `.git`, `.envidence`, build output, and other vendor directories. See
[Privacy](docs/PRIVACY.md) for the exact contract.

## How the evidence works

1. **Snapshot** — normalized facts, not opaque restore points. Full state is gzipped in a
   content-addressed blob store; SQLite holds metadata and indexes.
2. **Attribute** — `watch` compares the pre-window and post-window snapshots and labels a
   difference `observed-during` the command window, or `pre-existing` relative to the
   last known-good reference. Sequence-aware PATH diffing reports moves, not fake
   add/remove pairs.
3. **Rank** — rules combine base weight, project relevance, recency, stderr signals, and
   historical correlation (Laplace-smoothed, gated by sample count). Scores are hypotheses,
   not verdicts. A confident “nothing in the machine layer changed” is a valid result.
4. **Remediate** — the rollback planner emits typed actions (env, PATH, packages, services,
   startup, tasks, config restore) plus manual steps. Preconditions are checked against
   current state. Dry run is the default. Apply requires `--yes` and takes a full safety
   snapshot first. `undo` inverts the plan.
5. **Package** — a single offline HTML file with inline CSS/JS/JSON and redaction. The
   dashboard uses the same case data for interactive investigation.

The UI is a React 19 + Vite single-file bundle served by a local Node HTTP server. It is
not a cloud service and does not need a separate web server.

## Dashboard

```powershell
.\bin\evd.cmd ui --demo
# or serve an existing store:
.\bin\evd.cmd ui --port 4317
```

- Binds to `127.0.0.1` only.
- Generates a random per-session token and puts it in the URL fragment, never in a query
  string or server log.
- The UI sends the token in an `X-Envidence-Token` header. API requests without it get
  `401`.
- POST requests require a same-origin `Origin` header.
- CSP, frame denial, no-sniff, no-referrer, path-traversal protection, and no directory
  listings are enabled.
- The dashboard is for investigation: rollback plans can be previewed and **simulated**,
  but real apply is intentionally a CLI action. The server exposes a guarded apply
  endpoint for API users; it requires a plan created in the same session, the literal
  confirmation `rollback`, a same-origin POST, and a safety snapshot.

The dashboard pages are Timeline, Case File (findings, all changes, timeline,
remediation, raw evidence), Runs, Baselines, and Settings. The case file can be exported
directly from the UI with standard or strict redaction.

See [Security](docs/SECURITY.md) for the threat model.

## Report and redaction

```powershell
.\bin\evd.cmd report --case CASE-20261023-7F3A --out evd-case.html
.\bin\evd.cmd report --case CASE-... --redact strict --open
```

| Level | Behavior |
|---|---|
| `standard` (default) | Home → `~`; project paths shortened; host/user placeholder; secrets redacted; public-ish IPs removed |
| `strict` | Also removes project/branch/commit and service identifiers |
| `none` | Local viewing only; unredacted paths and hosts, with a visible warning |

Even at `none`, env values marked secret are replaced with `<redacted>`, and secret-like
tokens found in config text or URLs are stripped. A report over 3 MB produces a warning,
not a failure. The report has no external scripts, styles, fonts, or images.

Do not attach an unredacted `none` report to a public issue without reviewing it.

## Rollback safety

```powershell
# Default: plan only, no mutations.
.\bin\evd.cmd rollback --case CASE-... --dry-run --script rollback.ps1

# Real apply: explicit, interactive confirmation, full safety snapshot first.
.\bin\evd.cmd rollback --case CASE-... --apply

# Invert the last applied rollback.
.\bin\evd.cmd undo
```

Apply:

- refuses if preconditions no longer match the plan;
- takes a full snapshot with trigger `pre_rollback` and pins it;
- writes a `rollbacks` audit record with per-action results;
- tells you when an action needs an administrator shell or a manual step;
- never claims an action succeeded if it failed or was skipped.

Tests use `FakeEnvironmentAdapter` and a sandboxed temp config. This machine's real
environment was not mutated by the test suite or the demo.

## Development

```powershell
npm install
npm run typecheck
npx vitest run
npm run build
```

- `npm test` is `vitest run`, but use `npx vitest run` if your npm version mangles
  forwarded arguments.
- Tests create temporary stores under `.envidence/vitest-*` and remove them.
- The demo is fixture-based and deterministic; it never reads the live machine.
- No global installs and no `npm link` are required.

Project layout:

```text
bin/                 local evd launchers
src/cli.ts           commander entry
src/commands/        CLI commands
src/collectors/      read-only Windows/POSIX collectors
src/core/            store, facts, diff, rules, run, report, rollback, adapters
src/server/          localhost dashboard server and APIs
src/ui/              React dashboard
tests/               core, UI server, report, and sandbox rollback tests
docs/                plan and product/security/privacy documentation
```

## Documentation

- [Deterministic demo](docs/DEMO.md)
- [Privacy](docs/PRIVACY.md)
- [Security](docs/SECURITY.md)
- [Limitations](docs/LIMITATIONS.md)
- [Changelog](CHANGELOG.md)

## License

MIT. See [LICENSE](LICENSE).
