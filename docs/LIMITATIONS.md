# Limitations

Envidence is useful because it is narrow and honest. These are the known edges of the
current v1.0.0 build; they are not a promise of a future release.

## Platform coverage

- **Windows-first.** The full collector set targets Windows 10/11 with PowerShell. Service,
  startup, scheduled-task, hotfix, WSL, and machine-scope rollback support are limited or
  unavailable on macOS/Linux.
- **POSIX is a fallback.** Basic host, environment, PATH, package, network, and project
  collectors exist so the CLI does not crash elsewhere, but parity is post-v1.
- **WSL and containers are partly opaque.** WSL distributions are listed, but packages and
  services inside a distro, VM, or container are not captured as if they were host state.
  A command that fails inside WSL may have no corresponding machine-layer finding.
- **Remote machines are out of scope.** Envidence snapshots the machine it runs on. It does
  not collect SSH hosts, CI runners, or cloud environments.
- **Node 24 is required** because persistence uses `node:sqlite`. Older Node versions fail
  before the CLI starts.

## Collection coverage

- **Fixed candidate lists.** Config collection covers a documented set of files, not every
  dotfile. A custom tool's config may be invisible unless it appears on the list.
- **Bounded project scans.** Project scans default to 200 source files and 512 KiB per
  file, skip vendor directories, and store references rather than source text. A large
  monorepo can exceed that bound.
- **Environment scope.** User and machine environment variables are read where the OS
  exposes them. Changes made only in the current shell process are not persistent user or
  machine state and are not all visible outside `watch`.
- **Permissions.** Some service, task, port-owner, and program fields need elevation or
  produce warnings. A warning means the evidence is incomplete, not that nothing changed.
- **Volatile facts.** Free disk space, listeners, uptime, and clock values change
  constantly. They are labeled volatile and are usually excluded from ranking and
  fingerprinting.
- **Snapshot latency is not uniform.** On the reference Windows 11 machine, a cold
  `init` took 11.7s, a warm full snapshot 7.3s, and a warm fast snapshot 2.6–2.9s
  wall-clock (including Node startup). The plan's fast target was under 2.5s; the current
  build misses it slightly. Service-heavy and PowerShell-heavy machines will be slower.
  Collector warnings are preserved, and `watch` uses the faster profile by default.
- **Windows package coverage is uneven.** Global package managers have different output and
  install semantics. Optional winget/choco/scoop collection is off by default. Version
  strings are normalized only enough to compare; a package manager can report a version in
  a form Envidence does not understand.
- **No binary inspection.** Envidence records names, versions, paths, hashes, and process
  metadata. It does not scan executables for malware or verify signatures.

## Evidence and causality

- **Correlation is not proof.** The score is a ranked hypothesis built from rule weight,
  project relevance, recency, stderr signals, and historical correlation. A high score can
  still be wrong.
- **One observation cannot establish causation.** The UI and reports distinguish
  `pre-existing` differences from `observed-during` changes. Neither label proves that a
  change caused a failure.
- **The reference can be wrong.** `why` prefers an explicit case reference, then the last
  successful run, then the active baseline, then the previous snapshot. If the last success
  was recorded under different conditions, the diff can be misleading.
- **No machine changes is a real result.** If the evidence does not support a finding,
  Envidence should say so. It may still miss the cause because collection was incomplete,
  the cause was in code, or the failure was external.
- **Correlation learns slowly.** Historical lift is Laplace-smoothed and gated by a minimum
  sample count. On a fresh store, findings lean on base rules and project relevance.
- **Code and machine state are separate.** Git already tracks source changes. Envidence
  captures manifest and lockfile hashes and project metadata, but it is not a replacement
  for `git diff` or a dependency lockfile review.

## Watch and command capture

- **Only the child process window is observed.** `watch` snapshots before and after the
  command it spawns. Changes made by a parent shell after the command returns, or by another
  process outside that window, may be missed or labeled background.
- **Output is bounded.** Stdout/stderr tails are truncated. `--capture-output` keeps more,
  but not unlimited output, and may retain sensitive text.
- **Long-running commands are your responsibility.** The child can be killed with
  `--timeout`; signal forwarding is best effort, especially on Windows.
- **No daemon or scheduler.** There is no background snapshot loop in the shipped core.
  Take a snapshot before risky work or wrap the work in `watch`.
- **Fast profile is not a full picture.** `watch` uses fast snapshots by default. Use
  `--full` when full-only collectors are relevant to the failure.

## Dashboard

- **Local only.** The server binds to loopback and is not designed for remote access. Do not
  port-forward it.
- **Dashboard apply is intentionally absent.** The UI previews and simulates remediation.
  Real machine mutation is a CLI operation. The server has a guarded apply API for
  programmatic clients, but the dashboard does not invoke it.
- **One process, one store.** The dashboard serves the store chosen at startup. It is not a
  multi-project or multi-user console.
- **The session token is not identity.** Anyone who can read it or reach the loopback port
  under your account is effectively authorized.
- **Browser behavior varies.** The UI is tested in current Edge/Chromium. Very old browsers
  or unusual security policies may break the single-file bundle.
- **No mobile or hosted mode.** The layout is designed for a desktop case-review workflow.

## Reports

- **Pattern-based redaction.** Standard and strict redaction are best effort. Unusual
  secrets, ordinary values, internal hostnames, and paths can remain, especially at
  `--redact none`.
- **No encryption or signing.** A report is an ordinary HTML file. Anyone who receives it
  can read the embedded JSON.
- **One case or run at a time.** There is no multi-case portfolio report.
- **No external assets.** That is deliberate for offline use, but it also means no remote
  images or shared fonts.
- **Size can grow with evidence.** Reports over 3 MiB warn. Huge command output or many
  changes can still make a large file.

## Rollback

- **Typed actions only.** Supported actions cover environment values, PATH, selected global
  package managers, VS Code extensions, config restore, service state, startup entries, and
  scheduled-task enable/disable. Arbitrary installers, registry surgery, Windows updates,
  WSL internals, and unknown tools become manual steps.
- **Preconditions can drift.** If state changed after planning, apply refuses rather than
  guessing. That is safer, but it means you may need to replan.
- **Config restore is limited by redaction.** If a config contained a secret and was stored
  redacted, Envidence will not restore a placeholder over the real file. It emits a manual
  step instead.
- **Admin actions need an elevated shell.** Envidence does not auto-elevate.
- **Package scripts execute third-party code.** Installing or uninstalling a package can run
  lifecycle scripts and use the network.
- **Undo is not time travel.** It inverts the actions Envidence recorded. Changes made by
  other processes or by hand after the rollback are not reversed.
- **No real-machine apply in tests.** The suite uses a fake adapter and a sandboxed config.
  That proves the control flow, not every OS-specific edge case.
- **Safety snapshots consume space.** They are pinned and retain evidence needed for
  recovery. Pruning respects pins and references.

## Security and privacy

- **No encryption at rest.** The SQLite database, blobs, and config are readable by a
  same-user process or an administrator.
- **Heuristic secret detection.** Secret-like variable names are hashed; unrecognized
  secrets can remain in the store, command output, or a `none` report.
- **No remote authentication.** There is no account, role, or multi-user permission model.
- **No signed audit trail.** Rollback records are stored locally but are not tamper-evident.
- **No sandbox.** Watched commands run with your privileges.

## Product scope

- **No OpenCode plugin or agent integration.** The full product works without one.
- **No cloud sync, team sharing, or hosted dashboard.**
- **No automatic remediation.** Plans and scripts are generated; applying them is a human
  decision.
- **No `evd prove` command.** The plan mentioned it as optional; the current build focuses on
  ranked evidence and reversible plans instead.
- **CI is Windows-only.** The included GitHub Actions workflow runs
  `npm ci`, typecheck, tests, build, and a package dry-run on `windows-latest`. The POSIX
  fallback does not yet have a separate hosted test lane.

## Demo-specific limits

The demo is a deterministic fixture, not a recording of a real machine. It reads no live
system state during seeding and makes no network calls. The TypeScript `72/100 high` and
PATH `38/100 low` findings are a regression test for the ranking and case pipeline, not a
statement about any installed package on your machine.
