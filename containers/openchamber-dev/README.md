# OpenChamber dev container

OpenChamber and OpenCode from npm, pinned to the pair the host runs, for building
OpenChamber extensions in [`../../extensions/`](../../extensions/). Not part of the
release build; `vendors/` stays pristine.

| Component | Version | Source |
|---|---|---|
| OpenChamber | 2.4.0 | npm `@openchamber/web` |
| OpenCode | 2.0.32 | npm `@opencode/cli`; OpenChamber starts and manages it |
| Node | 26.12.0 | `node:26.12.0-trixie-slim` |
| Bun | 1.4.3 | `oven/bun:1.4.3`, for `bunx openchamber-guest-bundle` |

Pin other versions with the build args `OPENCHAMBER_VERSION`, `OPENCODE_VERSION`,
`NODE_IMAGE` and `BUN_IMAGE`.

## Files

| Path | Contents |
|---|---|
| `Dockerfile` | image `oc-forge/openchamber-dev:2.4.0` |
| `compose.yaml` | container `oc-forge-openchamber-dev`; volume `oc-forge-openchamber-dev-home` at `/home/node` (settings, projects, sessions, OpenCode data); `../../extensions` at `/extensions` |
| `.env` (untracked) | optional `OC_DEV_BIND` and `OC_DEV_PORT`; default `127.0.0.1:35310` |
| `~/.local/share/oc-forge-openchamber-dev/secrets.env` (outside the repository, mode 0600) | `OPENCHAMBER_UI_PASSWORD` and provider keys such as `DEEPSEEK_API_KEY` or `OPENAI_API_KEY` |

## First run

1. Create the secrets file with a random UI password:

   ```sh
   install -d -m 700 ~/.local/share/oc-forge-openchamber-dev
   ( umask 077; printf 'OPENCHAMBER_UI_PASSWORD=%s\n# DEEPSEEK_API_KEY=\n# OPENAI_API_KEY=\n' \
       "$(python3 -c 'import secrets; print(secrets.token_hex(16))')" \
       > ~/.local/share/oc-forge-openchamber-dev/secrets.env )
   ```

2. To reach it from other machines, publish it on another address: `echo OC_DEV_BIND=<address> > .env`.
3. Run `docker compose up -d --build`, open `http://<address>:35310`, and sign in with the UI password.

OpenCode reads provider keys from the environment: uncomment one key line in the
secrets file, add the key, and run `docker compose up -d` to recreate the container.
Every variable in the secrets file is visible to agent shells in the container.

## Daily use

From this folder:

| Task | Command |
|---|---|
| Start / stop | `docker compose up -d` / `docker compose stop` |
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
