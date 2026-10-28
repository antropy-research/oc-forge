# OpenChamber dev container

OpenCode, OpenChamber and VS Code Server for the web, each built from its `vendors/` submodule
at the commit `vendors.json` pins, for building OpenChamber extensions in
[`../../extensions/`](../../extensions/). Not part of the release build. The builds run in
Docker build stages on copies of the vendors, so `vendors/` stays pristine.

| Component | Built from | How |
|---|---|---|
| OpenCode | `vendors/opencode` with `adapters/opencode/` | `scripts/build.py opencode-linux-<arch>`, as the releases are built: upstream's `packages/cli/script/build.ts` with `scripts/build-preload.ts` preloaded. build.py checks the binary has the adapted location TTL and starts. Installed as `opencode` and `opencode2`; OpenChamber starts and manages it |
| OpenChamber | `vendors/openchamber` | `bun install --frozen-lockfile`, the web package's build (`OPENCHAMBER_BUILD`, below), `bun pm pack` of `packages/sdk` and `packages/web`, then `npm install -g` of both tarballs; their npm dependencies resolve when they are installed, as the published package's do |
| VS Code Server for the web | `vendors/vscode` | Node as its `.nvmrc` says, `npm ci`, then the steps of Microsoft's Linux pipeline: `npm run gulp core-ci`, the built-in Copilot extension packed as a VSIX (`npm run build`, `vsce package`) and unpacked into `.build/extensions/copilot`, and `npm run gulp vscode-reh-web-linux-<arch>-min-ci`. First `vscode-product.json` is merged into `product.json` (below), and the pinned commit is given as `BUILD_SOURCEVERSION` (the copy has no git), with `VSCODE_QUALITY` as the pipeline sets it. Code - OSS (MIT), in `/opt/vscode-server`; `vscode-server` starts it (the `vscode` service) |
| GitHub CLI | release tarball, `GH_VERSION` | the Planner reads GitHub with it and agents open pull requests with it (`gh auth login` once in the container; the agent journey points it at a fake GitHub instead) |
| Node | `NODE_IMAGE`, `node:26.12.0-trixie-slim` | the image's runtime, and the base of every build stage, so what they compile runs in the image |
| Bun | npm `bun`, at the version a vendor's `packageManager` names | each stage uses its vendor's; the image has OpenChamber's, for `bunx openchamber-guest-bundle` |

No vendor version is written in these files: the image is whatever the pins check out
(`vendors.json`; OpenChamber v2.5.1, OpenCode v2.1.4 and VS Code 1.140.0 when this was written).
OpenChamber still offers *OpenCode update* when npm has a newer OpenCode; it fails and changes
nothing (OpenCode cannot tell how this binary was installed), so OpenCode moves only with its pin.

The one-task local build, `npm run gulp vscode-reh-web-linux-<arch>-min`, does not work at this
pin. It packs the Copilot extension itself, without the `node_modules/@github/copilot/sdk` that its
last step (the ripgrep shim) requires; with `BUILD_SOURCEVERSION` set it also reinstalls into those
`node_modules` while it copies them (ENOENT). Microsoft's pipeline never takes that path: it builds
Copilot as a VSIX in a job of its own (`build/azure-pipelines/product-copilot.yml`) and unpacks it
into `.build/extensions/copilot` (`common/downloadCopilotVsix.ts`), and the stage does the same.

`vscode-product.json` is what VS Code leaves to whoever distributes its OSS build:

- `quality: "stable"`: the server serves its workbench under `/stable-<commit>/static`, as
  Microsoft's does, and the VS Code extension reads the commit from that path. Without it the
  route is `/oss-<commit>/static`.
- `extensionsGallery`: Open VSX, with VSCodium's `serviceUrl` and `itemUrl`, and a
  `resourceUrlTemplate`, without which the server gives the browser no gallery at all. VSCodium's
  `controlUrl` (a list of malicious extensions on raw.githubusercontent.com) is left out: the VS
  Code extension's view may not reach that host.
- `linkProtectionTrustedDomains`: Open VSX, as VSCodium.

Code - OSS cannot check extension signatures: the checker, `@vscode/vsce-sign`, is not in the
sources (Microsoft's distro adds it). So each install from the gallery asks to *Install Anyway
(Don't Verify Signature)*; the setting `extensions.verifySignature` is left at its default.

`OPENCHAMBER_BUILD` (a build arg) is the hook for oc-forge's OpenChamber adapters. It builds
`packages/web`; today with upstream's own build, unadapted. When `adapters/openchamber/` has
adapters and a build script of its own, copy that script into the `openchamber` stage beside the
adapters and set `OPENCHAMBER_BUILD` to run it.

## Files

| Path | Contents |
|---|---|
| `Dockerfile` | stages `toolchain`, `pins`, `opencode`, `openchamber` and `vscode`, then the image `oc-forge/openchamber-dev:vendors` |
| `Dockerfile.dockerignore` | the build context, the repository root, cut to what the stages copy, without git metadata or `node_modules` |
| `vscode-product.json` | merged into VS Code's `product.json` before its build |
| `build.sh` | checks that the three vendors are checked out at their pins and unmodified, then runs `docker compose build` |
| `compose.yaml` | containers `oc-forge-openchamber-dev` (OpenChamber) and `oc-forge-vscode-dev` (VS Code Server), from the same image; both mount volume `oc-forge-openchamber-dev-home` at `/home/node` (settings, projects, sessions, OpenCode data, VS Code Server data) and `../../extensions` at `/extensions`. Each may use 16 GiB of memory and no swap (`mem_limit`, `memswap_limit`), so a runaway one is OOM-killed alone instead of the host running out: on 2026-10-28 the VS Code Server reached 24.5 GiB of the host's 62.6 GiB through a tunnel leak in the VS Code extension |
| `.env` (untracked) | optional `OC_DEV_BIND`, `OC_DEV_PORT` and `OC_VSCODE_PORT`; default `127.0.0.1:35310` and `:35311` |
| `~/.local/share/oc-forge-openchamber-dev/secrets.env` (outside the repository, mode 0600) | `OPENCHAMBER_UI_PASSWORD`, `VSCODE_CONNECTION_TOKEN` and provider keys such as `DEEPSEEK_API_KEY` or `OPENAI_API_KEY` |

## Build

```sh
git submodule update --init vendors/opencode vendors/openchamber vendors/vscode   # once, and after a pin moves
./build.sh             # arguments go to `docker compose build`, such as --no-cache
```

The stages build in parallel. From a clean cache (`./build.sh --no-cache`) the build took 36
minutes on the 16-core host it was written on, whose Docker disk is slow; VS Code's stage is the
longest (its `npm ci` about 8 minutes; `core-ci`, the Copilot VSIX and the packaging about 10),
OpenCode's took about 13 minutes and OpenChamber's about 4. The image is 2.8 GB (`docker images`);
the npm-based image before it was 3.9 GB.

A rebuild redoes only what changed: a pin that moves rebuilds that vendor's stage (the VS Code
commit is read from `vendors.json` on its own, so another pin moving leaves VS Code alone), and
changing an OpenCode adapter reruns only `build.py`. `docker compose up -d --build` builds too,
without `build.sh`'s check.

### After CI moves a pin

1. Merge the branch with the new pins, then `git submodule update --init vendors/opencode vendors/openchamber vendors/vscode`.
2. `./build.sh`, then `docker compose up -d`: both containers are recreated on the same home volume.
3. Nothing in these files names a version: Bun follows `packageManager`, VS Code's build Node
   follows `.nvmrc`, and the server's own Node follows its `remote/.npmrc`. An OpenCode adapter that
   no longer matches upstream fails the build, as in CI.
4. When VS Code moved, refresh the VS Code extension's `service/web-files.json` as
   [its README](../../extensions/vscode/README.md) says; the extension prepares the new commit's
   workbench on its next connect.

### Switching the running stack to this image

The stack running before this change uses `oc-forge/openchamber-dev:2.5.2`: OpenChamber 2.5.2
and OpenCode 2.1.4 from npm, and Microsoft's VS Code Server 1.140.0. To move it onto the image
built from the vendors:

1. In the checkout the stack runs from (`docker inspect oc-forge-openchamber-dev --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}'`),
   merge this change and initialize the three vendors as above.
2. `./build.sh`. The old image stays, for going back.
3. `docker compose up -d` recreates `oc-forge-openchamber-dev` and `oc-forge-vscode-dev` from
   `oc-forge/openchamber-dev:vendors` on the same volume, so settings, projects, sessions, OpenCode
   data and the VS Code Server's data and extensions stay.
4. Delete the VS Code extension's prepared workbench, `extensions/vscode/vscode-web/<commit>/`.
   Microsoft's build and this one share the commit, so the extension would keep serving the
   workbench it copied from Microsoft's build; deleted, it is prepared again from this one.
5. OpenChamber becomes the pinned release, which may be older than the npm release the old image
   had (the planner branch pins v2.5.1); both extensions accept 2.5.1.

To go back, check out the previous `compose.yaml` and run `docker compose up -d`.

### File watchers

OpenCode and the VS Code Server watch files with inotify, and the host counts inotify instances per
user (`fs.inotify.max_user_instances`, 128 by default); the containers' `node` is the host's UID
1000. When that user has none left, VS Code's Source Control stops seeing changes (`EMFILE` in the
server's log), and OpenCode, the npm release as much as this build, can stop answering once a chat
opens in OpenChamber. The VS Code Server keeps a watcher process for each window it has served, so
a `vscode` service that has run for long can hold most of them: `docker compose restart vscode`
gives them back, or raise the limit (`sudo sysctl fs.inotify.max_user_instances=1024`).

## First run

1. Create the secrets file with a random UI password and VS Code connection token:

   ```sh
   install -d -m 700 ~/.local/share/oc-forge-openchamber-dev
   ( umask 077; printf 'OPENCHAMBER_UI_PASSWORD=%s\nVSCODE_CONNECTION_TOKEN=%s\n# DEEPSEEK_API_KEY=\n# OPENAI_API_KEY=\n' \
       "$(python3 -c 'import secrets; print(secrets.token_hex(16))')" \
       "$(python3 -c 'import secrets; print(secrets.token_hex(16))')" \
       > ~/.local/share/oc-forge-openchamber-dev/secrets.env )
   ```

2. To reach it from other machines, publish it on another address: `echo OC_DEV_BIND=<address> > .env`.
3. Build (above), run `docker compose up -d`, open `http://<address>:35310`, and sign in with the UI password.
4. VS Code is at `http://<address>:35311/?tkn=<VSCODE_CONNECTION_TOKEN>`.

OpenCode reads provider keys from the environment: uncomment one key line in the
secrets file, add the key, and run `docker compose up -d` to recreate the container.
Every variable in the secrets file is visible to agent shells in the container.

## Daily use

From this folder:

| Task | Command |
|---|---|
| Start / stop | `docker compose up -d` / `docker compose stop` (both services; name one, such as `vscode`, to act on it alone) |
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
