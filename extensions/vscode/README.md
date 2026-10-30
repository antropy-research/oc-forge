# VS Code extension

Renders compiled VS Code inside OpenChamber (manifest `apiVersion` 1, SDK 2.5.3, OpenChamber 2.5.1 or newer, tested on
2.5.3 with VS Code 1.144.0; web and desktop): the workbench of your own VS Code Server for the web, the same commit,
in OpenChamber's **VS Code** rail panel (beside the chat, expandable) and as a full **VS Code** page (Extension
pages → VS Code). Nothing opens in another tab or window. Explorer, editor (VS Code's own grammars, themes and
IntelliSense from the server's extensions), Search, Source Control with its diff editor, the integrated terminal, Run
and Debug, extensions, webviews such as the Markdown preview, and the command palette are VS Code itself, running on
the server's files.

- **Open in VS Code** in a chat's menu shows that chat's folder (or worktree) in the VS Code panel (with oc-forge's
  adapters: in VS Code's Explorer, in the rail panel).
- VS Code wears OpenChamber's theme: its light or dark mode, its colors and its code font, and follows when
  OpenChamber's changes (light and dark, another theme, the system's mode), without a reload and without touching an
  unsaved edit. All through VS Code's own documented settings, as defaults (`src/theme.ts`):
  - OpenChamber's tokens (`HostReadyContext.theme`) become `workbench.colorCustomizations` (334 workbench colors:
    each frame's surface is the color OpenChamber paints around it, floating surfaces and inputs its `elevated`,
    selections and hovers its own, accents its `primary`) and `editor.tokenColorCustomizations` (code as in
    OpenChamber's Files view, each color made readable on the editor, WCAG AA), both scoped to VS Code's default theme
    of that mode (`[Light 2026]`, `[Dark 2026]`; the same in 1.140–1.144). Its monospace font is `editor.fontFamily`
    (and so the terminal's), its interface font `markdown.preview.fontFamily`.
  - VS Code picks its light or dark default theme the way it follows a system (`window.autoDetectColorScheme`): in
    the frame, `prefers-color-scheme` answers OpenChamber's mode (`workbench/theme.ts`).
  - The look is VS Code's defaults as it starts; once it runs, the frame keeps it in VS Code's memory configuration
    (`IConfigurationService`, `ConfigurationTarget.MEMORY`): never written to the user's settings, and resolved so
    that a color, rule or font the user set (for that theme or for every theme, in any settings layer) still wins,
    key by key. A theme the user picks in VS Code shows as its author made it (VS Code's picker sets its preferred
    theme for that mode).
  - "Follow OpenChamber's theme" in the connection form turns all of it off: VS Code's own themes, as they are. On a
    VS Code release the surface patches don't fit (the whole workbench, `services` never called), the light or dark
    switch is live and the colors of a changed theme come with the next start.
- When OpenChamber moves to another folder, VS Code offers to open it; *OpenChamber: Open OpenChamber's Folder* and
  *OpenChamber: VS Code Server Connection…* are in VS Code's command palette.
- VS Code keeps its settings, keybindings, open editors and layout across reloads.
- With focus in VS Code, VS Code takes the keys, Cmd/Ctrl+1–9 and Cmd/Ctrl+Alt+←/→ included (VS Code for the web
  drops those in a browser tab).

On an OpenChamber built with oc-forge's adapters (`adapters/openchamber`) VS Code's parts move into OpenChamber's own
surfaces instead: [below](#in-openchambers-own-surfaces-oc-forges-adapters).

## How it fits in an extension frame

OpenChamber runs an extension's pages in `sandbox="allow-scripts"` frames: an opaque origin with a CSP that lets
them load files from their own package and connect nowhere else. VS Code's web workbench expects a normal page on
its server's origin. The extension's intermediate components close that gap:

| VS Code needs | In an extension frame | What this extension does |
|---|---|---|
| Its compiled files (`out/`, a few `node_modules`) | Only its own package's `.html .js .css .svg .json .png` load | `service/assets.ts` copies the browser's files of the server's own commit into `vscode-web/<commit>/` (from the install on this machine, or over HTTP from the server's static route by `service/web-files.json`; a copy made over HTTP from an older list, or missing any file it was made with, which its `ready.json` lists, is made again), WebAssembly renamed `.json` |
| Its embedder (`create(document.body, options)`) | | `src/patch.ts` routes the compiled embedder's options through the frame, which adds the folder, the web socket factory, the workspace provider and OpenChamber's defaults; each patch fails loudly if a release moved its code |
| A web socket to the server | `connect-src` is the package only | The workbench's `webSocketFactory` tunnels through the host's service channel: the service opens the connection, the frame sends batches and long-polls (`workbench/tunnel.ts`, `service/tunnel.ts`). The service connects as VS Code's own Node client does: an upgrade with `skipWebSocketFrames=true`, then the raw stream. A WebSocket can't be closed there, since the server ignores Close frames; it kept every closed tunnel's connection, and with it the server's extension host for that workbench. Tunnels no frame polls for 45 s are closed, and `/health` reports `tunnels` and the `sockets` still open |
| vsda to sign the handshake | Needs `crypto.subtle`, which plain HTTP lacks | The client sends its connection token, which the VS Code Server accepts in place of the signature |
| Remote resources (themes, grammars, icon fonts, extension icons) and the gallery | Blocked by the CSP | `fetch`, `<img>`, `<style>` and CSSOM rules that name the server or the gallery are fetched by the service (`workbench/shims.ts`) |
| Module workers from `blob:` URLs | An opaque origin cannot start them | The bootstrap's text starts the worker from a `data:` URL |
| IndexedDB, localStorage, cookies | They throw | An in-memory IndexedDB (`fake-indexeddb`) filled from, and saved to, the service (`~/.local/share/openchamber-vscode/state/`, one file per server, mode 0600); memory storage for the rest. What a frame sends as it unloads never reaches the service, so VS Code's save before it reloads the window (Reload Window, a folder switch) waits for the service before the reload; otherwise a Markdown preview opened just before came back without its state and its extension threw restoring it |
| Codicon font | Fonts are not served to the frame | Inlined into the stylesheet |
| Room for its dialogs: 480 px (350 px laid out vertically), centred | A part's frame can be narrower: 340 px for the page beside the rail panel at 1024×768, and the terminal under it | A stylesheet after VS Code's (`NARROW_FRAME_CSS`, `src/workbench.ts`): a dialog is never wider than its frame, and in a narrow one it keeps 8 px from each side and wraps its buttons, so the unsaved-file prompt's Save, Don't Save and Cancel stay in reach. Notifications, the quick input and menus fit already |

| Webviews (Markdown preview, extension pages, Mermaid) | VS Code's webview host needs a service worker, `crypto.subtle` and same-origin access to the frame it writes into | `webview/` replaces it in the prepared workbench: the same protocol with the workbench, the content in a srcdoc frame run by an agent over a MessagePort, its files read through the workbench's `load-resource` channel and put inline (module imports through an import map of `blob:` URLs); the webview's own CSP keeps its nonce. VS Code 1.143 takes `webview-ready` only with the mount id from the host page's URL and a key-event token, and runs the webview's keys only when they carry that token (`webview/protocol.ts`); the agent keeps the native `MessagePort.postMessage` before the content runs, so the content can't send keys of its own. A workbench prepared earlier gets the current host page when the service next reports it ready |

Limits: images a webview loads from the internet (badges in an extension's README) are blocked, as the frame
connects nowhere but its package. VS Code's chat and its GitHub sign-in are turned off (`chat.disableAIFeatures`):
OpenChamber is where agents run. Copy and paste with the keyboard work; the clipboard from VS Code's context menus
may not.

The extension no longer replaces OpenChamber's own file editor (`contributes.fileEditors`): the host can't hand a
line to an extension editor, so search results and file links lost their line. Code renders in the VS Code view.

## In OpenChamber's own surfaces (oc-forge's adapters)

On an OpenChamber built with oc-forge's adapters (`adapters/openchamber`, contract version 1; `AGENTS.md` 2.ii a–c)
VS Code's activity bar, editor tabs and terminal become OpenChamber's rail, header tabs and bottom panel. On a stock
OpenChamber `connectOcForge()` answers null and every frame is the whole workbench, as above.

| VS Code's | In OpenChamber | How |
|---|---|---|
| Activity bar: Explorer, Search, Source Control, Run and Debug, Extensions, and every installed extension's view container | One rail icon each, in VS Code's order; installed or uninstalled on the VS Code Server, an icon comes or goes within the next poll (2 s), no reload | The manifest's `ocForge.rail` (`GET /rail`, every 2 s). The service lists the built-ins (Remixicons of OpenChamber's sprite: `file-copy-2`, `search`, `git-branch`, `bug`, `puzzle`) and each installed extension's `contributes.viewsContainers.activitybar`, read from the server's `extensions.json`, `package.json` (and `package.nls.json`) and SVG icon through the server's own `/vscode-remote-resource` route, so it needn't share the server's disk (`service/rail.ts`, `src/rail.ts`). An SVG is inlined (16 KB at most, cleaned for the mask), a `$(codicon)` maps to a Remixicon, anything else is `apps`. Where the extensions live, a workbench tells the service once (its default profile's `extensions.json`); it is kept with the server's address (mode 0600), so after a restart the rail is complete before any frame runs. The host takes 100 entries from an extension and scrolls its rail when they are more than its height: beside the built-ins and the terminal that is 94 containers, and past them the last entry is **Additional Views**, which shows a container left out and VS Code's quick pick of them all, as VS Code's activity bar does behind "…", so none is left out. The list starts with the built-ins, the terminal and that entry (the host shows them by `order`): a host that takes fewer, as an adapted OpenChamber before `d459d05` took 32, drops containers, not them |
| A view container in the side bar | The rail panel shows that container alone, filling it | The panel's frame is the **view** role: `rail-entry` opens the container (`IViewsService.openViewContainer`); VS Code switching containers by itself (Ctrl+Shift+F, *Reveal in Explorer*, the default container when the one shown is uninstalled) moves the rail's light (`rail.setActive`). The host tells frames nothing when its list changes, so the frame reads `/rail` again on each entry chosen, on each container VS Code opens and every 3 s while it shows: Additional Views offers the containers behind it at that moment, under their current titles, and the light follows a container that moved between its own entry and Additional Views as others came and went (`followView`). A container uninstalled while it shows gives way to the first view, which the rail lights: VS Code does that when it can drop the container, and the frame when VS Code keeps it until a reload because its extension ran. Until the frame says what it shows, the rail lights none of the panel's entries, and a click on any of them, the first one too, shows it |
| Editor tabs | Header tabs after the chats'; choosing one shows its editor in the main area; they switch and close like chat tabs | The page is the **editor** role: each editor it has open is a header tab (id: its resource, or `diff:<original> <modified>`; title; icon by type; the unsaved dot). Choosing one activates its editor; closing one (its ×, a middle click, the close-tab key) closes the editor. An unsaved one is left to the page (`forge.tabs.onCloseRequest`): VS Code closes it as its own tab, with its save prompt, and the tab goes only once the editor has (Save, Don't Save), back to the chat after the last one; Cancel keeps the tab, the editor and the changes. An editor VS Code closes or switches to moves the header with it. A tab of an editor the page can open from its id (a file, a diff) carries the editor's link as its `route`: a Cmd/Ctrl+click on it opens that editor in a new browser tab, and this window stays as it is (`tabRoute`; a webview's tab has none). VS Code's own tab bar is off (`workbench.editor.showTabs: none`), and so is preview mode, as header tabs have none. The header holds as many as VS Code does: a host has room for 1000 per extension (one before 2026-10-30 for 64; `forge.limits()` says), and the strip scrolls to the selected tab and lists every tab at its end. A tab OpenChamber has no room for never stops the header from following the rest: the selection follows the editor shown once its tab is there, and the address bar names that editor at once. With the header full, the page closes the editors used least recently to make room, never one unsaved, pinned or on screen, as VS Code's `workbench.editor.limit` does, and a notification says which (`EditorArea.makeRoom`); a file opened from a rail view or the terminal then says it didn't open. A tab's title is the editor's whole name up to the host's limit (512, before 80), cut by characters with an ellipsis. Every editor has a route the host takes: its link, or for a key that would make one too long (`editorRoute` past 2048), `/editor?tab=<hash>`, which finds it while VS Code has it open (`pageRoute`). The folder's tabs are saved for after a reload in parts when one service request can't carry them (the route takes 64,000 characters; `tabChunks`, `SavedTabs.savePart`) |
| The panel's terminal | VS Code's panel at OpenChamber's bottom, maximized: several terminals, split, the shell picker, Problems and Output beside it; under a chat, and under a file's editor as in VS Code | A rail entry `terminal` with `zone: "bottom"`, so a panel of its own (`plugin:oc-forge-vscode--terminal`): the **terminal** role. Its workbench starts the first time that panel is shown. The manifest's `ocForge.page.keepBottomZone` keeps OpenChamber's bottom zone under the page, which OpenChamber (2.5.2, 2.5.3) otherwise covers with it. The parts are one workspace, whose terminals VS Code reconnects every window to as it starts: only this part does (`terminal.integrated.enablePersistentSessions` is off in the views and the page), so after a reload its shells come back here. It asks for a terminal only once VS Code has reconnected them (`whenConnected`), so a new one starts only when the folder has none: asked before, each start added a terminal, which every later start reconnected and replayed too |

**Roles.** Each frame is a workbench of its own on the same server, in one role (`src/surfaces.ts`, `workbench/surfaces.ts`):
`view` (the rail panel), `editor` (the page), `terminal` (the terminal's panel), or `classic` (the whole workbench: a
stock OpenChamber, a service without `/rail`, or a release the surface patches don't fit). A role is settings and a
layout. The settings (activity bar hidden; status bar, title bar and layout buttons off in a view and the terminal;
the tab and preview settings in the page; a maximized, centred panel in the terminal) are the workbench's defaults
from the start, and are set again in VS Code's in-memory configuration once it runs, above the user's
`settings.json`, which nothing writes to. The layout (which parts show) is set as the workbench starts and again
once it has restored its parts, through VS Code's layout service; a view and the terminal keep theirs when VS Code
brings a part back.

**Reaching VS Code's services.** The embedder API (`IWorkbench`) has no events for editors, parts or view containers.
Five more patches (`src/patch.ts`, *surface patches*) hand the frame VS Code's instantiation service as the
workbench starts and its service identifiers by name (`createDecorator`'s map), keep the keybindings VS Code for
the web drops in a browser tab (`BrowserFeatures.keyboard`), and let a view show its container alone (VS Code
otherwise brings the panel back whenever the editor area hides). From there the frame uses public members of
VS Code's service interfaces only (`workbench/vscode.ts`: the editor, editor groups, layout, views, pane composite,
configuration, remote agent and file services). Unlike the others these patches may be missing: the prepared
workbench records which (`ready.json`), and a release that moved them runs as the whole workbench per frame.
They apply once each to VS Code 1.140.0, 1.143.1 and 1.144.0.

**Between frames.** Frames reach each other only through OpenChamber, plus the service for what doesn't fit a tab
message:
- A file opened in a view or the terminal (Explorer, Search, Source Control, a terminal link) is handed to the page:
  the frame's `openEditor`/`openEditors` post the editor (marshalled as VS Code does, with its selection) to the
  service (`/editors/request`) and open its header tab with `activate`; OpenChamber shows the page on it, the page
  gets `tab-activated`, takes the request (`/editors/take`) and opens it. An extension's details page goes as
  `extension.open`. What can't be handed over (a webview of that frame's extension host, a terminal or output
  editor) opens in that frame.
- The page keeps its tabs in the service, per server and folder (`/tabs/save`); after OpenChamber reloads, the rail
  view opens that folder's again (`/tabs/load`), which mounts the page behind them, and the page's VS Code restores
  the same editors. After the page's last tab closes, OpenChamber keeps the page a few seconds more, hidden (the
  adapters' `OC_FORGE_PAGE_LINGER_MS`): on that `tab-closed` the page closes the editor and saves the folder's tabs
  empty and VS Code's state (as before a reload) at once, so neither brings the file back; an unsaved last tab it
  closes itself the same way, after the save prompt, so the file's backup is gone too and Don't Save's change doesn't
  come back. A page still starting (its VS Code not running yet) hears nothing: a part that stays (a rail view, the
  terminal) also saves the folder's tabs empty on the last `tab-closed`. VS Code's own state may still name editors
  whose tabs were closed: when the page starts it closes the editors no saved or header tab stands for (an unsaved
  one stays). A webview panel (Markdown's preview) comes back under a new key, as VS Code revives it with
  a new id: it takes the place of its old tab, which can't open it (`restoredTabOf`).
- The page and the terminal follow the folder the rail view shows (host storage `folder`); the page closes its tabs
  first, as they are the other folder's editors. "Open in VS Code" on a chat is answered by the rail view: it shows
  the chat's folder in the Explorer (lit on the rail), and hands a file to the page.
- The page names its editor in the address bar (`?extension=oc-forge-vscode&route=/editor?key=…`), so a reload or a
  copied link opens it again, and selects its tab, though the rail view may have brought the folder's saved tabs back
  (and OpenChamber selected the first) while the page started; until VS Code has restored its editors the header
  doesn't follow them. A Cmd/Ctrl+click in a view or the terminal that opens a file opens it in a new browser
  tab on that link instead of over the current view (what opens within 10 s of it, before another click or key: a
  link's `command:` first waits for VS Code's extensions to activate on it); Cmd/Ctrl+click in VS Code's lists
  (multi-select) and in the page's editor (Go to Definition) keeps its VS Code meaning. Web links open in a new tab
  as before.
- A page that starts for a file a rail view or the terminal handed over shows that file, not the page's last route,
  which OpenChamber keeps for the extension after the page went with its last tab.

**State.** One store per server for the user's data (settings, keybindings, snippets: VS Code's `vscode-web-db`),
shared by every frame and by the whole workbench of a stock OpenChamber; one store per role for VS Code's state
databases (layout, open editors, view state, extensions' state: `vscode-web-state-db-*`), so the parts don't
overwrite each other's layout (`service/state.ts`, `<server>.<role>.json`). The page starts from the whole
workbench's state (its open editors), the others from nothing. Two frames that both write the same user file (each
saved `settings.json`) still keep the later one, as two windows of the whole workbench did. VS Code for the web
saves its state every few seconds only while its document has focus; a frame here saves either way
(`shouldFlushWhenIdle`), as the focus is often in OpenChamber while its state changes (a preview's, the editors the
header opens) and a frame can't save as it unloads: a browser reload keeps what was saved a few seconds before.

**Keys.** VS Code takes the keys while it has focus, in every frame: with the keyboard patch it keeps Cmd/Ctrl+1–9
and Cmd/Ctrl+Alt+←/→ too, as VS Code's own default keybindings (not user keybindings, so `keybindings.json` stays
the user's). OpenChamber's tab keys are not forwarded. The exception is a press VS Code has no binding for
(it didn't prevent its default) that OpenChamber binds to navigation: it goes to OpenChamber, since those tabs and
that rail are OpenChamber's now. Which presses those are depends on the frame. OpenChamber's rail digits
(Cmd/Ctrl+Alt+1–9) are in every frame. Its close-tab key (Alt+W) is in a view, but VS Code's editor binds it
(Toggle Find: Match Whole Word). A terminal gives the shell every press VS Code doesn't run, and xterm stops it
before any listener of the frame sees it (Ctrl+Alt+digit becomes Esc and the digit): there the rail digits skip
the shell, as VS Code's own navigation keys do (`terminal.integrated.commandsToSkipShell`), unless VS Code binds
them, and the rest stay the shell's (Alt+W is Esc w for Emacs, Ctrl+[ is Esc, Ctrl+B is readline's and tmux's).
Keys Chrome keeps in a normal tab (Ctrl+Tab, Cmd+W, Cmd+Option+←/→) reach VS Code only in an installed app window.

**Tunnels.** Each workbench holds 2 of the service's tunnels (its management connection and its extension host's).
A browser window runs up to 3 workbenches, so 6, and 12 for the 45 s a reloaded frame's old tunnels linger; past
`MAX_TUNNELS` the least recently polled one is closed, which ends a live workbench. The limit is 128 (was 32): room
for about ten such windows. A frame long-polls once for both of its tunnels (`/tunnel/recv` with its `poller`): sent
as an HTTP request, a poll held open takes one of the browser's connections to OpenChamber, and over plain HTTP
(HTTP/1.1) Chrome opens six per host, for all its tabs (the adapted host's service WebSocket takes none). With a poll
per tunnel, the three workbenches of a window held all six with OpenChamber's own event stream, and every other
request (the tunnels' sends, the files a webview loads, OpenChamber's own calls) waited in the browser until a poll
came back, on VS Code's 5 s keep-alive: a Markdown preview revived after a reload took minutes to load its 60-odd
files one after another, and stayed blank.

**Cost** (adapters' scratch stack, VS Code 1.143.1, Chromium headless; `tests/e2e/surfaces.mjs` writes
`<size>-frames.json`; two runs at 1440×900 and 1024×768). Each workbench, from its frame's navigation to running,
with the prepared workbench cached: rail view 1.4–1.6 s, page 2.1–2.5 s, terminal 1.2–1.4 s; to a live shell
7–13 s from the click (VS Code revives the last session's terminals first). The three add 210–225 MB of JS heap
to the page's renderer (the sandboxed frames share it; 60–135 MB each, depending on which start together). On the
server each workbench is an extension host of its own, 145–250 MB resident, against one for the whole workbench.
To keep it down the terminal's workbench starts only when its panel is first shown, and the page only when it has
a tab or is opened.

**Limits.**
- A file a rail view or the terminal hands to a page that is still starting (VS Code restoring, the page closing
  editors closed before) opens once the page is ready, and takes the focus then.
- The adapted OpenChamber sends a window's service requests over one WebSocket (its transport, which Chrome pools
  apart from the six connections), so two browser tabs each run VS Code's parts. Where they go over plain HTTP
  instead (an adapted build before the transport, or with it off, `oc-forge:service-socket` in localStorage), a
  second browser tab with VS Code's parts (a Cmd/Ctrl+click tab beside the first) makes six polls and two event
  streams, more than Chrome's six connections per host, and starves: on the scratch stack the second tab's VS Code
  didn't show its file within 2 minutes, and the first tab stopped answering too until the second went. Over HTTPS
  (HTTP/2, e.g. `tailscale serve`) requests share one connection and the per-host limit doesn't apply.
- Each part has its own extension host: an extension's webview or terminal opened from a view stays in that view's
  workbench; the Explorer doesn't show the page's unsaved dots; a task run in the page shows in the page's own panel.
- Rail icons follow what is installed on the server (`extensions.json`), not VS Code's `when` clauses or a
  disabled state: an installed extension whose container VS Code hides still has its icon, and opening it says so.
- The Remixicons for the built-ins are the closest OpenChamber's sprite has to VS Code's codicons.
- On an adapted OpenChamber this extension's rail entries replace its one `plugin:oc-forge-vscode` icon; a check
  that compares the rail with a stock build's turns the extension off first.

## Layout

| Path | Role |
|---|---|
| `src/` | Pure code: settings and open requests (`settings.ts`), which install files the browser loads (`clientFiles.ts`), the patches (`patch.ts`), the workbench configuration and request routing (`workbench.ts`), the rail entries (`rail.ts`), the roles and editors between frames (`surfaces.ts`) |
| `service/` | The local service (Node): the VS Code Server (`server.ts`), the prepared workbench (`assets.ts`, `web-files.json`), web socket tunnels (`tunnel.ts`), the workbench's storage (`state.ts`), the rail (`rail.ts`), editors handed to the page and its saved tabs (`editors.ts`) |
| `workbench/` | The VS Code view (panel and page): connection form, boot, shims, tunnel client, IndexedDB; the roles in OpenChamber's own surfaces (`surfaces.ts`) and the VS Code services they use (`vscode.ts`) |
| `panel/` | The background frame: "Open in VS Code" on a chat |
| `webview/` | The webview host page (`host.ts`, built to `host.js` with the agent inside) and the agent that runs in each webview's content (`agent.ts`); `content.ts` makes a webview's HTML self-contained |
| `scripts/web-files.ts` | Lists the browser's files of a VS Code Server install for `service/web-files.json` |

## Build

```sh
bun install
bun run check                      # tsc, strict
bun test tests/                    # VSCODE_SERVER_DIR=<install> also patches a real compiled workbench
bun run build                      # workbench/main.js, panel/main.js, service/main.js
node tests/e2e/run.mjs http://<bind>:35310   # on the host, against the dev container
node tests/e2e/tunnel-leak.mjs               # against the adapters' scratch stack (its header says how)
node tests/e2e/surfaces.mjs                  # against the adapters' scratch stack's adapted instance (its header says how)
```

`tunnel-leak.mjs` opens a workbench in a scratch OpenChamber, closes the browser, and checks that every
connection to the VS Code Server ends and that the server starts the grace after which it frees the extension host,
for each of the run's management connections (the server notices a closed one up to 30 s late).

`surfaces.mjs` checks OpenChamber's own surfaces at 1440×900 and 1024×768, with screenshots: the five built-ins
as rail icons, each opening its view alone; an extension it builds and installs with the server's CLI getting
its icon, opening its view, and losing the icon when uninstalled; files from the Explorer as header tabs (the
editor in the main area, kept across a chat, the unsaved dot, closing asks to save in a prompt within the page's
frame, no VS Code tab bar); the terminal at the bottom (a command, a second terminal, a split, the shell picker, kept
while file tabs show); Ctrl+Alt+→ and Ctrl+1 acting in VS Code; nothing opening another page but the Ctrl+click tabs;
the page with session tabs off keeping VS Code's tab bar; Additional Views as extensions come and go (95 containers,
then one more installed and uninstalled while the rail view stays mounted: reopened, it lists exactly the containers
behind it then and opens each, and the Explorer shows, lit, once the container shown is uninstalled); 66 files opened
through VS Code's Quick Open in the page, past the 64 tabs the host had room for (each has its header tab, the last
selected, in view and named by the address bar; the strip's list holds every one and opens the 30th; the last, switched
to from its tab and closed unsaved from the header, asks to save: Cancel keeps it, Don't Save closes it, and the file
shown next is the selected tab and the address bar's; `4ac4898`'s build failed all of these).
At 1440×900 also: Markdown's preview in the stock instance's
whole workbench (it renders, a key pressed in it reaches VS Code, Reload Window restores it), in the page and in a
rail view; Ctrl+click on a link in a rail view (the probe extension's welcome view) and on a file link in the terminal
opening a new browser tab on that file's editor while this tab stays as it was, a plain click opening it here;
OpenChamber's rail digits (Ctrl+Alt+digit) reaching it from the rail view, the page and the terminal, Alt+W from a
rail view, Alt+W staying VS Code's in the editor and the shell's in the terminal; "Open in VS Code" on a chat in a
second project and back; the terminal under a file's editor (`keepBottomZone`: the page ends where the bottom zone
begins, both take input, both stay through a chat); closing the last unsaved file tab (Cancel keeps the tab, the
editor and the change; Don't Save closes without writing, and the file opens again as on disk; Save writes; each back
to the chat), and across a reload the tabs coming back once each (Markdown's preview too), tabs chosen while the page
starts ending on the one chosen last, and closed ones staying closed; the page alone (as a new browser tab from
Cmd/Ctrl+click loads it, no rail view or terminal): its last tab closed, the hidden page keeps the folder's tabs
empty, and nothing comes back after a reload; a Cmd/Ctrl+click on a file tab opening that file in a new browser tab
while this one stays as it was, VS Code's rail view and page then working in both browser tabs, each sending its
service requests over a WebSocket of its own (the adapters' transport); and three browser windows in a row each
opening the terminal and running a command in it, the terminal's part adding no terminal to the ones VS Code
reconnects. It writes each size's start times and memory to `<size>-frames.json`. Run the stack's `prepare` outside a
private network namespace (it downloads), then `up`, the check and `down` inside one.

`run.mjs` checks the dev container, whichever OpenChamber it runs; its catalog tells (an adapted server publishes the
extension's `ocForge` block). On a stock OpenChamber it connects the panel to the VS Code Server and checks the
whole workbench there, then the page; on an adapted one it goes through the rail entries (Explorer, Source
Control, Search), the editor page with its header tabs and the terminal at the bottom. Either way: the Explorer,
file icons, the editor's grammar colors, a save with Ctrl+S, Markdown's preview (a webview), Source Control and its
diff editor, Search, the terminal, state kept across a reload (on an adapted one: the tabs back once each, the
cursor where it was, and once closed, the folder's saved tabs as before the run), "Open in VS Code" on a chat,
that OpenChamber's own editor still opens a search hit at its line, and that no other page or tab opened. It puts
the demo project's README, the extension's settings, the folders' saved tabs and its chats back afterwards, closes
its tabs and terminal, and clears its Search query.

After the VS Code pin moves, refresh `service/web-files.json` from a server of that release and one of the release
before it, and run the tests against the new one (every patch, the surface patches too, must apply once).
Microsoft's web server of the pinned version has the same compiled workbench. The list is both releases' files, so
a server one release behind the pin, prepared over HTTP, still gets all of its own (a listed file its release lacks
answers 404 and is skipped); it is now 1.144.0's 310 files and 1.143.1's 397, 401 in all, which hold all of
1.140.0's too. A copy prepared over HTTP records the list it came from and is prepared again from a newer one, so
it gains the files added since; a copy made from the install on the same machine has them all already:

```sh
for v in 1.144.0 1.143.1; do
  mkdir -p /tmp/vscode-server-$v
  curl -fsSL https://update.code.visualstudio.com/$v/server-linux-x64-web/stable | tar -xz -C /tmp/vscode-server-$v --strip-components=1
done
bun run web-files /tmp/vscode-server-1.144.0 /tmp/vscode-server-1.143.1
VSCODE_SERVER_DIR=/tmp/vscode-server-1.144.0 bun test tests/
```

## Install

In OpenChamber: Settings → Extensions, add the folder (`/extensions/vscode` in the dev container) and approve its
local service. Open the VS Code panel and give the VS Code Server's address as the machine running OpenChamber
reaches it, and its connection token: in the dev container `http://vscode:8000` and `VSCODE_CONNECTION_TOKEN` from
the secrets file; with `code serve-web --connection-token <token>` on the same machine, `http://127.0.0.1:8000`.
The first start prepares about 40 MB of that VS Code release inside the extension's folder (`vscode-web/`,
ignored by git); later starts take a second or two.
