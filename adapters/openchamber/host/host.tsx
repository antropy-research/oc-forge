// What the adapted MainLayout mounts: the address bar's bookkeeping for
// extension pages, the bindings frames are told about, and the app window's
// tab keys.
import React from 'react';

import { useUIStore } from '@/stores/useUIStore';

import { broadcastOcForge } from './bus.ts';
import { ocForgeShortcuts, useOcForgeAppWindowKeys } from './keys.ts';
import { useOcForgeRouteSync } from './routes.ts';

/** Frames forward exactly the keys OpenChamber binds; tell them when the user rebinds. */
const useOcForgeShortcutsBroadcast = (): void => {
  React.useEffect(() => useUIStore.subscribe((state, previous) => {
    if (state.shortcutOverrides !== previous.shortcutOverrides) {
      broadcastOcForge(null, { type: 'shortcuts', payload: ocForgeShortcuts() });
    }
  }), []);
};

export const OcForgeHost: React.FC = () => {
  useOcForgeRouteSync();
  useOcForgeShortcutsBroadcast();
  useOcForgeAppWindowKeys();
  return null;
};
