# OpenChamber adapters

oc-forge's additions to OpenChamber's extension host: what `AGENTS.md` asks
of the Planner that the released extension API cannot do (2.5.2's, 2.5.3's,
whose SDK changed only a comment, and 2.6.1's, whose SDK adds trackers,
notifications and session events but none of these). They are applied to
`vendors/openchamber` while its web package is built; the vendor is never
written. With no extension using them, the adapted OpenChamber looks and
behaves as the release (the end-to-end check compares screenshots: 0.00% of
pixels differ).

| API | `AGENTS.md` | What an extension gets |
|---|---|---|
| **keys** | tab shortcuts | Forward a key press to OpenChamber, which runs it through its own shortcut handlers, for navigation actions only and only with a user activation; the frame is told the current bindings. In an installed app window, Chrome's own tab keys act on OpenChamber's tabs. |
| **links** | Cmd+click | `?extension=<id>&route=<route>` deep links to its page; URL prefixes for real `<a href>` links to its page and to chats; its page can keep its route in the address bar. |
| **modals** | (printing) | Its frames sandboxed with `allow-modals` as well, so `print()` opens the browser's print dialog (the Planner's task lists and calendar). |
| **global panel** | (the Planner in the right panel, the same in every chat) | Its panel is the window's, not a folder's: one frame, loaded hidden at startup, kept through every change of chat or folder; shown or not, and expanded or not, as the user last chose, in every folder. |
| **autostart** | (the Planner starts with OpenChamber) | The server starts its service when OpenChamber starts, and again after each extension change, instead of on a frame's first request. |

Beside the APIs, one fix for a host bug the Planner runs into ("Fixes", below).

The study behind this (what 2.5.2 can and cannot do, and the smallest host
change for each) is zmemory `02-draft/syncopation/2026-10-27-openchamber-extension-surfaces-feasibility.md`.

Until 2026-11-04 the adapters also gave extensions rail entries, header tabs,
default zones, the bottom zone under a page, the window's id, warm pages, rail
badges and a WebSocket for service requests. Only the VS Code extension used
them, and they went with it (Qihang, 2026-11-04). The last tree that has them,
with their contract and end-to-end checks, is `bce1c16`
(`git show bce1c16:adapters/openchamber/README.md`).

## Using it from an extension

Bundle `client/index.ts` (no dependencies) into the frame next to
`@openchamber/sdk`. `connectOcForge()` says hello on its own channel and
resolves with a client when the host answers, or **`null` on a stock
OpenChamber**: that is the whole feature detection; keep the stock behaviour then.

```ts
import { connectOcForge } from '../../../adapters/openchamber/client/index.ts';

const forge = await connectOcForge();          // null: stock OpenChamber
forge?.keys.forwardHostShortcuts({ except: ['toggle_sidebar'] });   // OpenChamber's tab keys go to OpenChamber
link.href = forge?.links.pageUrl(`/task/${id}`) ?? fallbackUrl;     // Cmd+click opens a browser tab
forge?.links.onRoute((route) => show(route));                       // a deep link, back/forward
if (forge?.has('modals')) print();                                  // the print dialog, on this frame's document
```

The manifest additions sit in a top-level `ocForge` block of `package.json`,
beside `openchamber`. OpenChamber's own parser (`@openchamber/sdk`, installed
from npm with the web package) drops keys it does not know, so the same
package installs and runs on a stock OpenChamber.

```json
{
  "openchamber": { "apiVersion": 1, "contributes": { "panel": { "...": "..." } } },
  "ocForge": { "apiVersion": 1, "modals": true }
}
```

## Contract (version 1)

### Manifest: `ocForge`

| Field | Meaning | Needs |
|---|---|---|
| `apiVersion` | `1`; any other value ignores the block | |
| `modals` | `true`: the extension's frames (its panels and its page) are sandboxed with `allow-modals` as well as the release's `allow-scripts`, in the frame's `sandbox` attribute and in the `sandbox` of the CSP the server sends with its documents (the browser applies both), so `print()` opens the browser's print dialog on the frame's own document (a list it lays out for print, say); `alert()`, `confirm()` and `prompt()` work too. In an `allow-scripts` frame Chrome ignores `print()`. OpenChamber's own HTML preview in the Files view is sandboxed with `allow-modals` already. The hello's features then include `modals` | `panel.entry` |

The server reads the block from the same `package.json` OpenChamber parsed
(`server/manifest.js`) and publishes it in the catalog row as `ocForge`.
| `globalPanel` | `true`: the extension's panel is one for the window, not one per folder. Its pane is mounted, hidden, as soon as the catalog lists the extension active, before it is first opened, and stays mounted in every folder, so the frame loads at startup and keeps its state through every change of chat or folder. Whether it shows in its zone, and whether that zone is expanded, is one choice for the window: the user's last, in whatever folder, carried into each folder as it comes on screen (in the same render when the chat or folder is picked through OpenChamber's stores, else before the browser paints) and kept in localStorage (`oc-forge:global-panels`) for the next load | `panel.entry` |
| `autostart` | `true`: the server sends the extension's service a `GET /health` through the release's own proxy (the same enabled, grant and package checks as a frame's request) once its routes are registered, and again after every catalog change (install, update, rebuilt folder, enable, approval), so the service starts with OpenChamber rather than on the first request a frame sends. A paused or unapproved extension, or a folder mid-rebuild, is skipped quietly; any other failure is logged once | `service.entry` |

Fields only the VS Code extension used (`zone`, `rail`, `page`) are ignored.

### Wire protocol

Messages are `postMessage`d beside the SDK's (`channel: "openchamber"`), so a
stock host and the stock SDK ignore them. Each carries `channel: "oc-forge"`,
`v: 1`, `type`, and `payload`; a request carries `id` and is answered with
`{ type: "result", id, ok, error?, payload? }`. The host identifies the frame
by `event.source`, as for SDK messages; a frame of an extension that is paused
or not approved gets `ok: false`. A request the host can't take (a field
missing or past its limit, a type it doesn't know) gets `ok: false` at once,
with what it takes (`Refused route: a route is at most 2048 characters.`).

| Frame → host | Payload | Effect |
|---|---|---|
| `hello` | | The host answers with a `hello` event; only frames that said hello get events. |
| `key` | `{ key, code, ctrlKey, metaKey, altKey, shiftKey, repeat? }` | Runs the press through OpenChamber's own key handlers if it is one of the navigation actions below and the page has a user activation; answers `{ action }` or an error. |
| `route` | `{ route, push? }` | Pages only: the page's own route (at most 2048 characters); while the page shows, the address bar names it (`push` adds a history entry). |

| Host → frame | Payload |
|---|---|
| `hello` | `{ version: 1, features, extension, surface, route, links: { page, session } \| null, shortcuts }` |
| `route` | `{ route }`: a deep link or back/forward handed the frame a route |
| `shortcuts` | the bindings again, after the user rebinds |

`features` lists what the host supports for this frame: `keys` and `links`
everywhere, `modals` for extensions with `ocForge.modals` (the frame may
`print()`).

**Forwardable actions** (`keys`): `switch_session_tab` (held prefix + 1–9),
`switch_context_surface` (held prefix + 0–9), `switch_session_previous`,
`switch_session_next`, `session_history_back`, `session_history_forward`,
`close_session_tab`, `toggle_sidebar`, `open_command_palette`. `shortcuts`
gives their current single-chord bindings (`mod+alt+arrowleft`) and which
modifier flags count as `mod`; sequences (`mod+k t`) cannot be forwarded. The
host refuses a press bound to anything else, a press another (non-forwardable)
action also takes, held-down repeats, and any press without a transient user
activation (a key press or click in the frame gives one for about 5 s).

**App windows.** In an installed app window (`display-mode: standalone` or
`window-controls-overlay`) Chrome reserves none of its tab keys, and AGENTS.md
asks for them only there. They act on OpenChamber's tabs beside the bindings:
Ctrl+Tab and Ctrl+Shift+Tab move to the next and previous tab, and Cmd+W
(Ctrl+W off macOS) closes the selected tab. Cmd+Option+←/→ is OpenChamber's
own binding already. With focus in OpenChamber the host runs them, and
`shortcuts.aliases` lists them, so a frame that forwards OpenChamber's keys
forwards these too. Either way the host runs the action as a press of its
current binding would. An action the user unassigned has no alias. In a
normal tab Chrome keeps these keys, and nothing changes there. Headless
Chromium has no app window: `on` under the window's localStorage key
`oc-forge:app-window` makes a window count as one, for the end-to-end check.

### Behaviour in the host

- **Deep links.** `?extension=<id>&route=<route>` opens the extension's page (or
  its panel when it has none) once the catalog has loaded, and hands the
  frame the route in `hello`/`route`. The page opens once the app's own choice
  of a chat or a new-chat draft has held for 400 ms. OpenChamber closes every
  page when a chat is selected or a draft changes. So for 10 s after that the
  page opens again when the app changes its choice by itself: on a slow machine
  the draft gets its folder late, or the last chat is restored late. That stops
  at the user's first key or pointer press in the window (a key a frame
  forwards counts), and after 3 reopens. The URL keeps the parameters while the
  page shows; leaving the page drops them. `links.page`/`links.session` are
  prefixes in the window's own origin, so modified clicks on real `<a href>`
  open new browser tabs even from the sandboxed frame (Chromium; see the study).
- **Global panels** (`ocForge.globalPanel`). The release keeps the context
  panel per folder (each zone's tab, open and expanded state) and mounts a
  plugin's frame while its folder's panel has its tab, so a chat in another
  folder shows that folder's panel and loads the frame anew. `ContextSurfacePanes`
  adds a tab for each global panel to every folder's plugin tabs
  (`host/panels.ts` `ocForgeWithGlobalPanels`). A plugin tab's id is its mode in
  every folder, so React keeps that one pane, and its frame, through every
  switch. The host (`useOcForgeGlobalPanels`) records the window's choice from
  the folder on screen and carries it into each folder it switches to, through
  the store's own `openContextPanelTab`, `closeContextZone` and
  `toggleContextPanelExpanded`: in the same tick when the chat or folder is
  picked (a subscription to the session and folder stores), else in a layout
  effect before the browser paints. A deep link to a global panel shows it in
  the folder on screen and records that choice first, so the first folder the
  window carries its choice into does not close it again. The frame stays
  mounted while hidden: its rail badge is not cleared on open (the release
  clears it when a panel mounts), and it runs while the window does.
- Pages, the rail, the header's tabs, the zone frames and guest service
  requests are the release's.

## How it is applied

| Part | Where | Applied by |
|---|---|---|
| Edits to upstream UI files | `edits/*.ts` (anchors + replacements) | `vite-plugin.ts`: Vite `transform` hook, in memory, before any other plugin |
| Edits to upstream server files | `edits/core.ts` (`packages/web/server/…`) | `cli.ts stage … server`: they ship unbuilt, so the adapted copy is what gets packed |
| New UI modules | `host/` → `packages/ui/src/oc-forge/` | `cli.ts stage … added`, into the scratch build tree |
| New server modules | `server/manifest.js`, `server/autostart.js` → `packages/web/server/lib/oc-forge/` | the same |
| Extension client | `client/index.ts` (+ `host/protocol.ts`) | bundled by extensions |

Every edit names exact upstream text that must occur exactly once
(`apply.ts`); otherwise the build stops with the adapter, the file and the
anchor. The Vite plugin also fails the build if a targeted module never loaded
(upstream stopped using it); `lib/guests/types.ts` is exempt, being imported
only as types. 27 edits in 12 files (18 `insertAfter`, 7 `replace`, 2
`insertBefore`): `core` 14 (the frame channel and its sandbox in `PluginPane`,
the `ocForge` block through the catalog and its CSP, the host in `MainLayout`),
`links` 6 (the router), `fixes` 2, `panels` 2 (the plugin panes in
`ContextSurfacePanes`), `autostart` 3 (the guest routes' setup in
`feature-routes-runtime.js`). Before 2026-11-04 there were 72 in 23; the 50
that went were the VS Code extension's.

OpenChamber is compiled with the React Compiler, which memoizes on the values a
render reads: host code that renders passes the oc-forge state it read as an
argument, never reads the store inside a render.

`scripts/build-openchamber.py` (`mise run build:openchamber`) copies the
vendor's tracked files to `build/openchamber/<version>/`, checks every anchor,
installs, builds with OpenChamber's own Vite config plus the plugin, packs,
type-checks the adapted tree with OpenChamber's own `bun check -b`, checks the
package and that the vendor is still pristine, and writes
`dist/openchamber-web-<version>.tgz` (install it with `npm install -g`).
`--check-only` (`mise run check:openchamber`) skips the Vite build and the
package. `--source` builds another checkout. CI runs the full build in its own job.

To add an edit: put it in the adapter it belongs to under `edits/`, with an
anchor that is unique and survives formatting; put the logic in `host/` (or
`server/`); add a test in `tests/openchamber-adapters.test.ts`.

## Verification

- `tests/openchamber-adapters.test.ts`: every edit applies to the pinned source
  (`OPENCHAMBER_SOURCE` for another checkout) and produces the expected code; a
  moved or doubled anchor fails with a message naming it; the Vite plugin
  rewrites targeted modules and fails a build that never loaded one; the
  release's rail, header tabs, zone frames, panel state and service requests
  are not adapted; a global panel's pane is added to every folder's plugin
  tabs; the autostart is created with the guest routes and asked again on
  each catalog change; the edit count above is the edits there are.
- `tests/openchamber-client.test.ts`: the protocol readers, the manifest rules
  (server and UI), shortcut matching as OpenChamber does it, the client's
  handshake, requests, events and key forwarding, and which services start
  with the server, what they are sent, which failures are said, and that
  passes never overlap.
- `tests/e2e/openchamber-adapters/`: two throwaway instances on this machine
  (the npm release and the adapted package), two scratch extensions
  (`extension/`, which asks for `modals`, and `plain-extension/`, which
  doesn't) and the repository's Planner extension. `run.mjs` checks every API
  at 1440×900 and 1024×768, the release against the adapted build with no
  extension using the APIs (rail, header and an extension page, pixel by
  pixel), and that the Planner works on both. R4 forwards keys from a frame
  (and refuses a non-navigation key, and one without a user activation), and
  checks the app window's tab keys. R5 opens deep links, Cmd/Ctrl+clicks real
  links into new browser tabs, and opens a deep link in a fresh window with the
  new-chat draft's folder held 2.5 s, so the draft changes after the page
  opened. The page stays; without the reopening it closed at 3.6 s. "Back to
  chat" still closes it. `OC_FORGE_E2E_PARTS` picks parts
  (`compare,extensions,api`). The instances start like fresh installs: their
  own HOME and data dir, and none of the `OPENCODE*`/`OPENCHAMBER*` variables
  or credentials of the session that runs the check, so they cannot load its
  config or reach its services. The Planner's own `tests/e2e/forge.mjs` runs on
  the same stack (its header says how).

```sh
node tests/e2e/openchamber-adapters/stack.mjs prepare   # network: both builds, Playwright
node tests/e2e/openchamber-adapters/stack.mjs up
node tests/e2e/openchamber-adapters/run.mjs /tmp/opencode/oc-adapters/screens
node tests/e2e/openchamber-adapters/stack.mjs down
```

On a host whose network interfaces keep changing (Docker builds), Chromium
aborts requests with `ERR_NETWORK_CHANGED`; run `up`, `run.mjs` and `down`
inside one private network namespace (`unshare -rn` once, then `nsenter -t
<pid> -U -n --preserve-credentials` for each command) after `prepare`.

OpenCode 2.1.4 sometimes stops answering on an instance's first page loads
(every thread parked on a futex, its log ending in concurrent `git` spawns),
and OpenChamber's own relaunch takes about six minutes to start. Before each
phase and between page-load attempts, `run.mjs` waits up to 90 s for the
instance to list the chats, restarts the instance (`stack.mjs restart
<stock|adapted>`) when it does not, and lists those restarts in
`results.json`.

## Fixes

Host bugs an extension runs into, worked around in the adapted build until
upstream fixes them (`edits/fixes.ts`):

- **A first slash command in a new folder** (OpenCode 2.2 with OpenChamber 2.5.2; still OpenCode 2.2.5 with OpenChamber 2.6.1).
  - OpenCode 2.2 loads a folder's commands on the first request for them, and answers that request with none. A folder that has loaded them always lists its built-ins (`init`, `review`).
  - 2.2.5 answers a quiet server's new folder with its commands at once, but a folder asked while it reloads its global commands still gets none: right after a file appears in `~/.config/opencode/command/`, which is what the Planner writes before an assignment's chat starts. Measured on 2026-11-04 (`/tmp/opencode/v260/tools/new-command-probe.sh`): a folder never asked gets 0 commands at once and all of them, the new one included, 0.3 s later; 2.2.1 the same. That day the adapter was dropped on a probe of a quiet server only, and the Planner's `sunsama.mjs` failed 4 checks on the dev container (the assignment ran on the default agent) until it came back.
  - OpenChamber looks a command up once, right before it sends. So `/name args` sent first in a folder whose commands nobody had asked for, such as a worktree just made, went out as a plain prompt, and the chat ran on the default agent.
  - This is what every Planner assignment to a chosen agent or preset does: it starts the chat in a new worktree with the assignee's command.
  - The live lookup now asks again while the answer is empty, every 250 ms for up to 3 s (`host/commands.ts`).
  - Measured on 2026-10-28 for a worktree OpenChamber had just made: the first answer was empty (18 ms), the next one had the commands (272 ms).

## Limits and choices

- **Runtimes.** The APIs exist where OpenChamber mounts extensions: the web and
  desktop main window. Deep links and `links` assume an http(s) origin (not the
  desktop shell's own window handling, nor relay mode).
- **No persistence** of routes: a page sets its own again as it starts, and a
  deep link hands its own.
- **Versions.** Written against 2.5.2 and run end to end there. On 2.5.3, the
  pin from 2026-10-29, every edit applied unchanged. On 2.6.1, the pin since
  2026-11-04, the `links` anchor in `useRouter` had moved; the adapted tree
  type-checks and the end-to-end check passes against the stock 2.6.1 release.
  When `mise run vendors:update` moves the pin, its `ci` and `openchamber`
  steps say which anchors moved; the end-to-end check says what moved around
  them.
