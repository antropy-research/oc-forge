// The bridge's bus between the parts of a window (bridge/src/bus.ts), on real Unix sockets.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus, busFiles, sweepStale } from '../bridge/src/bus.ts';
import { waitFor } from '../bridge/src/events.ts';

const PARTS = ['view', 'editor', 'terminal'] as const;
const made: Bus[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const bus of made.splice(0)) bus.dispose();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-bus-'));
  dirs.push(dir);
  return dir;
};

const bus = (dir: string, part: string, key = 'host|file:///w|window-1'): Bus => {
  const created = new Bus({ dir, key, part, parts: PARTS });
  made.push(created);
  return created;
};

const all = (list: Bus[], count: number) => waitFor(() => list.every((item) => item.members.size === count), 3_000, 10);

describe('bus', () => {
  test("one part listens; every part hears of the others; a message reaches the others, not itself", async () => {
    const dir = scratch();
    const [view, editor, terminal] = [bus(dir, 'view'), bus(dir, 'editor'), bus(dir, 'terminal')];
    await Promise.all([view.start(), editor.start(), terminal.start()]);
    expect(await all([view, editor, terminal], 3)).toBe(true);
    expect([view, editor, terminal].filter((item) => item.leading)).toHaveLength(1);
    const heard: string[] = [];
    for (const item of [view, editor, terminal]) item.on('ping', (message) => void heard.push(`${item.me.part}<-${message.from?.part}`));
    editor.send({ type: 'ping' });
    expect(await waitFor(() => heard.length === 2, 2_000, 10)).toBe(true);
    expect(heard.sort()).toEqual(['terminal<-editor', 'view<-editor']);
  });

  test('a request for a part goes to one member of it, the first to join; its answer comes back', async () => {
    const dir = scratch();
    const view = bus(dir, 'view');
    await view.start();
    const first = bus(dir, 'terminal');
    await first.start();
    await waitFor(() => view.members.size === 2, 2_000, 10);
    const second = bus(dir, 'terminal');
    await second.start();
    expect(await all([view, first, second], 3)).toBe(true);
    const ran: string[] = [];
    first.on('debug.start', () => (ran.push('first'), 'ok-first'));
    second.on('debug.start', () => (ran.push('second'), 'ok-second'));
    expect(await view.request('terminal', 'debug.start', {})).toBe('ok-first');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(ran).toEqual(['first']);
    // By member: that one.
    expect(await view.request(second.me.member, 'debug.start', {})).toBe('ok-second');
    // No such part: an error at once.
    await expect(view.request('editor', 'anything', {}, 2_000)).rejects.toThrow('no editor part');
    // A handler's error is the request's.
    first.on('fail', () => {
      throw new Error('broken');
    });
    await expect(view.request('terminal', 'fail', {})).rejects.toThrow('broken');
  });

  test("the one listening goes: another listens, and the rest find it; nobody's left out", async () => {
    const dir = scratch();
    const view = bus(dir, 'view');
    await view.start();
    const editor = bus(dir, 'editor');
    const terminal = bus(dir, 'terminal');
    await Promise.all([editor.start(), terminal.start()]);
    expect(await all([view, editor, terminal], 3)).toBe(true);
    expect(view.leading).toBe(true);
    view.dispose();
    expect(await waitFor(() => editor.members.size === 2 && terminal.members.size === 2 && [editor, terminal].filter((item) => item.leading).length === 1, 5_000, 20)).toBe(true);
    expect(await editor.request('terminal', 'x', {}, 2_000).catch((error: Error) => error.message)).toMatch(/no answer|x/);
  });

  test("parts that find a dead socket at once don't both listen (the lock)", async () => {
    const dir = scratch();
    const key = 'host|file:///w|window-race';
    // A socket file nobody listens on: a part that went without closing it.
    writeFileSync(busFiles(dir, key).socket, '');
    const parts = Array.from({ length: 6 }, (_, index) => bus(dir, PARTS[index % 3]!, key));
    await Promise.all(parts.map((item) => item.start()));
    expect(await all(parts, 6)).toBe(true);
    expect(parts.filter((item) => item.leading)).toHaveLength(1);
  });

  test("a part whose window went leaves, and comes back with it", async () => {
    const dir = scratch();
    const [view, editor] = [bus(dir, 'view'), bus(dir, 'editor')];
    await view.start();
    await editor.start();
    expect(await all([view, editor], 2)).toBe(true);
    editor.leave();
    expect(await waitFor(() => view.members.size === 1, 2_000, 10)).toBe(true);
    expect(view.has('editor')).toBe(false);
    await editor.rejoin();
    expect(await all([view, editor], 2)).toBe(true);
  });

  test("old sockets nobody answers on (a window whose parts were killed) are swept; a live one and a new one stay", async () => {
    const dir = scratch();
    const old = (Date.now() - 10 * 60_000) / 1000;
    const dead = busFiles(dir, 'host|file:///w|gone');
    writeFileSync(dead.socket, '');
    writeFileSync(dead.lock, '1');
    utimesSync(dead.socket, old, old);
    const fresh = busFiles(dir, 'host|file:///w|starting');
    writeFileSync(fresh.socket, '');
    const live = busFiles(dir, 'host|file:///w|live');
    const server = net.createServer(() => undefined);
    await new Promise<void>((resolve) => server.listen(live.socket, resolve));
    utimesSync(live.socket, old, old);
    expect(await sweepStale(dir, '')).toBe(1);
    expect([existsSync(dead.socket), existsSync(dead.lock), existsSync(fresh.socket), existsSync(live.socket)]).toEqual([false, false, true, true]);
    await new Promise((resolve) => server.close(resolve));
  });

  test("two windows on one folder are two buses: a request in one never reaches the other's runtime", async () => {
    const dir = scratch();
    const [a, b] = ['host|file:///w|window-a', 'host|file:///w|window-b'];
    const viewA = bus(dir, 'view', a);
    const terminalA = bus(dir, 'terminal', a);
    const viewB = bus(dir, 'view', b);
    const terminalB = bus(dir, 'terminal', b);
    await Promise.all([viewA.start(), terminalA.start(), viewB.start(), terminalB.start()]);
    expect(await all([viewA, terminalA, viewB, terminalB], 2)).toBe(true);
    const ran: string[] = [];
    terminalA.on('debug.start', () => (ran.push('A'), true));
    terminalB.on('debug.start', () => (ran.push('B'), true));
    await viewB.request('terminal', 'debug.start', {});
    await viewA.request('terminal', 'debug.start', {});
    expect(ran).toEqual(['B', 'A']);
    expect(existsSync(busFiles(dir, a).socket) && existsSync(busFiles(dir, b).socket)).toBe(true);
  });
});
