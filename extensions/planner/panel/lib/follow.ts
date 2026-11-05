// The Planner as one panel for the whole window, with OpenChamber's released extension API alone. OpenChamber keeps its
// right panel per folder (which surface each zone shows, open or not) and mounts the Planner's frame while that
// folder's panel has the Planner's tab: a chat in another folder (a worktree an agent works in, another project) showed
// that folder's panel, without the Planner. So:
//
// - while the rail panel is on screen it says so, every second, in this browser's storage for the extension
//   (`shownAt`, with its folder); hidden for a moment without a change of folder (closed, or another surface shown
//   in its zone), it says that too (`hiddenAt`);
// - the Work Status section, which OpenChamber shows with a chat whose right panel is closed (it hides the card while
//   the panel is open, and keeps it through chat switches), shows the Planner's panel in its folder
//   (`host.openSurface`, which never closes one already shown) when the panel was on screen in another folder just
//   before: the chat changed under an open Planner. Its own folder's panel just closed is the user's choice.
//
// Once a folder's panel has the Planner's tab, OpenChamber keeps the frame mounted there, shown or not: it loads with
// the window, and moving between two folders that both have it keeps the same frame, so nothing reloads.
import type { HostClient, JsonValue } from '@openchamber/sdk';

/** The rail panel's surface (`contributes.panel.id`). */
export const PANEL_SURFACE = 'plugin:oc-forge-planner';
const SHOWN_KEY = 'planner.panel.shown';
const HIDDEN_KEY = 'planner.panel.hidden';
const DEVICE = { scope: 'device' } as const;
/** How often an open panel says so. */
const BEAT_MS = 1000;
/**
 * A panel on screen this recently was open when the chat changed. The Work Status section starts only once the next
 * folder's card shows, and loads, a few seconds after the switch; a panel the user hid says so (`hiddenAt`) first.
 */
export const FOLLOW_MS = 15_000;
/** Hidden this long with no change of folder: the user closed it, or showed something else in its zone. */
const HIDDEN_MS = 700;
/**
 * On screen: this much of the frame in view. A closed zone keeps its pane laid out and only fades it (opacity 0,
 * inert), sliding it behind the Work Status column, half in view (0.51 at 1440 px); an open one shows all of it.
 * Another surface in the zone hides the pane (`display: none`): nothing in view.
 */
export const ON_SCREEN_RATIO = 0.9;

export type PanelShown = { at: number; directory: string | null };
export type PanelHidden = { at: number };

const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

export const readShown = (value: unknown): PanelShown | null => {
  if (typeof value !== 'object' || value === null) return null;
  const { at, directory } = value as { at?: unknown; directory?: unknown };
  return isTime(at) ? { at, directory: typeof directory === 'string' ? directory : null } : null;
};

export const readHidden = (value: unknown): PanelHidden | null => {
  if (typeof value !== 'object' || value === null) return null;
  const { at } = value as { at?: unknown };
  return isTime(at) ? { at } : null;
};

/** The panel was on screen just now, and not hidden by the user since. */
export const shouldFollow = (shown: PanelShown | null, hidden: PanelHidden | null, now: number): boolean => (
  Boolean(shown) && now - shown!.at <= FOLLOW_MS && now >= shown!.at - FOLLOW_MS && !(hidden && hidden.at > shown!.at)
);

const save = (host: HostClient, key: string, value: JsonValue): void => {
  void host.storage.set(key, value, DEVICE).catch(() => {});
};

/**
 * The rail panel's side: on screen (an IntersectionObserver on the document, ON_SCREEN_RATIO of it in view), it writes
 * `shownAt` at once and every second; hidden for HIDDEN_MS without a change of folder, `hiddenAt`.
 */
export const trackPanelShown = (host: HostClient, root: Element = document.documentElement): (() => void) => {
  if (typeof IntersectionObserver !== 'function') return () => {};
  let directory: string | null = null;
  let directoryChangedAt = 0;
  let beat: ReturnType<typeof setInterval> | null = null;
  let hide: ReturnType<typeof setTimeout> | null = null;
  const shown = () => save(host, SHOWN_KEY, { at: Date.now(), directory });
  let started = false;
  const stopDirectory = host.onDirectory((next) => {
    // The first folder the frame learns (replayed when it subscribes) is where it starts, not a switch.
    if (!started) {
      started = true;
      directory = next;
      return;
    }
    if (next === directory) return;
    directory = next;
    directoryChangedAt = Date.now();
  });
  const observer = new IntersectionObserver((entries) => {
    const onScreen = entries.some((entry) => entry.isIntersecting && entry.intersectionRatio >= ON_SCREEN_RATIO);
    if (onScreen) {
      if (hide) clearTimeout(hide);
      hide = null;
      if (!beat) {
        shown();
        beat = setInterval(shown, BEAT_MS);
      }
      return;
    }
    if (beat) clearInterval(beat);
    beat = null;
    if (hide) clearTimeout(hide);
    hide = setTimeout(() => {
      hide = null;
      // Hidden by a change of chat into a folder whose panel shows something else: the Work Status section decides.
      if (Date.now() - directoryChangedAt < HIDDEN_MS + 300) return;
      save(host, HIDDEN_KEY, { at: Date.now() });
    }, HIDDEN_MS);
  }, { threshold: [0, 0.5, ON_SCREEN_RATIO, 1] });
  observer.observe(root);
  return () => {
    observer.disconnect();
    stopDirectory();
    if (beat) clearInterval(beat);
    if (hide) clearTimeout(hide);
  };
};

/**
 * The Work Status section's side: when it starts and whenever its folder changes, it shows the Planner's panel there
 * if the panel was on screen just before in another folder. Once per folder it comes to.
 */
export const followPanel = (host: HostClient): (() => void) => {
  let current: string | null | undefined;
  let stopped = false;
  const check = async (directory: string | null) => {
    const [shown, hidden] = await Promise.all([
      host.storage.get(SHOWN_KEY, DEVICE).then(readShown, () => null),
      host.storage.get(HIDDEN_KEY, DEVICE).then(readHidden, () => null),
    ]);
    if (stopped || directory !== current || !directory || shown?.directory === directory || !shouldFollow(shown, hidden, Date.now())) return;
    await host.openSurface(PANEL_SURFACE).catch(() => {});
  };
  const stop = host.onDirectory((directory) => {
    if (directory === current) return;
    current = directory;
    void check(directory);
  });
  return () => {
    stopped = true;
    stop();
  };
};
