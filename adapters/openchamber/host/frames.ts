// The host end of the oc-forge channel, mounted by every visible extension
// frame (PluginPane). A frame that never says hello on this channel gets
// nothing from it: stock extensions see the release's behaviour.
import React from 'react';

import { isGuestActive } from '@/lib/guests/capabilities';
import { useGuestsStore } from '@/lib/guests/store';
import type { InstalledGuest } from '@/lib/guests/types';

import { postToFrame, registerOcForgeFrame, type OcForgeFrame } from './bus.ts';
import { ocForgeEntrySurfaceOf, setOcForgeCatalogReader } from './ids.ts';
import { forwardOcForgeKey, ocForgeShortcuts } from './keys.ts';
import {
  OC_FORGE_FEATURES,
  readOcForgeRequest,
  type OcForgeFeature,
  type OcForgeHello,
  type OcForgeRequest,
} from './protocol.ts';
import { ocForgeCurrentEntry, setOcForgeCurrentEntry } from './rail.ts';
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
  const features = new Set<OcForgeFeature>(['zones', 'keys', 'links']);
  if (railPanel) features.add('rail');
  if (guest.pageEntry) features.add('tabs');
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
  };
};

type Answer = { ok: true; payload?: unknown } | { ok: false; error: string };

const answer = (frame: OcForgeFrame, guest: InstalledGuest, request: OcForgeRequest): Answer | null => {
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
      const read = readOcForgeRequest(event.data);
      if (!read) return;
      identify(frame);
      const guest = useGuestsStore.getState().guests.find((entry) => entry.id === frame.guestId) ?? null;
      const reply = guest && isGuestActive(guest)
        ? answer(frame, guest, read.request)
        : { ok: false as const, error: 'Extension is unavailable.' };
      if (!reply || read.id === null) return;
      postToFrame(frame, reply.ok
        ? { type: 'result', id: read.id, ok: true, payload: 'payload' in reply ? reply.payload : undefined }
        : { type: 'result', id: read.id, ok: false, error: reply.error });
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      unregister();
    };
  }, [enabled, iframeRef, mode, surface]);
};
