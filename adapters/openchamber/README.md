# OpenChamber adapters

oc-forge's additions to OpenChamber's extension host: the five things
`AGENTS.md` asks of the Planner and VS Code extensions that the released
extension API cannot do (2.5.2's, and 2.5.3's, whose SDK changed only a
comment). They are applied to `vendors/openchamber`
while its web package is built; the vendor is never written. With no extension
using them, the adapted OpenChamber looks and behaves as the release (the
end-to-end check compares screenshots: 0.00% of pixels differ).

| API | `AGENTS.md` | What an extension gets |
|---|---|---|
| **rail** | 2.ii.a | A list of rail entries polled from its service: each its own rail icon with its own highlight; the panel's frame is told which entry was clicked. Entries come and go within a poll (1 s in the check). |
| **tabs** | 2.ii.b | Tabs in the header's strip, after the session tabs: choosing one shows the extension's page on that tab, kept mounted while it has tabs; OpenChamber's tab shortcuts cover them. Room for 1000 per extension; the strip keeps the selected one in view and, while it overflows, lists every tab. The extension may decide how an unsaved tab closes (a save prompt). |
| **zones** | 2.ii.c | A default zone (`bottom`) for its panel, or for one rail entry, which then gets a panel of its own; its page may keep the bottom zone shown under it (an editor over its terminal). |
| **keys** | tab shortcuts | Forward a key press to OpenChamber, which runs it through its own shortcut handlers, for navigation actions only and only with a user activation; the frame is told the current bindings. |
| **links** | Cmd+click | `?extension=<id>&route=<route>` deep links to its page; URL prefixes for real `<a href>` links to its page and to chats; its page can keep its route in the address bar. |

The study behind this (what 2.5.2 can and cannot do, and the smallest host
change for each) is zmemory `02-draft/syncopation/2026-10-27-openchamber-extension-surfaces-feasibility.md`.

Beside the APIs, the adapted host sends every extension's service requests over
one WebSocket per window ("Behaviour in the host", Transport): with VS Code's
long-polls, two windows over plain HTTP used to stall each other.

## Using it from an extension

Bundle `client/index.ts` (no dependencies) into the frame next to
`@openchamber/sdk`. `connectOcForge()` says hello on its own channel and
resolves with a client when the host answers, or **`null` on a stock
OpenChamber**: that is the whole feature detection; keep the stock behaviour then.

```ts
import { connectOcForge } from '../../../adapters/openchamber/client/index.ts';

const forge = await connectOcForge();          // null: stock OpenChamber
if (forge?.has('tabs') && forge.tabs.state().strip) {
  await forge.tabs.open({ id: uri, title: 'main.ts', dirty: false }, { activate: true });
  forge.tabs.onActivate((id) => showEditor(id));
  forge.tabs.onClose((id) => closeEditor(id));
  // An unsaved tab the user closes is left to this frame: close it after the save prompt, or keep it.
  forge.tabs.onCloseRequest((id) => void closeEditorAsking(id).then((closed) => closed && forge.tabs.close(id)));
}
forge?.keys.forwardHostShortcuts({ except: ['toggle_sidebar'] });   // OpenChamber's tab keys go to OpenChamber
link.href = forge?.links.pageUrl(`/task/${id}`) ?? fallbackUrl;     // Cmd+click opens a new browser tab
```

The manifest additions sit in a top-level `ocForge` block of `package.json`,
beside `openchamber`. OpenChamber's own parser (`@openchamber/sdk`, installed
from npm with the web package) drops keys it does not know, so the same
package installs and runs on a stock OpenChamber.

```json
{
  "openchamber": { "apiVersion": 1, "contributes": { "panel": { "...": "..." }, "service": { "...": "..." } } },
  "ocForge": {
    "apiVersion": 1,
    "zone": "bottom",
    "rail": { "path": "/rail", "interval": 3000 },
    "page": { "keepBottomZone": true },
    "modals": true
  }
}
```

## Contract (version 1)

### Manifest: `ocForge`

| Field | Meaning | Needs |
|---|---|---|
| `apiVersion` | `1`; any other value ignores the block | |
| `zone` | `left`, `right` or `bottom`: where the panel opens until the user moves it | `panel.entry` |
| `rail.path` | The service path the host polls with `GET` for rail entries (`/…`, no `..`) | `panel.entry`, `contributes.service` (approved) |
| `rail.interval` | Poll interval in ms, 1000–60000, default 3000; never while the page is hidden | |
| `page.keepBottomZone` | `true`: while its page shows, OpenChamber's bottom zone stays shown under the page instead of being covered with the chat (an editor area over a terminal); any other page still covers it | `panel.entry`, `page.entry` |
| `modals` | `true`: the extension's frames (its panels and its page) are sandboxed with `allow-modals` as well as the release's `allow-scripts`, in the frame's `sandbox` attribute and in the `sandbox` of the CSP the server sends with its documents (the browser applies both), so `print()` opens the browser's print dialog on the frame's own document (a list it lays out for print, say); `alert()`, `confirm()` and `prompt()` work too. In an `allow-scripts` frame Chrome ignores `print()`. OpenChamber's own HTML preview in the Files view is sandboxed with `allow-modals` already. The hello's features then include `modals` | `panel.entry` |

The server reads the block from the same `package.json` OpenChamber parsed
(`server/manifest.js`) and publishes it in the catalog row as `ocForge`.

### Rail entries: the service's answer

`GET <rail.path>` answers `200 { "entries": [ … ] }`; each entry:

| Field | Rules |
|---|---|
| `id` | kebab-case, at most 48 characters, no `--` (reserved) |
| `title` | 1–80 characters: the icon's tooltip, and an own panel's header |
| `icon` | A Remixicon name in OpenChamber's sprite, or an inline `<svg …>` of at most 16 KB, drawn as a mask in the rail's colour (an SVG used as a mask never runs scripts) |
| `order` | Optional number; ascending, then the order listed |
| `zone` | Optional. Gives the entry **a panel of its own** (a second frame loading `panel.entry`, the surface `plugin:<extension>--<entry>`) that opens in this zone until the user moves it. Without it the entry is a **view** of the extension's one panel and follows its zone. |

At most 100 entries; a malformed entry is dropped on its own. While the list is
non-empty it replaces the extension's own rail icon. When the icons are more
than the rail's height, the rail scrolls (its scrollbar hidden); the release cut
the last ones off. An unreachable service
keeps the last list (no flicker while it restarts); an extension that is
disabled or removed loses its entries, and an entry's own panel closes when the
entry leaves the list.

Clicking a view entry shows the panel on it (the frame gets `rail-entry`);
clicking the lit one closes the panel, as for any surface. The digit shortcuts
(`mod+alt+<n>`) select entries the same way. A frame that changes views by
itself reports it with `rail.setActive(entry)` so the highlight follows. While
the entry the panel shows is not in the list (it left it, or the frame reported
one the next poll brings), the rail lights none of the panel's entries and a
frame's `hello` names none: the frame shows what it showed until it reports
what it shows next, and a click on any entry, the first one too, shows that
entry rather than closing the panel.

### Wire protocol

Messages are `postMessage`d beside the SDK's (`channel: "openchamber"`), so a
stock host and the stock SDK ignore them. Each carries `channel: "oc-forge"`,
`v: 1`, `type`, and `payload`; a request carries `id` and is answered with
`{ type: "result", id, ok, error?, payload? }`. The host identifies the frame
by `event.source`, as for SDK messages; a frame of an extension that is paused
or not approved gets `ok: false`. A request the host can't take (a field
missing or past its limit, a type it doesn't know) gets `ok: false` at once,
with what it takes (`Refused tab-open: a title is 1–512 characters.`); before
2026-10-30 it got no answer, and the client gave up after 10 s.

**Limits** (`OC_FORGE_LIMITS`, also in each frame's `hello` as `limits`): 1000
header tabs per extension, tab ids of 1–1024 characters, titles of 1–512 (a
file's whole name, a diff of two), routes of at most 2048, inline SVG icons of
at most 16,384, 100 rail entries with kebab-case ids of at most 48. A host
before 2026-10-30 sends no `limits`; its tabs were 64 and its titles 80
(`OC_FORGE_LEGACY_LIMITS`), and the client's `limits()` answers those for it.

| Frame → host | Payload | Effect |
|---|---|---|
| `hello` | | The host answers with a `hello` event; only frames that said hello get events. |
| `rail-active` | `{ entry }` | The extension's one panel shows this entry now (rail panels of `rail` extensions). |
| `tab-open` | `{ id, title, icon?, dirty?, route?, activate? }` | Opens or updates a header tab; `activate` shows the page on it; `route` is the tab's place on the page (a Cmd/Ctrl+click on the tab opens the page there in a new browser tab). Needs `contributes.page`; past an extension's 1000th tab the host refuses one more (`An extension has at most 1000 header tabs: close one to open another.`) and changes nothing. |
| `tab-update` | `{ id, title?, icon? (null clears), dirty?, route? (null clears) }` | |
| `tab-close` | `{ id }` | The extension closed its tab (no `tab-closed` event comes back). After a `tab-close-request` for it, the host goes on as for the user's close (back to the chat after the last tab). |
| `tab-close-handler` | `{ on }` | This frame decides how the extension's unsaved tabs close (the client sends it with the first `tabs.onCloseRequest` listener, and `on: false` after the last). A frame's `hello` resets it. |
| `tab-activate` | `{ id }` | Shows the page on that tab. |
| `key` | `{ key, code, ctrlKey, metaKey, altKey, shiftKey, repeat? }` | Runs the press through OpenChamber's own key handlers if it is one of the navigation actions below and the page has a user activation; answers `{ action }` or an error. |
| `route` | `{ route, push? }` | Pages only: the page's own route; while the page shows, the address bar names it (`push` adds a history entry). |

| Host → frame | Payload |
|---|---|
| `hello` | `{ version: 1, features, extension, surface, rail: { entry, own } \| null, tabs: { list, active, shown, strip }, route, links: { page, session } \| null, shortcuts, limits }` |
| `rail-entry` | `{ entry }`: the user picked this entry of the panel |
| `tab-activated` | `{ id }`: the user chose this tab, or it became the shown one |
| `tab-closed` | `{ id }`: the user closed it in the header (it is gone there already) |
| `tab-close-request` | `{ id }`: the user closed this unsaved (`dirty`) tab while this frame decides; the tab stays, and the page shows it, until the frame sends `tab-close` |
| `tabs` | `{ list, active, shown, strip }` after any change; `strip` follows OpenChamber's "Session tabs" setting |
| `route` | `{ route }`: a deep link or back/forward handed the frame a route |
| `shortcuts` | the bindings again, after the user rebinds |

`features` lists what the host supports for this frame: `rail` (rail panels of
extensions with a rail source), `tabs` (extensions with a page), `modals`
(extensions with `ocForge.modals`: the frame may `print()`), and `zones`,
`keys`, `links` everywhere.

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

- **Header tabs.** The strip order is the session tabs, then the extension tabs
  in the order they opened. `mod+<digit>` counts across both; previous/next
  wraps across both; the close-tab shortcut and a tab's × close the selected
  extension tab, the page moving to the extension's neighbouring tab, or back
  to the chat after the last one. When a frame of the extension decides
  (`tabs.onCloseRequest`), closing a `dirty` tab that way asks that frame
  instead (`tab-close-request`): the page shows the tab, and the tab stays
  until the frame closes it, after its own save prompt, or stays if the user
  cancels. Clean tabs, and every tab while no frame decides, close at once. While an extension tab is selected no session
  tab is; choosing a session tab hides the page (it stays mounted) and shows
  that chat. A page whose extension has tabs keeps the strip instead of
  "← title". Tabs need OpenChamber's "Session tabs" setting (off by default in
  2.5.2 and 2.5.3): without the strip they are not shown (`tabs.state().strip` says so).
  With 2.5.3's separate tabs per workspace on, the strip shows the current
  workspace's session tabs, then the extension tabs, which are the same in every
  workspace.
  The strip scrolls as it does for session tabs (the wheel, the edge fades), and
  keeps the selected extension tab in view as it keeps the selected session's:
  in the release it scrolls only when the current session changes. While the
  strip holds extension tabs and overflows, a button at its end (`All tabs (N)`,
  `data-oc-forge-all-tabs`) lists every tab of the strip, the chats first, the
  selected one marked and in sight; choosing one selects it, as VS Code's "Show
  All Opened Editors" lists its editors. A tab's whole title is its tooltip and
  its accessible name; the strip cuts it to the tab's width.
  Tabs are not persisted: after a reload the extension opens the ones it wants.
  A plain click selects a tab and a middle click closes it, as on OpenChamber's
  own tabs; a Cmd/Ctrl+click on a tab with a `route` opens the extension's page
  on that route in a new browser tab, as on a link (`?extension=<id>&route=`),
  and this window stays as it is.
- **Kept-alive pages.** The page of an extension with tabs is mounted (hidden,
  with its size kept) as soon as it has a tab, and stays mounted while it has
  any; switching away and back does not reload it. After its last tab closes
  it stays mounted, hidden, for 8 s more (`OC_FORGE_PAGE_LINGER_MS`), so its
  frame still gets that `tab-closed` and the empty `tabs` and can save (the
  release removes a page that is not on screen at once, before its frame hears
  anything); a tab opened meanwhile brings it back as it was. Pages are kept in
  a fixed order, since a moved iframe reloads.
- **Zones.** A default zone is placed once per device, the first time the
  surface is known, unless the user already placed it; after that only the
  user moves it (the placement is OpenChamber's own, per device).
- **The bottom zone under a page.** The release hides the bottom zone (it
  belongs to the chat column) whenever a page covers the chat. While the page
  of an extension with `page.keepBottomZone` shows, it stays: the page takes
  the chat column's height above it (edits/pages.ts, host/pages.ts).
- **Deep links.** `?extension=<id>&route=<route>` opens the extension's page (or
  its rail panel when it has none) once the catalog has loaded, and hands the
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
- **Transport.** Over plain HTTP/1.1 a browser keeps six connections per host,
  shared by all of a site's tabs, and each guest service request (`serviceRequest`)
  was an HTTP request of its own. An extension whose frames long-poll their
  service held all six once two windows were open (VS Code: a poll per frame,
  three frames per window), and every other request of both windows waited:
  the second window's VS Code stayed empty, the first stopped answering. The
  adapted host sends service requests over one WebSocket per window
  (`/api/oc-forge/service-socket`, which a browser pools apart from those six;
  host/service-socket.ts, host/service-transport.ts). The server runs each one
  as the release's `POST /api/guests/:id/service/request` on its own address,
  with the window's cookie and host (server/service-socket.js), so the route's
  checks, limits and answers are the release's, and a long-poll waits on the
  server. The socket opens on the web runtime only (the page's own origin, no
  relay or realtime proxy), behind the gate of OpenChamber's own guest
  sockets; anywhere else, before it opens, and for 30 s after it fails to,
  requests go over HTTP as in the release. A request whose answer is lost with
  the socket fails, as a fetch that is cut off does: it is never sent twice.
  Frames and services see no difference. Over HTTPS (HTTP/2, one connection
  for everything) the limit does not exist. `off` under the window's
  localStorage key `oc-forge:service-socket` keeps service requests on HTTP:
  tests that answer them in place with Playwright routes set it (the Planner's
  harness and its full end-to-end check), since requests over the socket would
  pass their routes and reach the real service.

## How it is applied

| Part | Where | Applied by |
|---|---|---|
| Edits to upstream UI files | `edits/*.ts` (anchors + replacements) | `vite-plugin.ts`: Vite `transform` hook, in memory, before any other plugin |
| Edits to upstream server files | `edits/core.ts` (`packages/web/server/…`) | `cli.ts stage … server`: they ship unbuilt, so the adapted copy is what gets packed |
| New UI modules | `host/` → `packages/ui/src/oc-forge/` | `cli.ts stage … added`, into the scratch build tree |
| New server module | `server/manifest.js` → `packages/web/server/lib/oc-forge/` | the same |
| Extension client | `client/index.ts` (+ `host/protocol.ts`) | bundled by extensions |

Every edit names exact upstream text that must occur exactly once
(`apply.ts`); otherwise the build stops with the adapter, the file and the
anchor. The Vite plugin also fails the build if a targeted module never loaded
(upstream stopped using it); `lib/guests/types.ts` is exempt, being imported
only as types. 47 edits in 17 files.

OpenChamber is compiled with the React Compiler, which memoizes on the values a
render reads: host code that renders passes the oc-forge state it read as an
argument (`useOcForgeRailRevision()`), never reads the store inside a render.

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
  rewrites targeted modules and fails a build that never loaded one.
- `tests/openchamber-client.test.ts`: the protocol readers, the rail-entry and
  manifest rules (server and UI), shortcut matching as OpenChamber does it, and
  the client's handshake, requests, events and key forwarding.
- `tests/e2e/openchamber-adapters/`: two throwaway instances on this machine
  (the npm release and the adapted package), a scratch extension
  (`extension/`, `zone-extension/`) and the repository's Planner and VS Code
  extensions. `run.mjs` checks every API at 1440×900 and 1024×768, the release
  against the adapted build with no extension using the APIs (rail, header and
  an extension page, pixel by pixel), and that the Planner and VS Code work on
  both. R5 also opens a deep link in a fresh window with the new-chat draft's
  folder held 2.5 s, so the draft changes after the page opened. The page
  stays; without the reopening it closed at 3.6 s. "Back to chat" still
  closes it. R6 holds eight service requests open (more than a browser's six
  connections) and times a ninth: 3 ms on the adapted build, over the socket
  with no service HTTP request, against 11.5 s on the release. A round of its
  own (`many`) opens seventy tabs at each size: each gets its header tab, the
  70th is selected and scrolled into view with the strip's fade at its start,
  the strip's list holds the three chats and all seventy, choosing the 7th or a
  chat there shows it; a title of 513 is refused in a few milliseconds saying
  why, one of 512 is taken whole; at 1440 a thousand tabs open, and one more is
  refused at once while the header keeps its thousand and its selection
  (`4ac4898`'s host failed 16 of these 18). `OC_FORGE_E2E_PARTS` picks parts
  (`compare,extensions,api,many`). The instances start like fresh installs: their own HOME and data dir,
  and none of the `OPENCODE*`/`OPENCHAMBER*` variables or credentials of the
  session that runs the check, so they cannot load its config or reach its
  services.

```sh
node tests/e2e/openchamber-adapters/stack.mjs prepare   # network: both builds, Playwright, a VS Code Server
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

- **A first slash command in a new folder** (OpenCode 2.2 with OpenChamber 2.5.2).
  - OpenCode 2.2 loads a folder's commands on the first request for them, and answers that request with none. A folder that has loaded them always lists its built-ins (`init`, `review`).
  - OpenChamber looks a command up once, right before it sends. So `/name args` sent first in a folder whose commands nobody had asked for, such as a worktree just made, went out as a plain prompt, and the chat ran on the default agent.
  - This is what every Planner assignment to a chosen agent or preset does: it starts the chat in a new worktree with the assignee's command.
  - The live lookup now asks again while the answer is empty, every 250 ms for up to 3 s (`host/commands.ts`).
  - Measured on 2026-10-28 for a worktree OpenChamber had just made: the first answer was empty (18 ms), the next one had the commands (272 ms).

## Limits and choices

- **Bottom zone width.** The bottom zone stays under the chat column, as in
  OpenChamber. Spanning the full width would move the zone out of the chat
  column in `MainLayout`, and with it the zone drop targets (`ZoneDropOverlay`),
  the size arbitration (`ZoneFitArbiter`) and the Work Status card's slot, for
  every bottom-zone surface: not additive, so not done.
- **R3 placement** is a one-time default per device instead of a change in
  `zoneOfMode`: that function's caller deletes the placement when a surface
  moves back to the right, so a default inside it could never be left.
- **Runtimes.** The APIs exist where OpenChamber mounts extensions: the web and
  desktop main window. Deep links and `links` assume an http(s) origin (not the
  desktop shell's own window handling, nor relay mode).
- **No persistence** of header tabs and routes; rail entries return with the
  next poll.
- **Versions.** Written against 2.5.2 and run end to end there. On 2.5.3, the
  pin since 2026-10-29, every edit applies unchanged, the adapted tree
  type-checks, and the end-to-end check passes against the stock 2.5.3 release
  (108/108). When CI moves the pin, `--check-only` on the new tree says which
  anchors moved.
