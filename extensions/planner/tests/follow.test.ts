// The Planner as one panel for the window, with OpenChamber's released API alone (panel/lib/follow.ts): the rail
// panel says when it is on screen, under a key of its own frame; the Work Status section shows it in the folder of
// the next chat when the panel that was on screen there stopped saying so; and the page the Planner was on is kept
// for a new frame (panel/lib/place.ts).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { HostClient, JsonValue } from '@openchamber/sdk';
import { BEAT_MS, BEAT_PREFIX, FIRST_LOOK_MS, FOLLOW_MS, HIDDEN_MS, PANEL_SURFACE, STALE_MS, STOPPED_MS, decide, followPanel, readBeat, readHidden, trackPanelShown } from '../panel/lib/follow.ts';
import { readPlace, savePlace } from '../panel/lib/place.ts';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A host with this browser's storage for the extension, a folder that changes, and the surfaces it was asked to show. */
const fakeHost = (stored: Record<string, JsonValue> = {}, start: string | null = '/projects/a') => {
  const directoryListeners = new Set<(directory: string | null) => void>();
  let directory: string | null = start;
  const opened: string[] = [];
  const writes: Array<{ key: string; value: JsonValue; scope: unknown }> = [];
  const deleted: string[] = [];
  const host = {
    storage: {
      get: async (key: string) => stored[key],
      set: async (key: string, value: JsonValue, options?: { scope?: string }) => {
        stored[key] = value;
        writes.push({ key, value, scope: options?.scope });
      },
      delete: async (key: string) => {
        delete stored[key];
        deleted.push(key);
      },
      keys: async () => Object.keys(stored),
    },
    onDirectory: (listener: (directory: string | null) => void) => {
      directoryListeners.add(listener);
      listener(directory);
      return () => directoryListeners.delete(listener);
    },
    openSurface: async (surface: string) => {
      opened.push(surface);
    },
  } as unknown as HostClient;
  const moveTo = (next: string | null) => {
    directory = next;
    for (const listener of directoryListeners) listener(next);
  };
  const beats = () => writes.filter((write) => write.key.startsWith(BEAT_PREFIX));
  return { host, stored, opened, writes, deleted, beats, moveTo };
};

describe('when the Work Status section shows the panel in the next folder', () => {
  const now = 1_000_000;
  test('a panel on screen in another folder just now, silent since: follow it', () => {
    expect(decide([{ at: now - STOPPED_MS, directory: '/a' }], null, '/b', now)).toEqual({ follow: true });
    expect(decide([{ at: now - FOLLOW_MS, directory: '/a' }], { at: now - FOLLOW_MS - 1 }, '/b', now)).toEqual({ follow: true });
    // One silent among others still on screen (another window's).
    expect(decide([{ at: now - 100, directory: '/x' }, { at: now - 2000, directory: '/a' }], null, '/b', now)).toEqual({ follow: true });
  });
  test('one that still says so: look again when it would have stopped', () => {
    expect(decide([{ at: now - 300, directory: '/a' }], null, '/b', now)).toEqual({ follow: false, againIn: STOPPED_MS - 300 + 50 });
  });
  test('none: in this folder, too old, hidden by the user since, its window in the background', () => {
    const none = { follow: false, againIn: null };
    expect(decide([], null, '/b', now)).toEqual(none);
    expect(decide([{ at: now - 2000, directory: '/b' }], null, '/b', now)).toEqual(none);
    expect(decide([{ at: now - FOLLOW_MS - 1, directory: '/a' }], null, '/b', now)).toEqual(none);
    expect(decide([{ at: now - 2000, directory: '/a' }], { at: now - 1000 }, '/b', now)).toEqual(none);
    expect(decide([{ at: now - 2000, directory: '/a', away: true }], null, '/b', now)).toEqual(none);
  });
  test('what storage holds is read, never trusted', () => {
    expect(readBeat({ at: 5, directory: '/a' })).toEqual({ at: 5, directory: '/a' });
    expect(readBeat({ at: 5 })).toEqual({ at: 5, directory: null });
    expect(readBeat({ at: 5, directory: '/a', away: true })).toEqual({ at: 5, directory: '/a', away: true });
    expect(readBeat({ at: 5, away: 'yes' })).toEqual({ at: 5, directory: null });
    expect(readBeat({ at: 'soon' })).toBeNull();
    expect(readBeat('x')).toBeNull();
    expect(readHidden({ at: 7 })).toEqual({ at: 7 });
    expect(readHidden({ at: -1 })).toBeNull();
  });
});

describe('the Work Status section follows the panel', () => {
  const beatKey = (name: string) => `${BEAT_PREFIX}${name}`;
  test('into the folder of the next chat, once the panel there stopped; once per folder', async () => {
    const { host, stored, opened, moveTo } = fakeHost({ [beatKey('one')]: { at: Date.now() - 2000, directory: '/projects/a' } });
    const stop = followPanel(host, { firstLook: 0 });
    await wait(5);
    // It starts in the folder the panel was on screen in: closing the panel brings this section back there.
    expect(opened).toEqual([]);
    moveTo('/projects/b');
    await wait(5);
    expect(opened).toEqual([PANEL_SURFACE]);
    // The same folder again (the host sends it with every update) asks nothing more.
    moveTo('/projects/b');
    await wait(5);
    expect(opened).toEqual([PANEL_SURFACE]);
    expect(Object.keys(stored)).toEqual([beatKey('one')]);
    stop();
  });
  test('a panel that spoke just before: once it has been silent a moment', async () => {
    const { host, opened } = fakeHost({ [beatKey('one')]: { at: Date.now() - 200, directory: '/projects/a' } }, '/projects/b');
    const stop = followPanel(host, { firstLook: 0 });
    await wait(5);
    expect(opened).toEqual([]);
    await wait(STOPPED_MS);
    expect(opened).toEqual([PANEL_SURFACE]);
    stop();
  });
  test('not a panel that keeps saying it is on screen: another window shows it', async () => {
    const stored: Record<string, JsonValue> = {};
    const other = () => {
      stored[beatKey('other')] = { at: Date.now(), directory: '/projects/a' };
    };
    other();
    const beating = setInterval(other, BEAT_MS);
    const { host, opened } = fakeHost(stored, '/projects/b');
    const stop = followPanel(host, { firstLook: 0 });
    await wait(STOPPED_MS * 2 + 600);
    expect(opened).toEqual([]);
    clearInterval(beating);
    stop();
  });
  test('not after the user hid it, nor in a chat with no folder, nor after its window went to the background', async () => {
    const { host, stored, opened, moveTo } = fakeHost({ [beatKey('one')]: { at: Date.now() - 2000, directory: '/projects/a' }, 'planner.panel.hidden': { at: Date.now() - 1000 } });
    const stop = followPanel(host, { firstLook: 0 });
    moveTo('/projects/b');
    await wait(5);
    expect(opened).toEqual([]);
    delete stored['planner.panel.hidden'];
    moveTo(null);
    await wait(5);
    expect(opened).toEqual([]);
    stored[beatKey('one')] = { at: Date.now() - 2000, directory: '/projects/a', away: true };
    moveTo('/projects/c');
    await wait(5);
    expect(opened).toEqual([]);
    stop();
  });
  test('its first look waits for the panel just closed in its folder to say the user hid it', async () => {
    // Closed here a moment ago (OpenChamber brings the section back as the panel closes); an older panel, which a
    // chat switch took away a few seconds ago, is silent in another folder.
    const { host, stored, opened } = fakeHost({
      [beatKey('closed-here')]: { at: Date.now() - 100, directory: '/projects/b' },
      [beatKey('older')]: { at: Date.now() - 6000, directory: '/projects/a' },
    }, '/projects/b');
    const stop = followPanel(host);
    await wait(HIDDEN_MS);
    stored['planner.panel.hidden'] = { at: Date.now() };
    await wait(FIRST_LOOK_MS - HIDDEN_MS + STOPPED_MS + 200);
    expect(opened).toEqual([]);
    stop();
  });
  test('what panels said long ago is deleted as it is read', async () => {
    const { host, stored, deleted } = fakeHost({ [beatKey('old')]: { at: Date.now() - STALE_MS - 1000, directory: '/projects/a' }, [beatKey('junk')]: 'x', 'planner.place': '/today' }, '/projects/b');
    const stop = followPanel(host, { firstLook: 0 });
    await wait(10);
    expect(deleted.sort()).toEqual([beatKey('junk'), beatKey('old')]);
    expect(Object.keys(stored)).toEqual(['planner.place']);
    stop();
  });
});

describe('the rail panel says when it is on screen', () => {
  type Callback = (entries: Array<{ isIntersecting: boolean; intersectionRatio: number }>) => void;
  let observers: Callback[] = [];
  const page = { hidden: false, listeners: new Set<() => void>() };
  const original = { IntersectionObserver: (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver, document: (globalThis as { document?: unknown }).document };
  beforeEach(() => {
    observers = [];
    page.hidden = false;
    page.listeners.clear();
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
      constructor(callback: Callback) {
        observers.push(callback);
      }
      observe() {}
      disconnect() {}
    };
    (globalThis as { document?: unknown }).document = {
      get hidden() {
        return page.hidden;
      },
      addEventListener: (type: string, listener: () => void) => type === 'visibilitychange' && page.listeners.add(listener),
      removeEventListener: (type: string, listener: () => void) => type === 'visibilitychange' && page.listeners.delete(listener),
    };
  });
  afterEach(() => {
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = original.IntersectionObserver;
    (globalThis as { document?: unknown }).document = original.document;
  });
  /** In view as much as `ratio`: a closed zone leaves its pane half in view (0.51), an open one all (1). */
  const onScreen = (value: boolean, ratio = value ? 1 : 0) => observers.forEach((callback) => callback([{ isIntersecting: ratio > 0, intersectionRatio: ratio }]));
  const windowShown = (shown: boolean) => {
    page.hidden = !shown;
    for (const listener of page.listeners) listener();
  };

  test('on screen: at once and every beat, under its own key, with its folder; hidden by the user: after a moment', async () => {
    const { host, writes, beats } = fakeHost();
    const stop = trackPanelShown(host, {} as Element);
    onScreen(true);
    expect(beats().at(-1)).toMatchObject({ value: { directory: '/projects/a' }, scope: 'device' });
    await wait(BEAT_MS * 2 + 100);
    expect(beats().length).toBeGreaterThanOrEqual(3);
    expect(new Set(beats().map((write) => write.key)).size).toBe(1);
    onScreen(false);
    await wait(800);
    expect(writes.at(-1)).toMatchObject({ key: 'planner.panel.hidden', scope: 'device' });
    stop();
  });
  test('a closed zone, which keeps the pane half in view behind the Work Status column, is hidden', async () => {
    const { host, writes } = fakeHost();
    const stop = trackPanelShown(host, {} as Element);
    onScreen(true);
    onScreen(true, 0.51);
    await wait(800);
    expect(writes.at(-1)).toMatchObject({ key: 'planner.panel.hidden' });
    stop();
  });
  test('hidden by a change of chat into another folder: no "hidden", and never on screen in the folder it left for', async () => {
    const { host, writes, beats, moveTo } = fakeHost();
    const stop = trackPanelShown(host, {} as Element);
    onScreen(true);
    // The folder changes just before a beat; OpenChamber hides the pane a moment later: the beat in between says nothing.
    await wait(BEAT_MS - 50);
    moveTo('/projects/b');
    await wait(200);
    onScreen(false);
    await wait(1200);
    expect(writes.some((write) => write.key === 'planner.panel.hidden')).toBe(false);
    expect(beats().every((write) => (write.value as { directory: string }).directory === '/projects/a')).toBe(true);
    stop();
  });
  test('still on screen after the change of folder (the same frame shows there): it says the new folder', async () => {
    const { host, beats, moveTo } = fakeHost();
    const stop = trackPanelShown(host, {} as Element);
    onScreen(true);
    moveTo('/projects/b');
    await wait(1200);
    expect(beats().at(-1)).toMatchObject({ value: { directory: '/projects/b' } });
    stop();
  });
  test('its window in the background: it says it went, then nothing; shown again, it says so again', async () => {
    const { host, beats, writes } = fakeHost();
    const stop = trackPanelShown(host, {} as Element);
    onScreen(true);
    await wait(50);
    windowShown(false);
    await wait(100);
    expect(beats().at(-1)).toMatchObject({ value: { directory: '/projects/a', away: true } });
    const said = beats().length;
    await wait(BEAT_MS * 2 + 100);
    expect(beats().length).toBe(said);
    // Not the user hiding it.
    expect(writes.some((write) => write.key === 'planner.panel.hidden')).toBe(false);
    windowShown(true);
    await wait(20);
    expect(beats().length).toBe(said + 1);
    expect((beats().at(-1)!.value as { away?: boolean }).away).toBeUndefined();
    stop();
  });
  test('stopped, it takes its key away; what earlier frames left long ago is swept as it starts', async () => {
    const { host, stored } = fakeHost({ [`${BEAT_PREFIX}gone`]: { at: Date.now() - STALE_MS - 1000, directory: '/projects/a' } });
    const stop = trackPanelShown(host, {} as Element);
    onScreen(true);
    await wait(20);
    const keys = Object.keys(stored);
    expect(keys).toHaveLength(1);
    expect(keys[0]!.startsWith(BEAT_PREFIX) && keys[0] !== `${BEAT_PREFIX}gone`).toBe(true);
    stop();
    await wait(5);
    expect(Object.keys(stored)).toEqual([]);
  });
});

describe('where the Planner was', () => {
  test('is its page, kept as a route and read back as a place, without the details open over it; anything else is no place', async () => {
    const { host, stored } = fakeHost();
    savePlace(host, { page: 'today', openTaskId: 't-1' });
    await wait(1);
    expect(stored['planner.place']).toBe('/today');
    expect(await readPlace(host)).toEqual({ page: 'today' });
    stored['planner.place'] = '/linear?issue=i-1&workspace=w-1';
    expect(await readPlace(host)).toEqual({ page: 'linear' });
    stored['planner.place'] = '/nowhere';
    expect(await readPlace(host)).toBeNull();
    stored['planner.place'] = 42;
    expect(await readPlace(host)).toBeNull();
  });
});
