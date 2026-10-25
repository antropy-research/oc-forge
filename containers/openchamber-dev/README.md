# OpenChamber dev container

OpenChamber and OpenCode from npm, for building OpenChamber extensions in
[`../../extensions/`](../../extensions/): the latest OpenChamber release, which the
extensions are installed on, with an OpenCode it supports (OpenChamber 2.5.1 needs
OpenCode 2.1.0 or newer). Not part of the release build; `vendors/` stays pristine.

| Component | Version | Source |
|---|---|---|
| OpenChamber | 2.5.1 | npm `@openchamber/web` |
| OpenCode | 2.1.4 | npm `@opencode/cli`; OpenChamber starts and manages it |
| VS Code Server | 1.140.0 | Microsoft's server for the web (`server-linux-<arch>-web`), the VS Code release `vendors.json` pins; the `vscode` service |
| Node | 26.12.0 | `node:26.12.0-trixie-slim` |
| Bun | 1.4.4 | `oven/bun:1.4.4`, for `bunx openchamber-guest-bundle` |

Pin other versions with the build args `OPENCHAMBER_VERSION`, `OPENCODE_VERSION`,
`VSCODE_VERSION`, `NODE_IMAGE` and `BUN_IMAGE`.

## Files

| Path | Contents |
|---|---|
| `Dockerfile` | image `oc-forge/openchamber-dev:2.5.1` |
| `compose.yaml` | containers `oc-forge-openchamber-dev` (OpenChamber) and `oc-forge-vscode-dev` (VS Code Server), from the same image; both mount volume `oc-forge-openchamber-dev-home` at `/home/node` (settings, projects, sessions, OpenCode data, VS Code Server data) and `../../extensions` at `/extensions` |
| `.env` (untracked) | optional `OC_DEV_BIND`, `OC_DEV_PORT` and `OC_VSCODE_PORT`; default `127.0.0.1:35310` and `:35311` |
| `~/.local/share/oc-forge-openchamber-dev/secrets.env` (outside the repository, mode 0600) | `OPENCHAMBER_UI_PASSWORD`, `VSCODE_CONNECTION_TOKEN` and provider keys such as `DEEPSEEK_API_KEY` or `OPENAI_API_KEY` |

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
3. Run `docker compose up -d --build`, open `http://<address>:35310`, and sign in with the UI password.
4. VS Code is at `http://<address>:35311/?tkn=<VSCODE_CONNECTION_TOKEN>`. The service starts
   Microsoft's VS Code Server with `--accept-server-license-terms`, so running it accepts the
   [VS Code Server license](https://aka.ms/vscode-server-license).

OpenCode reads provider keys from the environment: uncomment one key line in the
secrets file, add the key, and run `docker compose up -d` to recreate the container.
Every variable in the secrets file is visible to agent shells in the container.

## Daily use

From this folder:

| Task | Command |
|---|---|
| Start / stop | `docker compose up -d` / `docker compose stop` (both services; name one, such as `vscode`, to act on it alone) |
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
