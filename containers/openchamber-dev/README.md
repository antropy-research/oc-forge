# OpenChamber dev container

OpenCode and OpenChamber, each built from its `vendors/` submodule at the commit `vendors.json`
pins, for building OpenChamber extensions in [`../../extensions/`](../../extensions/). Not part
of the release build. The builds run in Docker build stages on copies of the vendors, so
`vendors/` stays pristine.

| Component | Built from | How |
|---|---|---|
| OpenCode | `vendors/opencode` with `adapters/opencode/` | `scripts/build.py opencode-linux-<arch>`, as the releases are built: upstream's `packages/cli/script/build.ts` with `scripts/build-preload.ts` preloaded. build.py checks the binary has the adapted location TTL and starts. Installed as `opencode` and `opencode2`; OpenChamber starts and manages it |
| OpenChamber | `vendors/openchamber` with `adapters/openchamber/` | `bun install --frozen-lockfile`, the web package's adapted build (`OPENCHAMBER_BUILD`, below: `scripts/build-openchamber.py`), `bun pm pack` of `packages/sdk`, then `npm install -g` of both tarballs; their npm dependencies resolve when they are installed, as the published package's do |
| GitHub CLI | release tarball, `GH_VERSION` | the Planner reads GitHub with it and agents open pull requests with it (`gh auth login` once in the container; the agent journey points it at a fake GitHub instead) |
| Node | `NODE_IMAGE`, `node:26.12.0-trixie-slim` | the image's runtime, and the base of every build stage, so what they compile runs in the image |
| Bun | npm `bun`, at the version a vendor's `packageManager` names | each stage uses its vendor's; the image has OpenChamber's, for `bunx openchamber-guest-bundle` |

No vendor version is written in these files: the image is whatever the pins check out
(`vendors.json`; OpenChamber v2.5.1 and OpenCode v2.1.4 when this was written).
OpenChamber still offers *OpenCode update* when npm has a newer OpenCode; it fails and changes
nothing (OpenCode cannot tell how this binary was installed), so OpenCode moves only with its pin.

`OPENCHAMBER_BUILD` (a build arg) is the command that builds the web package from
`vendors/openchamber` and leaves its tarball in `/out`. By default it is oc-forge's adapted build,
`scripts/build-openchamber.py --source vendors/openchamber` (`adapters/openchamber/README.md`): the
adapters are applied to a copy of the vendor's sources (each anchor exactly once, or the build
stops), the UI is built and type-checked with OpenChamber's own tooling, and the package must
contain the adapted code. The stage's copy has no git metadata, so the script copies its files and
leaves the pristine check to `build.sh`, which checks the checkout. Upstream's own build, unadapted,
is `--build-arg OPENCHAMBER_BUILD="bun run --cwd packages/web build && bun pm pack --cwd
packages/web --destination /out"`.

## Files

| Path | Contents |
|---|---|
| `Dockerfile` | stages `toolchain`, `opencode` and `openchamber`, then the image `oc-forge/openchamber-dev:vendors` |
| `Dockerfile.dockerignore` | the build context, the repository root, cut to what the stages copy, without git metadata or `node_modules` |
| `build.sh` | checks that the two vendors are checked out at their pins and unmodified, then runs `docker compose build` |
| `compose.yaml` | container `oc-forge-openchamber-dev` (OpenChamber); it mounts volume `oc-forge-openchamber-dev-home` at `/home/node` (settings, projects, sessions, OpenCode data) and `../../extensions` at `/extensions`. It may use 16 GiB of memory and no swap (`mem_limit`, `memswap_limit`), so a runaway one is OOM-killed alone instead of the host running out (a container reached 24.5 GiB of the host's 62.6 GiB on 2026-10-28) |
| `.env` (untracked) | optional `OC_DEV_BIND` and `OC_DEV_PORT`; default `127.0.0.1:35310` |
| `~/.local/share/oc-forge-openchamber-dev/secrets.env` (outside the repository, mode 0600) | `OPENCHAMBER_UI_PASSWORD` and provider keys such as `DEEPSEEK_API_KEY` or `OPENAI_API_KEY` |

## Build

```sh
git submodule update --init vendors/opencode vendors/openchamber   # once, and after a pin moves
./build.sh             # arguments go to `docker compose build`, such as --no-cache
```

The stages build in parallel. From a clean cache OpenCode's stage is the longest (13 to 25
minutes on the 16-core host this was written on, whose Docker disk is slow and shared), then
OpenChamber's (4 to 10). The disk load slows every container on the host while it runs. On
2026-11-04 the build took 20 minutes (OpenCode's install 12 and its build 5, OpenChamber's stage
15 beside them), and the image is 1.91 GB (`docker images`).

A rebuild redoes only what changed: a pin that moves rebuilds that vendor's stage, and changing an
OpenCode adapter reruns only `build.py`. `docker compose up -d --build` builds too, without
`build.sh`'s check.

### After CI moves a pin

1. Merge the branch with the new pins, then `git submodule update --init vendors/opencode vendors/openchamber`.
2. `./build.sh`, then `docker compose up -d`: the container is recreated on the same home volume.
3. Nothing in these files names a version: Bun follows `packageManager`. An OpenCode adapter that
   no longer matches upstream fails the build, as in CI.

### Moving a stack that still has the VS Code Server

Until 2026-11-04 the image also carried a VS Code Server, run as a second container,
`oc-forge-vscode-dev`. To move a stack started from an older checkout onto this one:

1. `./build.sh` here. Tag the running image first if you may want to go back
   (`docker tag "$(docker inspect -f '{{.Image}}' oc-forge-openchamber-dev)" oc-forge/openchamber-dev:<tag>`).
2. `docker compose up -d --remove-orphans` here: `oc-forge-openchamber-dev` is recreated on the same
   home volume, and `oc-forge-vscode-dev`, whose service is gone, is removed. The container then
   mounts this checkout's `extensions/` (and takes `OC_DEV_BIND` from this folder's `.env`: copy the
   old checkout's).
3. OpenChamber keeps `/extensions/vscode` in its folder installs (`~/.config/openchamber/extensions.json`)
   and skips it while the folder is missing. The extension's state (`~/.local/share/openchamber-vscode/`)
   and the server's (`~/.vscode-server-web/`) stay in the home volume until you delete them.

### File watchers

OpenCode watches files with inotify, and the host counts inotify instances per user
(`fs.inotify.max_user_instances`, 128 by default); the container's `node` is the host's UID 1000.
When that user has none left, OpenCode, the npm release as much as this build, can stop answering
once a chat opens in OpenChamber (it hung each time all of the user's instances were taken, and
never otherwise; on 2026-10-28 a leak held 90 of them). Free them, or raise the limit
(`sudo sysctl fs.inotify.max_user_instances=1024`).

## First run

1. Create the secrets file with a random UI password:

   ```sh
   install -d -m 700 ~/.local/share/oc-forge-openchamber-dev
   ( umask 077; printf 'OPENCHAMBER_UI_PASSWORD=%s\n# DEEPSEEK_API_KEY=\n# OPENAI_API_KEY=\n' \
       "$(python3 -c 'import secrets; print(secrets.token_hex(16))')" \
       > ~/.local/share/oc-forge-openchamber-dev/secrets.env )
   ```

2. To reach it from other machines, publish it on another address: `echo OC_DEV_BIND=<address> > .env`.
   If that address goes away (on 2026-11-05 the host's tailnet node was re-created with a new IP), write
   the new one and run `docker compose up -d --no-build`. Until then Docker keeps listening on the old
   address and still reports the container healthy.
3. Build (above), run `docker compose up -d`, open `http://<address>:35310`, and sign in with the UI password.

OpenCode reads provider keys from the environment: uncomment one key line in the
secrets file, add the key, and run `docker compose up -d` to recreate the container.
Every variable in the secrets file is visible to agent shells in the container.

## Daily use

From this folder:

| Task | Command |
|---|---|
| Start / stop | `docker compose up -d` / `docker compose stop` |
| Rebuild | `./build.sh`, then `docker compose up -d` |
| Logs | `docker compose logs -f` |
| Shell | `docker compose exec openchamber bash` |
| Delete all data | `docker compose down -v` (removes the home volume) |

## Extensions

`extensions/<name>` appears in the container as `/extensions/<name>`. Build inside
the container, then add the folder once in Settings → Extensions:

```sh
docker compose exec -w /extensions/planner openchamber bun install
docker compose exec -w /extensions/planner openchamber bun run check   # tsc, strict
docker compose exec -w /extensions/planner openchamber bun run build   # panel/main.js
```

A folder install keeps its real path: the catalog re-reads `package.json` and serves
the rebuilt files, so reload the page after a build instead of reinstalling.

`extensions/planner` and `extensions/cloak-browser` are submodules, each its own repository
([openchamber-planner](https://github.com/antropy-research/openchamber-planner),
[openchamber-cloak-browser](https://github.com/antropy-research/openchamber-cloak-browser)):
check them out with `git submodule update --init extensions/planner extensions/cloak-browser`
before building them, and again after their pins move. A change to one is committed and pushed
in its repository first; this one then commits the submodule's new commit. It runs CloakBrowser, a Chromium, in the
container: the image has Chromium's libraries and fonts for it, and the extension
downloads the browser itself on first use into the home volume
(`~/.cache/oc-forge-cloak-browser`, about 700 MB), its profile beside the other data
(`~/.local/share/oc-forge-cloak-browser`).

## A model for agents

Without a provider of its own, the container's OpenCode runs agents on OpenCode's free
models, which stop at a daily limit ("Free usage limit reached", HTTP 429). To give its
agents a model, add a provider to the container's OpenCode config, with the key in a file
of its own (OpenCode 2 reads `{file:…}` references; the key is never in the config):

```sh
# The key, from the host's environment, into a 0600 file in the container's home.
printf '%s' "$OPENCODE_OPENAI_API_KEY" | docker compose exec -T openchamber sh -c 'umask 077 && cat > ~/.config/opencode/model-proxy.key'
# ~/.config/opencode/opencode.json in the container: an OpenAI-compatible provider whose
# settings are { "baseURL": "<the proxy's /v1>", "apiKey": "{file:~/.config/opencode/model-proxy.key}" }
# and whose models include the one the agents use (openai/gpt-6-luna by default).
```

Then restart the container's OpenCode: Settings → OpenCode, or `POST /api/config/reload`.
Sessions an extension starts (the Planner's agents) use OpenChamber's default model, else
the model picked last; set it in Settings, or `PUT /api/config/settings` with
`{ "defaultModel": "openai/gpt-6-luna" }`, so they don't fall back to the free tier.
`extensions/planner/tests/e2e/agentpr.mjs` runs its agent on `AGENTPR_MODEL`
(default `openai/gpt-6-luna`), and stops early, saying so, when the container's OpenCode
has no such provider. Remove both files, clear the default model and reload to go back to
the free models.
