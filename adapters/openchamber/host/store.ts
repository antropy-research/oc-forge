import { create } from 'zustand';

import type { OcForgeRailEntry, OcForgeTab } from './protocol.ts';

export type OcForgeHeaderTab = OcForgeTab & { guestId: string };

/**
 * oc-forge's host state. Nothing is persisted: rail entries come back with the
 * next poll, header tabs and routes belong to the frames that opened them.
 */
type OcForgeState = {
  /** The last list each extension's service answered. */
  entries: Record<string, OcForgeRailEntry[]>;
  /** The entry an extension's one panel shows. */
  current: Record<string, string>;
  /** Extension tabs in the header, in the order they opened. */
  tabs: OcForgeHeaderTab[];
  /** The tab each extension's page shows (or will, when it opens). */
  activeTab: Record<string, string>;
  /**
   * Extensions whose last tab just closed, with when (ms) their page may go:
   * until then it stays mounted, hidden, so its frame hears the close.
   */
  lingering: Record<string, number>;
  /** The route each extension's page was handed. */
  routes: Record<string, string>;
  /** The extension whose page the address bar names, if any. */
  linked: string | null;
};

export const useOcForgeStore = create<OcForgeState>()(() => ({
  entries: {},
  current: {},
  tabs: [],
  activeTab: {},
  lingering: {},
  routes: {},
  linked: null,
}));
