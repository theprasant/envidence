# Privacy

Envidence keeps evidence on the machine that produced it. There is no account, cloud sync, telemetry, analytics, remote error reporting, or LLM call.

The CLI and dashboard do not contact a remote service. Network activity can only happen in two cases:

- A command you run with `evd watch` uses the network.
- `evd rollback --apply` runs a package manager that downloads a package or extension.

This page describes what Envidence stores, why it stores it, and how to remove it.

## The local store

The store is a directory:

```text
<store>/
  config.json          redaction level, collector switches, retention, salt
  db.sqlite            snapshots, runs, cases, baselines, rollbacks, events
  objects/             gzip-compressed, content-addressed snapshot and config blobs
  logs/                local operational logs
```

The default location is:

- Windows: `%LOCALAPPDATA%\Envidence`
- macOS and Linux: `$XDG_DATA_HOME/envidence` or `~/.local/share/envidence`

To keep evidence inside a project, set `ENVIDENCE_HOME=./.envidence` or pass `--store <path>` to a command. Both options change the base directory used by that command.

A report created with `evd report` is a separate HTML file written wherever you choose. Reports are self-contained: styles, scripts, data, and images are inline. There are no external fonts, scripts, images, or tracking pixels.

## What a snapshot contains

A full snapshot can contain:

| Data | Examples | Notes |
|---|---|---|
| Host identity | Hostname, username, OS, build, architecture, timezone, uptime, clock | Needed to make evidence meaningful |
| Environment | User, machine, and effective variable names and values | Secret-like names are hashed |
| PATH | User, machine, and effective entries, order, duplicates, missing directories | Order is evidence |
| Tools and runtimes | Node, npm, Python, pip, Rust, .NET, Go, Java, PowerShell, Git | Versions and resolved paths |
| Global packages | npm, pip, cargo, dotnet, VS Code; optional winget, choco, and scoop | Names and versions |
| Services, startup, tasks | Names, state, start mode, executable paths, commands | Windows full profile; admin access may be needed for some fields |
| Network and ports | Listeners, owning process and path, DNS, proxy settings, hosts entries | Bounded and normalized |
| Config files | Selected Git, npm, Cargo, shell, editor, and tool files | Content is redacted and hashed |
| Shell | Shell type, profile paths and hashes, execution policy | Does not store full profile content for arbitrary shells |
| Disks, time, WSL | Capacity, free space, clock, distribution names and state | Volatile facts are labeled |
| Project metadata | Manifests, lockfile hashes, scripts, dependency names, environment key names, references, likely ports, Compose services, Git branch and commit details | Bounded; source text is not stored |

Collectors use read-only queries. Full-only collectors can be disabled in `config.json`. A collector failure becomes a warning; it does not crash the snapshot.

## Environment values and secrets

Envidence stores environment variable names and, for ordinary variables, their values. Values whose names look secret-like are handled differently:

- The raw value is not stored.
- A salted SHA-256 hash is stored so changes can still be detected.
- A short masked preview is stored for recognition. Values longer than four characters show the first two and last two characters. Values of four characters or fewer show `****`.
- The salt is generated per store in `config.json`. It is not a secret from a local process that can read the store, and low-entropy values can be guessed from hashes. Treat the store as sensitive even when obvious tokens are hashed.

The name check is heuristic. It catches names containing forms such as `TOKEN`, `SECRET`, `PASSWORD`, `API_KEY`, `AUTH`, `CREDENTIAL`, `PRIVATE_KEY`, `SESSION`, and `COOKIE`. A secret stored in a variable with an ordinary name, such as `FOO=ghp_...`, is not automatically hashed because of the name. Known token shapes and URL credentials are stripped from reports, but the original snapshot value may remain in the store.

Use a secret manager, not environment variables, for high-value secrets. `evd why`, `evd diff`, and the dashboard can display masked previews and before and after values. Reports replace secret-marked values with `<redacted>`.

## Config files

Only a fixed candidate set is read: Git config, `.npmrc`, Cargo config, shell profiles, `.editorconfig`, pip config, VS Code user settings and keybindings, the hosts file, and a handful of project-local tool configs. Envidence is not a general file crawler.

For a readable config file up to 256 KiB:

- Secret-looking assignment lines are replaced with `<redacted>`.
- Known token shapes such as GitHub, npm, OpenAI-style `sk-`, AWS, Slack, bearer and basic auth, URL credentials, and PEM private keys are stripped.
- The redacted text is stored as a gzipped blob.
- A hash of the original file is stored.
- Files that needed redaction are marked `restorable: false`.

Binary files and files over 256 KiB are hashed but their content is not stored. Missing files are recorded without reading them. Config paths are limited to the candidate list, so SSH private keys, cloud credential directories, browser profiles, cookies, and keychains are not collected as config files.

Redaction is best effort. A secret in an unusual format, an inline value the patterns do not recognize, or a secret embedded in a command can remain. Review the store and reports before sharing them.

## Project scanning

Project collection is scoped to the current project root. It stores:

- Manifest and lockfile hashes, not full contents.
- `package.json` dependency names and scripts, with known secret shapes in scripts redacted.
- Environment variable key names from `.env*` files, plus a `PORT`-style value when needed for port inference.
- Environment variable references and line numbers from source files, not source text.
- Likely local ports, Compose service definitions, and config-file hashes.

The scan skips `node_modules`, `.git`, `dist`, `build`, and other dependency or output directories. It does not read personal document folders or browser profile data.

## Command output

`evd watch` stores the command, its arguments, exit code, timestamps, and bounded tails of stdout and stderr. Output can contain paths, usernames, internal hostnames, or secrets printed by the command. Known token shapes are removed by report redaction. If you do not want output retained, use the default bounded capture and do not pass `--capture-output`.

Closing a case does not delete the underlying run. Commands that print secrets should not be run under `evd watch` unless you accept that risk.

Startup entries, service paths, scheduled-task commands, package names, and process paths are stored because they are part of the machine state. Commands can contain inline credentials. Reports redact recognized secret shapes and paths; the store itself is not encrypted.

## Network and third parties

- No telemetry endpoint, crash reporter, update check, analytics SDK, CDN, remote font, or remote image.
- No LLM or network-based inference.
- No package publishing or account login from the CLI.
- `evd report --open` and `evd ui` open a local browser page. The report and dashboard are served from your machine.
- `evd rollback --apply` may run package managers. Their downloads and lifecycle scripts are outside Envidence's control.

## Retention and deletion

`config.json` defaults to keeping 50 snapshots and snapshots younger than 30 days. Pinned snapshots, baselines, snapshots referenced by runs or cases, and safety snapshots are protected from pruning.

```sh
evd prune
evd prune --keep 30 --days 14 --yes
```

`evd prune` is a dry run unless you pass `--yes`.

To delete the entire local evidence store:

```powershell
# Windows, project-local store
Remove-Item -Recurse -Force ./.envidence

# Default store
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\Envidence"
```

```sh
# macOS and Linux
rm -rf ./.envidence
rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/envidence"
```

Generated reports are ordinary files. Delete them separately. Deleting the store is irreversible and removes the evidence needed for `evd why`, `evd case show`, and rollback.

## Sharing a report

Use `standard` or `strict` redaction:

```sh
evd report --case CASE-... --out case.html --redact strict
```

`none` is for local viewing. It keeps paths, host and user names, project identifiers, and non-secret values. Even with `none`, secret-marked values and recognized token shapes are redacted, but that is not a guarantee that the report contains no sensitive information.

Read [Security](SECURITY.md) before sharing a report outside your machine.
