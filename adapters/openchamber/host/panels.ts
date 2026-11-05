// A panel that is the window's, not a folder's (`ocForge.globalPanel`).
//
// The release keeps the context panel per folder: which tab each zone shows,
// whether it is open and expanded, and a plugin's frame lives while its
// folder's panel has its tab. A chat in another folder shows that folder's
// panel, and the extension's frame starts over there, from its first open.
// For a global panel:
//
// - its pane is mounted once, hidden, as soon as the catalog lists the
//   extension active, and stays mounted in every folder (ContextSurfacePanes,
//   through `ocForgeWithGlobalPanels`; a plugin tab's id is its mode in every
//   folder, so React keeps that one pane through a switch): the frame has
//   loaded before the first click and keeps its state through every switch;
// - whether it shows in its zone, and whether that zone is expanded, is one
//   choice for the window, the user's last in whatever folder, carried into
//   each folder as it comes on screen, in the same render where possible,
//   else before the frame is painted. The choice is kept in localStorage, so
//   a reload opens as the user left it.
import React from 'react';

import { resolveEffectiveDirectory, useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { isGuestActive } from '@/lib/guests/capabilities';
import { useGuestsStore } from '@/lib/guests/store';
import { pluginModeFromId, type PluginContextPanelMode } from '@/lib/surfaces/modes';
import { getZoneView, resolveZoneActiveTab, zoneOfMode, type ContextZonePlacement, type ZonedPanel } from '@/lib/workspace/zones';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionWorktreeStore } from '@/sync/session-worktree-store';

const STORAGE_KEY = 'oc-forge:global-panels';

type GuestsState = ReturnType<typeof useGuestsStore.getState>;

/** One string for a stable selector: the modes of active extensions whose panel is global. */
const selectGlobalModes = (state: GuestsState): string => state.guests
  .filter((guest) => guest.ocForge?.globalPanel === true && Boolean(guest.entry) && isGuestActive(guest))
  .map((guest) => pluginModeFromId(guest.id))
  .join('\n');

const splitModes = (joined: string): PluginContextPanelMode[] => (joined ? (joined.split('\n') as PluginContextPanelMode[]) : []);

export const ocForgeGlobalPanelModes = (): PluginContextPanelMode[] => splitModes(selectGlobalModes(useGuestsStore.getState()));

export const useOcForgeGlobalPanelModes = (): readonly PluginContextPanelMode[] => {
  const joined = useGuestsStore(selectGlobalModes);
  return React.useMemo(() => splitModes(joined), [joined]);
};

type GlobalTab = { id: string; mode: PluginContextPanelMode };

/**
 * A folder's plugin tabs, and a tab for each global panel the folder has none
 * of, so that panel's pane is mounted in every folder, shown or not.
 */
export const ocForgeWithGlobalPanels = <T extends { id: string; mode: string }>(
  tabs: readonly T[],
  modes: readonly PluginContextPanelMode[],
): Array<T | GlobalTab> => {
  const present = new Set(tabs.map((tab) => tab.mode));
  const missing = modes.filter((mode) => !present.has(mode));
  return missing.length === 0 ? [...tabs] : [...tabs, ...missing.map((mode) => ({ id: mode, mode }))];
};

/** Whether the panel is what its zone shows in one folder, and whether that zone is expanded. */
export type OcForgeGlobalView = { shown: boolean; expanded: boolean };

export const ocForgePanelView = (
  panel: ZonedPanel | undefined,
  placement: ContextZonePlacement,
  mode: PluginContextPanelMode,
): OcForgeGlobalView => {
  if (!panel) return { shown: false, expanded: false };
  const zone = zoneOfMode(placement, mode);
  const view = getZoneView(panel, zone);
  const shown = view.isOpen && resolveZoneActiveTab(panel, placement, zone)?.mode === mode;
  return { shown, expanded: shown && view.expanded };
};

const isView = (value: unknown): value is OcForgeGlobalView => typeof value === 'object' && value !== null
  && typeof (value as OcForgeGlobalView).shown === 'boolean' && typeof (value as OcForgeGlobalView).expanded === 'boolean';

let choices: Record<string, OcForgeGlobalView> | null = null;
/** The folder whose panel the window's choice was last carried into; its changes are the user's choice. */
let synced: string | null = null;

const readChoices = (): Record<string, OcForgeGlobalView> => {
  if (choices) return choices;
  choices = {};
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
    if (typeof stored === 'object' && stored !== null) {
      for (const [mode, view] of Object.entries(stored)) if (isView(view)) choices[mode] = { shown: view.shown, expanded: view.expanded };
    }
  } catch {
    // No storage, or something else's text under the key: no choice yet.
  }
  return choices;
};

const choose = (mode: PluginContextPanelMode, view: OcForgeGlobalView): void => {
  const current = readChoices()[mode];
  if (current && current.shown === view.shown && current.expanded === view.expanded) return;
  choices = { ...readChoices(), [mode]: view };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(choices));
  } catch {
    // Kept for this window only.
  }
};

/** The folder's panel as the user left it is the window's choice, for every global panel. */
const record = (key: string): void => {
  const ui = useUIStore.getState();
  for (const mode of ocForgeGlobalPanelModes()) choose(mode, ocForgePanelView(ui.contextPanelByDirectory[key], ui.contextSurfaceZones, mode));
};

/** The window's choice, carried into one folder's panel through the store's own actions. */
const carryInto = (key: string): void => {
  for (const mode of ocForgeGlobalPanelModes()) {
    const want = readChoices()[mode];
    if (!want) continue;
    const ui = useUIStore.getState();
    const zone = zoneOfMode(ui.contextSurfaceZones, mode);
    const now = ocForgePanelView(ui.contextPanelByDirectory[key], ui.contextSurfaceZones, mode);
    if (want.shown && !now.shown) ui.openContextPanelTab(key, { mode });
    else if (!want.shown && now.shown) ui.closeContextZone(key, zone);
    if (!want.shown) continue;
    const after = useUIStore.getState();
    if (ocForgePanelView(after.contextPanelByDirectory[key], after.contextSurfaceZones, mode).expanded !== want.expanded) {
      after.toggleContextPanelExpanded(key, zone);
    }
  }
};

/** The folder on screen is `key` now. A panel without a choice yet takes the one this folder shows. */
const follow = (key: string): void => {
  if (!key) return;
  if (key !== synced) {
    carryInto(key);
    synced = key;
  }
  record(key);
};

/**
 * Shows a global panel in the folder on screen, and so in every folder: a deep link to it, opened before the window
 * has carried its choice into a folder, would otherwise be closed again by that choice.
 */
export const showOcForgeGlobalPanel = (mode: PluginContextPanelMode): void => {
  choose(mode, { shown: true, expanded: readChoices()[mode]?.expanded ?? false });
  const key = normalizeContextPanelDirectoryKey(resolveEffectiveDirectory() ?? useDirectoryStore.getState().currentDirectory ?? '');
  if (!key) return;
  const ui = useUIStore.getState();
  if (!ocForgePanelView(ui.contextPanelByDirectory[key], ui.contextSurfaceZones, mode).shown) ui.openContextPanelTab(key, { mode });
};

/** Mounted with the oc-forge host. */
export const useOcForgeGlobalPanels = (): void => {
  const modes = useOcForgeGlobalPanelModes();
  const directory = useEffectiveDirectory() ?? '';

  React.useEffect(() => {
    // A chat or folder picked in a handler or a fetch callback changes these stores first; the choice goes into the
    // new folder in the same tick, so the render that shows the folder already shows the panel as chosen. Only when
    // this reading of the folder changes: while a chat's record is still on its way it can differ from the hook's
    // (which falls back to the chat's own directory), and the layout effect below, the folder drawn, has the last word.
    let selected: string | null = null;
    const onSelection = () => {
      if (ocForgeGlobalPanelModes().length === 0) return;
      const key = normalizeContextPanelDirectoryKey(resolveEffectiveDirectory() ?? '');
      if (key === selected) return;
      selected = key;
      follow(key);
    };
    const stops = [
      useSessionUIStore.subscribe(onSelection),
      useDirectoryStore.subscribe(onSelection),
      useSessionWorktreeStore.subscribe(onSelection),
      useUIStore.subscribe((state, previous) => {
        if (!synced || ocForgeGlobalPanelModes().length === 0) return;
        const panel = state.contextPanelByDirectory[synced];
        // A folder's panel the store dropped (it keeps the 20 used last, a runtime switch clears them) is no choice.
        if (!panel || (panel === previous.contextPanelByDirectory[synced] && state.contextSurfaceZones === previous.contextSurfaceZones)) return;
        record(synced);
      }),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  }, []);

  // Whatever else moved the folder on screen (a chat's record arriving late), and a global panel the catalog has just
  // listed: before the browser paints.
  React.useLayoutEffect(() => {
    if (modes.length === 0) return;
    follow(normalizeContextPanelDirectoryKey(directory));
  }, [directory, modes]);
};
