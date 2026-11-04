// The host end of the oc-forge channel, mounted by every visible extension
// frame (PluginPane). A frame that never says hello on this channel gets
// nothing from it: stock extensions see the release's behaviour.
import React from 'react';

import { isGuestActive } from '@/lib/guests/capabilities';
import { useGuestsStore } from '@/lib/guests/store';
import type { InstalledGuest } from '@/lib/guests/types';

import { postToFrame, registerOcForgeFrame, type OcForgeFrame } from './bus.ts';
import { forwardOcForgeKey, ocForgeShortcuts } from './keys.ts';
import {
  OC_FORGE_FEATURES,
  parseOcForgeRequest,
  type OcForgeFeature,
  type OcForgeHello,
  type OcForgeRequest,
} from './protocol.ts';
import { ocForgeLinks, setOcForgeRoute } from './routes.ts';
import { useOcForgeStore } from './store.ts';

const PLUGIN_PREFIX = 'plugin:';

/** The route a frame is handed: the page's, or the panel's when the extension has no page. */
const routeFor = (frame: OcForgeFrame, guest: InstalledGuest): string | null => {
  const routed = frame.surface === 'page' || (frame.surface === 'panel' && !guest.pageEntry);
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
  const features = new Set<OcForgeFeature>(['keys', 'links']);
  if (guest.ocForge?.modals) features.add('modals');
  return {
    version: 1,
    features: OC_FORGE_FEATURES.filter((feature) => features.has(feature)),
    extension: guest.id,
    surface: frame.surface,
    route: routeFor(frame, guest),
    links: ocForgeLinks(guest.id),
    shortcuts: ocForgeShortcuts(),
  };
};

type Answer = { ok: true; payload?: unknown } | { ok: false; error: string };

const answer = (frame: OcForgeFrame, guest: InstalledGuest, request: OcForgeRequest): Answer | null => {
  switch (request.type) {
    case 'hello':
      frame.listening = true;
      postToFrame(frame, { type: 'hello', payload: ocForgeHello(frame, guest) });
      return null;
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
      listening: false,
      window: () => iframeRef.current?.contentWindow ?? null,
    };
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
      const guest = useGuestsStore.getState().guests.find((entry) => entry.id === frame.guestId) ?? null;
      const reply = guest && isGuestActive(guest)
        ? answer(frame, guest, read.request)
        : { ok: false as const, error: 'Extension is unavailable.' };
      const id = read.id;
      if (!reply || id === null) return;
      postToFrame(frame, reply.ok
        ? { type: 'result', id, ok: true, payload: 'payload' in reply ? reply.payload : undefined }
        : { type: 'result', id, ok: false, error: reply.error });
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      unregister();
    };
  }, [enabled, iframeRef, mode, surface]);
};
