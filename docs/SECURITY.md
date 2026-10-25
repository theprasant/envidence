# Security

Envidence reads machine state and can, with explicit confirmation, change selected parts of that state. This page describes the security model and the controls you should understand before using it on a work machine.

Envidence is not hardened for hostile multi-user hosts. It runs with your user privileges and treats the local store as sensitive data.

## Security goals

1. **No silent exfiltration.** Evidence stays in a local store and in local report files.
2. **No silent mutation.** Collection is read-only. Rollback defaults to a dry run. Real apply requires confirmation and a safety snapshot.
3. **No accidental dashboard exposure.** The server binds to loopback, requires a per-session token, and rejects cross-origin browser writes.
4. **No obvious secret leakage into reports.** Secret-marked values and recognized token shapes are redacted. Stronger levels remove paths and identifiers.
5. **Honest evidence.** Findings are correlations, not proof. The tool separates changes seen during a command from changes that were already present.

## Threat model

### In scope

- A developer accidentally exposing the dashboard on a shared or untrusted network.
- A malicious web page trying to reach the local dashboard through DNS rebinding, CSRF, or a guessed URL.
- A report being attached to a public issue with secrets or machine identifiers in it.
- A rollback being applied to a machine state that no longer matches the plan.
- Path traversal or malformed requests against the local HTTP server.

### Out of scope

- A hostile process running as the same user, or an administrator, reading the store, token, terminal, or environment.
- Malware, compromised dependencies, or malicious package lifecycle scripts.
- Physical access or full-disk encryption.
- Guarantees about commands that `evd watch` or `evd rollback --apply` deliberately run.
- Multi-user isolation. The store is not encrypted or ACL-hardened beyond normal user profile permissions.

The store is sensitive. It contains machine history, paths, usernames, command output, and possibly unrecognized secrets. Treat it like a local log archive, not public data.

## Dashboard controls

`evd ui` starts a Node HTTP server on `127.0.0.1` only. It does not accept a configurable public interface.

| Control | Implementation |
|---|---|
| Binding | Listens on `127.0.0.1` |
| Session token | 24 random bytes, shown as 48 hex characters, generated for each server process |
| Token delivery | URL fragment (`#token=...`), read once into `sessionStorage`, then removed from the visible hash |
| API authentication | `X-Envidence-Token` header. A missing or wrong token returns `401` |
| Token comparison | Length check plus `timingSafeEqual` |
| Host allowlist | `127.0.0.1:<port>` and `localhost:<port>`. Other hosts receive `421` |
| POST origin | Requires an `Origin` header that matches the loopback origin. Otherwise `403` |
| Static files | Resolved paths must stay inside the built UI directory. Malformed or NUL paths are rejected |
| Directory listing | Not served |
| Security headers | CSP, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer` |
| CSP | `default-src 'self'`. No remote scripts, fonts, images, or connections |
| UI rendering | React escapes text. Raw evidence is rendered as text, not HTML |
| Browser storage | Only the session token in `sessionStorage`. No cookies |

The token is not a password and is not encryption. Any process that can read the browser session storage or the terminal output can use it. The token is regenerated each time the server starts.

### Dashboard rollback endpoint

The local server exposes a guarded apply endpoint for API clients. It requires the session token, a same-origin request, a plan created in the same server session, a single-use plan, and the literal confirmation `rollback`. It checks preconditions again immediately before mutation and takes a safety snapshot first.

The dashboard itself only previews and simulates plans and has no apply button. Apply from the CLI for the supported flow so that the plan, confirmation prompt, and safety snapshot stay in one place. If you build another local client, keep the confirmation gate and do not automate it.

## Rollback controls

- `evd rollback` is a dry run by default. It prints the plan and can write a script.
- `evd rollback --apply` prints the plan, asks for the literal word `rollback`, and then takes a full safety snapshot.
- `--yes` skips the interactive prompt. It is an explicit non-interactive opt-in and is not implied by `--apply`.
- Preconditions compare the current environment with the plan. A mismatch aborts before any action is applied.
- Machine-scope services, environment variables, and tasks may need an elevated shell. Envidence does not auto-elevate or trigger a surprise UAC prompt.
- `evd undo` asks for the literal word `undo` unless you pass `--yes`. It takes a safety snapshot and only reverses an applied rollback that has not already been undone.
- Package-manager actions such as `npm install -g`, `pip install`, `cargo install`, and VS Code extension installs execute third-party code and may use the network. Review the plan first.

Real rollback apply and undo change the machine. They have not been validated on a real machine for this release. Use a dry run and test on a disposable machine before relying on a rollback for important state.

## Report controls

- A report is one HTML file with inline CSS, JavaScript, data, and no remote references.
- Standard redaction replaces home and project paths, host and user names, and public-looking IPs, and strips recognized token shapes.
- Strict redaction also replaces project identifiers, branch and commit details, service names, Windows and POSIX paths, and long hex commit hashes.
- Secret-marked values become `<redacted>` even with `--redact none`.
- Reports over 3 MiB produce a warning.
- The report footer and a visible banner at `none` tell the reader when the file is unredacted.

Redaction is pattern-based and best effort. It cannot identify every possible secret, and `none` deliberately retains paths and ordinary values. Review the HTML before sharing it.

## Collector boundaries

- Collectors use read-only queries only.
- Config collection is limited to a fixed candidate list. Sensitive directories such as `.ssh`, `.gnupg`, `.aws`, `.azure`, `.kube`, Docker credentials, browser cookie stores, and keychains are not collector candidates.
- A secret-looking config line is replaced and the file is marked non-restorable. Envidence will not write a placeholder over your real config.
- Project scanning is bounded by `project.maxFiles` and `project.maxBytes`, does not follow symlinks, and ignores vendor and output directories.
- Environment values with secret-looking names are hashed with a per-store salt. A short masked preview is retained.
- Collector warnings and errors are surfaced rather than swallowed. They can contain paths or command stderr, so treat them as local evidence.

See [Privacy](PRIVACY.md) for the data inventory and deletion instructions.

## Residual risks

1. **Same-user access.** Run Envidence under your normal account and protect the store with normal OS permissions. Full-disk encryption is strongly recommended.
2. **Terminal and browser exposure.** The dashboard URL and token may appear in terminal scrollback. Close the server when finished and avoid screen sharing with the token or a sensitive case open.
3. **Local web attacks.** Loopback binding, Host checks, Origin checks, and a high-entropy header token reduce risk, but a compromised browser extension or a same-user process can still reach the server. Do not port-forward it.
4. **Report sharing.** Even strict reports can contain unique machine details. Inspect the file, or generate a report with `--redact strict` before attaching it to a public issue.
5. **Third-party commands.** `evd watch` runs exactly the command you give it. `evd rollback --apply` may run package managers. Envidence cannot sandbox those commands.
6. **Windows administration.** Some collectors and rollback actions are incomplete without elevation. Do not run the whole tool elevated just to collect more. Prefer running only the specific action that needs it.
7. **Unusual secrets.** Heuristics miss bespoke token formats, secrets in command arguments, and secrets in variables with ordinary names. Use a secret manager.

## Security limitations

- No encryption at rest for the SQLite database or blobs.
- No signed reports or tamper-evident audit chain.
- No OS keychain integration for the session token.
- No remote authentication, TLS, or multi-user access control.
- No guarantee that a report or snapshot is safe to publish.
- No antivirus or binary inspection of collected executables.
- No sandbox around watched commands.

## Reporting a security issue

Do not attach a store or unredacted report to a public issue. Share the smallest safe description with the maintainer, preferably with a synthetic reproduction. You can reach the maintainer through the contact listed in the package metadata.
