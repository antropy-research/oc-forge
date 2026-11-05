// The Planner as one panel for the whole window, with OpenChamber's released extension API alone. OpenChamber keeps its
// right panel per folder (which surface each zone shows, open or not) and mounts the Planner's frame while that
// folder's panel has the Planner's tab: a chat in another folder (a worktree an agent works in, another project) showed
// that folder's panel, without the Planner. So:
//
// - while the rail panel is on screen, in a window that is shown, it says so in this browser's storage for the
//   extension, every half second, under a key of its own frame (with its folder); hidden for a moment without a change
//   of folder (closed, or another surface shown in its zone), it says the user hid it;
// - the Work Status section, which OpenChamber shows with a chat whose right panel is closed (it hides the card while
//   the panel is open, and keeps it through chat switches), shows the Planner's panel in its folder
//   (`host.openSurface`, which never closes one already shown) when a panel was on screen in another folder just
//   before and has stopped saying so: the chat changed under an open Planner, whose frame went or hid with it.
//
// Storage is the browser's, shared by its windows and tabs. A panel that still says so is on screen in another window,
// not this one's: it is not followed, so closing the Planner here never brings it back because another window shows it.
// A panel the user hid since is not followed either; nor one whose window went to the background (it says so: another
// tab was chosen, which is no change of chat under it).
//
// Once a folder's panel has the Planner's tab, OpenChamber keeps the frame mounted there, shown or not: it loads with
// the window, and moving between two folders that both have it keeps the same frame, so nothing reloads.
import type { HostClient, JsonValue } from '@openchamber/sdk';

/** The rail panel's surface (`contributes.panel.id`). */
export const PANEL_SURFACE = 'plugin:oc-forge-planner';
/** One key per panel frame: `planner.panel.beat.<frame>`. */
export const BEAT_PREFIX = 'planner.panel.beat.';
const HIDDEN_KEY = 'planner.panel.hidden';
const DEVICE = { scope: 'device' } as const;
/** How often a panel on screen says so. */
export const BEAT_MS = 500;
/** A panel silent this long is not on screen any more: its frame went or hid, or its window went to the background. */
export const STOPPED_MS = 1500;
/**
 * A panel on screen this recently was open when the chat changed. The Work Status section starts only once the next
 * folder's card shows, and loads, a few seconds after the switch; a panel the user hid says so first.
 */
export const FOLLOW_MS = 15_000;
/** How many times the Work Status section looks again for a panel that still says it is on screen. */
const LOOKS = 4;
/** What a panel said this long ago is of no use: whoever reads it deletes it. */
export const STALE_MS = 60_000;
/** Hidden this long with no change of folder: the user closed it, or showed something else in its zone. */
export const HIDDEN_MS = 700;
/**
 * The Work Status section's first look, this long after it learns its folder: OpenChamber brings the section back as
 * the panel closes, and the panel says the user hid it only HIDDEN_MS later; looking before, the section would follow
 * an older panel (one a chat switch took away a few seconds ago) back into the panel the user just closed.
 */
export const FIRST_LOOK_MS = HIDDEN_MS + 500;
/**
 * After a change of folder the panel says nothing for this long: the folder is the new one before OpenChamber has
 * hidden it (a zone closed there, or one without the Planner), and saying so then would put the panel in the folder it
 * is leaving. Still on screen afterwards, it is on screen in the new one.
 */
const SETTLE_MS = 600;
/**
 * On screen: this much of the frame in view. A closed zone keeps its pane laid out and only fades it (opacity 0,
 * inert), sliding it behind the Work Status column, half in view (0.51 at 1440 px); an open one shows all of it.
 * Another surface in the zone hides the pane (`display: none`): nothing in view.
 */
export const ON_SCREEN_RATIO = 0.9;

/** `away`: its window went to the background. */
export type PanelBeat = { at: number; directory: string | null; away?: true };
export type PanelHidden = { at: number };

const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

export const readBeat = (value: unknown): PanelBeat | null => {
  if (typeof value !== 'object' || value === null) return null;
  const { at, directory, away } = value as { at?: unknown; directory?: unknown; away?: unknown };
  if (!isTime(at)) return null;
  return { at, directory: typeof directory === 'string' ? directory : null, ...(away === true ? { away: true as const } : {}) };
};

export const readHidden = (value: unknown): PanelHidden | null => {
  if (typeof value !== 'object' || value === null) return null;
  const { at } = value as { at?: unknown };
  return isTime(at) ? { at } : null;
};

export type FollowAnswer = { follow: true } | { follow: false; againIn: number | null };

/**
 * Whether the Work Status section in `directory` shows the Planner's panel. A panel on screen in another folder within
 * FOLLOW_MS, after the user last hid one, may be this window's, which the chat switch took away: follow once one of
 * them has been silent STOPPED_MS. Ones still saying so are on screen somewhere: look again when the first of them
 * would have stopped (`againIn`); one that keeps saying so is another window's.
 */
export const decide = (beats: readonly PanelBeat[], hidden: PanelHidden | null, directory: string, now: number): FollowAnswer => {
  const open = beats.filter((beat) => !beat.away && beat.directory !== directory && beat.at >= now - FOLLOW_MS && beat.at <= now + BEAT_MS && !(hidden && hidden.at > beat.at));
  if (!open.length) return { follow: false, againIn: null };
  if (open.some((beat) => now - beat.at >= STOPPED_MS)) return { follow: true };
  return { follow: false, againIn: Math.max(50, Math.min(...open.map((beat) => beat.at + STOPPED_MS - now)) + 50) };
};

const save = (host: HostClient, key: string, value: JsonValue): void => {
  void host.storage.set(key, value, DEVICE).catch(() => {});
};

/** Every panel's last word, by key; ones STALE_MS old (or unreadable) are deleted as they are read. */
export const readBeats = async (host: HostClient, now = Date.now()): Promise<PanelBeat[]> => {
  const keys = await host.storage.keys(DEVICE).catch(() => [] as string[]);
  const read = await Promise.all(keys.filter((key) => key.startsWith(BEAT_PREFIX)).map(async (key) => {
    const beat = readBeat(await host.storage.get(key, DEVICE).catch(() => undefined));
    if (!beat || beat.at < now - STALE_MS) {
      void host.storage.delete(key, DEVICE).catch(() => {});
      return null;
    }
    return beat;
  }));
  return read.filter((beat): beat is PanelBeat => beat !== null);
};

/** A name for this frame's key, random enough among the browser's frames (no secure context needed). */
const frameName = (): string => {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const windowHidden = (): boolean => typeof document !== 'undefined' && document.hidden;

/**
 * The rail panel's side: on screen (an IntersectionObserver on the document, ON_SCREEN_RATIO of it in view) in a
 * window that is shown, it writes its beat at once and every BEAT_MS; hidden for HIDDEN_MS without a change of folder,
 * that the user hid it.
 */
export const trackPanelShown = (host: HostClient, root: Element = document.documentElement): (() => void) => {
  if (typeof IntersectionObserver !== 'function') return () => {};
  const key = `${BEAT_PREFIX}${frameName()}`;
  let directory: string | null = null;
  let directoryChangedAt = 0;
  let inView = false;
  let beat: ReturnType<typeof setInterval> | null = null;
  let hide: ReturnType<typeof setTimeout> | null = null;
  const say = () => {
    if (Date.now() - directoryChangedAt < SETTLE_MS) return;
    save(host, key, { at: Date.now(), directory });
  };
  const update = () => {
    const shown = inView && !windowHidden();
    if (shown && !beat) {
      say();
      beat = setInterval(say, BEAT_MS);
    } else if (!shown && beat) {
      clearInterval(beat);
      beat = null;
    }
  };
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
    inView = entries.some((entry) => entry.isIntersecting && entry.intersectionRatio >= ON_SCREEN_RATIO);
    update();
    if (inView) {
      if (hide) clearTimeout(hide);
      hide = null;
      return;
    }
    if (hide) return;
    hide = setTimeout(() => {
      hide = null;
      // Hidden by a change of chat into a folder whose panel shows something else: the Work Status section decides.
      if (inView || Date.now() - directoryChangedAt < HIDDEN_MS + 300) return;
      save(host, HIDDEN_KEY, { at: Date.now() });
    }, HIDDEN_MS);
  }, { threshold: [0, 0.5, ON_SCREEN_RATIO, 1] });
  observer.observe(root);
  // A window in the background says nothing more, after saying it went (its panel is on no screen, and no chat changed
  // under it); shown again, it says so again. Said a moment later: a frame that goes (a chat switch took it) also
  // turns hidden as it unloads, and runs no more timers, so it never says "away".
  let away: ReturnType<typeof setTimeout> | null = null;
  const onVisibility = () => {
    const wasBeating = beat !== null;
    update();
    if (away) clearTimeout(away);
    away = null;
    if (!wasBeating || !windowHidden()) return;
    away = setTimeout(() => {
      away = null;
      if (windowHidden() && !beat) save(host, key, { at: Date.now(), directory, away: true });
    }, 50);
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
  // What earlier frames left behind is swept, so the keys stay few.
  void readBeats(host);
  return () => {
    observer.disconnect();
    stopDirectory();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    if (beat) clearInterval(beat);
    if (hide) clearTimeout(hide);
    if (away) clearTimeout(away);
    void host.storage.delete(key, DEVICE).catch(() => {});
  };
};

/**
 * The Work Status section's side: when it starts and whenever its folder changes, it shows the Planner's panel there
 * if `decide` says so (first FIRST_LOOK_MS later), looking again a few times while a panel it may follow still says it
 * is on screen.
 */
export const followPanel = (host: HostClient, { firstLook = FIRST_LOOK_MS }: { firstLook?: number } = {}): (() => void) => {
  let current: string | null | undefined;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const look = async (directory: string, looks: number) => {
    const [beats, hidden] = await Promise.all([readBeats(host), host.storage.get(HIDDEN_KEY, DEVICE).then(readHidden, () => null)]);
    if (stopped || directory !== current) return;
    const answer = decide(beats, hidden, directory, Date.now());
    if (answer.follow) {
      await host.openSurface(PANEL_SURFACE).catch(() => {});
      return;
    }
    if (answer.againIn !== null && looks > 1) timer = setTimeout(() => void look(directory, looks - 1), answer.againIn);
  };
  const stop = host.onDirectory((directory) => {
    if (directory === current) return;
    current = directory;
    if (timer) clearTimeout(timer);
    timer = null;
    if (directory) timer = setTimeout(() => void look(directory, LOOKS), firstLook);
  });
  return () => {
    stopped = true;
    stop();
    if (timer) clearTimeout(timer);
  };
};
