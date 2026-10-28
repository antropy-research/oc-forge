# oc-forge

Patched, jointly pinned releases of OpenCode, OpenChamber, Orca, and VS Code.

The `vendors/` submodules are pinned to official stable release git tags in
`vendors.json` and are **never modified**. Fixes live in `adapters/` and are
applied in memory while the OpenCode build and the OpenChamber web build run.

OpenCode V2 uses npm `@opencode/cli`'s `latest` version and its matching git tag;
GitHub's latest release still tracks V1. OpenChamber, Orca, and VS Code use GitHub's latest
non-draft, non-prerelease desktop release. Current binary builds cover OpenCode;
OpenChamber, Orca, and VS Code are source-pinned for future joint packaging.

## Adapters

| Vendor | Adapter | Change |
|---|---|---|
| OpenCode | `location-ttl` | Location inactivity eviction default 60 minutes → **24 hours**, so long silent tool calls (e.g. waiting on `codex exec`) are no longer interrupted after an hour. Override at runtime with `OPENCODE_LOCATION_TTL`, e.g. `90 minutes` or `7 days`. |
| OpenChamber | `rail` | An extension's service lists **rail entries**: each its own rail icon with its own highlight, opening the extension's panel on that entry (or, with a zone, a panel of its own); they come and go at runtime. |
| OpenChamber | `tabs` | Extensions open **tabs in the header**, after the session tabs; a tab shows the extension's page, kept mounted, and OpenChamber's tab shortcuts cover them. |
| OpenChamber | `core` | The `oc-forge` channel for extension frames: **default zones** (`bottom`) for a panel or rail entry, **key forwarding** of OpenChamber's navigation shortcuts from frames, the `ocForge` manifest block in the catalog, the main layout's host. |
| OpenChamber | `links` | `?extension=<id>&route=<route>` **deep links** to extension pages, and link prefixes for real `<a href>` (Cmd+click opens a browser tab). |

The OpenChamber adapters are a small, versioned extension API with feature
detection: the contract and the client module extensions bundle are in
[`adapters/openchamber/README.md`](adapters/openchamber/README.md). With no
extension using them, OpenChamber looks and behaves as the release.

## Layout

| Folder | Contains |
|---|---|
| `vendors/` | Pristine OpenCode, OpenChamber, Orca, and VS Code release submodules. |
| `adapters/` | Per-vendor changes: `opencode/`, `openchamber/` (`edits/` to upstream files, the new `host/` UI and `server/` modules they call, `vite-plugin.ts`, and `client/`, the module extensions bundle), `orca/`, and `vscode/`. Empty vendor folders are kept with `.gitkeep` until patches are added. |
| `scripts/` | Everything that builds, syncs and verifies: `adapter-plugin.ts` (adapters as a Bun plugin), `build-preload.ts` (injects it into upstream's build), `build.py`, `build-openchamber.py` (OpenChamber's web package with its adapters), `upstream.py`, `verify.py`. |
| `tests/` | Every test we add: `preload.ts` (loads the same plugin into `bun test`) and `*.test.ts`; `e2e/openchamber-adapters/` runs the OpenChamber adapters against the release in a browser, with a scratch extension. |
| `extensions/` | OpenChamber extensions, installed on the latest OpenChamber release: `planner/` (Sunsama-style planning with Linear, GitHub, Google Calendar, Google Tasks, Gmail and agents) and `vscode/` (the compiled workbench of your own VS Code Server, rendered in OpenChamber's panel and page). Both are checked by `mise run test:extensions` in CI. |
| `containers/` | `openchamber-dev/`: OpenChamber, OpenCode, VS Code Server and the GitHub CLI for developing the extensions. |

How it works:

- `scripts/build-preload.ts` is preloaded into upstream's unmodified
  `packages/cli/script/build.ts`. It wraps `Bun.build` and adds one plugin that
  rewrites the matched upstream source in memory.
- Each adapter targets exact upstream code and **fails the build** if that code
  is missing or ambiguous, so an upstream refactor stops the release instead of
  silently dropping the fix. The build also fails if an adapter matched nothing.
- `tests/preload.ts` applies the same plugin in `bun test`, so `tests/` exercise
  real upstream code exactly as it is compiled.
- `scripts/build.py` checks the binary contains the adapted code, that the
  submodule is still pristine, and that the binary starts.

To add an OpenCode adapter: create `adapters/opencode/<name>.ts` exporting an `Adapter`, register
it in `adapters/opencode/index.ts`, and add a test in `tests/` that fails without it.

OpenChamber's web package is built by Vite, so its adapters are a Vite plugin
added to OpenChamber's own config: `scripts/build-openchamber.py` copies the
vendor's tracked files to `build/openchamber/<version>/`, the plugin rewrites the
UI sources there as they load, the server sources (which ship unbuilt) are
adapted when the package is staged, and the result is type-checked with
OpenChamber's own `bun check -b`, checked for the adapted code and packed to
`dist/openchamber-web-<version>.tgz` (`npm install -g` it). The same anchor rule
applies: an edit whose upstream text is missing or ambiguous stops the build.

## Releases

Every push to main is released as the next `v<upstream>-fixed.N`: N counts up
for the same OpenCode version and restarts at 1 when OpenCode releases a new
version (e.g. `v2.0.20-fixed.1`, `v2.0.20-fixed.2`, then `v2.0.21-fixed.1`). Each has
`linux-x64` and `darwin-arm64` (Apple silicon) CLI binaries plus `SHA256SUMS`.
Binaries report the upstream version (e.g. `2.0.20`) so official clients stay
compatible.

- **Disable auto-update** (`OPENCODE_DISABLE_AUTOUPDATE=1`), otherwise the next
  official upgrade replaces the adapted binary.
- macOS binaries are ad-hoc signed, not notarized.
- Releases are artifacts only; nothing is deployed to any server.

## Automation

```mermaid
flowchart LR
  A[hourly: official stable release channels] -->|newer| B[pin all vendor submodules to tags]
  B --> C[mise run ci]
  C --> D[build linux-x64 + darwin-arm64]
  D --> E[fast-forward main]
  E --> F[GitHub Release]
```

- `upstream-sync.yml` follows formal release tags only, never moving branches. A
  new version is staged on the `upstream-sync` branch; main moves and
  a release is published only after tests pass and all targets build. If an
  adapter no longer matches upstream, the run fails and publishes nothing.
- `release.yml` publishes every push to main as the next `fixed.N`.
- `ci.yml` runs setup and checks on pushes and pull requests.

## Local development

Install [mise](https://mise.jdx.dev/), then:

```sh
mise trust
mise install
mise run setup                        # submodule and locked dependencies
mise run ci                           # same checks as GitHub Actions
mise run test:adapters                # our adapter tests only
mise run build opencode-linux-x64     # dist/opencode-linux-x64.tar.gz
mise run build:openchamber            # dist/openchamber-web-<version>.tgz, with the adapters
mise run check:openchamber            # the OpenChamber adapters apply and type-check
mise run vendors:sync                 # pin newer formal releases, if any
mise run release:notes
```

`mise run ci` runs upstream lint/type checks, upstream's own lifecycle tests
(unadapted), and our adapter tests (OpenCode's and OpenChamber's). CI also
builds the adapted OpenChamber web package in a job of its own. Tests use upstream's isolated environment
(in-memory database, temporary HOME), not a live OpenCode service. Workflows are
thin shells over these tasks, so failures reproduce locally, except runner
permissions, secrets and the release upload.
