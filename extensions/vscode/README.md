# VS Code extension

Puts compiled VS Code into OpenChamber (manifest `apiVersion` 1, OpenChamber 2.5.1 or newer; web and desktop):

- **Code rendering:** code files open in OpenChamber's Files view in VS Code's editor (Monaco), colored by the
  TextMate grammars and default themes of VS Code itself, taken from a compiled VS Code (1.140.0, the release
  `vendors.json` pins) and run by vscode-textmate on vscode-oniguruma, the libraries VS Code uses. Saving,
  autosave and unsaved changes stay OpenChamber's.
- **The whole VS Code:** the VS Code panel opens the folder at hand in the VS Code Server for the web (the dev
  container runs one on port 35311), in OpenChamber's built-in browser on desktop or a browser tab; every chat
  has "Open in VS Code" in its menu, and the editor's status bar opens the file there at its line.

## Why this shape

OpenChamber 2.5.1 runs an extension's pages in `sandbox="allow-scripts"` frames whose CSP allows frames only from
OpenChamber itself, so no extension can host VS Code's whole workbench inside its own page. What it does allow,
and what this extension uses:

| Need | Mechanism | Limit |
|---|---|---|
| Code rendering | `contributes.fileEditors` with a bundled Monaco | Files view only (not diffs or chat); files up to 20,000,000 characters |
| VS Code's colors | Grammars, language configurations and themes collected into `editor/vscode/` | Languages VS Code ships a grammar for (75, 85 grammars) |
| The full VS Code | `host.openUrl` to the VS Code Server, `openSurface('browser')` | Desktop opens it in the built-in browser when "Open links in the built-in browser" is on; the web UI opens a tab |

## Layout

| Path | Role |
|---|---|
| `src/` | Pure code: VS Code's extension manifests to languages and grammars (`vscodeData.ts`), language configurations and themes for Monaco (`monacoConfig.ts`), settings and VS Code Server addresses (`settings.ts`), the files the editor claims (`fileTypes.ts`) |
| `editor/` | The file editor: `main.ts` (Monaco and the host's file contract), `textmate.ts` (TextMate coloring), `worker.ts` (Monaco's helper worker), `vscode/` (collected from VS Code, with `NOTICE.md`), `build/` (built) |
| `panel/` | The VS Code panel and, as the background frame, the "Open in VS Code" chat action |
| `scripts/collect-vscode.ts` | Copies grammars, language configurations and themes from a compiled VS Code |
| `scripts/build.ts` | Builds `panel/main.js` and `editor/build/` |

## Build

```sh
bun install
bun run check                      # tsc, strict
bun test tests/                    # including a line of TypeScript in Dark Modern's colors
bun run build                      # panel/main.js, editor/build/main.{js,css}
node tests/e2e/run.mjs http://<bind>:35310   # on the host, against the dev container
```

The E2E check opens a scratch `.ts` file in the Files view (VS Code's grammar and theme colors), saves an edit
with Ctrl+S, and opens the project in the VS Code Server from the panel; it removes the file and puts the
extension's settings back afterwards.

To collect the VS Code data again (after the VS Code pin moves), copy a compiled VS Code's `extensions/`,
`package.json`, `product.json` and `LICENSE` to a folder and run the collector on it, for example from the dev
container:

```sh
mkdir -p /tmp/vscode-compiled
for item in extensions package.json product.json LICENSE; do docker cp oc-forge-vscode-dev:/opt/vscode-server/$item /tmp/vscode-compiled/$item; done
bun run collect /tmp/vscode-compiled          # writes editor/vscode/
```

The build works around three things a sandboxed frame cannot do: it starts Monaco's worker from a blob of its
inlined source, carries vscode-oniguruma's WASM and the codicon font inside the script and the CSS (OpenChamber
serves neither `.wasm` nor fonts with the CORS headers an opaque origin needs), and replaces `import.meta.url`,
which a classic script cannot read.

## Install

In OpenChamber: Settings → Extensions, add the folder (`/extensions/vscode` in the dev container). It asks for no
capabilities. Open the VS Code panel to set the VS Code Server address and connection token
(`VSCODE_CONNECTION_TOKEN` in the dev container's secrets file), the editor theme, the minimap and wrapping.

VS Code's webviews (Markdown preview, extension views) need a secure context; over plain HTTP on an address other
than localhost they may not work. Serving both apps over HTTPS on their own host names fixes that.
