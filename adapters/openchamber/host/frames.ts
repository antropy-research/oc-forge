// The host end of the oc-forge channel, mounted by every visible extension
// frame (PluginPane). A frame that never says hello on this channel gets
// nothing from it: stock extensions see the release's behaviour.
import React from 'react';

import { useZoneHostsStore } from '@/components/layout/zoneHosts';
import { resolveEffectiveDirectory, useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { isGuestActive } from '@/lib/guests/capabilities';
import { useGuestsStore } from '@/lib/guests/store';
import type { InstalledGuest } from '@/lib/guests/types';
import { isPluginContextPanelMode, type PluginContextPanelMode } from '@/lib/surfaces/modes';
import { shownContextModes, zoneOfMode } from '@/lib/workspace/zones';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';

import { postToFrame, registerOcForgeFrame, type OcForgeFrame } from './bus.ts';
import { newOcForgeWindowId, ocForgeEntrySurfaceOf, setOcForgeCatalogReader } from './ids.ts';
import { forwardOcForgeKey, ocForgeShortcuts } from './keys.ts';
import {
  OC_FORGE_FEATURES,
  OC_FORGE_LIMITS,
  parseOcForgeRequest,
  type OcForgeFeature,
  type OcForgeHello,
  type OcForgeRequest,
} from './protocol.ts';
import { ocForgeCurrentEntry, ocForgePanelEntryTitle, ocForgeRailListed, openOcForgeRailEntry, setOcForgeCurrentEntry, setOcForgeRailBadges } from './rail.ts';
import { ocForgeLinks, setOcForgeRoute } from './routes.ts';
import { useOcForgeStore } from './store.ts';
import {
  activateOcForgeTab,
  closeOcForgeTabFromFrame,
  ocForgeTabbedPageShown,
  ocForgeTabStripShown,
  ocForgeTabsOf,
  openOcForgeTab,
  updateOcForgeTab,
} from './tabs-state.ts';

// `plugin:<extension>--<entry>` surfaces resolve against the live catalog.
setOcForgeCatalogReader(() => useGuestsStore.getState().guests);

const PLUGIN_PREFIX = 'plugin:';

/** Where a browser tab keeps its window id across its reloads (`sessionStorage` is the tab's own). */
const WINDOW_KEY = 'oc-forge:window';

/**
 * This OpenChamber window's id, in each frame's hello: one per browser tab, so every frame of the tab has the same, a
 * frame that reloads gets it again, and so does the app when the tab reloads (an extension keeps what is the tab's,
 * VS Code its header tabs). Another browser tab has its own, a duplicated tab included: it copies the session storage,
 * but the id is handed over only as the page goes (`pagehide`), which the tab it copies hasn't done.
 */
const windowIdOf = (): string => {
  let id: string | null = null;
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(WINDOW_KEY) ?? 'null') as { id?: unknown; handedOver?: unknown } | null;
    if (saved?.handedOver === true && typeof saved.id === 'string' && /^[0-9a-f]{32}$/.test(saved.id)) id = saved.id;
  } catch {
    id = null;
  }
  const kept = id ?? newOcForgeWindowId();
  const keep = (handedOver: boolean) => {
    try {
      window.sessionStorage.setItem(WINDOW_KEY, JSON.stringify(handedOver ? { id: kept, handedOver } : { id: kept }));
    } catch {
      // Without session storage the next load of the tab is another window, as before.
    }
  };
  keep(false);
  window.addEventListener('pagehide', () => keep(true));
  // Back from the back-forward cache, the page is this one again: a copy of the tab made now gets an id of its own.
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) keep(false);
  });
  return kept;
};

const OC_FORGE_WINDOW_ID = windowIdOf();

/** A frame may start before its extension's service has listed the entries: `rail-open` waits this long for the list, under the client's 10 s. */
const RAIL_LIST_WAIT_MS = 8_000;

const identify = (frame: OcForgeFrame): void => {
  const surfaceId = frame.mode.slice(PLUGIN_PREFIX.length);
  const own = ocForgeEntrySurfaceOf(surfaceId);
  frame.guestId = own?.guestId ?? surfaceId;
  frame.ownEntry = own?.entry ?? null;
};

/** The route a frame is handed: the page's, or the one panel's when the extension has no page. */
const routeFor = (frame: OcForgeFrame, guest: InstalledGuest): string | null => {
  const routed = frame.surface === 'page' || (frame.surface === 'panel' && !guest.pageEntry && frame.ownEntry === null);
  return routed ? useOcForgeStore.getState().routes[guest.id] ?? null : null;
};

/**
 * The sandbox of an extension's frames: the release's `allow-scripts`, and `allow-modals` too for one that asks
 * (`ocForge.modals`), so that its `print()` opens the browser's print dialog on the frame's own document.
 */
export const ocForgeFrameSandbox = (guest: Pick<InstalledGuest, 'ocForge'> | null | undefined): string => (
  guest?.ocForge?.modals ? 'allow-scripts allow-modals' : 'allow-scripts'
);

export const ocForgeHello = (frame: OcForgeFrame, guest: InstalledGuest): OcForgeHello => {
  const railPanel = frame.surface === 'panel' && Boolean(guest.ocForge?.rail);
  const features = new Set<OcForgeFeature>(['zones', 'keys', 'links', 'window-id']);
  if (railPanel) features.add('rail');
  if (guest.ocForge?.rail) {
    features.add('rail-open');
    features.add('rail-badge');
  }
  if (guest.pageEntry) {
    features.add('tabs');
    features.add('page-warm');
  }
  if (guest.ocForge?.modals) features.add('modals');
  return {
    version: 1,
    features: OC_FORGE_FEATURES.filter((feature) => features.has(feature)),
    extension: guest.id,
    surface: frame.surface,
    rail: railPanel ? { entry: frame.ownEntry ?? ocForgeCurrentEntry(guest.id), own: frame.ownEntry !== null } : null,
    tabs: {
      list: ocForgeTabsOf(guest.id),
      active: useOcForgeStore.getState().activeTab[guest.id] ?? null,
      shown: ocForgeTabbedPageShown() === guest.id,
      strip: ocForgeTabStripShown(),
    },
    route: routeFor(frame, guest),
    links: ocForgeLinks(guest.id),
    shortcuts: ocForgeShortcuts(),
    limits: OC_FORGE_LIMITS,
    windowId: OC_FORGE_WINDOW_ID,
  };
};

type Answer = { ok: true; payload?: unknown } | { ok: false; error: string };

/**
 * `page-warm`: a frame (a rail panel) keeps its extension's page mounted, hidden, while it lives, so that what it hands
 * the page opens at once rather than after the page has started (`OcForgeGuestPages`).
 */
const setOcForgePageWarm = (guestId: string, frameKey: string, on: boolean): void => {
  useOcForgeStore.setState((state) => {
    const frames = state.warm[guestId] ?? [];
    if (frames.includes(frameKey) === on) return state;
    const next = on ? [...frames, frameKey] : frames.filter((key) => key !== frameKey);
    const warm = { ...state.warm, [guestId]: next };
    if (next.length === 0) delete warm[guestId];
    return { warm };
  });
};

/** Each mounted frame's key, for what it alone reports (its rail badges) or asks for (a warm page). */
const frameKeys = new WeakMap<OcForgeFrame, string>();
let framesMounted = 0;
const frameKeyOf = (frame: OcForgeFrame): string => {
  let key = frameKeys.get(frame);
  if (!key) {
    key = `frame-${++framesMounted}`;
    frameKeys.set(frame, key);
  }
  return key;
};

/** `rail-open`: one of the extension's own entries, shown in the project the rail shows (the main chat's). */
const openRailEntry = async (guest: InstalledGuest, id: string): Promise<Answer> => {
  if (!guest.ocForge?.rail) return { ok: false, error: `${guest.id} has no rail entries: its package.json names no ocForge.rail.` };
  if (!await ocForgeRailListed(guest, RAIL_LIST_WAIT_MS)) {
    return { ok: false, error: `${guest.id}'s service has not listed its rail entries: it is not approved, or did not answer within ${RAIL_LIST_WAIT_MS / 1000} s.` };
  }
  const entry = useOcForgeStore.getState().entries[guest.id]?.find((item) => item.id === id);
  if (!entry) return { ok: false, error: `${guest.id} has no rail entry "${id}"; a frame opens only its own extension's entries.` };
  const directory = resolveEffectiveDirectory();
  if (!directory) return { ok: false, error: 'OpenChamber has no project open to show the entry in.' };
  return openOcForgeRailEntry(normalizeContextPanelDirectoryKey(directory), guest.id, entry)
    ? { ok: true }
    : { ok: false, error: `OpenChamber did not show "${id}".` };
};

const answer = (frame: OcForgeFrame, guest: InstalledGuest, request: OcForgeRequest): Answer | Promise<Answer> | null => {
  switch (request.type) {
    case 'hello':
      // A (re)loaded client: it says again whether it decides how tabs close.
      frame.listening = true;
      frame.closeHandler = false;
      postToFrame(frame, { type: 'hello', payload: ocForgeHello(frame, guest) });
      return null;
    case 'rail-active':
      if (frame.surface !== 'panel' || frame.ownEntry !== null || !guest.ocForge?.rail) {
        return { ok: false, error: 'Only the extension\'s rail panel reports its entry.' };
      }
      setOcForgeCurrentEntry(guest.id, request.payload.entry, false);
      return { ok: true };
    case 'rail-open':
      return openRailEntry(guest, request.payload.entry);
    case 'rail-badges':
      if (!guest.ocForge?.rail) return { ok: false, error: `${guest.id} has no rail entries: its package.json names no ocForge.rail.` };
      setOcForgeRailBadges(guest.id, frameKeyOf(frame), request.payload.badges, request.payload.fresh === true);
      return { ok: true };
    case 'page-warm':
      if (!guest.pageEntry) return { ok: false, error: `${guest.id} has no page: declare contributes.page.` };
      if (frame.surface === 'page') return { ok: false, error: 'The page itself keeps nothing warm.' };
      setOcForgePageWarm(guest.id, frameKeyOf(frame), request.payload.on);
      return { ok: true };
    case 'tab-open': {
      const { activate, ...tab } = request.payload;
      return openOcForgeTab(guest.id, tab, activate === true);
    }
    case 'tab-update':
      return updateOcForgeTab(guest.id, request.payload);
    case 'tab-close':
      closeOcForgeTabFromFrame(guest.id, request.payload.id);
      return { ok: true };
    case 'tab-close-handler':
      frame.closeHandler = request.payload.on;
      return { ok: true };
    case 'tab-activate':
      return activateOcForgeTab(guest.id, request.payload.id) ? { ok: true } : { ok: false, error: 'No such tab.' };
    case 'key': {
      const result = forwardOcForgeKey(request.payload);
      return result.ok ? { ok: true, payload: { action: result.action } } : result;
    }
    case 'route':
      if (frame.surface !== 'page') return { ok: false, error: 'Only the extension\'s page sets the address bar\'s route.' };
      return setOcForgeRoute(guest.id, request.payload.route, request.payload.push === true);
  }
};

type FrameOptions = {
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  mode: string;
  surface: string;
  /** False for hidden (background) frames and popovers: they get no channel. */
  enabled: boolean;
};

export const useOcForgeFrame = ({ iframeRef, mode, surface, enabled }: FrameOptions): void => {
  React.useEffect(() => {
    if (!enabled) return;
    const frame: OcForgeFrame = {
      guestId: mode.slice(PLUGIN_PREFIX.length),
      mode,
      surface,
      ownEntry: null,
      listening: false,
      closeHandler: false,
      window: () => iframeRef.current?.contentWindow ?? null,
    };
    identify(frame);
    const unregister = registerOcForgeFrame(frame);
    const onMessage = (event: MessageEvent) => {
      const source = iframeRef.current?.contentWindow;
      if (!source || event.source !== source) return;
      const read = parseOcForgeRequest(event.data);
      if (!read) return;
      // One the host can't take is answered at once, with why: the frame's promise would otherwise wait out its timeout.
      if ('error' in read) {
        if (read.id !== null) postToFrame(frame, { type: 'result', id: read.id, ok: false, error: read.error });
        return;
      }
      identify(frame);
      const guest = useGuestsStore.getState().guests.find((entry) => entry.id === frame.guestId) ?? null;
      const reply = guest && isGuestActive(guest)
        ? answer(frame, guest, read.request)
        : { ok: false as const, error: 'Extension is unavailable.' };
      const id = read.id;
      if (!reply || id === null) return;
      const post = (result: Answer) => postToFrame(frame, result.ok
        ? { type: 'result', id, ok: true, payload: 'payload' in result ? result.payload : undefined }
        : { type: 'result', id, ok: false, error: result.error });
      if (reply instanceof Promise) void reply.then(post, (error: unknown) => post({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      else post(reply);
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      unregister();
      // The counts it saw go with it, and the page it kept warm (unless it has tabs).
      if (frameKeys.has(frame)) {
        setOcForgeRailBadges(frame.guestId, frameKeyOf(frame), null);
        setOcForgePageWarm(frame.guestId, frameKeyOf(frame), false);
      }
    };
  }, [enabled, iframeRef, mode, surface]);
  useOcForgePanelTitle(mode, surface, enabled);
};

/**
 * An extension's one panel showing a rail entry is titled with that entry (VS Code's "Explorer", not "VS Code"), as an
 * entry's own panel is: in OpenChamber's place for a surface's own header, the slot in its zone's header that
 * `ContextPanelHeaderToolbar` renders into (`useZoneHostsStore`), which takes the place of the header's label while
 * the surface is the one its zone shows. OpenChamber hands that slot to its own surfaces only (`ContextSurfacePanes`).
 * Nothing changes for a panel without entries, a page, or a surface another one hides.
 */
const useOcForgePanelTitle = (mode: string, surface: string, enabled: boolean): void => {
  const headerSlots = useZoneHostsStore((state) => state.headerSlot);
  const zones = useUIStore((state) => state.contextSurfaceZones);
  const panels = useUIStore((state) => state.contextPanelByDirectory);
  const directory = useEffectiveDirectory();
  const entries = useOcForgeStore((state) => state.entries);
  const current = useOcForgeStore((state) => state.current);
  const guestId = mode.slice(PLUGIN_PREFIX.length);
  const shared = enabled && surface === 'panel' && isPluginContextPanelMode(mode) && !ocForgeEntrySurfaceOf(guestId);
  const shown = shared && Boolean(directory) && shownContextModes(panels[normalizeContextPanelDirectoryKey(directory!)], zones).has(mode as PluginContextPanelMode);
  const slot = shown ? headerSlots[zoneOfMode(zones, mode as PluginContextPanelMode)] : null;
  const title = shown ? ocForgePanelEntryTitle({ entries, current }, guestId) : null;
  React.useEffect(() => {
    if (!slot || !title) return;
    // The same element and classes as the header's own label, in the slot OpenChamber's own surfaces render into.
    const toolbar = document.createElement('div');
    toolbar.setAttribute('data-context-panel-toolbar', '');
    toolbar.setAttribute('data-oc-forge-panel-title', guestId);
    toolbar.className = 'flex min-w-0 flex-1 items-center ps-1.5';
    const label = document.createElement('span');
    label.className = 'truncate typography-ui-label text-foreground';
    label.textContent = title;
    toolbar.append(label);
    slot.append(toolbar);
    return () => toolbar.remove();
  }, [slot, title, guestId]);
};
