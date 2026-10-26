# VS Code extension

Renders compiled VS Code inside OpenChamber (manifest `apiVersion` 1, OpenChamber 2.5.1 or newer, tested on
2.5.2; web and desktop): the workbench of your own VS Code Server for the web, the same commit, in OpenChamber's
**VS Code** rail panel (beside the chat, expandable) and as a full **VS Code** page (Extension pages → VS Code).
Nothing opens in another tab or window. Explorer, editor (VS Code's own grammars, themes and IntelliSense from the
server's extensions), Search, Source Control with its diff editor, the integrated terminal, Run and Debug,
extensions and the command palette are VS Code itself, running on the server's files.

- **Open in VS Code** in a chat's menu shows that chat's folder (or worktree) in the VS Code panel.
- VS Code follows OpenChamber's light or dark look when it starts, and switches when OpenChamber's does.
- When OpenChamber moves to another folder, VS Code offers to open it; *OpenChamber: Open OpenChamber's Folder* and
  *OpenChamber: VS Code Server Connection…* are in VS Code's command palette.
- VS Code keeps its settings, keybindings, open editors and layout across reloads.

## How it fits in an extension frame

OpenChamber runs an extension's pages in `sandbox="allow-scripts"` frames: an opaque origin with a CSP that lets
them load files from their own package and connect nowhere else. VS Code's web workbench expects a normal page on
its server's origin. The extension's intermediate components close that gap:

| VS Code needs | In an extension frame | What this extension does |
|---|---|---|
| Its compiled files (`out/`, a few `node_modules`) | Only its own package's `.html .js .css .svg .json .png` load | `service/assets.ts` copies the browser's files of the server's own commit into `vscode-web/<commit>/` (from the install on this machine, or over HTTP from the server's static route by `service/web-files.json`), WebAssembly renamed `.json` |
| Its embedder (`create(document.body, options)`) | | `src/patch.ts` routes the compiled embedder's options through the frame, which adds the folder, the web socket factory, the workspace provider and OpenChamber's defaults; each patch fails loudly if a release moved its code |
| A web socket to the server | `connect-src` is the package only | The workbench's `webSocketFactory` tunnels through the host's service channel: the service opens the socket, the frame sends batches and long-polls (`workbench/tunnel.ts`, `service/tunnel.ts`) |
| vsda to sign the handshake | Needs `crypto.subtle`, which plain HTTP lacks | The client sends its connection token, which the VS Code Server accepts in place of the signature |
| Remote resources (themes, grammars, icon fonts, extension icons) and the gallery | Blocked by the CSP | `fetch`, `<img>`, `<style>` and CSSOM rules that name the server or the gallery are fetched by the service (`workbench/shims.ts`) |
| Module workers from `blob:` URLs | An opaque origin cannot start them | The bootstrap's text starts the worker from a `data:` URL |
| IndexedDB, localStorage, cookies | They throw | An in-memory IndexedDB (`fake-indexeddb`) filled from, and saved to, the service (`~/.local/share/openchamber-vscode/state/`, one file per server, mode 0600); memory storage for the rest |
| Codicon font | Fonts are not served to the frame | Inlined into the stylesheet |

Limits: VS Code's webviews (Markdown preview, release notes, extension detail pages, extensions' own webview
panels) need service workers and same-origin nested frames, which an opaque-origin frame cannot have; they show
VS Code's own error. OpenChamber's Files view has its own Markdown preview. VS Code's chat and its GitHub sign-in
are turned off (`chat.disableAIFeatures`): OpenChamber is where agents run. Copy and paste with the keyboard work;
the clipboard from VS Code's context menus may not.

The extension no longer replaces OpenChamber's own file editor (`contributes.fileEditors`): the host can't hand a
line to an extension editor, so search results and file links lost their line. Code renders in the VS Code view.

## Layout

| Path | Role |
|---|---|
| `src/` | Pure code: settings and open requests (`settings.ts`), which install files the browser loads (`clientFiles.ts`), the patches (`patch.ts`), the workbench configuration and request routing (`workbench.ts`) |
| `service/` | The local service (Node): the VS Code Server (`server.ts`), the prepared workbench (`assets.ts`, `web-files.json`), web socket tunnels (`tunnel.ts`), the workbench's storage (`state.ts`) |
| `workbench/` | The VS Code view (panel and page): connection form, boot, shims, tunnel client, IndexedDB |
| `panel/` | The background frame: "Open in VS Code" on a chat |
| `scripts/web-files.ts` | Lists the browser's files of a VS Code Server install for `service/web-files.json` |

## Build

```sh
bun install
bun run check                      # tsc, strict
bun test tests/                    # VSCODE_SERVER_DIR=<install> also patches a real compiled workbench
bun run build                      # workbench/main.js, panel/main.js, service/main.js
node tests/e2e/run.mjs http://<bind>:35310   # on the host, against the dev container
```

The E2E check connects the panel to the dev container's VS Code Server, checks the Explorer, file icons, the
editor's grammar colors, a save with Ctrl+S, Source Control and its diff editor, Search, the terminal, state kept
across a reload, the page, "Open in VS Code" on a chat, that OpenChamber's own editor still opens a search hit at its line, and that no other page or tab opened. It puts the
demo project's README, the extension's settings and its chats back afterwards.

After the VS Code pin moves, refresh `service/web-files.json` from a server of that release:

```sh
docker cp oc-forge-vscode-dev:/opt/vscode-server /tmp/vscode-server
bun run web-files /tmp/vscode-server
VSCODE_SERVER_DIR=/tmp/vscode-server bun test tests/patch.test.ts
```

## Install

In OpenChamber: Settings → Extensions, add the folder (`/extensions/vscode` in the dev container) and approve its
local service. Open the VS Code panel and give the VS Code Server's address as the machine running OpenChamber
reaches it, and its connection token: in the dev container `http://vscode:8000` and `VSCODE_CONNECTION_TOKEN` from
the secrets file; with `code serve-web --connection-token <token>` on the same machine, `http://127.0.0.1:8000`.
The first start prepares about 40 MB of that VS Code release inside the extension's folder (`vscode-web/`,
ignored by git); later starts take a second or two.
