# Demo

The demo shows a complete Envidence case without reading your machine. It seeds a small fixture store with three snapshots, two runs, a baseline, and one failure.

Use it when you want to see the case view, report, dashboard, and rollback preview before recording real evidence.

## Requirements

- Node.js 24 or newer
- Envidence installed with `npm install -g envidence`

## Run the demo

The examples below use `./.envidence` as the base store, so every command points at the same demo files. Omit `--store` to use the default store instead.

```sh
evd demo --reset --store ./.envidence
```

The command prints the case and the strongest findings. The fixture tells this story:

| Item | Value |
|---|---|
| Failure | `npm test` exits with code 1 |
| Case | `CASE-20261023-7F3A` |
| Top finding | Global npm package `typescript` changed, 72/100, high confidence |
| Second finding | PATH order changed, 38/100, low confidence |
| Hidden change | Free disk space changed |

Both findings were present before the command window. The case labels them `pre-existing` so you can see the difference between a change that happened during a command and a change that was already there.

The demo store is written under `<store>/demo`. With the base store above, that is `./.envidence/demo`. With the default store, it is `%LOCALAPPDATA%\Envidence\demo` on Windows. The demo does not scan live system state while seeding.

## Explore the case

```sh
evd why --store ./.envidence/demo
evd case list --store ./.envidence/demo
evd case show CASE-20261023-7F3A --store ./.envidence/demo
```

The `--store` flag here points directly at the demo store. For the `demo` command itself, `--store` is the base directory, and Envidence adds the `demo` child.

Preview the rollback. Nothing is changed:

```sh
evd rollback --case CASE-20261023-7F3A --dry-run --store ./.envidence/demo
```

## Report

Create a self-contained HTML report:

```sh
evd demo --report --store ./.envidence --out ./.envidence/demo-report.html
```

Or use the existing demo store:

```sh
evd report --case CASE-20261023-7F3A \
  --store ./.envidence/demo \
  --redact standard \
  --out ./.envidence/demo-report.html
```

Review the report before sharing it. It contains fixture data, but the same redaction rules apply as with a real case.

## Dashboard

```sh
evd demo --ui --no-open --store ./.envidence
```

The command prints a URL such as `http://127.0.0.1:4317/#token=...` and keeps running until you press `Ctrl+C`. The dashboard is local only and uses a session token for API requests.

To serve the existing demo store without reseeding:

```sh
evd ui --store ./.envidence/demo
```

## Reset

`evd demo --reset --store ./.envidence` deletes and recreates only the demo child directory. It does not remove other snapshots in the parent store.

To remove the demo artifacts completely:

```powershell
Remove-Item -Recurse -Force ./.envidence/demo
Remove-Item -Force ./.envidence/demo-report.html -ErrorAction SilentlyContinue
```

On macOS or Linux, use `rm -rf ./.envidence/demo` and remove the report file separately.
