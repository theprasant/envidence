# Limitations

Envidence is useful because it is narrow. These are the known limits you should understand before relying on it.

## Platform coverage

- **Windows first.** The full collector set targets Windows 10 and 11 with PowerShell. Service, startup, scheduled-task, hotfix, WSL, and machine-scope rollback support are limited or unavailable on macOS and Linux.
- **POSIX is a fallback.** Basic host, environment, PATH, package, network, and project collectors exist so the CLI works outside Windows, but the coverage is smaller.
- **WSL and containers are partly opaque.** WSL distributions are listed, but packages and services inside a distribution, VM, or container are not captured as host state. A failure inside WSL may have no matching machine-layer finding.
- **Remote machines are out of scope.** Envidence snapshots the machine it runs on. It does not collect SSH hosts, CI runners, or cloud environments.
- **Node 24 is required** because the store uses `node:sqlite`. Older Node versions fail before the CLI starts.

## Collection coverage

- **Fixed candidate lists.** Config collection covers a documented set of files, not every dotfile. A custom tool's config may be invisible unless it is on the list.
- **Bounded project scans.** Project scans default to 200 source files and 512 KiB per file, skip vendor directories, and store references rather than source text. A large monorepo can exceed that bound.
- **Environment scope.** User and machine environment variables are read where the OS exposes them. Changes made only in the current shell process are not persistent user or machine state and may not be visible outside the watched command window.
- **Permissions.** Some service, task, port-owner, and program fields need elevation or produce warnings. A warning means the evidence is incomplete, not that nothing changed.
- **Volatile facts.** Free disk space, listeners, uptime, and clock values change constantly. They are labeled volatile and are usually excluded from ranking and fingerprinting.
- **Snapshot time varies.** A full snapshot can take several seconds. Service-heavy machines and PowerShell-heavy environments are slower. `evd watch` uses the faster profile by default.
- **Package coverage is uneven.** Global package managers have different output and install behavior. Optional winget, choco, and scoop collection is off by default. Version strings are normalized only enough to compare.
- **No binary inspection.** Envidence records names, versions, paths, hashes, and process metadata. It does not scan executables for malware or verify signatures.

## Evidence and causality

- **Correlation is not proof.** A score is a ranked hypothesis built from rule weight, project relevance, recency, stderr signals, and historical correlation. A high score can still be wrong.
- **One observation cannot establish causation.** The dashboard and reports distinguish pre-existing differences from changes observed during a command. Neither label proves that a change caused a failure.
- **The reference can be wrong.** A run uses the last successful run of the same command in the same project, then the active baseline, then the most recent snapshot before the command window. If that reference was recorded under different conditions, the diff can mislead.
- **No machine changes is a real result.** If the evidence does not support a finding, Envidence should say so. It may still miss the cause because collection was incomplete, the cause was in code, or the failure came from outside the machine.
- **Correlation learns slowly.** Historical lift is smoothed and gated by a minimum sample count. On a new store, findings rely more on base rules and project relevance.
- **Code and machine state are separate.** Git already tracks source changes. Envidence captures manifests, lockfile hashes, and project metadata, but it is not a replacement for `git diff` or dependency review.

## Watch and command capture

- **Only the child process window is observed.** `evd watch` snapshots before and after the command it runs. Changes made by a parent shell after the command returns, or by another process outside that window, may be missed or labeled background.
- **Output is bounded.** Stdout and stderr tails are truncated. `--capture-output` keeps more, but not unlimited output, and may retain sensitive text.
- **Long-running commands are your responsibility.** A child process can be stopped with `--timeout`. Signal forwarding is best effort, especially on Windows.
- **No background daemon.** There is no scheduler or automatic snapshot loop. Take a snapshot before risky work or wrap the work in `evd watch`.
- **Fast snapshots are not a full picture.** `evd watch` uses the fast profile by default. Use `--full` when full-only collectors matter to the failure.

## Dashboard

- **Local only.** The server binds to loopback and is not designed for remote access. Do not port-forward it.
- **No dashboard apply button.** The dashboard previews and simulates remediation. Apply from the CLI for the supported flow. The local server also exposes a guarded apply endpoint for API clients.
- **One process, one store.** The dashboard serves the store chosen at startup. It is not a multi-project or multi-user console.
- **The session token is not identity.** Anyone who can read the token or reach the loopback port under your account is effectively authorized.
- **Browser behavior varies.** The UI targets current Edge and Chromium. Very old browsers or unusual security policies may break the single-file bundle.
- **No mobile or hosted mode.** The layout is designed for reviewing a case on a desktop.

## Reports

- **Pattern-based redaction.** Standard and strict redaction are best effort. Unusual secrets, ordinary values, internal hostnames, and paths can remain, especially with `--redact none`.
- **No encryption or signing.** A report is an ordinary HTML file. Anyone who receives it can read the embedded data.
- **One case or run at a time.** There is no multi-case portfolio report.
- **No external assets.** That keeps reports offline, but it also means no remote images or shared fonts.
- **Size can grow.** Reports over 3 MiB warn. Large command output or many changes can still make a large file.

## Rollback

- **Typed actions only.** Supported actions cover environment values, PATH, selected global package managers, VS Code extensions, config restore, service state, startup entries, and scheduled-task enable or disable. Arbitrary installers, registry changes, Windows updates, WSL internals, and unknown tools become manual steps.
- **Preconditions can drift.** If state changed after planning, apply refuses rather than guessing. That is safer, but you may need to plan again.
- **Config restore is limited by redaction.** If a config contained a secret and was stored redacted, Envidence will not write a placeholder over the real file. It emits a manual step instead.
- **Admin actions need an elevated shell.** Envidence does not elevate automatically.
- **Package scripts execute third-party code.** Installing or uninstalling a package can run lifecycle scripts and use the network.
- **Undo is not time travel.** It reverses the actions Envidence recorded. Changes made by other processes or by hand after the rollback are not reversed.
- **Real apply is not validated on a real machine.** Real apply and undo change the system. Test on a disposable machine before relying on rollback for important state.
- **Safety snapshots consume space.** They are pinned and retain evidence needed for recovery. Pruning respects pins and references.

## Security and privacy

- **No encryption at rest.** The SQLite database, blobs, and config are readable by a same-user process or an administrator.
- **Heuristic secret detection.** Secret-like variable names are hashed. Unrecognized secrets can remain in the store, command output, or a report generated with `--redact none`.
- **No remote authentication.** There is no account, role, or multi-user permission model.
- **No signed audit trail.** Rollback records are stored locally but are not tamper-evident.
- **No sandbox.** Watched commands run with your privileges.

## Product scope

- **No cloud sync, team sharing, or hosted dashboard.**
- **No automatic remediation.** Plans and scripts are generated. Applying them is a human decision.
- **No editor plugin requirement.** The CLI and local dashboard are the complete interface.
