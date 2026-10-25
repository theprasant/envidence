# Security

Envidence is a local developer tool that reads machine state and can, with explicit
confirmation, change selected parts of that state. This page describes the threat model and
the controls in the current build. It is not a claim that the tool is hardened for hostile
multi-user hosts.

## Security goals

1. **No silent exfiltration.** Evidence remains in a local store and local report files.
2. **No silent mutation.** Collection is read-only. Rollback defaults to a dry run; real
   apply requires confirmation and a pinned safety snapshot.
3. **No accidental dashboard exposure.** The server binds to loopback, requires a per-session
   bearer token, and rejects cross-origin browser writes.
4. **No obvious secret leakage into reports.** Secret-marked values and recognized token
   shapes are redacted; stronger levels remove paths and identifiers.
5. **Honest evidence.** The tool reports correlation, not proof, and distinguishes
   pre-existing from observed-during changes.

## Threat model

### In scope

- A developer accidentally exposing the dashboard on a shared or untrusted network.
- A malicious web page in the same browser trying to reach the local dashboard through
  DNS rebinding, CSRF, or a guessed URL.
- A report being attached to a public issue with secrets or machine identifiers in it.
- A rollback being applied to a machine state that no longer matches the plan.
- A test or demo accidentally mutating the real environment.
- Path traversal or malformed requests against the local HTTP server.

### Out of scope

- A hostile process running as the same Windows user, or an administrator, reading the
  store, token, terminal, or environment.
- Malware, compromised dependencies, or malicious package lifecycle scripts.
- Physical access or full-disk encryption.
- Guarantees about commands that `evd watch` or `rollback --apply` deliberately runs.
- Multi-user isolation. The store is not encrypted or ACL-hardened beyond normal user
  profile permissions.

The store is sensitive. It contains machine history, paths, usernames, command output, and
possibly non-obvious secrets. Treat it like a local log archive, not public data.

## Dashboard controls

`evd ui` starts a Node HTTP server on `127.0.0.1` only. It does not accept a configurable
public interface.

| Control | Implementation |
|---|---|
| Binding | `server.listen(port, "127.0.0.1")` |
| Session token | 24 random bytes (48 hex characters) per server process |
| Token delivery | URL fragment (`#token=...`), read once into `sessionStorage`, then removed from the visible hash |
| API authentication | `X-Envidence-Token` header; missing or wrong token returns `401` |
| Token comparison | Length check plus `timingSafeEqual` |
| Host allowlist | `127.0.0.1:<port>` and `localhost:<port>`; otherwise `421` |
| POST origin | Requires `Origin` matching the loopback origin; otherwise `403` |
| Static file serving | Resolved paths must stay inside the built UI directory; malformed or NUL paths are rejected |
| Directory listing | Not served |
| Security headers | CSP, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` |
| CSP | `default-src 'self'`; no remote scripts, fonts, images, or connections |
| UI rendering | React escapes text; raw evidence is rendered as text, not HTML |
| Browser storage | Only the session token in `sessionStorage`; no cookies |

The token is not a password and is not encryption. Any process that can read the browser's
session storage or the terminal output can use it. The token is regenerated each time the
server starts.

### Rollback API

The server exposes `POST /api/rollback/apply` for API clients. It is deliberately strict:

- token required;
- same-origin `Origin` required;
- a plan must have been created by `POST /api/rollback/plan` in the **same server session**;
- the cached plan is single-use;
- the request body must contain `{"confirmation":"rollback"}`;
- preconditions are checked again immediately before mutation;
- a full safety snapshot is taken and pinned when safety snapshots are enabled;
- conflicts cause a `409` with **no actions applied**;
- an audit record is stored.

The React dashboard does **not** call the apply endpoint. It previews and simulates plans.
Real apply is intentionally a CLI action (`evd rollback --apply`) so the person sees the
plan, the confirmation prompt, and the safety snapshot in one place. If you build another
local client, keep the confirmation gate and do not automate it.

## Rollback controls

- `evd rollback` is dry-run by default; it prints the plan and optional script.
- `evd rollback --apply` prints the plan, asks for the literal word `rollback` (unless
  `--yes` is supplied), and then takes a full snapshot with trigger `pre_rollback`.
- Preconditions compare the current environment to the plan. A mismatch aborts before any
  action.
- All mutation goes through `EnvironmentAdapter`; tests use `FakeEnvironmentAdapter` and
  temporary files.
- `--yes` is an explicit non-interactive opt-in. It is not implied by `--apply`.
- Machine-scope services, environment variables, and tasks may require an elevated shell.
  Envidence does not auto-elevate or trigger a surprise UAC prompt.
- `evd undo` requires the literal word `undo` (or `--yes`), takes a safety snapshot, and
  only inverts an applied, not-yet-undone rollback.
- Package-manager actions (`npm install -g`, `pip install`, `cargo install`, VS Code
  extension install) execute third-party code and may use the network. Review the plan first.

The test suite never applies a real rollback. It uses a fake adapter and a sandboxed temp
config, and the deterministic demo is fixture data.

## Report controls

- The report is one HTML file with inline CSS, JavaScript, data, and no remote references.
- Standard redaction replaces home/project paths, host/user names, and public-looking IPs,
  and strips recognized token shapes.
- Strict redaction additionally replaces project identifiers, branch/commit, service names,
  Windows/POSIX paths, and long hex commit hashes.
- Secret-marked values become `<redacted>` even at `--redact none`.
- Reports over 3 MiB produce a warning.
- The report footer and a visible banner at `none` tell the reader when the file is
  unredacted.

Redaction is pattern-based and best effort. It cannot identify every possible secret, and
`none` deliberately retains paths and ordinary values. Review the HTML before sharing it.

## Collector controls and data boundaries

- Collectors use read-only queries only.
- Config collection is limited to a fixed candidate list. Sensitive directories such as
  `.ssh`, `.gnupg`, `.aws`, `.azure`, `.kube`, Docker credentials, browser cookie stores,
  and keychains are not collector candidates.
- A secret-looking config line is replaced and the file is marked non-restorable; Envidence
  will not write a placeholder back over your real config.
- Project scanning is bounded by `project.maxFiles` and `project.maxBytes`, follows no
  symlinks, and ignores vendor/output directories.
- Environment values with secret-looking names are hashed with a per-store salt; a short
  masked preview is retained.
- Collector warnings and errors are surfaced rather than swallowed. They can contain paths
  or command stderr, so treat them as local evidence.

See [Privacy](PRIVACY.md) for the data inventory and deletion instructions.

## Residual risks and operator guidance

1. **Same-user access.** Run Envidence under your normal account and protect the store with
   normal OS permissions. Full-disk encryption is strongly recommended.
2. **Terminal and browser exposure.** The dashboard URL and token may appear in terminal
   scrollback. Close the server when finished and avoid screen sharing with the token or
   sensitive case open.
3. **DNS rebinding / local web attacks.** Loopback binding, Host checks, Origin checks, and a
   high-entropy header token reduce this risk, but a compromised browser extension or a
   same-user process remains able to reach the server. Do not port-forward it.
4. **Report sharing.** Even strict reports can contain unique machine details. Inspect the
   file, or generate a report with `--redact strict` before attaching it to a public issue.
5. **Third-party commands.** `watch` runs exactly the command you give it. `rollback --apply`
   may run package managers. Envidence cannot sandbox those commands.
6. **Windows administration.** Some collectors and rollback actions are incomplete without
   elevation. Do not run the whole tool elevated just to collect more; prefer running only
   the specific action that needs it.
7. **Unusual secrets.** Heuristics miss bespoke token formats, secrets in command arguments,
   and secrets in variables with non-secret-looking names. Use a secret manager.

## Security-relevant limitations

- No encryption at rest for the SQLite database or blobs.
- No signed reports or tamper-evident audit chain.
- No OS keychain integration for the session token.
- No remote authentication, TLS, or multi-user access control.
- No guarantee that a report or snapshot is safe to publish.
- No antivirus or binary inspection of collected executables.
- No sandbox around watched commands.

If you discover a security issue, do not attach a store or unredacted report to a public
issue. Reproduce it with the deterministic demo or synthetic fixtures and share the smallest
safe description with the maintainer.
