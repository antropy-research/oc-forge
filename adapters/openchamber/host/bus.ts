import { envelope, type OcForgeEvent } from './protocol.ts';

/** A mounted extension frame (rail panel, page, Work Status section, file editor, dialog). */
export type OcForgeFrame = {
  guestId: string;
  /** `plugin:<extension>`, or `plugin:<extension>--<entry>` for an entry's own panel. */
  mode: string;
  surface: string;
  /** Set for a rail entry's own panel. */
  ownEntry: string | null;
  /** Its client said hello on the oc-forge channel; only such frames get events. */
  listening: boolean;
  /** Its client decides how the extension's dirty tabs close (`tabs.onCloseRequest`). */
  closeHandler: boolean;
  window: () => Window | null;
};

const frames = new Set<OcForgeFrame>();

export const registerOcForgeFrame = (frame: OcForgeFrame): (() => void) => {
  frames.add(frame);
  return () => {
    frames.delete(frame);
  };
};

// Sandboxed frames have an opaque origin; isolation is the contentWindow, as for the SDK's own messages.
export const postToFrame = (frame: OcForgeFrame, event: OcForgeEvent): void => {
  frame.window()?.postMessage(envelope(event), '*');
};

/** Posts to every listening frame of one extension (or of all, for `null`) that `filter` accepts. */
export const broadcastOcForge = (guestId: string | null, event: OcForgeEvent, filter?: (frame: OcForgeFrame) => boolean): void => {
  for (const frame of frames) {
    if (!frame.listening || (guestId !== null && frame.guestId !== guestId) || (filter && !filter(frame))) continue;
    postToFrame(frame, event);
  }
};

export const listeningFrames = (guestId: string): OcForgeFrame[] => [...frames].filter((frame) => frame.listening && frame.guestId === guestId);
