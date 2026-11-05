import { create } from 'zustand';

/**
 * oc-forge's host state. Nothing is persisted: routes belong to the frames
 * that set them, and a deep link hands its own.
 */
type OcForgeState = {
  /** The route each extension's page was handed. */
  routes: Record<string, string>;
  /** The extension whose page the address bar names, if any. */
  linked: string | null;
};

export const useOcForgeStore = create<OcForgeState>()(() => ({
  routes: {},
  linked: null,
}));
