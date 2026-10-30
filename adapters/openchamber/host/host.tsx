// What the adapted MainLayout mounts: the rail pollers and default zones, tab
// and route bookkeeping, and the keep-alive extension pages.
import React from 'react';

import { useUIStore } from '@/stores/useUIStore';

import { broadcastOcForge } from './bus.ts';
import { ocForgeShortcuts, useOcForgeAppWindowKeys } from './keys.ts';
import { useOcForgeDefaultZones, useOcForgeRailPolling } from './rail.ts';
import { useOcForgeRouteSync } from './routes.ts';
import { useOcForgeTabsCleanup } from './tabs-state.ts';

export { OcForgeGuestPages } from './tabs-ui.tsx';

/** Frames forward exactly the keys OpenChamber binds; tell them when the user rebinds. */
const useOcForgeShortcutsBroadcast = (): void => {
  React.useEffect(() => useUIStore.subscribe((state, previous) => {
    if (state.shortcutOverrides !== previous.shortcutOverrides) {
      broadcastOcForge(null, { type: 'shortcuts', payload: ocForgeShortcuts() });
    }
  }), []);
};

export const OcForgeHost: React.FC = () => {
  useOcForgeRailPolling();
  useOcForgeDefaultZones();
  useOcForgeTabsCleanup();
  useOcForgeRouteSync();
  useOcForgeShortcutsBroadcast();
  useOcForgeAppWindowKeys();
  return null;
};
