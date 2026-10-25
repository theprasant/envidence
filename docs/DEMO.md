# Deterministic demo

The demo is the fastest way to see the whole Envidence loop: snapshot evidence, attribute a
failure, rank hypotheses, open a case, generate a report, serve the dashboard, and preview a
reversible remediation.

It is **fixture data**. Seeding does not scan your live machine, read your packages, or send
anything anywhere. The demo store is isolated at `<store>/demo`.

> **Store base, not the demo child.** The global `--store` is the base directory; `demo`
> always adds a `demo` child. With `ENVIDENCE_HOME=./.envidence`, the demo store is
> `./.envidence/demo`. Do not pass `--store .envidence/demo` to `demo` itself, or it will
> create `.envidence/demo/demo`. Passing `--store .envidence/demo` to `why`, `report`, `ui`,
> `rollback`, and other read commands is correct because they use the demo store directly.

## Prerequisites

- Node.js 24+
- Either the npm package (`npm install -g envidence`) or a local checkout with
  `npm install` and `npm run build` completed

The commands below use the checkout launcher. If you installed the npm package, replace
`.\bin\evd.cmd` with `evd` (or `npx envidence`) and use any directory you control for
`ENVIDENCE_HOME`.

From a checkout:

```powershell
npm install
npm run build
$env:ENVIDENCE_HOME = "./.envidence"
```

`npm run build` builds both the CLI/server and the single-file dashboard. The npm package
already contains both builds. If UI assets are missing in a checkout, `demo --ui` will fail
with a build hint; `demo` and `demo --report` only need the CLI build.

## Run it

```powershell
.\bin\evd.cmd demo --reset
# Installed package:
evd demo --reset
```

On macOS/Linux use `./bin/evd demo --reset` (or `evd demo --reset`). If you prefer the built
entry point directly from a checkout:

```powershell
node dist/cli.js demo --reset
```

Expected output (ANSI colors removed):

```text
Envidence demo · the machine layer Git ignores
  It worked yesterday. Envidence knows what changed.
  Git protects your code. Envidence protects the machine.

  Demo store C:\myproject\project001\.envidence\demo
  Baseline   Last known good · npm test passed · 12 files, 48 tests
  Failure    npm test failed · RUN-11A00002
  Case       CASE-20261023-7F3A · npm test failed after TypeScript prerelease install

  TOP SUSPECT Global npm package typescript changed 72/100 · high confidence
  typescript: 5.9.2 → 6.0.0-dev.
  npm install -g typescript@5.9.2

What changed since the last successful run
  ~ npm package typescript [packages] · pre-existing
    5.9.2 → 6.0.0-dev
  ↕ User PATH order changed [path] · pre-existing
    moved C:\Users\demo\AppData\Roaming\npm from position 2 to 4
  … 1 volatile/background change hidden.

Ranked hypotheses
   1. TOP SUSPECT · Global npm package typescript changed [high] 72/100
      [packages] typescript: 5.9.2 → 6.0.0-dev.
      before 5.9.2
      after  6.0.0-dev
      Fix    npm install -g typescript@5.9.2
      · npm package typescript: 5.9.2 → 6.0.0-dev
      · Present before the command window.
      · The project or command uses package typescript.
   2. PATH changed [low] 38/100
      [path] User PATH order changed: moved C:\Users\demo\AppData\Roaming\npm from position 2 to 4.
      before 1
      after  3
      Fix    Restore the previous PATH order and remove duplicates.
      · User PATH order changed: moved C:\Users\demo\AppData\Roaming\npm from position 2 to 4
      · Present before the command window.
```

The exact store path and ANSI styling depend on your machine. The case ID, findings, scores,
and ordering are deterministic.

## What the fixture contains

| Item | Value |
|---|---|
| Case | `CASE-20261023-7F3A` |
| Failure | `npm test` exits `1`; TypeScript rejects a number passed where a string is expected |
| Run | `RUN-11A00002` |
| Snapshots | good, before the command, after the command |
| Runs | one successful run and one failed run |
| Baseline | the good snapshot |
| Top finding | **Global npm package typescript changed** — `72/100`, high confidence |
| Second finding | **PATH changed** — `38/100`, low confidence |
| Hidden change | a volatile disk-free-space delta |

The TypeScript change and the PATH reorder are marked **pre-existing**: they were already
present when the command window started, relative to the last successful run. This is the
honesty distinction the case file is designed to show. Envidence does not claim that the
73rd point of evidence proves causation; it shows what changed and why the rule ranked it.

## Explore the case

Use the store explicitly so you do not depend on the current directory:

```powershell
.\bin\evd.cmd why --store ./.envidence/demo

.\bin\evd.cmd case list --store ./.envidence/demo
.\bin\evd.cmd case show CASE-20261023-7F3A --store ./.envidence/demo

.\bin\evd.cmd diff --store ./.envidence/demo
.\bin\evd.cmd log --store ./.envidence/demo

# Read-only remediation preview; nothing is changed.
.\bin\evd.cmd rollback --case CASE-20261023-7F3A --dry-run --store ./.envidence/demo
```

The rollback preview should show the TypeScript restore and the PATH reorder restore as typed
actions, plus any manual notes. The demo never applies them.

## Report

```powershell
.\bin\evd.cmd demo --report --out .envidence/demo-report.html
```

Or generate it without reseeding:

```powershell
.\bin\evd.cmd report --case CASE-20261023-7F3A `
  --store ./.envidence/demo `
  --redact standard `
  --out .envidence/demo-report.html
```

The result is one self-contained HTML file with inline CSS and data, no external requests,
and standard redaction. Open it directly from disk or pass `--open`. Inspect it before
sharing; standard redaction is useful, but it is not a guarantee that the file is safe for a
public issue.

## Dashboard

```powershell
.\bin\evd.cmd demo --ui --no-open
```

`--no-open` prints the URL without launching the browser. The command keeps running until
`Ctrl+C`. The URL looks like:

```text
http://127.0.0.1:4317/#token=...
```

Open it in a local browser. The dashboard provably binds to loopback and requires the token
in the URL fragment. It shows:

- a timeline with the demo snapshot and run;
- the case file with the TypeScript and PATH findings;
- before/after values, evidence, and the case timeline;
- all changes, including the hidden volatile one, with origin labels;
- a remediation preview/simulation (no mutation);
- raw evidence and a downloadable report.

To serve the existing demo store without reseeding:

```powershell
.\bin\evd.cmd ui --store ./.envidence/demo
```

Use `demo --ui` when you want the command to seed and serve in one step. Use `ui --demo` if
you specifically want the UI command's demo-store selection behavior.

Stop the server with `Ctrl+C`. Closing the tab does not stop the Node process.

## Reset and clean up

`--reset` deletes and reseeds only `<store>/demo`, never the parent store:

```powershell
.\bin\evd.cmd demo --reset
```

To remove every demo artifact, including reports you wrote under `.envidence/`:

```powershell
Remove-Item -Recurse -Force ./.envidence/demo
Remove-Item -Force ./.envidence/demo-report.html -ErrorAction SilentlyContinue
```

Removing the whole `.envidence` directory also removes any real evaluation store in that
project; check before doing it.

## Determinism and regression

`demo --reset` rebuilds the same case with the same snapshot/run IDs, changes, findings,
scores, and confidence. Generated timestamps for a report and generated rollback plan IDs
are expected to differ; they are not part of the finding assertions.

The demo is also covered by the test suite (`tests/core.test.ts`, `tests/report.test.ts`,
`tests/ui.test.ts`). If a rule or diff change moves the top finding away from
`72/100 high`, the demo command warns and the tests fail.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Envidence is not built` | Run `npm run build` |
| `ui` fails because assets are missing | Run `npm run build:ui` or `npm run build` |
| Port 4317 is in use | The server falls back to a free port; read the printed URL |
| Browser shows a token error | Use the full printed URL; the fragment token is per server run |
| Report cannot be found | Use the printed absolute path; `--out` is resolved from the current directory |
| Dashboard still shows old CSS | Rebuild with `npm run build` and restart the server |
| Demo output is not deterministic | Use `--reset`; existing stores are reused without one |
