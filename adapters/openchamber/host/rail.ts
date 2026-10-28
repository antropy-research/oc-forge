// R1 rail entries and R3 default zones. An extension that declares
// `ocForge.rail` in its package.json has its service polled for a list of
// entries; each entry is its own rail icon. Entries without a zone are views
// of the extension's one panel (one frame, told which entry to show); an
// entry with a zone is a panel of its own, `plugin:<extension>--<entry>`.
import React from 'react';

import { isGuestActive } from '@/lib/guests/capabilities';
import { FALLBACK_GUEST_ICON, resolveGuestIconName } from '@/lib/guests/icon';
import { proxyGuestServiceRequest } from '@/lib/guests/service';
import { useGuestsStore } from '@/lib/guests/store';
import { closeGuestTabsEverywhere } from '@/lib/guests/tabs';
import type { InstalledGuest } from '@/lib/guests/types';
import type { ContextSurfaceDescriptor } from '@/lib/surfaces/registry';
import { isPluginContextPanelMode, type PluginContextPanelMode } from '@/lib/surfaces/modes';
import { shownContextModes } from '@/lib/workspace/zones';
import { useUIStore } from '@/stores/useUIStore';

import { broadcastOcForge } from './bus.ts';
import { ocForgeEntrySurfaceId, ocForgeEntrySurfaceOf } from './ids.ts';
import { readOcForgeRailEntries, type OcForgeRailEntry, type OcForgeZone } from './protocol.ts';
import { useOcForgeStore } from './store.ts';

const PLUGIN_PREFIX = 'plugin:';

const sharedEntries = (entries: readonly OcForgeRailEntry[] | undefined): OcForgeRailEntry[] => (
  entries ?? []
).filter((entry) => !entry.zone);

/**
 * The polled entries and each panel's current entry. Code that renders takes
 * it as an argument (from useOcForgeRailRevision): OpenChamber is built with
 * the React Compiler, which memoizes on the values a render reads, so state
 * read from the store inside a render would never invalidate it.
 */
export type OcForgeRailState = Readonly<{ entries: Record<string, OcForgeRailEntry[]>; current: Record<string, string> }>;

export const currentOcForgeRail = (): OcForgeRailState => {
  const { entries, current } = useOcForgeStore.getState();
  return { entries, current };
};

/** The entry an extension's one panel shows: the last one chosen, else its first view. */
export const ocForgeCurrentEntry = (guestId: string, rail: OcForgeRailState = currentOcForgeRail()): string | null => {
  const { current, entries } = rail;
  const views = sharedEntries(entries[guestId]);
  const chosen = current[guestId];
  if (chosen && views.some((entry) => entry.id === chosen)) return chosen;
  return views[0]?.id ?? null;
};

/** Sets the panel's entry; `notify` tells its frame (a rail click), not when the frame itself reported it. */
export const setOcForgeCurrentEntry = (guestId: string, entry: string, notify: boolean): void => {
  useOcForgeStore.setState((state) => (state.current[guestId] === entry ? state : { current: { ...state.current, [guestId]: entry } }));
  if (notify) {
    broadcastOcForge(guestId, { type: 'rail-entry', payload: { entry } }, (frame) => frame.surface === 'panel' && frame.ownEntry === null);
  }
};

// Starts from the extension's own descriptor, so whatever else OpenChamber puts there carries over.
const entryDescriptor = (guestId: string, entry: OcForgeRailEntry, extension: ContextSurfaceDescriptor): ContextSurfaceDescriptor => {
  const surface: PluginContextPanelMode = `${PLUGIN_PREFIX}${ocForgeEntrySurfaceId(guestId, entry.id)}`;
  const svg = entry.icon.trimStart().startsWith('<');
  return {
    ...extension,
    id: surface,
    mode: entry.zone ? surface : `${PLUGIN_PREFIX}${guestId}`,
    icon: svg ? FALLBACK_GUEST_ICON : resolveGuestIconName(entry.icon),
    // Drawn as a CSS mask: an SVG used as an image never runs scripts.
    iconSrc: svg ? `data:image/svg+xml,${encodeURIComponent(entry.icon.trim())}` : undefined,
    label: entry.title,
  };
};

/**
 * The rail's extension surfaces with each polling extension's icon replaced by
 * its entries. An extension whose list is empty or not read yet keeps its icon.
 */
export const ocForgeExpandRailSurfaces = (
  surfaces: ContextSurfaceDescriptor[],
  rail: OcForgeRailState = currentOcForgeRail(),
): ContextSurfaceDescriptor[] => {
  const { entries } = rail;
  if (Object.keys(entries).length === 0) return surfaces;
  return surfaces.flatMap((surface) => {
    if (!isPluginContextPanelMode(surface.mode) || surface.id !== surface.mode) return [surface];
    const guestId = surface.mode.slice(PLUGIN_PREFIX.length);
    const list = entries[guestId];
    return list && list.length > 0 ? list.map((entry) => entryDescriptor(guestId, entry, surface)) : [surface];
  });
};

/** The rail state for a render: pass it on, so a change of entries or current entry re-renders. */
export const useOcForgeRailRevision = (): OcForgeRailState => {
  const entries = useOcForgeStore((state) => state.entries);
  const current = useOcForgeStore((state) => state.current);
  return React.useMemo(() => ({ entries, current }), [entries, current]);
};

/** An entry's own panel is titled with the entry, in its zone's header. */
export const ocForgeSurfaceLabel = (mode: string): string | null => {
  const own = ocForgeEntrySurfaceOf(mode.slice(PLUGIN_PREFIX.length));
  if (!own) return null;
  return useOcForgeStore.getState().entries[own.guestId]?.find((entry) => entry.id === own.entry)?.title ?? null;
};

/** A view entry of an extension's one panel: its rail id is the entry, its mode the panel. */
const viewEntryOf = (surface: Pick<ContextSurfaceDescriptor, 'id' | 'mode'>): { guestId: string; entry: string } | null => {
  if (surface.id === surface.mode || !isPluginContextPanelMode(surface.mode)) return null;
  const guestId = surface.mode.slice(PLUGIN_PREFIX.length);
  const prefix = `${PLUGIN_PREFIX}${guestId}--`;
  return surface.id.startsWith(prefix) ? { guestId, entry: surface.id.slice(prefix.length) } : null;
};

/** Whether the rail lights this icon: its surface is on screen and, for a view entry, the panel shows it. */
export const ocForgeRailSurfaceActive = (
  surface: Pick<ContextSurfaceDescriptor, 'id' | 'mode'>,
  shownModes: ReadonlySet<string>,
  rail: OcForgeRailState = currentOcForgeRail(),
): boolean => {
  if (!shownModes.has(surface.mode)) return false;
  const view = viewEntryOf(surface);
  return !view || ocForgeCurrentEntry(view.guestId, rail) === view.entry;
};

/**
 * A rail click or digit shortcut on a view entry: show the panel on that
 * entry, or close it when it already shows it. False for every other surface,
 * which the caller opens the stock way.
 */
export const ocForgeSelectRailSurface = (directory: string, surface: Pick<ContextSurfaceDescriptor, 'id' | 'mode'>): boolean => {
  const view = viewEntryOf(surface);
  if (!view || !directory) return false;
  const ui = useUIStore.getState();
  const shown = shownContextModes(ui.contextPanelByDirectory[directory], ui.contextSurfaceZones).has(surface.mode);
  if (shown && ocForgeCurrentEntry(view.guestId) === view.entry) {
    ui.openContextSurface(directory, surface.mode);
    return true;
  }
  setOcForgeCurrentEntry(view.guestId, view.entry, true);
  if (!shown) ui.openContextSurface(directory, surface.mode);
  return true;
};

const sameEntries = (left: readonly OcForgeRailEntry[] | undefined, right: readonly OcForgeRailEntry[]): boolean => (
  Boolean(left) && JSON.stringify(left) === JSON.stringify(right)
);

/** A removed entry's own panel closes, in every project. */
const closeRemovedEntryPanels = (guestId: string, entries: readonly OcForgeRailEntry[]): void => {
  const kept = new Set(entries.filter((entry) => entry.zone).map((entry) => `${PLUGIN_PREFIX}${ocForgeEntrySurfaceId(guestId, entry.id)}`));
  const prefix = `${PLUGIN_PREFIX}${guestId}--`;
  const stale = new Set<PluginContextPanelMode>();
  for (const panel of Object.values(useUIStore.getState().contextPanelByDirectory)) {
    for (const tab of panel.tabs) {
      if (isPluginContextPanelMode(tab.mode) && tab.mode.startsWith(prefix) && !kept.has(tab.mode)) stale.add(tab.mode);
    }
  }
  for (const mode of stale) closeGuestTabsEverywhere(mode);
};

const setEntries = (guestId: string, entries: OcForgeRailEntry[] | null): void => {
  const previous = useOcForgeStore.getState().entries[guestId];
  if (entries === null) {
    if (!previous) return;
    useOcForgeStore.setState((state) => {
      const next = { ...state.entries };
      delete next[guestId];
      return { entries: next };
    });
    return;
  }
  if (!sameEntries(previous, entries)) {
    useOcForgeStore.setState((state) => ({ entries: { ...state.entries, [guestId]: entries } }));
  }
  closeRemovedEntryPanels(guestId, entries);
};

type RailSource = { path: string; interval: number };

/** Reads the list now and then every `interval` after the last answer, never while the page is hidden. */
const startRailPolling = (guestId: string, source: RailSource): (() => void) => {
  let stopped = false;
  let running = false;
  let timer: number | null = null;
  const tick = async (): Promise<void> => {
    timer = null;
    if (stopped || running || document.visibilityState === 'hidden') return;
    running = true;
    const answer = await proxyGuestServiceRequest(guestId, { method: 'GET', path: source.path });
    running = false;
    if (stopped) return;
    if (answer.ok && answer.result.status >= 200 && answer.result.status < 300) {
      let body: unknown = null;
      try {
        body = JSON.parse(answer.result.body);
      } catch {
        body = null;
      }
      const entries = readOcForgeRailEntries(body);
      if (entries) setEntries(guestId, entries);
    }
    // An unreachable service keeps the last list: icons do not flicker while it restarts.
    timer = window.setTimeout(() => { void tick(); }, source.interval);
  };
  const onVisible = () => {
    if (document.visibilityState !== 'hidden' && timer === null && !running) void tick();
  };
  document.addEventListener('visibilitychange', onVisible);
  void tick();
  return () => {
    stopped = true;
    if (timer !== null) window.clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisible);
  };
};

const railSourceOf = (guest: InstalledGuest): RailSource | null => (
  isGuestActive(guest) && guest.entry && guest.service?.granted && guest.ocForge?.rail ? guest.ocForge.rail : null
);

/** One poller per active extension that declares a rail source and has its service approved. */
export const useOcForgeRailPolling = (): void => {
  React.useEffect(() => {
    const pollers = new Map<string, { key: string; stop: () => void }>();
    const sync = () => {
      const wanted = new Map<string, RailSource>();
      for (const guest of useGuestsStore.getState().guests) {
        const source = railSourceOf(guest);
        if (source) wanted.set(guest.id, source);
      }
      for (const [guestId, poller] of pollers) {
        const source = wanted.get(guestId);
        if (source && JSON.stringify(source) === poller.key) continue;
        poller.stop();
        pollers.delete(guestId);
        if (!source) setEntries(guestId, null);
      }
      for (const [guestId, source] of wanted) {
        if (!pollers.has(guestId)) pollers.set(guestId, { key: JSON.stringify(source), stop: startRailPolling(guestId, source) });
      }
      for (const guestId of Object.keys(useOcForgeStore.getState().entries)) {
        if (!wanted.has(guestId)) setEntries(guestId, null);
      }
    };
    sync();
    const unsubscribe = useGuestsStore.subscribe((state, previous) => {
      if (state.guests !== previous.guests) sync();
    });
    return () => {
      unsubscribe();
      for (const poller of pollers.values()) poller.stop();
    };
  }, []);
};

const APPLIED_ZONES_KEY = 'oc-forge:default-zones';

const readAppliedZones = (): Set<string> => {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(APPLIED_ZONES_KEY) ?? '[]');
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
  } catch {
    return new Set();
  }
};

/**
 * R3: a panel whose extension (or rail entry) names a zone opens there until
 * the user moves it. The default is placed once per device, the first time
 * the surface is known, unless the user already placed it; after that the
 * user's placement is all there is, as for any surface.
 */
export const applyOcForgeDefaultZones = (): void => {
  const wanted: Array<[PluginContextPanelMode, OcForgeZone]> = [];
  for (const guest of useGuestsStore.getState().guests) {
    if (!isGuestActive(guest) || !guest.entry) continue;
    if (guest.ocForge?.zone) wanted.push([`${PLUGIN_PREFIX}${guest.id}`, guest.ocForge.zone]);
    for (const entry of useOcForgeStore.getState().entries[guest.id] ?? []) {
      if (entry.zone) wanted.push([`${PLUGIN_PREFIX}${ocForgeEntrySurfaceId(guest.id, entry.id)}`, entry.zone]);
    }
  }
  if (wanted.length === 0) return;
  const applied = readAppliedZones();
  let changed = false;
  for (const [mode, zone] of wanted) {
    if (applied.has(mode)) continue;
    applied.add(mode);
    changed = true;
    const ui = useUIStore.getState();
    if (zone !== 'right' && ui.contextSurfaceZones[mode] === undefined) ui.moveContextSurfaceToZone(mode, zone);
  }
  if (changed) {
    try {
      window.localStorage.setItem(APPLIED_ZONES_KEY, JSON.stringify([...applied]));
    } catch {
      // Without storage the default is placed again next time; the user's own moves still win.
    }
  }
};

export const useOcForgeDefaultZones = (): void => {
  React.useEffect(() => {
    applyOcForgeDefaultZones();
    const unsubscribeGuests = useGuestsStore.subscribe((state, previous) => {
      if (state.guests !== previous.guests) applyOcForgeDefaultZones();
    });
    const unsubscribeEntries = useOcForgeStore.subscribe((state, previous) => {
      if (state.entries !== previous.entries) applyOcForgeDefaultZones();
    });
    return () => {
      unsubscribeGuests();
      unsubscribeEntries();
    };
  }, []);
};
