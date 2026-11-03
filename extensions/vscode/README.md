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
once it has restored its parts, through VS Code's layout service, and every part keeps it when VS Code brings a part
back: a view never shows an editor area or a panel, the page never a side bar or a panel, the terminal its panel
maximized (`workbench/layoutGuard.ts`). It lays the part out again on a timer, never in the task VS Code changed it
in: a terminal made in a rail view once made VS Code show the panel again from each change, and a re-layout queued as
a microtask never let the frame paint or answer, freezing all of OpenChamber while its renderer grew by gigabytes.
When VS Code changes a part back more than 8 times in a second, the part leaves it as VS Code has it for a while (1 s,
doubling up to 30 s) and logs which parts it fought over.

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
  gets `tab-activated`, takes the request (`/editors/take`) and opens it.
- An editor with no file to name it goes by VS Code's own command (`workbench/handoff.ts`): Settings and Keyboard
  Shortcuts with their query (no part opens editors as modals: `workbench.editor.useModal` is off), a search editor
  with its configuration, read from the editor (the page searches again: the Search view's "Open in editor" and a
  new search editor alike), a walkthrough at its step, an extension's details through `_extensions.manage` (installed
  here, no gallery), then `extension.open` (the gallery). Its tab has the key the page gives the editor (an
  extension's details by its extension, so choosing it again reuses the tab) and opens unselected: the page finds the
  request (`/editors/pending`), opens the editor, and only then selects its tab, which shows the page; an editor that
  doesn't open closes its tab and says why. A view's editor that can't be handed over at all (a webview of its
  extension host) doesn't open there: Markdown's preview opens in the page by the command that just made it, anything
  else says it can't open from the rail. The terminal still opens its own (a terminal moved into its editor area).
- A side bar VS Code opens in the page (Ctrl+Shift+E/F/G/D/X, Ctrl+B, Reveal in Explorer, Run and Debug as a session
  starts) opens on the rail instead (`workbench/sideBars.ts`): the page lights the container's entry with
  `forge.rail.open`, and what the entry should show waits in host storage for this browser tab
  (`view-request:<window id>`: a container behind Additional Views, the file to reveal), where the rail view takes it
  as the entry opens, or within 500 ms when it shows already, and reveals the file (`revealInExplorer`).
- The page keeps its tabs in the service, per server and folder, and per browser tab (`/tabs/save` with
  `forge.window.id()`, which the tab keeps across its reloads); after OpenChamber reloads, the rail view opens that
  tab's again (`/tabs/load`), or the folder's latest in a browser tab that kept none, which mounts the page behind
  them, and the page's VS Code restores the same editors. Two browser tabs on a folder no longer take each other's
  tabs on a reload; the lists of all but a folder's 64 latest browser tabs go. After the page's last tab closes,
  OpenChamber keeps the page a few seconds more, hidden (the
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

**One window's chrome.** What VS Code's one window shows about its parts, the parts show in OpenChamber's places:
- The rail panel's header names the entry it shows ("Explorer", "Search"), not the extension, through OpenChamber's
  own slot for a surface's header (`ContextPanelHeaderToolbar`; the adapters' `useOcForgePanelTitle`). VS Code's own
  title row stays under it: it holds the container's actions and its "…" menu (a one-view container such as Search
  or Source Control has its view's actions only there), as VS Code shows it under the activity bar's icon.
- VS Code's activity badges (Source Control's changes, the Extensions view's updates, an extension's own count) are on
  the rail icons, open or not (`workbench/badges.ts`): each part reads `IActivityService` for the containers the rail
  lists and sends its counts when they change (`forge.rail.setBadges`); the rail shows each entry's count from the part
  that saw it change last. Each part
  keeps its own Source Control, which VS Code refreshes while that part has the focus, and the bridge refreshes when
  another part's Git changes (*One VS Code across the parts*), so the parts count the same changes.
- The bottom shows no VS Code "Maximize Panel" or "Hide Panel": OpenChamber's bottom zone has its own, and no host API
  lets a frame act on the zone. VS Code contributes Hide Panel with no `when` and has no setting for either, so the
  terminal part's CSS hides them (`PART_CSS`).
- The page's status bar is the editor's: no remote indicator or keyboard layout (OpenChamber names both already),
  then, as the page narrows beside the rail panel, no branch and sync (below 720 px), then no bell, language status
  or problems count (below 440 px): the language, indentation, encoding, line endings and line and column stay in
  sight down to the page's 340 px at 1024 (`PART_CSS`, by status entry id; VS Code has no setting). Below 600 px the
  page shows no minimap, and as the user has it when it widens (`workbench/minimap.ts`): `editor.minimap.enabled` in
  memory for each open editor's resource, as VS Code merges a folder's settings with the global memory layer into a
  cache a memory change doesn't clear, so a global value set later never reached a file's editor.
- Split, each of the page's groups shows one tab naming its editor (`workbench.editor.showTabs: single` while there
  is more than one group, `none` again after); zen mode shows none (`zenMode.showTabs: none`).
- A part keeps the boot screen over it, busy, until it shows what it is for (the rail its view, the page its editor
  or nothing to open, the bottom its terminal), rather than a blank frame while VS Code starts. The rail view asks
  OpenChamber to start the page with it (`forge.page.warm`), hidden, so the first file it opens shows at once rather
  than after VS Code starts in the page (see **Cost**).

**State.** One store per server for the user's data (settings, keybindings, snippets: VS Code's `vscode-web-db`),
shared by every frame and by the whole workbench of a stock OpenChamber; one store per role for VS Code's state
databases (layout, open editors, view state, extensions' state: `vscode-web-state-db-*`), so the parts don't
overwrite each other's layout (`service/state.ts`, `<server>.<role>.json`). The page starts from the whole
workbench's state (its open editors), the others from nothing. Two frames that both write the same user file (each
saved `settings.json`) still keep the later one, as two windows of the whole workbench did. VS Code for the web
saves its state every few seconds only while its document has focus, but the focus is often in OpenChamber while a
frame's state changes (a preview's, the editors the header opens), and a frame can't save as it unloads. So a frame
without the focus saves too, through `IStorageService.flush()`, 5 s after something changed (`saveInBackground` in
`workbench/storage.ts`): what VS Code's interfaces report (editors, view containers, stored values, a webview's own
state) and the user's input in the frame, one save at a time, none while nothing changed. A browser reload keeps
what was saved a few seconds before. VS Code's own save before it reloads (`flush(SHUTDOWN)`) waits for the
service.

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

**Focus.** A frame takes the keyboard focus only for the user (`src/focus.ts`). VS Code focuses a part as it starts
(`Layout.restoreParts`), and each part focused what it showed, so a frame that started or reloaded while the user was
elsewhere in OpenChamber took the focus from them. After "Open in VS Code" the rail view, the page and the terminal
reload on the new folder, and a folder's rail panel starts when one of its chats shows. Before this guard, every
"Open in VS Code" round trip saw 3–5 such grabs. The focus left the menu the user had just opened (OpenChamber's
menus close when they lose it) or the composer they were typing in. Now, from before VS Code runs, a focus call
(`element.focus()`, `window.focus()`) takes effect only:
- while the frame has the focus already;
- within 2 s of the user acting on it: a click, a touch, a key or a drop in it;
- when the user chose something in it through OpenChamber, as it opens:
  - a rail entry: its view container, as VS Code's activity bar focuses it, and the quick pick behind Additional Views;
  - a header tab, while the page still shows it;
  - an unsaved tab being closed: VS Code's save prompt;
  - a link followed.

That moment ends early when the frame loses the focus. The terminal takes the focus when it is opened, as
OpenChamber's own terminal does, but not when it reloads to follow the folder (the frame marks that reload in
`window.name`). A view or a page that OpenChamber starts by itself (a rail panel opening, a chat in another folder, a
reload) takes the focus only on a click. The "OpenChamber is now in …" notification shows at the bottom of the rail
view and takes no focus.

A webview (Markdown's preview, an extension's page or view) goes by the same rule. VS Code focuses one through its
frame's window: `WebviewElement._doFocus` calls `iframe.contentWindow.focus()`, a cross-origin call no `element.focus()`
guard sees, then posts the webview `focus` for its content. A preview restored as the page's active editor took the
focus that way each time the page started again behind a chat (the way back from "Open in VS Code", a reload). Now:
- every webview the webview service makes (`IWebviewService.createWebviewElement`, the same in 1.140 to 1.144) has its
  `focus()` guarded. The service is a delayed one, a proxy that keeps the first function read through it, so the
  guard takes the original from the class and puts its own in before anything reads it (`guardWebviews`);
- the `focus()` VS Code gives the webview's iframe goes through the guard too;
- the host page (`webview/host.ts`) passes VS Code's `focus` on to the content only while its own frame has the
  focus, as it already did when content loads, so a late one (the content still loading) doesn't take the focus back
  from where the user went. This page serves the stock panel's webviews too; nothing the user does there changes.

A click into a webview, choosing its header tab, Find (Ctrl+F, Enter, and Escape back into it) and Ctrl+C work as
before.

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
  editors closed before) opens once the page is ready, and takes the focus then if the page still shows it.
- The adapted OpenChamber sends a window's service requests over one WebSocket (its transport, which Chrome pools
  apart from the six connections), so two browser tabs each run VS Code's parts. Where they go over plain HTTP
  instead (an adapted build before the transport, or with it off, `oc-forge:service-socket` in localStorage), a
  second browser tab with VS Code's parts (a Cmd/Ctrl+click tab beside the first) makes six polls and two event
  streams, more than Chrome's six connections per host, and starves: on the scratch stack the second tab's VS Code
  didn't show its file within 2 minutes, and the first tab stopped answering too until the second went. Over HTTPS
  (HTTP/2, e.g. `tailscale serve`) requests share one connection and the per-host limit doesn't apply.
- Each part has its own extension host: an extension's webview opened from a view (but Markdown's preview) doesn't
  open, and says so; the Explorer doesn't show the page's unsaved dots. A terminal or task started in the page or a
  view runs at the bottom through the bridge (*One VS Code across the parts*); without the bridge it runs in that
  part, its panel hidden.
- Rail icons follow what is installed on the server (`extensions.json`), not VS Code's `when` clauses or a
  disabled state: an installed extension whose container VS Code hides still has its icon, and opening it says so.
- The Remixicons for the built-ins are the closest OpenChamber's sprite has to VS Code's codicons.
- On an adapted OpenChamber this extension's rail entries replace its one `plugin:oc-forge-vscode` icon; a check
  that compares the rail with a stock build's turns the extension off first.

## One VS Code across the parts

The rail view, the page and the bottom terminal of one OpenChamber window are three VS Code workbenches, each with
its own extension host and state (*Roles* above). The bridge extension (`bridge/src/*.ts`, bundled to
`bridge/main.js`) runs in each one's extension host and makes them one VS Code: one debugger, one list of terminals
and tasks, one Problems list, one Output, file operations and Git that every part follows. The bottom terminal's
workbench is the window's **runtime**: debug sessions, terminals and tasks run there, and its panel (Terminal,
Problems, Output, Debug Console) is VS Code's own, at the bottom where VS Code has it. The page and the rail send it
what they start, and mirror its debug sessions.

Without the bridge (not installed yet, or disabled) each part works on its own, as before, and the rail says so once
per window (a notification with "Show Extension"). The frame installs the bridge itself (*Deployment*).

### The parts' bus

1. Every part's extension host runs on the VS Code Server's machine, so the parts meet on a Unix socket there:
   `$TMPDIR/ocvsb-<uid>/<sha1(host|folder|window)>.sock`, in a 0700 directory. One hop: a relayed debug request
   takes {{relay.median}} ms (median).
2. **One bus per OpenChamber window.** `window` is the frame's `forge.window.id()` (the same in every frame of a
   browser tab, another in each tab). Each browser tab is a VS Code window of its own, as VS Code's windows are: its
   own runtime, sessions, terminals and tasks. On a host without `window-id`, the bus is per folder.
3. The first part listens and relays JSON lines; the others connect. When it goes, the next part to notice listens,
   one at a time under a lock file (`<name>.lock`, holder's pid, taken over when its process is gone).
4. A request for a part (`view`, `editor`, `terminal`) goes to one member of it, the first that joined (a reloaded
   frame's old extension host lingers until it leaves).
5. A window that went leaves its extension host on the server for VS Code's reconnection grace. Its parts leave the
   bus while their frame doesn't answer (`openchamber.vscode.bridge.info`, every 2 s, away after 3 s). Only one
   question waits at a time (a disconnected host queues calls), and the wait between questions doubles up to 60 s.

### Debug

- **Breakpoints: one list per folder.** Within a window, every change goes to the other parts at once (breakpoints
  API). It is also kept in a file on the server (the bridge's global storage, one per folder), changed as a change
  (put, remove) under a lock, so a window that hasn't heard of another's change doesn't undo it. **Across windows the
  list does not follow live** (VS Code's own windows don't share breakpoints either): a part takes the file's list
  when it joins its window's bus, so a new or reloaded tab has every tab's breakpoints.
- **A launch from the page or the rail** (F5, the Run and Debug view, Select and Start Debugging) is caught in the
  `'*'` provider's `resolveDebugConfiguration`, after the type's own providers and before VS Code substitutes
  variables and runs the preLaunchTask. What only that part can resolve (the editor's `${file}`, `${lineNumber}`, …;
  `${input:…}` and `${command:…}`, which ask the user there) is resolved there; a launch from the rail that names the
  editor goes to the page for it. The runtime starts it (`startDebugging` with the debug view, toolbar and status
  bar suppressed), and its preLaunchTask runs there, once.
- **A compound launch** runs its own preLaunchTask before its configurations reach any provider, so the frame catches
  it whole (`IDebugService.startDebugging`, named or the selected one) and the runtime starts it: its task once, its
  `stopAll`.
- **Mirrors.** The page and the rail show each of the runtime's sessions as a session of type `openchamber-mirror`
  (hidden from pickers) with an inline adapter that relays every DAP request to the real session
  (`customRequest` in the runtime) and gets its events back (a `'*'` tracker there).
  - The page shows the editor's debug UI (paused line, hovers, inline values, F10/F11, the floating toolbar); the
    rail shows the Run and Debug view (call stack, variables, watch, breakpoints). Neither shows a Debug side bar of
    its own in the page.
  - A child session (js-debug's process under its launch) is mirrored under its parent's.
  - **Restart** (Ctrl+Shift+F5, the toolbar) is VS Code's own restart in the runtime
    (`workbench.action.debug.restart` with the session), its tasks included. Mirrors start with no folder, so
    VS Code's restart of a mirror never reads launch.json again.
  - **Breakpoint verification** is the real adapter's: the runtime's tracker reads its `setBreakpoints` answers and
    `breakpoint` events, and each mirror tells its VS Code (verified, moved lines, messages).
  - **Stop** from any part (Shift+F5, the toolbar, the call stack) stops the real session, and its end ends every
    mirror. A window that closes or reloads only disconnects its mirrors: the real session goes on.
  - A bridge installed while the window runs waits until VS Code knows the mirror's type
    (`IAdapterManager.getDebugger`) before it starts one.

### Terminals and tasks

The page and the rail make no terminal of their own: they show at the bottom, and the bottom opens for them
(`forge.rail.open('terminal')`, as VS Code opens its panel).

- **VS Code's commands** that make or show a terminal are the bridge's in the page and the rail (an extension's
  registration of a command id is the one keys, menus and the palette run), and run in the runtime:
  `workbench.action.terminal.new`, `newWithProfile`, `newWithCwd`, `newLocal`, `newInActiveWorkspace`, `split`,
  `splitActiveTab`, `splitInActiveWorkspace`, `toggleTerminal` (Ctrl+`), `focus`, `runSelectedText`,
  `runActiveFile`; `createTerminalEditor*` (a terminal at the bottom, as the bottom shows no editor area); the
  Explorer's `openInIntegratedTerminal` and `openInTerminal` (in that folder); and the running tasks' `reRunTask`,
  `restartTask`, `terminate`, `showTasks`, `showLog`.
- **Tasks** VS Code starts in the page or the rail (Run Task, Run Build Task, a task an extension runs through the
  API, the NPM Scripts view) are caught in `ITaskService.run`, as no extension can catch them before they run. The
  runtime finds the same task (`vscode.tasks.fetchTasks`, by source, label and definition) and runs it.
- **A terminal an extension makes** in the page or the rail (`createTerminal`) is its handle on a process on the
  server's pty host. The frame creates it hidden (`hideFromUser`) and the runtime attaches to the same process
  (`ITerminalService.createTerminal` with `attachPersistentProcess`): the user sees it in the bottom's list, and
  `terminal.show()` shows it there (`showBackgroundTerminal`, `ITerminalGroupService.showPanel`). An extension's own
  pseudoterminal (its process is the extension's, in that part) can't move: it stays, with a notice.
- **The panel's views** are the bottom's: Ctrl+J, Problems (Ctrl+Shift+M), Output (Ctrl+Shift+U) and the Debug
  Console pressed in the page or the rail open the bottom on that view. A guard closes the page's and the rail's
  panel if anything else shows it.

### Problems, Output, Outline, Timeline

- **Problems, both ways.** Each part publishes the diagnostics it has of its own (`languages.getDiagnostics`, without
  those it mirrors); the others mirror them into a diagnostic collection. The bottom's Problems lists the page's
  language servers' problems; the page's editor marks a task's problem matches; the rail's Explorer colours files.
- **Output.** The page's and the rail's output channels are in the bottom's Output as "<name> (page)" and
  "<name> (rail)". Each extension host writes its channels to files on the server (`output_logging_*/<n>-<name>.log`,
  `<extension>/<name>.log`); the page's and the rail's bridges list theirs, and the runtime's appends what each file
  gains to a channel of its own. (Not `IOutputChannelRegistry.registerChannel`, planned first: the registry is a
  module singleton, not a service, so a frame can't reach it without a new patch; and
  `IOutputService.registerCompoundLogChannel`, a service member, parses log lines, which would garble a plain channel.)
- **Outline and Timeline in the rail** follow the page's editor: the page publishes its active editor's symbols
  (`vscode.executeDocumentSymbolProvider`) and cursor; the rail's Outline shows them, follows the cursor, and a
  symbol chosen there is revealed in the page. The Timeline is the file's Git history (the Git extension's API),
  loaded again when Git opens the repository or HEAD moves; a commit opens its diff in the page. VS Code's own
  Outline and Timeline, which follow the rail's active editor (it has none), are hidden in the rail while the bridge
  runs (`IViewContainerModel.setVisible`), and shown again when it doesn't.

### Files, Undo, Search, Source Control

- **Rename, move, delete.** A file operation in the rail (or the bottom) is announced by the stable
  `workspace.onWillRenameFiles`/`onDidRenameFiles`/`onWillDeleteFiles`/`onDidDeleteFiles`; VS Code waits for the
  page's answer before it runs the operation.
  - Before: the page keeps the unsaved text of the files concerned and marks their models saved (VS Code's soft
    revert), so no save, the user's or auto-save's, writes the old name again.
  - After a rename or move: the page moves each editor of it to the new name where it was, with its view state
    (VS Code's own move: `EditorInput.rename`, `IEditorService.replaceEditors`), and its unsaved text is unsaved in
    the new name's model. The header tab and the route follow the editor (their key is its file). The new header tab
    comes last: the host's tab API has no position.
  - After a delete: the page's editors of it are marked deleted (VS Code's own mark, the file read again); their text
    stays shown.
- **Undo and Redo** on a file the page has nothing for (Ctrl+Z in the page after the rail's Explorer deleted or
  renamed it) go to the part that ran the operation (`IUndoRedoService.canUndo`/`undo`, asked of each part in
  turn). One window's undo would take the newest of the file's text edits and file operations; here a part's own
  text edits come first.
- **Search's replace preview** opened from the rail shows in the page: the page's bridge serves its content (a
  content provider of VS Code's `private` scheme, asked before VS Code's own) from the rail's search, and follows a
  new replacement typed there.
- **Source Control.** When a part's Git repository changes (a stage, a commit, a checkout: the Git extension's
  `repository.state.onDidChange`), the other parts run `git status` on theirs. A refresh to a state already
  announced isn't announced again, so the parts don't ping-pong.

### Testing

Each part's extension host runs the test extensions, each with its own controllers, items and results:

- the rail's Testing view lists the rail's tests; a run from there runs in the rail's extension host, and its pass
  or fail shows there;
- the page's gutter shows the page's own controllers' items, and a run from the gutter runs and shows in the page;
- the Test Results view is a panel view: the page's and the rail's never show (their panels stay closed), and the
  bottom's shows only runs of the runtime's own controllers;
- **Debug Test**, and any launch an extension starts in the page or the rail (`vscode.debug.startDebugging`, named
  or a configuration), runs in the runtime like the user's, and the extension gets its session where it asked, as
  from one VS Code window: `startDebugging` answers true, and the session is that part's mirror of the runtime's,
  which ends when it does, so a test run's Debug lasts as long as its session. The frame tells an extension's launch
  from the user's by VS Code's own mark on the user's (`IDebugSessionOptions.startedByUser`: F5, the Run and Debug
  view, its pickers) and marks it, with the debug UI that part shows for every mirror; the launch provider then
  answers with the mirror's configuration instead of nothing (`resolveDebugConfiguration`), bound to the session the
  runtime started (`debug.startSession`), and the other part mirrors it as any other.

Routing the run commands (`testing.*`, the gutter's) to the runtime would show results in the bottom's Test Results
but not in the rail's tree or the page's gutter: no stable API hands one controller's results to another
extension host's.

### Deployment

1. The service builds the bridge's .vsix from `bridge/package.json` and `bridge/main.js` (stored zip entries, a
   fixed date: the same bytes each time), stamped with the bundle's hash (`openchamberBuild`): `/bridge/package`.
2. A frame that finds the bridge missing or of another build claims the install (`/bridge/claim`, one frame per
   server and build), writes the .vsix to the server (`IFileService.writeFile`, into the extensions' global storage)
   and installs it with the documented `workbench.extensions.installExtension`. VS Code starts an extension
   installed while it runs, in each window: the parts join within seconds.
3. The bridge tells its frame it runs, and which build (`openchamber.vscode.bridge.hello`). Until then, everything
   the frame catches runs as VS Code's own.

### Interfaces

| Interface | Kind | Used for |
|---|---|---|
| `vscode.debug`: breakpoints API; `registerDebugConfigurationProvider('*')`; `registerDebugAdapterTrackerFactory('*')`; `registerDebugAdapterDescriptorFactory` with `DebugAdapterInlineImplementation`; `startDebugging` with `DebugSessionOptions`; `stopDebugging`; `DebugSession.customRequest`; `onDidStart/TerminateDebugSession` | stable | debug, mirrors |
| Debug Adapter Protocol | stable | the mirror |
| `vscode.commands.registerCommand` with VS Code's command ids (the documented keybinding commands); `executeCommand` (`workbench.action.debug.restart`, `workbench.extensions.installExtension`, the panel views' `.focus`) | stable | terminals, tasks, the panel's views, restart, install |
| `vscode.tasks.fetchTasks`, `executeTask`; `window.createTerminal`, `activeTerminal`; `window.createOutputChannel` | stable | tasks, terminals, Output |
| `languages.getDiagnostics`, `onDidChangeDiagnostics`, `createDiagnosticCollection`; `executeDocumentSymbolProvider`; `window.createTreeView` | stable | Problems; Outline |
| `workspace.onWill/DidRenameFiles`, `onWill/DidDeleteFiles`; `registerTextDocumentContentProvider`; `openTextDocument`, `onDidChangeTextDocument` | stable | file operations; the replace preview |
| The Git extension's API (`vscode.git`, version 1): `repositories`, `onDidOpenRepository`, `getRepository`, `state.onDidChange`, `status`, `log`, `toGitUri` | stable (the extension's) | Source Control across parts; Timeline |
| Node's `net`, `fs`; `ExtensionContext.globalStorageUri`, `logUri` | stable | the bus, the breakpoints' file, Output |
| Embedder API `commands` (`web.api.ts`) | stable | the frame's commands for the bridge (`openchamber.vscode.bridge.*`) |
| The frame's catches and calls listed in *Which VS Code internals the frames use* | internal, interface members | what no extension can reach in another window |

### Measured

{{measured}}

### Limits

- The mirror's type is `openchamber-mirror`, so UI an adapter's extension adds for its own type (js-debug's "Toggle
  Skipping This File", …) doesn't show in the page or the rail. Its custom requests, through the mirror, work.
- Every debug request takes one more hop ({{relay.median}} ms median, {{relay.p95}} ms p95).
- An extension's own pseudoterminal stays in its part (with a notice).
- A renamed file's header tab comes last in the strip (the host's tab API has no position).
- Undo order across parts: a part's own text edits on a file come before another part's file operation on it.
- Testing: see above.
- `runOn: folderOpen` tasks run in each part as VS Code starts them, before the bridge says hello.

## Which VS Code internals the frames use

Each VS Code service member a frame calls is a member of a VS Code service interface (`IEditorService`,
`IEditorGroupsService`, `IWorkbenchLayoutService`, `IPaneCompositePartService`, `IViewsService`, `IQuickInputService`,
`INotificationService`, `IConfigurationService`, `IRemoteAgentService`, `IFileService`, `ICommandService`,
`IEnvironmentService`, `ITerminalService`, `IStorageService`, `IWebviewService`, `IKeybindingService`,
`IActivityService`), or a public
member of a class those interfaces hand out (`EditorInput`, `URI`, `DisposableStore`). `workbench/vscode.ts` declares
each under its VS Code interface's name, and `tests/vscode-api.test.ts` holds every declaration to the pinned source
(`vendors/vscode`): a protected, private or class-only member fails it. That is VS Code's internal API, not the
`vscode` extension API: stable in practice, checked on each release. Beyond it, the frames use:

| What | Interface or class | Why | What it would take to drop it |
|---|---|---|---|
| The instantiation service and the service identifiers by name (`__ocVSCode.services`, `serviceIds`) | Two of the surface patches to the compiled workbench (`src/patch.ts`) | The embedder API (`web.api.ts`) hands out no services, and a frame needs the editor, layout, view and storage services to be one part | An embedder API that hands out services, or the parts' events and control |
| `EditorInput`'s `typeId`, `editorId`, `resource`, `getName`, `isDirty`, `toUntyped`, `matches` | Public members of the abstract class `IEditorService` hands out for each open editor | To name an editor (its header tab's key and title) and hand it to the page | Nothing: they are its public API, and VS Code has no interface for it |
| `URI.revive` and `URI.parse` | Public static members of class `URI`, reached through the constructor of a URI `IEnvironmentService` holds (`VscodeServices.uriClass`) | The editor service takes VS Code's own URIs (an editor from another frame arrives as JSON) | The bundle the frame loads (`code/browser/workbench/workbench.js`) exporting `URI`, as VS Code's embedder module (`workbench.web.main`) does |
| `IEditorService.openEditor` and `openEditors`, replaced on the service in a rail view and the terminal | Interface members; replacing them is the frame's | An editor opened there goes to the page as a header tab; VS Code has no hook before an editor opens that can send it elsewhere | An event before an editor opens that can redirect it |
| `IStorageService.flush`, wrapped on the service (`saveThroughService`) | Interface member; wrapping it is the frame's | VS Code's own reloads (`flush(SHUTDOWN)`, then reload) wait until the service has the state; in the browser, `ILifecycleService`'s shutdown events can't hold a reload for that | A lifecycle join that holds an expected reload |
| `IWebviewService.createWebviewElement` and each webview's `focus`, wrapped (`src/focus.ts`); the original method is read from the class, as the delayed service's proxy keeps the first function read through it | Interface members; the proxy's behavior is `InstantiationService`'s implementation | A webview takes the focus only for the user, as the rest of a frame does | A focus policy for webviews (or an event when one is created) |
| `_workbench.open`, run by id through the embedder's `IWorkbench.commands`: only on a release the surface patches don't fit, where there are no services (else `IEditorService.openEditor`) | VS Code's internal command behind the extension API's `vscode.open`; the workbench's own `vscode.open` takes no line | "Open in VS Code" on a file at a line | `vscode.open` taking editor options in the workbench |
| Editors' type ids (`workbench.extensions.input2`, `workbench.editorinputs.searchEditorInput`, `workbench.input.settings2`, `workbench.input.preferences`, `workbench.input.keybindings`, `workbench.editors.gettingStartedInput`), the Welcome page's resource (`walkThrough://vscode_getting_started_page`), and the options they open with (settings' `query` and `target`, a walkthrough's `selectedCategory` and `selectedStep`) | `EditorInput.typeId` is public; the ids are each input's own `ID`, the options the editors' (`ISettingsEditorOptions`, `GettingStartedEditorOptions`) | To hand an editor with no file to the page by the command that opens it (`workbench/handoff.ts`) | An editor API that moves an editor between windows |
| A search editor's configuration: `resolveModels()`, then `configurationModel.config` | Public members of class `SearchEditorInput`, read off the editor `IEditorService.openEditor` is given | To run the same search in the page ("Open in editor", a new search editor) | `toUntyped()` describing an untitled search editor |
| Commands and their arguments: `_extensions.manage` (an installed extension's details, no gallery), `extension.open`, `search.action.openNewEditor` (`OpenSearchEditorArgs`), `workbench.action.openSettings`, `openWorkspaceSettings` and `openRemoteSettings` (`{ query }`), `workbench.action.openGlobalKeybindings` (its query), `workbench.action.openWalkthrough` (`{ category, step }`), `markdown.showPreview`, `showPreviewToSide` and `showLockedPreviewToSide` (watched in a view, run again in the page), `revealInExplorer` (a URI); `workbench.files.action.showActiveFileInExplorer` watched in the page | Run through `ICommandService.executeCommand`, watched through `onWillExecuteCommand`; `_extensions.manage` is VS Code's internal command behind `extension.open`'s fallback | The page opens what a view chose; the rail reveals what the page asked for | Nothing for the documented ones; an `extension.open` that doesn't ask the gallery for an installed extension |
| `NumberBadge.number` | Public field of the class every count badge is (`IActivity.badge` is an `IBadge`, which has only `getDescription`) | The count on a rail icon (`workbench/badges.ts`) | `IBadge` naming its count |
| Status bar entries' element ids (`status.host`, `status.workbench.keyboardLayout`, `status.scm.*`, `status.notifications`, `status.languageStatus`, `status.problems`), the panel title's global actions' codicon classes (`panel-close`, `panel-maximize`, `panel-restore`), and a started part's look (`.part.sidebar .pane-body`, `.part.panel .xterm`) | VS Code's DOM, in a part's own CSS (`PART_CSS`) and its boot screen (`workbench/main.ts`) | Which status items a narrow page drops and which panel buttons the bottom doesn't show, which VS Code has no settings for; when the boot screen lifts | Settings for status items and the panel's title actions |
| The webview host page's protocol (`webview/`: `webview-ready` with `mountId` and `keyEventToken`, `load-resource`, the key and focus messages) | Internal, between `WebviewElement` and its host page (`webview/browser/pre/index.html`) | VS Code's own host page needs a service worker, `crypto.subtle` and a same-origin content frame, none of which an opaque-origin extension frame has | VS Code hosting webviews without them, or frames on real origins |
| The other patches to the compiled workbench: the embedder's `create()` options, the handshake signature, the webview origin, keyboard support, the editor area's hiding | Compiled code, each matched exactly (`src/patch.ts`); a release they don't fit runs the whole workbench | See "How it fits in an extension frame" and the surface patches above | Each its own: see `src/patch.ts` |
| `ITaskService.run`, replaced on the service in the page and the rail; the task's `_label`, `_source.label` and `getDefinition` | Interface member (replacing it is the frame's); public members of `CommonTask`, the class `run` takes | A task VS Code starts there (Run Task, Run Build Task, an extension's `tasks.executeTask`, the NPM Scripts view) runs in the runtime: no extension API is asked before a task runs, and none runs a task in another window | A task-start participant, or tasks run in the window an embedder names |
| `IDebugService.startDebugging`, replaced in the page and the rail; `getConfigurationManager().selectedConfiguration`; `ILaunch.getCompound`; `getAdapterManager().getDebugger` | Interface members | A compound launch runs its own preLaunchTask before any configuration provider sees its launches, and F5 passes no name: the frame hands the compound to the runtime whole. A bridge installed while the window runs waits until VS Code knows the mirror's type | A provider hook for compounds |
| `IDebugService.getModel().getSession().getThread().getCallStack()`, `getViewModel().focusedStackFrame`, `focusStackFrame` (in the runtime) | Interface members (`IDebugService`, `IDebugModel`, `IDebugSession`, `IThread`, `IStackFrame`, `IViewModel`) | A frame chosen in the rail's call stack is the bottom's too: its Debug Console evaluates in the runtime's focused frame. The API reads `debug.activeStackItem`; nothing sets it | A settable active stack item |
| `ITerminalService.createTerminal` (replaced in the page and the rail: an extension's terminal is created hidden; in the runtime with `attachPersistentProcess`), `showBackgroundTerminal` (replaced), `onDidCreateInstance`; `ITerminalInstance`'s `persistentProcessId`, `processId`, `processReady`, `title`, `titleSource`, `shellLaunchConfig`, `shellIntegrationNonce`, `hasChildProcesses`, `getInitialCwd`; `ITerminalInstanceHost`'s `activeInstance`, `setActiveInstance`, `focusInstance`; `ITerminalGroupService.showPanel` (replaced) | Interface members | A terminal an extension makes in the page or the rail shows at the bottom, attached to the same process on the server's pty host, and `terminal.show()` shows it there. No API shows a terminal in another window | A terminal location in another window, or moving a terminal between windows |
| `IWorkbenchLayoutService.onDidChangePartVisibility`, `isVisible`, `setPartHidden` for the page's and the rail's panel (with the bridge running) | Interface members | A guard: whatever else shows the panel there closes it again (the panel's views are the bottom's) | Nothing to drop: VS Code's own layout API |
| `IUndoRedoService.canUndo`, `undo`, `canRedo`, `redo`: replaced in the page and the rail, VS Code's own in the part asked | Interface members | Undo on a file with nothing for it here goes to the part that ran the file operation (the rail's Explorer); undo stacks are per window | Undo across windows |
| `ITextFileService.files` (`models`, `resolve`); `IWorkingCopy.isDirty`, `revert({ soft })`; `IWorkingCopyIdentifier.resource`; `ITextEditorModel.textEditorModel`; `ITextModel.getValue`, `setValue`; `IEditorService.getEditors`, `replaceEditors`; `IEditorGroup.isPinned`, `isSticky`, `isActive`, `getIndexOfEditor`; `EditorInput.rename` | Interface members; a public method of `EditorInput` | A file another part renames or deletes: the page keeps its unsaved text and marks it saved (no save writes the old name), and moves its editors to the new name as VS Code's own move does. VS Code does this only for operations its own window ran, and the API can neither mark a document saved without saving it nor replace an editor in place | File operation events that every window's editors follow |
| `IViewDescriptorService.getViewContainerByViewId`, `getViewContainerModel`; `IViewContainerModel.setVisible`; `IStorageService.get`, `store`, `remove` | Interface members | VS Code's own Outline and Timeline in the rail (they follow the rail's editor, it has none) hidden while the bridge's stand in for them, and shown again without it (which ones the rail's storage keeps) | Nothing in the API hides VS Code's own views |
| `IExtensionService.extensions`, `whenInstalledExtensionsRegistered`; `ExtensionIdentifier.value`; `IRemoteAgentService.getEnvironment()`'s `appRoot`, `globalStorageHome`; `IFileService.readFile`, `writeFile`; `VSBuffer.wrap` (its class from a file's content `readFile` gave); `INotificationService.prompt` | Interface members; a public static member of the class `IFileContent.value` is | The frame installs the bridge on the server it is connected to: the .vsix written where the server reads it, installed by the documented `workbench.extensions.installExtension`; the rail's notice when it isn't running | An embedder API that installs an extension from its bytes |

## Layout

| Path | Role |
|---|---|
| `src/` | Pure code: settings and open requests (`settings.ts`), which install files the browser loads (`clientFiles.ts`), the patches (`patch.ts`), the workbench configuration and request routing (`workbench.ts`), the rail entries (`rail.ts`), the roles and editors between frames (`surfaces.ts`), the frames' keyboard focus (`focus.ts`) |
| `service/` | The local service (Node): the VS Code Server (`server.ts`), the prepared workbench (`assets.ts`, `web-files.json`), web socket tunnels (`tunnel.ts`), the workbench's storage (`state.ts`), the rail (`rail.ts`), editors handed to the page and its saved tabs (`editors.ts`) |
| `workbench/` | The VS Code view (panel and page): connection form, boot, shims, tunnel client, IndexedDB; the roles in OpenChamber's own surfaces (`surfaces.ts`) and the VS Code services they use (`vscode.ts`); each part's layout kept (`layoutGuard.ts`), editors handed over by command (`handoff.ts`), the page's side bars on the rail (`sideBars.ts`), activity badges on the rail (`badges.ts`) |
| `panel/` | The background frame: "Open in VS Code" on a chat |
| `bridge/` | The VS Code extension that makes a window's parts one VS Code (*One VS Code across the parts*): its sources (`src/`), its manifest, its bundle (`main.js`); the frame's side is `workbench/bridge.ts`, its .vsix the service's (`service/bridge.ts`) |
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
shown next is the selected tab and the address bar's; `4ac4898`'s build failed all of these); "Open in VS Code" on a
chat in a second project and back, the chat's menu opened once each time (no retry), and a menu opened while VS Code
follows the folder staying open, with the focus still in OpenChamber once the rail view and the page have started on it
(`ffd6c44`'s build lost the menu and the focus to a VS Code frame every time); the same with Markdown's preview as the
page's active editor: coming back, the page starts again with the preview active while the menu held open stays open
(`63c9cb1`'s build lost both to the preview's frame every time), then a click into the preview and choosing its header
tab each give it the keys.
At 1440×900 also: Markdown's preview in the stock instance's
whole workbench (it renders, a key pressed in it reaches VS Code, Reload Window restores it), in the page and in a
rail view; Ctrl+click on a link in a rail view (the probe extension's welcome view) and on a file link in the terminal
opening a new browser tab on that file's editor while this tab stays as it was, a plain click opening it here;
OpenChamber's rail digits (Ctrl+Alt+digit) reaching it from the rail view, the page and the terminal, Alt+W from a
rail view, Alt+W staying VS Code's in the editor and the shell's in the terminal; the terminal under a file's editor (`keepBottomZone`: the page ends where the bottom zone
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
private network namespace (it downloads), then `up`, the check and `down` inside one. `SURFACES_ONLY=openInVscode`
(phase functions, comma-separated) runs only those, after the seed. `SURFACES_TRACE=1` writes `toasts.log`: every VS Code
notification and OpenChamber toast shown, where and for how long, among the checks. A full run shows two, both
"OpenChamber is now in …" in phase 10's rail view, for under 2 s.

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
