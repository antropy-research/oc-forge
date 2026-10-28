// R5 deep links: `?extension=<id>&route=<route>` opens that extension's page
// (or, without a page, its rail panel) and hands the frame the route. A page
// that sets its route keeps it in the address bar, so the URL can be copied,
// reloaded or opened in a new tab. Frames learn the URL prefixes to render
// real `<a href>` links.
import React from 'react';

import { isGuestActive } from '@/lib/guests/capabilities';
import { useGuestsStore } from '@/lib/guests/store';
import { pluginModeFromId } from '@/lib/surfaces/modes';
import { shownContextModes } from '@/lib/workspace/zones';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';

import { broadcastOcForge } from './bus.ts';
import { isGuestId, OC_FORGE_LIMITS } from './protocol.ts';
import { useOcForgeStore } from './store.ts';

export const OC_FORGE_EXTENSION_PARAM = 'extension';
export const OC_FORGE_ROUTE_PARAM = 'route';

const CATALOG_WAIT_MS = 20_000;

/** For the router: the URL names an extension page. */
export const hasOcForgeRouteParams = (params: URLSearchParams): boolean => params.has(OC_FORGE_EXTENSION_PARAM);

const readDeepLink = (params: URLSearchParams): { guestId: string; route: string } | null => {
  const guestId = params.get(OC_FORGE_EXTENSION_PARAM);
  const route = params.get(OC_FORGE_ROUTE_PARAM) ?? '';
  return isGuestId(guestId) && route.length <= OC_FORGE_LIMITS.route ? { guestId, route } : null;
};

/** The parameters the router writes for the page the address bar names (see serializeRoute). */
export const ocForgeRouteParams = (): Array<[string, string]> => {
  const { linked, routes } = useOcForgeStore.getState();
  if (!linked || useUIStore.getState().openGuestPageId !== linked) return [];
  return [[OC_FORGE_EXTENSION_PARAM, linked], [OC_FORGE_ROUTE_PARAM, routes[linked] ?? '']];
};

/** Rewrites only oc-forge's parameters in the address bar, keeping the router's. */
const syncOcForgeUrl = (push = false): void => {
  if (typeof window === 'undefined' || (window as { __VSCODE_CONFIG__?: unknown }).__VSCODE_CONFIG__ !== undefined) return;
  const url = new URL(window.location.href);
  url.searchParams.delete(OC_FORGE_EXTENSION_PARAM);
  url.searchParams.delete(OC_FORGE_ROUTE_PARAM);
  for (const [key, value] of ocForgeRouteParams()) url.searchParams.set(key, value);
  if (url.href === window.location.href) return;
  if (push) window.history.pushState({ ...window.history.state }, '', url);
  else window.history.replaceState(window.history.state, '', url);
};

const waitForCatalog = (): Promise<boolean> => new Promise((resolve) => {
  const settled = (status: string) => status === 'ready' || status === 'error' || status === 'unsupported';
  const status = useGuestsStore.getState().status;
  if (settled(status)) {
    resolve(status === 'ready');
    return;
  }
  const timer = window.setTimeout(() => {
    unsubscribe();
    resolve(false);
  }, CATALOG_WAIT_MS);
  const unsubscribe = useGuestsStore.subscribe((state) => {
    if (!settled(state.status)) return;
    window.clearTimeout(timer);
    unsubscribe();
    resolve(state.status === 'ready');
  });
});

const deliverRoute = (guestId: string, route: string, surface: 'page' | 'panel'): void => {
  useOcForgeStore.setState((state) => ({ routes: { ...state.routes, [guestId]: route } }));
  broadcastOcForge(guestId, { type: 'route', payload: { route } }, (frame) => frame.surface === surface && frame.ownEntry === null);
};

let applying = 0;

const openDeepLink = async (link: { guestId: string; route: string }): Promise<void> => {
  const attempt = ++applying;
  if (!await waitForCatalog() || attempt !== applying) return;
  const guest = useGuestsStore.getState().guests.find((entry) => entry.id === link.guestId);
  if (!guest || !isGuestActive(guest)) return;
  if (guest.pageEntry) {
    deliverRoute(guest.id, link.route, 'page');
    useOcForgeStore.setState({ linked: guest.id });
    useUIStore.getState().setOpenGuestPage(guest.id);
    syncOcForgeUrl();
    return;
  }
  if (!guest.entry) return;
  deliverRoute(guest.id, link.route, 'panel');
  const directory = useDirectoryStore.getState().currentDirectory;
  if (!directory) return;
  const key = normalizeContextPanelDirectoryKey(directory);
  const ui = useUIStore.getState();
  const mode = pluginModeFromId(guest.id);
  if (!shownContextModes(ui.contextPanelByDirectory[key], ui.contextSurfaceZones).has(mode)) ui.openContextSurface(key, mode);
};

/** Called by the router each time it applies the URL: on load and on back/forward. */
export const applyOcForgeRoute = (): void => {
  if (typeof window === 'undefined') return;
  const link = readDeepLink(new URLSearchParams(window.location.search));
  if (link) {
    void openDeepLink(link);
    return;
  }
  // Back to a URL without an extension leaves the page the address bar named.
  const { linked } = useOcForgeStore.getState();
  if (linked && useUIStore.getState().openGuestPageId === linked) {
    useOcForgeStore.setState({ linked: null });
    useUIStore.getState().setOpenGuestPage(null);
  }
};

export type OcForgeRouteResult = { ok: true } | { ok: false; error: string };

/** A page frame names its own route; while its page shows, the address bar follows. */
export const setOcForgeRoute = (guestId: string, route: string, push: boolean): OcForgeRouteResult => {
  useOcForgeStore.setState((state) => ({ routes: { ...state.routes, [guestId]: route } }));
  if (useUIStore.getState().openGuestPageId !== guestId) return { ok: true };
  const pushed = push && useOcForgeStore.getState().linked === guestId;
  useOcForgeStore.setState({ linked: guestId });
  syncOcForgeUrl(pushed);
  return { ok: true };
};

/** URL prefixes for real links: this extension's page and a chat, in this window's origin. */
export const ocForgeLinks = (guestId: string): { page: string; session: string } | null => {
  if (typeof window === 'undefined' || !/^https?:$/.test(window.location.protocol)) return null;
  const base = `${window.location.origin}${window.location.pathname}`;
  return {
    page: `${base}?${OC_FORGE_EXTENSION_PARAM}=${encodeURIComponent(guestId)}&${OC_FORGE_ROUTE_PARAM}=`,
    session: `${base}?session=`,
  };
};

/** The address bar drops the extension when its page closes. */
export const useOcForgeRouteSync = (): void => {
  React.useEffect(() => useUIStore.subscribe((state, previous) => {
    if (state.openGuestPageId === previous.openGuestPageId) return;
    const { linked } = useOcForgeStore.getState();
    if (linked && state.openGuestPageId !== linked) {
      useOcForgeStore.setState({ linked: null });
      syncOcForgeUrl();
    }
  }), []);
};
