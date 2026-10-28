# OpenChamber adapters

oc-forge's additions to OpenChamber's extension host: the five things
`AGENTS.md` asks of the Planner and VS Code extensions that the released
extension API (2.5.2) cannot do. They are applied to `vendors/openchamber`
while its web package is built; the vendor is never written. With no extension
using them, the adapted OpenChamber looks and behaves as the release (the
end-to-end check compares screenshots: 0.00% of pixels differ).

| API | `AGENTS.md` | What an extension gets |
|---|---|---|
| **rail** | 2.ii.a | A list of rail entries polled from its service: each its own rail icon with its own highlight; the panel's frame is told which entry was clicked. Entries come and go within a poll (1 s in the check). |
| **tabs** | 2.ii.b | Tabs in the header's strip, after the session tabs: choosing one shows the extension's page on that tab, kept mounted while it has tabs; OpenChamber's tab shortcuts cover them. |
| **zones** | 2.ii.c | A default zone (`bottom`) for its panel, or for one rail entry, which then gets a panel of its own. |
| **keys** | tab shortcuts | Forward a key press to OpenChamber, which runs it through its own shortcut handlers, for navigation actions only and only with a user activation; the frame is told the current bindings. |
| **links** | Cmd+click | `?extension=<id>&route=<route>` deep links to its page; URL prefixes for real `<a href>` links to its page and to chats; its page can keep its route in the address bar. |

The study behind this (what 2.5.2 can and cannot do, and the smallest host
change for each) is zmemory `02-draft/syncopation/2026-10-27-openchamber-extension-surfaces-feasibility.md`.

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
    "rail": { "path": "/rail", "interval": 3000 }
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

At most 32 entries; a malformed entry is dropped on its own. While the list is
non-empty it replaces the extension's own rail icon. An unreachable service
keeps the last list (no flicker while it restarts); an extension that is
disabled or removed loses its entries, and an entry's own panel closes when the
entry leaves the list.

Clicking a view entry shows the panel on it (the frame gets `rail-entry`);
clicking the lit one closes the panel, as for any surface. The digit shortcuts
(`mod+alt+<n>`) select entries the same way. A frame that changes views by
itself reports it with `rail.setActive(entry)` so the highlight follows.

### Wire protocol

Messages are `postMessage`d beside the SDK's (`channel: "openchamber"`), so a
stock host and the stock SDK ignore them. Each carries `channel: "oc-forge"`,
`v: 1`, `type`, and `payload`; a request carries `id` and is answered with
`{ type: "result", id, ok, error?, payload? }`. The host identifies the frame
by `event.source`, as for SDK messages; a frame of an extension that is paused
or not approved gets `ok: false`.

| Frame → host | Payload | Effect |
|---|---|---|
| `hello` | | The host answers with a `hello` event; only frames that said hello get events. |
| `rail-active` | `{ entry }` | The extension's one panel shows this entry now (rail panels of `rail` extensions). |
| `tab-open` | `{ id, title, icon?, dirty?, activate? }` | Opens or updates a header tab; `activate` shows the page on it. Needs `contributes.page`; at most 64 tabs. |
| `tab-update` | `{ id, title?, icon? (null clears), dirty? }` | |
| `tab-close` | `{ id }` | The extension closed its tab (no `tab-closed` event comes back). |
| `tab-activate` | `{ id }` | Shows the page on that tab. |
| `key` | `{ key, code, ctrlKey, metaKey, altKey, shiftKey, repeat? }` | Runs the press through OpenChamber's own key handlers if it is one of the navigation actions below and the page has a user activation; answers `{ action }` or an error. |
| `route` | `{ route, push? }` | Pages only: the page's own route; while the page shows, the address bar names it (`push` adds a history entry). |

| Host → frame | Payload |
|---|---|
| `hello` | `{ version: 1, features, extension, surface, rail: { entry, own } \| null, tabs: { list, active, shown, strip }, route, links: { page, session } \| null, shortcuts }` |
| `rail-entry` | `{ entry }`: the user picked this entry of the panel |
| `tab-activated` | `{ id }`: the user chose this tab, or it became the shown one |
| `tab-closed` | `{ id }`: the user closed it in the header (it is gone there already) |
| `tabs` | `{ list, active, shown, strip }` after any change; `strip` follows OpenChamber's "Session tabs" setting |
| `route` | `{ route }`: a deep link or back/forward handed the frame a route |
| `shortcuts` | the bindings again, after the user rebinds |

`features` lists what the host supports for this frame: `rail` (rail panels of
extensions with a rail source), `tabs` (extensions with a page), and `zones`,
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

### Behaviour in the host

- **Header tabs.** The strip order is the session tabs, then the extension tabs
  in the order they opened. `mod+<digit>` counts across both; previous/next
  wraps across both; the close-tab shortcut and a tab's × close the selected
  extension tab, the page moving to the extension's neighbouring tab, or back
  to the chat after the last one. While an extension tab is selected no session
  tab is; choosing a session tab hides the page (it stays mounted) and shows
  that chat. A page whose extension has tabs keeps the strip instead of
  "← title". Tabs need OpenChamber's "Session tabs" setting (off by default in
  2.5.2): without the strip they are not shown (`tabs.state().strip` says so).
  Tabs are not persisted: after a reload the extension opens the ones it wants.
- **Kept-alive pages.** The page of an extension with tabs is mounted (hidden,
  with its size kept) as soon as it has a tab, and stays mounted while it has
  any; switching away and back does not reload it.
- **Zones.** A default zone is placed once per device, the first time the
  surface is known, unless the user already placed it; after that only the
  user moves it (the placement is OpenChamber's own, per device).
- **Deep links.** `?extension=<id>&route=<route>` opens the extension's page (or
  its rail panel when it has none) once the catalog has loaded, and hands the
  frame the route in `hello`/`route`. The URL keeps the parameters while the
  page shows; leaving the page drops them. `links.page`/`links.session` are
  prefixes in the window's own origin, so modified clicks on real `<a href>`
  open new browser tabs even from the sandboxed frame (Chromium; see the study).

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
  both. The instances start like fresh installs: their own HOME and data dir,
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
- **Versions.** Written against and run end to end on 2.5.2. On 2.5.1 (the pin
  `planner` still has until CI moves it) every edit applies and the adapted
  tree type-checks (`--check-only`), so CI stays green across the move, but it
  was not run there.
