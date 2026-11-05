// The Planner as one panel for the window, with OpenChamber's released API alone (panel/lib/follow.ts): the rail
// panel says when it is on screen, the Work Status section shows it in the folder of the next chat; and where the
// Planner was is kept for a new frame (panel/lib/place.ts).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { HostClient, JsonValue } from '@openchamber/sdk';
import { FOLLOW_MS, PANEL_SURFACE, followPanel, readHidden, readShown, shouldFollow, trackPanelShown } from '../panel/lib/follow.ts';
import { readPlace, savePlace } from '../panel/lib/place.ts';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A host with this browser's storage for the extension, a folder that changes, and the surfaces it was asked to show. */
const fakeHost = (stored: Record<string, JsonValue> = {}) => {
  const directoryListeners = new Set<(directory: string | null) => void>();
  let directory: string | null = '/projects/a';
  const opened: string[] = [];
  const writes: Array<{ key: string; value: JsonValue; scope: unknown }> = [];
  const host = {
    storage: {
      get: async (key: string) => stored[key],
      set: async (key: string, value: JsonValue, options?: { scope?: string }) => {
        stored[key] = value;
        writes.push({ key, value, scope: options?.scope });
      },
      delete: async () => {},
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
  return { host, stored, opened, writes, moveTo };
};

describe('when the Work Status section shows the panel in the next folder', () => {
  const now = 1_000_000;
  test('the panel was on screen just now, and not hidden since', () => {
    expect(shouldFollow({ at: now - 900, directory: '/a' }, null, now)).toBe(true);
    expect(shouldFollow({ at: now - 900, directory: '/a' }, { at: now - 5000 }, now)).toBe(true);
    expect(shouldFollow({ at: now - FOLLOW_MS - 1, directory: '/a' }, null, now)).toBe(false);
    expect(shouldFollow({ at: now - 900, directory: '/a' }, { at: now - 100 }, now)).toBe(false);
    expect(shouldFollow(null, null, now)).toBe(false);
  });
  test('what storage holds is read, never trusted', () => {
    expect(readShown({ at: 5, directory: '/a' })).toEqual({ at: 5, directory: '/a' });
    expect(readShown({ at: 5 })).toEqual({ at: 5, directory: null });
    expect(readShown({ at: 'soon' })).toBeNull();
    expect(readShown('x')).toBeNull();
    expect(readHidden({ at: 7 })).toEqual({ at: 7 });
    expect(readHidden({ at: -1 })).toBeNull();
  });
});

describe('the Work Status section follows the panel', () => {
  test('into the folder of the next chat, once per folder, when the panel was on screen', async () => {
    const { host, stored, opened, moveTo } = fakeHost();
    const stop = followPanel(host);
    await wait(5);
    // At its start in a folder, the panel was not on screen: nothing to show.
    expect(opened).toEqual([]);
    stored['planner.panel.shown'] = { at: Date.now(), directory: '/projects/a' };
    moveTo('/projects/b');
    await wait(5);
    expect(opened).toEqual([PANEL_SURFACE]);
    // The same folder again (the host sends it with every update) asks nothing more.
    moveTo('/projects/b');
    await wait(5);
    expect(opened).toEqual([PANEL_SURFACE]);
    stop();
  });
  test('not after the user hid it, nor in a chat with no folder', async () => {
    const { host, stored, opened, moveTo } = fakeHost({ 'planner.panel.shown': { at: Date.now() - 500, directory: '/projects/a' } });
    stored['planner.panel.hidden'] = { at: Date.now() - 100 };
    const stop = followPanel(host);
    moveTo('/projects/b');
    await wait(5);
    expect(opened).toEqual([]);
    delete stored['planner.panel.hidden'];
    moveTo(null);
    await wait(5);
    expect(opened).toEqual([]);
    stop();
  });
  test('not in the folder where the panel was just on screen: closing it brings this section back there', async () => {
    const { host, opened } = fakeHost({ 'planner.panel.shown': { at: Date.now() - 300, directory: '/projects/a' } });
    const stop = followPanel(host);
    await wait(5);
    expect(opened).toEqual([]);
    stop();
  });
  test('a section started just after a switch shows it too (the panel was on screen in the last folder)', async () => {
    const { host, opened } = fakeHost({ 'planner.panel.shown': { at: Date.now() - 400, directory: '/projects/z' } });
    const stop = followPanel(host);
    await wait(5);
    expect(opened).toEqual([PANEL_SURFACE]);
    stop();
  });
});

describe('the rail panel says when it is on screen', () => {
  type Callback = (entries: Array<{ isIntersecting: boolean; intersectionRatio: number }>) => void;
  let observers: Callback[] = [];
  const original = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
  beforeEach(() => {
    observers = [];
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
      constructor(callback: Callback) {
        observers.push(callback);
      }
      observe() {}
      disconnect() {}
    };
  });
  afterEach(() => {
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = original;
  });
  /** In view as much as `ratio`: a closed zone leaves its pane half in view (0.51), an open one all (1). */
  const onScreen = (value: boolean, ratio = value ? 1 : 0) => observers.forEach((callback) => callback([{ isIntersecting: ratio > 0, intersectionRatio: ratio }]));

  test('on screen: at once and every second, with its folder; hidden by the user: after a moment', async () => {
    const { host, writes } = fakeHost();
    const stop = trackPanelShown(host, {} as Element);
    onScreen(true);
    expect(writes.at(-1)).toMatchObject({ key: 'planner.panel.shown', value: { directory: '/projects/a' }, scope: 'device' });
    await wait(1100);
    expect(writes.filter((write) => write.key === 'planner.panel.shown').length).toBeGreaterThanOrEqual(2);
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
  test('hidden by a change of chat into another folder: no "hidden", the Work Status section decides', async () => {
    const { host, writes, moveTo } = fakeHost();
    const stop = trackPanelShown(host, {} as Element);
    onScreen(true);
    moveTo('/projects/b');
    onScreen(false);
    await wait(1200);
    expect(writes.some((write) => write.key === 'planner.panel.hidden')).toBe(false);
    stop();
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
