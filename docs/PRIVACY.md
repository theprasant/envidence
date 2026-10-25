# Privacy

Envidence is built around a simple rule: **evidence stays on the machine that produced it.**

There is no account, cloud sync, telemetry, analytics, remote error reporting, or LLM call.
The CLI and dashboard do not make network requests. The only network activity Envidence can
cause is indirect and explicit: a command you ask `watch` to run may use the network, and
`rollback --apply` may invoke a package manager (`npm`, `pip`, `cargo`, or VS Code) that
downloads the requested version.

This page describes what is stored, why, and how to remove it. It is intentionally more
specific than the marketing promise.

## The local store

The store is a directory:

```text
<store>/
├─ config.json          redaction level, collector switches, retention, salt
├─ db.sqlite            snapshots, runs, cases, baselines, rollbacks, events
├─ objects/             gzip-compressed, content-addressed snapshot/config blobs
└─ logs/                local operational logs
```

The default location is:

- Windows: `%LOCALAPPDATA%\Envidence`
- macOS/Linux: `$XDG_DATA_HOME/envidence` or `~/.local/share/envidence`

During evaluation, set `ENVIDENCE_HOME=./.envidence` or pass `--store <path>` to keep
everything inside the project. The deterministic demo uses `<store>/demo`.

A report (`evd report`) is a separate HTML file written wherever you choose. Reports are
self-contained: CSS, JavaScript, data, and styles are inline. There are no external fonts,
scripts, images, or tracking pixels.

## What a snapshot contains

A full snapshot can contain:

| Data | Examples | Notes |
|---|---|---|
| Host identity | hostname, username, OS, build, architecture, timezone, uptime, clock | Needed to make evidence meaningful |
| Environment | user, machine, and effective variable names and values | Secret-like names are hashed; see below |
| PATH | user/machine/effective entries, order, duplicates, missing directories | Order is evidence |
| Tools and runtimes | Node, npm, Python, pip, Rust, .NET, Go, Java, PowerShell, Git | Versions and resolved paths |
| Global packages | npm, pip, cargo, dotnet, VS Code; optional winget/choco/scoop | Names and versions |
| Services/startup/tasks | names, state, start mode, executable paths, commands | Windows full profile; admin may be needed for some fields |
| Network/ports | listeners, owning process and path, DNS, WinHTTP/IE proxy, hosts entries | Bounded and normalized |
| Config files | selected Git/npm/Cargo/shell/editor/tool files | Content is redacted and hashed; see below |
| Shell | shell type, profile paths and hashes, execution policy | Not the full profile content for arbitrary shells |
| Disks/time/WSL | capacity, free space, clock, distro names/state | Volatile facts are labeled |
| Project metadata | manifests, lockfile hashes, scripts, dependency names, env key names, env references, likely ports, Compose services, Git branch/commit/dirty counts | Bounded; source text is not stored |

Every collector is read-only. Full-only collectors can be disabled in `config.json`. A
collector failure becomes a warning; it does not crash the snapshot.

## Environment values and secret handling

Envidence stores environment variable **names** and, for ordinary variables, values. Values
whose names look secret-like are treated differently:

- The raw value is not stored.
- A salted SHA-256 hash is stored so changes can still be detected.
- A short masked preview is stored for human recognition. Values longer than four
  characters show the first two and last two characters. Values of four characters or
  fewer are shown as `****`.
- The salt is generated per store in `config.json`. It is not a secret from a local
  process that can read the store, and low-entropy values can be guessed from hashes. Treat
  the store as sensitive even though obvious tokens are hashed.

The name test is heuristic. It catches names containing forms such as `TOKEN`, `SECRET`,
`PASSWORD`, `API_KEY`, `AUTH`, `CREDENTIAL`, `PRIVATE_KEY`, `SESSION`, and `COOKIE`. A
secret stored in a variable with an innocuous name (for example `FOO=ghp_...`) is not
automatically hashed just because of the name. Known token shapes and URL credentials are
stripped from reports, but the original snapshot value may remain in the store. Use a secret
manager, not environment variables, for high-value secrets.

`evd why`, `evd diff`, and the dashboard can display masked previews and before/after
values. Reports replace secret-marked values with `<redacted>`.

## Config files

Only a fixed candidate set is read: Git config, `.npmrc`, Cargo config, shell profiles,
`.editorconfig`, pip config, VS Code user settings/keybindings, the hosts file, and a handful
of project-local tool configs. This is not a general file crawler.

For a readable config file up to 256 KiB:

- secret-looking assignment lines are replaced with `<redacted>`;
- known token shapes (GitHub, npm, OpenAI-style `sk-`, AWS, Slack, bearer/basic auth, URL
  credentials, and PEM private keys) are stripped;
- the redacted text is stored as a gzipped blob;
- a hash of the original file is stored;
- files that needed redaction are marked `restorable: false`.

Binary files and files over 256 KiB are hashed but their content is not stored. Missing
files are recorded without reading them. Config paths are limited to the candidate list
above, so SSH private keys, cloud credential directories, browser profiles, cookies, and
keychains are not collected as config files.

Redaction is best effort. A secret in an unusual format, an inline value the patterns do not
recognize, or a secret embedded in a command can survive. Review the store and reports
before sharing them.

## Project scanning

Project collection is scoped to the current project root:

- manifest and lockfile **hashes**, not full contents;
- `package.json` dependency names and scripts (known secret shapes in scripts are redacted);
- environment variable **key names** from `.env*` files and a `PORT`-style value when needed
  for port inference;
- environment variable references and line numbers from source files, not source text;
- likely local ports, Compose service definitions, and config-file hashes.

It skips `node_modules`, `.git`, `dist`, `build`, and other vendor/output directories. It
does not read personal document folders or browser profile data.

## Command output and command lines

`watch` stores the command, its arguments, exit code, timestamps, and bounded tails of
stdout/stderr. Output can contain paths, usernames, internal hostnames, or secrets printed by
the command. Known token shapes are stripped by report redaction. If you do not want output
retained, use the default bounded capture and avoid `--capture-output`; closing a case does
not delete the underlying run. Commands that print secrets should not be run under
`watch` unless you accept that risk.

Startup entries, service paths, scheduled-task commands, package names, and process paths
are stored because they are part of the machine state. Commands can contain inline
credentials. Reports redact recognized secret shapes and paths; the store itself is not
encrypted.

## Network and third parties

- No telemetry endpoint, crash reporter, update check, analytics SDK, CDN, remote font, or
  remote image.
- No LLM or network-based inference.
- No package publishing or account login.
- `npm install` / `npm run build` during development use npm's normal network access; that is
  build setup, not Envidence telemetry.
- `evd open`/`--open` launches the local default browser or file handler. The report and
  dashboard are served from loopback only.
- `evd rollback --apply` may run package managers. Their downloads and lifecycle scripts are
  outside Envidence's control.

## Retention and deletion

`config.json` defaults to keeping 50 snapshots and snapshots younger than 30 days. Pinned
snapshots, baselines, snapshots referenced by runs/cases, and safety snapshots are protected
from pruning. `evd prune` is a dry run unless explicitly confirmed.

To delete the entire local evidence store:

```powershell
# Windows, project-local store
Remove-Item -Recurse -Force ./.envidence

# Production default
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\Envidence"
```

```sh
# POSIX
rm -rf ./.envidence
rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/envidence"
```

Generated reports are ordinary files; delete them separately. Deleting the store is
irreversible and removes the evidence needed for `why`, `case show`, and rollback.

## Sharing a report

Use `standard` (default) or `strict`:

```powershell
.\bin\evd.cmd report --case CASE-... --out case.html --redact strict
```

`none` is for local viewing. It keeps paths, host/user names, project identifiers, and
non-secret values. Even at `none`, secret-marked values and recognized token shapes are
redacted, but that is not a guarantee that the report contains no sensitive information.
Read [Security](SECURITY.md) before sharing a report outside your machine.
