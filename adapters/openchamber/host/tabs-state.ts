// R2 header tabs: an extension frame opens tabs in the header's strip, after
// the session tabs. Choosing one shows the extension's page in the main area
// on that tab; the page stays mounted while the extension has tabs. The
// strip's order for OpenChamber's tab shortcuts is the session tabs, then the
// extension tabs.
import React from 'react';

import { isGuestActive } from '@/lib/guests/capabilities';
import { useGuestsStore } from '@/lib/guests/store';
import { isVSCodeRuntime } from '@/lib/desktop';
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionTabsStore } from '@/stores/useSessionTabsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

import { broadcastOcForge, listeningFrames, postToFrame } from './bus.ts';
import { OC_FORGE_LIMITS, type OcForgeTab } from './protocol.ts';
import { useOcForgeStore, type OcForgeHeaderTab } from './store.ts';

/** Header tabs show while OpenChamber's own session tabs are on (Settings → General). */
export const ocForgeTabStripShown = (): boolean => !isVSCodeRuntime() && useUIStore.getState().sessionTabsEnabled;

const hasPage = (guestId: string): boolean => {
  const guest = useGuestsStore.getState().guests.find((entry) => entry.id === guestId);
  return Boolean(guest && guest.pageEntry && isGuestActive(guest));
};

/** Tabs of extensions that can show them: active, with a page. */
export const ocForgeVisibleTabs = (): OcForgeHeaderTab[] => useOcForgeStore.getState().tabs.filter((tab) => hasPage(tab.guestId));

export const ocForgeTabsOf = (guestId: string): OcForgeTab[] => useOcForgeStore.getState().tabs
  .filter((tab) => tab.guestId === guestId)
  .map(({ guestId: _guestId, ...tab }) => tab);

/** The extension whose page is on screen on one of its tabs, or null. */
export const ocForgeTabbedPageShown = (): string | null => {
  const page = useUIStore.getState().openGuestPageId;
  return page && ocForgeTabStripShown() && useOcForgeStore.getState().tabs.some((tab) => tab.guestId === page) ? page : null;
};

/** Whether an extension tab, not a session, is what the strip shows as selected. */
export const useOcForgeTabActive = (): boolean => {
  const page = useUIStore((state) => state.openGuestPageId);
  const stripShown = useUIStore((state) => state.sessionTabsEnabled) && !isVSCodeRuntime();
  const hasTabs = useOcForgeStore((state) => Boolean(page) && state.tabs.some((tab) => tab.guestId === page));
  return Boolean(page) && stripShown && hasTabs;
};

/** For the header: this open page keeps the tab strip instead of "← title". */
export const useOcForgeTabbedPage = (guestId: string | null): boolean => {
  const stripShown = useUIStore((state) => state.sessionTabsEnabled) && !isVSCodeRuntime();
  const hasTabs = useOcForgeStore((state) => Boolean(guestId) && state.tabs.some((tab) => tab.guestId === guestId));
  return stripShown && hasTabs;
};

const tabsEvent = (guestId: string) => {
  const state = useOcForgeStore.getState();
  return {
    type: 'tabs' as const,
    payload: {
      list: ocForgeTabsOf(guestId),
      active: state.activeTab[guestId] ?? null,
      shown: ocForgeTabbedPageShown() === guestId,
      strip: ocForgeTabStripShown(),
    },
  };
};

export const broadcastOcForgeTabs = (guestId: string): void => {
  broadcastOcForge(guestId, tabsEvent(guestId));
};

export const activateOcForgeTab = (guestId: string, id: string): boolean => {
  const state = useOcForgeStore.getState();
  if (!state.tabs.some((tab) => tab.guestId === guestId && tab.id === id) || !hasPage(guestId)) return false;
  useOcForgeStore.setState({ activeTab: { ...state.activeTab, [guestId]: id } });
  useUIStore.getState().setOpenGuestPage(guestId);
  broadcastOcForge(guestId, { type: 'tab-activated', payload: { id } });
  broadcastOcForgeTabs(guestId);
  return true;
};

export type OcForgeTabResult = { ok: true } | { ok: false; error: string };

export const openOcForgeTab = (guestId: string, tab: OcForgeTab, activate: boolean): OcForgeTabResult => {
  if (!hasPage(guestId)) return { ok: false, error: 'Header tabs show the extension\'s page: declare contributes.page.' };
  const state = useOcForgeStore.getState();
  const index = state.tabs.findIndex((entry) => entry.guestId === guestId && entry.id === tab.id);
  if (index === -1 && state.tabs.filter((entry) => entry.guestId === guestId).length >= OC_FORGE_LIMITS.tabs) {
    return { ok: false, error: `An extension has at most ${OC_FORGE_LIMITS.tabs} header tabs.` };
  }
  const next: OcForgeHeaderTab = { guestId, ...tab, dirty: tab.dirty ?? false };
  const tabs = index === -1 ? [...state.tabs, next] : state.tabs.map((entry, at) => (at === index ? { ...entry, ...next } : entry));
  const activeTab = state.activeTab[guestId] ? state.activeTab : { ...state.activeTab, [guestId]: tab.id };
  useOcForgeStore.setState({ tabs, activeTab });
  if (activate) activateOcForgeTab(guestId, tab.id);
  else broadcastOcForgeTabs(guestId);
  return { ok: true };
};

export const updateOcForgeTab = (guestId: string, update: { id: string; title?: string; icon?: string | null; dirty?: boolean }): OcForgeTabResult => {
  const state = useOcForgeStore.getState();
  if (!state.tabs.some((tab) => tab.guestId === guestId && tab.id === update.id)) return { ok: false, error: 'No such tab.' };
  useOcForgeStore.setState({
    tabs: state.tabs.map((tab) => {
      if (tab.guestId !== guestId || tab.id !== update.id) return tab;
      const next: OcForgeHeaderTab = { ...tab };
      if (update.title !== undefined) next.title = update.title;
      if (update.dirty !== undefined) next.dirty = update.dirty;
      if (update.icon === null) delete next.icon;
      else if (update.icon !== undefined) next.icon = update.icon;
      return next;
    }),
  });
  broadcastOcForgeTabs(guestId);
  return { ok: true };
};

/**
 * How long a page stays mounted, hidden, after its extension's last tab closed.
 * A page without tabs that is not on screen goes at once, as in the release,
 * which was before its frame heard the close: an editor could not drop the
 * closed file from what it restores. For this long it still can.
 */
export const OC_FORGE_PAGE_LINGER_MS = 8_000;
const lingerTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** The lingering map with this extension's page kept for OC_FORGE_PAGE_LINGER_MS from now. */
const lingerPage = (guestId: string): Record<string, number> => {
  clearTimeout(lingerTimers.get(guestId));
  lingerTimers.set(guestId, setTimeout(() => {
    lingerTimers.delete(guestId);
    const { lingering } = useOcForgeStore.getState();
    if (!(guestId in lingering)) return;
    const rest = { ...lingering };
    delete rest[guestId];
    useOcForgeStore.setState({ lingering: rest });
  }, OC_FORGE_PAGE_LINGER_MS));
  return { ...useOcForgeStore.getState().lingering, [guestId]: Date.now() + OC_FORGE_PAGE_LINGER_MS };
};

// Dirty tabs the user asked to close, left to their extension (`tab-close-request`).
const closeRequests = new Set<string>();
const requestKey = (guestId: string, id: string): string => `${guestId}\n${id}`;

/**
 * Closes a tab. The page moves to the neighbouring tab of the same extension
 * (right, then left). A user who closes the last tab the page shows goes back
 * to the chat; the extension is told whenever the user closed one, unless it
 * closed the tab itself (`notify`). After its last tab the page lingers.
 */
export const closeOcForgeTab = (guestId: string, id: string, byUser: boolean, notify = byUser): void => {
  const state = useOcForgeStore.getState();
  const own = state.tabs.filter((tab) => tab.guestId === guestId);
  const index = own.findIndex((tab) => tab.id === id);
  closeRequests.delete(requestKey(guestId, id));
  if (index === -1) return;
  const shownBefore = ocForgeTabbedPageShown() === guestId;
  const wasActive = state.activeTab[guestId] === id;
  const neighbour = own[index + 1] ?? own[index - 1] ?? null;
  const activeTab = { ...state.activeTab };
  if (wasActive) {
    if (neighbour) activeTab[guestId] = neighbour.id;
    else delete activeTab[guestId];
  }
  useOcForgeStore.setState({
    tabs: state.tabs.filter((tab) => !(tab.guestId === guestId && tab.id === id)),
    activeTab,
    // In the same update that removes the last tab, or the page would unmount first.
    ...(own.length === 1 ? { lingering: lingerPage(guestId) } : {}),
  });
  if (byUser && notify) broadcastOcForge(guestId, { type: 'tab-closed', payload: { id } });
  if (shownBefore && wasActive) {
    if (neighbour) broadcastOcForge(guestId, { type: 'tab-activated', payload: { id: neighbour.id } });
    else if (byUser) useUIStore.getState().setOpenGuestPage(null);
  }
  broadcastOcForgeTabs(guestId);
};

/**
 * The user closes a tab (its ×, its menu, the close-tab key). A dirty tab of an
 * extension with a frame that decides (`tabs.onCloseRequest`) stays: the page
 * shows it and the frame is asked, and runs its own flow (a save prompt), then
 * closes it or not. Any other tab closes at once.
 */
export const requestCloseOcForgeTab = (guestId: string, id: string): void => {
  const tab = useOcForgeStore.getState().tabs.find((entry) => entry.guestId === guestId && entry.id === id);
  if (!tab) return;
  const deciders = listeningFrames(guestId).filter((frame) => frame.closeHandler);
  if (!tab.dirty || deciders.length === 0) {
    closeOcForgeTab(guestId, id, true);
    return;
  }
  closeRequests.add(requestKey(guestId, id));
  if (ocForgeTabbedPageShown() !== guestId || useOcForgeStore.getState().activeTab[guestId] !== id) activateOcForgeTab(guestId, id);
  for (const frame of deciders) postToFrame(frame, { type: 'tab-close-request', payload: { id } });
};

/** A frame closes one of its tabs: after a close the user asked for, as the user's close (without echoing it). */
export const closeOcForgeTabFromFrame = (guestId: string, id: string): void => {
  if (closeRequests.has(requestKey(guestId, id))) closeOcForgeTab(guestId, id, true, false);
  else closeOcForgeTab(guestId, id, false);
};

/** Drops every tab of an extension that went away (disabled, removed, no page); its page does not linger. */
export const dropOcForgeTabsOf = (guestId: string): void => {
  const state = useOcForgeStore.getState();
  if (!state.tabs.some((tab) => tab.guestId === guestId)) return;
  const activeTab = { ...state.activeTab };
  delete activeTab[guestId];
  for (const key of [...closeRequests]) if (key.startsWith(requestKey(guestId, ''))) closeRequests.delete(key);
  useOcForgeStore.setState({ tabs: state.tabs.filter((tab) => tab.guestId !== guestId), activeTab });
};

/** Leaves an extension tab for a session: the page hides (it stays mounted) and the chat shows. */
export const leaveOcForgeTab = (): void => {
  if (ocForgeTabbedPageShown()) useUIStore.getState().setOpenGuestPage(null);
};

const renderableSessionIds = (): string[] => {
  const live = new Set(useGlobalSessionsStore.getState().activeSessions.map((session) => session.id));
  return useSessionTabsStore.getState().tabIds.filter((id) => live.has(id));
};

/** `mod+<digit>`: the session tabs first, then the extension tabs. */
export const ocForgeActivateTabByIndex = (index: number, stock: (index: number) => boolean): boolean => {
  const tabs = ocForgeVisibleTabs();
  if (tabs.length === 0) return stock(index);
  const sessions = renderableSessionIds();
  if (index < sessions.length) {
    leaveOcForgeTab();
    return stock(index);
  }
  const tab = tabs[index - sessions.length];
  return tab ? activateOcForgeTab(tab.guestId, tab.id) : false;
};

/** Previous/next tab across session and extension tabs, wrapping around. */
export const ocForgeActivateAdjacentTab = (delta: -1 | 1, stock: (delta: -1 | 1) => boolean): boolean => {
  const tabs = ocForgeVisibleTabs();
  if (tabs.length === 0) return stock(delta);
  const sessions = renderableSessionIds();
  const shown = ocForgeTabbedPageShown();
  const items: Array<{ session: string } | { tab: OcForgeHeaderTab }> = [
    ...sessions.map((session) => ({ session })),
    ...tabs.map((tab) => ({ tab })),
  ];
  const activeTab = shown ? useOcForgeStore.getState().activeTab[shown] : null;
  const current = shown
    ? sessions.length + tabs.findIndex((tab) => tab.guestId === shown && tab.id === activeTab)
    : sessions.indexOf(useSessionUIStore.getState().currentSessionId ?? '');
  if (current < (shown ? sessions.length : 0) || items.length < 2) return shown ? false : stock(delta);
  const next = items[(current + delta + items.length) % items.length];
  if ('tab' in next) return activateOcForgeTab(next.tab.guestId, next.tab.id);
  leaveOcForgeTab();
  const session = useGlobalSessionsStore.getState().activeSessions.find((entry) => entry.id === next.session);
  if (!session) return false;
  useSessionUIStore.getState().setCurrentSession(session.id, resolveGlobalSessionDirectory(session));
  return true;
};

/** `close_session_tab` while an extension tab is selected closes that tab. */
export const ocForgeCloseActiveTab = (): boolean => {
  const shown = ocForgeTabbedPageShown();
  const id = shown ? useOcForgeStore.getState().activeTab[shown] : null;
  if (!shown || !id) return false;
  requestCloseOcForgeTab(shown, id);
  return true;
};

/** Tabs follow the catalog: an extension that is gone, paused or without a page loses them. */
export const useOcForgeTabsCleanup = (): void => {
  React.useEffect(() => {
    const sync = () => {
      for (const guestId of new Set(useOcForgeStore.getState().tabs.map((tab) => tab.guestId))) {
        if (useGuestsStore.getState().status === 'ready' && !hasPage(guestId)) dropOcForgeTabsOf(guestId);
      }
    };
    sync();
    const unsubscribeGuests = useGuestsStore.subscribe(sync);
    // The page's tab strip comes and goes with the session tabs setting and the page itself.
    const unsubscribeUI = useUIStore.subscribe((state, previous) => {
      if (state.sessionTabsEnabled === previous.sessionTabsEnabled && state.openGuestPageId === previous.openGuestPageId) return;
      for (const guestId of new Set(useOcForgeStore.getState().tabs.map((tab) => tab.guestId))) broadcastOcForgeTabs(guestId);
    });
    return () => {
      unsubscribeGuests();
      unsubscribeUI();
    };
  }, []);
};
