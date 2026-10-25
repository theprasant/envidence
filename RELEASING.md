# Releasing Envidence

The npm package is `envidence`. Version `1.0.0` is the first public release.

## Preconditions

- Node.js 24+
- npm authenticated as the package owner: `npm whoami`
- The version in `package.json` and `package-lock.json` is the version being published
- The package name is still available, or the publisher owns/controls it

## Release checks

From the repository root:

```powershell
npm ci
npm run release:check
npm run build
npm pack --dry-run
npm publish --dry-run
```

`release:check` runs typecheck and the test suite. `prepack` builds the CLI and dashboard
automatically, but running `npm run build` explicitly catches build failures before the
publish step.

## Inspect and test the tarball

Package the release into a temporary directory, install it into a fresh local project, and
exercise the installed binaries:

```powershell
$packDir = Join-Path $env:TEMP "envidence-release"
New-Item -ItemType Directory -Path $packDir -Force | Out-Null
npm pack --pack-destination $packDir

$consumer = Join-Path $env:TEMP "envidence-consumer"
New-Item -ItemType Directory -Path $consumer -Force | Out-Null
Set-Location $consumer
npm init -y
npm install (Join-Path $packDir "envidence-1.0.0.tgz") --no-audit --no-fund
.\node_modules\.bin\envidence.cmd --version
.\node_modules\.bin\evd.cmd --help
```

Then verify the demo, report, and dashboard:

```powershell
$env:ENVIDENCE_HOME = "./.envidence"
.\node_modules\.bin\evd.cmd demo --reset
.\node_modules\.bin\evd.cmd demo --report --out .envidence/demo-report.html
.\node_modules\.bin\evd.cmd ui --demo --no-open
```

The dashboard must serve `http://127.0.0.1:<port>/`, require the session token for API
requests, and report version `1.0.0`.

## Publish

After authentication and final review:

```powershell
cd C:\myproject\project001
npm publish
```

`publishConfig.access` is `public`, and the package is unscoped. If npm asks for a one-time
password, provide the current authenticator code. Do not publish from a dirty or untested
tree.

## Verify the registry

```powershell
npm view envidence version
npm view envidence dist-tags
npx envidence@1.0.0 --version
```

Version `1.0.0` is immutable after publication. If a change is needed, publish a new
patch version rather than attempting to overwrite it.

## After publish

- Tag the source release `v1.0.0` once the canonical Git repository is available.
- Add `repository` and `bugs.url` metadata after the public repository URL exists. This
  checkout currently has no Git remote, so only the email bug link and homepage are set.
- Confirm `README.md` renders correctly on the npm package page and all linked docs are in
  the tarball.
- Keep the rollback limitation visible: automated apply/undo tests use a fake adapter. Do
  not advertise real-machine apply as validated.

## Rollback and safety note

Do not use the release process as a reason to run a real rollback apply on a development
machine. Use `--dry-run`, review the plan, and test on a disposable VM or a machine whose
state you can restore before making stronger validation claims.
