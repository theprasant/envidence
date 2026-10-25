# Envidence

[![npm version](https://img.shields.io/npm/v/envidence?color=0f766e)](https://www.npmjs.com/package/envidence)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24-0f766e)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-0f766e)](https://github.com/theprasant/envidence/blob/main/LICENSE)

Git tells you what changed in your code. Envidence tells you what changed on the machine around it.

Envidence is a local CLI for the failures Git cannot explain. It snapshots the parts of a development environment that Git does not track, records what changed while a command ran, ranks the likely causes of a failure, and produces an evidence report and a reversible plan.

It is useful when:

- `npm test` passed yesterday and fails today, but your source tree has not changed.
- A command works in one shell and fails in another.
- A global package, runtime, service, or PATH entry changed.
- You need to attach useful evidence to a bug report without sending your whole machine state.

Everything stays on your machine. There is no account, cloud service, telemetry, or LLM.

[Documentation](https://envidence.prasant.dev/docs/) | [npm](https://www.npmjs.com/package/envidence) | [GitHub](https://github.com/theprasant/envidence)

## Requirements

- Node.js 24 or newer
- Windows 10 or 11 for the full collector set
- macOS and Linux use a smaller POSIX collector set

## Install

```sh
npm install -g envidence
```

This installs two equivalent commands:

```sh
envidence --help
evd --help
```

You can also run it without a global install:

```sh
npx envidence --help
```

## Quick start

Run Envidence from the project you want to investigate.

```sh
cd /path/to/project

# Create the local store and mark the first snapshot as the known-good baseline.
evd init --label "Known good"

# Run the command you want to observe.
evd watch -- npm test
```

`evd watch` records the machine state before and after the command. If the command fails, it opens a case and prints the strongest changes it found. If it passes, the run is recorded and no case is opened. The command's exit code is preserved.

If the command failed, review the latest case:

```sh
evd why
```

List cases and inspect one:

```sh
evd case list
evd case show CASE-...
```

When a command fails, a common workflow looks like this:

```sh
# Work on the problem, then run the failing command again.
evd watch -- npm test

# Read the ranked leads.
evd why

# Create a report you can attach to an issue.
evd report --case CASE-... --out envidence-case.html

# Preview a fix without changing anything.
evd rollback --case CASE-... --dry-run
```

If the failure is already happening and you do not have a known-good snapshot, take a snapshot now and use `evd watch` for future commands. Envidence cannot reconstruct a machine state it never recorded.

### Try the demo

If you want to see the whole flow without reading your machine, run the built-in demo:

```sh
evd demo --reset
```

The demo uses isolated fixture data in `<store>/demo`. It does not scan live system state.

## Commands

| Command | What it does |
|---|---|
| `evd init` | Create the store and take the first full snapshot |
| `evd snap` | Take a snapshot without running a command |
| `evd watch -- <command>` | Snapshot, run a command, snapshot again, and explain failures |
| `evd why` | Rank the likely causes of a run or case |
| `evd diff` | Compare two snapshots |
| `evd log` | List recent snapshots, runs, or cases |
| `evd case list` | List investigation cases |
| `evd case show <id>` | Show a case, its findings, and its changes |
| `evd case close <id>` | Close a case with a summary |
| `evd baseline set` | Mark a snapshot as the known-good reference |
| `evd baseline show` | Show the active baseline and current drift |
| `evd fingerprint` | Print a stable fingerprint of tracked machine state |
| `evd report` | Write a self-contained HTML report |
| `evd rollback` | Plan or apply a reversal of machine changes |
| `evd undo` | Undo a previously applied rollback |
| `evd ui` | Open the local dashboard |
| `evd doctor` | Check store health, baselines, warnings, and collectors |
| `evd config` | Read or update configuration |
| `evd prune` | Remove old unprotected snapshots |
| `evd demo` | Open the isolated deterministic demo |

Run `evd --help` or `evd <command> --help` for every option. Global options are `--store <path>`, `--json`, `--quiet`, and `--verbose`.

### `evd init`

```sh
evd init
evd init --label "Clean install"
evd init --fast
```

`init` creates the local store, takes a full snapshot, and marks it as the active baseline unless you pass `--no-baseline`. Use `--fast` for a quicker snapshot with fewer collectors.

### `evd snap`

```sh
evd snap
evd snap --fast --label "Before upgrade"
evd snap --full --pin
```

A snapshot records the machine at one point in time. Pinned snapshots are protected from pruning.

### `evd watch`

```sh
evd watch -- npm test
evd watch --full -- npm run build
evd watch --timeout 300 -- npm run test:e2e
evd watch --no-why -- npm install
```

`watch` takes a fast snapshot by default, runs the command, takes another snapshot, and compares them. Add `--full` when the failure may involve a collector that is not in the fast profile.

`--capture-output` keeps more of the command's stdout and stderr. The default output tails are bounded, and recognized secrets are redacted in reports. If a command prints secrets, do not capture its output.

### `evd why`

```sh
evd why
evd why --case CASE-...
evd why --run RUN-...
evd why --since 2h
evd why --all
```

When `watch` records a run, it selects a reference in this order: the last successful run of the same command in the same project, the active baseline, then the most recent snapshot before the command window. If none is available, it uses the pre-command snapshot. `--since` overrides the reference. `--all` includes volatile changes such as free disk space and short-lived ports.

Findings are ranked leads, not proof. A high score means a change is worth checking first, not that it caused the failure.

### `evd diff`

```sh
evd diff
evd diff SNAP-1 SNAP-2
evd diff --category packages,path
evd diff --search typescript
```

Diffs are grouped by category and distinguish changes observed during a command window from changes that were already present.

### `evd baseline`

```sh
evd baseline set latest --label "Known good"
evd baseline show
evd baseline list
evd baseline accept
```

A baseline is the reference Envidence uses when deciding whether a change is new. Set one after a known-good test run or a clean install.

### `evd report`

```sh
evd report --case CASE-... --out envidence-case.html
evd report --case CASE-... --redact strict --out envidence-case.html
evd report --case CASE-... --redact none --open
```

The report is one offline HTML file with inline styles, scripts, and data. It has no remote assets.

| Redaction | Removes |
|---|---|
| `standard` (default) | Home directory, project path prefixes, hostname, username, and public-looking IPs |
| `strict` | Also removes project identifiers, branch and commit details, and service names |
| `none` | Keeps local paths and identifiers. Use only for local review |

Even with `none`, values marked as secrets and recognized token shapes are redacted. Review any report before sharing it.

### `evd rollback`

```sh
# Preview the plan and write a script. This changes nothing.
evd rollback --case CASE-... --dry-run --script rollback.ps1

# Apply the plan after reviewing it.
evd rollback --case CASE-... --apply

# Reverse the last applied rollback.
evd undo
```

Rollback can restore environment values, PATH order, selected global packages, VS Code extensions, config files, service state, startup entries, and scheduled-task state. Unsupported changes become manual steps.

Before applying a rollback, Envidence checks that the machine still matches the plan, takes a pinned safety snapshot, and asks for confirmation. Use `evd rollback --dry-run` first.

Real rollback apply and undo have not been validated on a real machine for this release. Test on a disposable machine before relying on them for important state.

### `evd ui`

```sh
evd ui
evd ui --port 4317
evd ui --no-open
```

The dashboard starts a local server on `127.0.0.1`, prints a session URL, and protects API requests with a per-session token. It is for local review only. Do not expose it through a proxy or port forward.

The dashboard previews and simulates rollback plans and has no apply button. Apply from the CLI for the supported flow.

### `evd doctor` and `evd prune`

```sh
evd doctor
evd config list
evd config set profile fast

evd prune
evd prune --keep 30 --days 14 --yes
```

`prune` is a dry run until you pass `--yes`. Pinned snapshots, baselines, snapshots used by runs or cases, and safety snapshots are protected.

## What Envidence records

A full snapshot can include:

- OS, architecture, hostname, username, timezone, uptime, and clock
- User, machine, and effective environment variables, including secret-like values as hashes
- PATH order, duplicates, and missing directories
- Resolved tools and versions such as Node, npm, Python, Rust, .NET, Go, Java, Git, and PowerShell
- Global packages from npm, pip, cargo, dotnet, and VS Code
- Services, startup entries, scheduled tasks, installed programs, and hotfixes
- Listening ports and their owning processes, proxies, DNS, and the hosts file
- Selected config files such as Git, npm, Cargo, shell profiles, VS Code settings, and project tool configs
- Project manifests, lockfile hashes, scripts, dependency names, environment key names, likely ports, Compose services, and Git branch and commit information

Envidence does not collect personal documents, browser history or cookies, SSH keys, cloud credentials, keychains, or source file contents. Project scanning skips dependency, build, and vendor directories.

See the [privacy guide](https://envidence.prasant.dev/docs/privacy/) for the full data inventory.

## How it works

1. **Snapshot.** Envidence records normalized machine facts in a local store. Full state is kept in content-addressed blobs, and SQLite holds the searchable index.
2. **Observe.** `evd watch` compares the state before and after a command. A change can be labeled `pre-existing` or `observed-during` the command window.
3. **Rank.** Rules combine change type, project relevance, recency, stderr signals, and historical correlation. The result is a ranked list of hypotheses.
4. **Review.** The case file, dashboard, and report show the evidence behind each lead.
5. **Plan.** The rollback planner produces typed actions and manual steps. A dry run is the default.

## Local store

The default store location is:

- Windows: `%LOCALAPPDATA%\Envidence`
- macOS and Linux: `$XDG_DATA_HOME/envidence` or `~/.local/share/envidence`

You can keep evidence inside a project:

```sh
ENVIDENCE_HOME=./.envidence evd init
```

On PowerShell:

```powershell
$env:ENVIDENCE_HOME = "./.envidence"
evd init
```

Or use a one-off store path:

```sh
evd init --store ./.envidence
```

The store contains environment values, command output, paths, and machine history. Treat it as sensitive local data. The [privacy guide](https://envidence.prasant.dev/docs/privacy/) explains retention and deletion.

## Platform support

Windows 10 and 11 have the full collector set. macOS and Linux have a smaller fallback set for host, environment, PATH, packages, network, and project metadata. Some Windows-only features, including services, scheduled tasks, hotfixes, WSL, and machine-scope rollback, are limited or unavailable.

Node.js 24 or newer is required because the store uses `node:sqlite`.

## Documentation

- [Documentation site](https://envidence.prasant.dev/docs/)
- [Getting started](https://envidence.prasant.dev/docs/getting-started/)
- [Command reference](https://envidence.prasant.dev/docs/commands/)
- [Dashboard](https://envidence.prasant.dev/docs/dashboard/)
- [Reports](https://envidence.prasant.dev/docs/reports/)
- [Rollback safety](https://envidence.prasant.dev/docs/rollback/)
- [Privacy](https://envidence.prasant.dev/docs/privacy/)
- [Security](https://envidence.prasant.dev/docs/security/)
- [Limitations](https://envidence.prasant.dev/docs/limitations/)
- [Changelog](https://github.com/theprasant/envidence/blob/main/CHANGELOG.md)

## Issues

Report bugs and request features at [github.com/theprasant/envidence/issues](https://github.com/theprasant/envidence/issues).

For security-sensitive reports, read the [security guide](https://envidence.prasant.dev/docs/security/) first and do not attach an unredacted store or report to a public issue.

## License

MIT. See [LICENSE](https://github.com/theprasant/envidence/blob/main/LICENSE).
