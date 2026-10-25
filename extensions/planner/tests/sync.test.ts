import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../service/store.ts';
import { Planner } from '../service/planner.ts';
import { SyncManager, isRemoteUrl } from '../service/sync.ts';

const dirs: string[] = [];
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'planner-sync-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const replica = async (dir: string) => {
  const store = new EventStore({ dir, commitDelayMs: 5 });
  await store.init();
  const planner = new Planner(store, () => new Date('2026-10-24T18:00:00Z'));
  const sync = new SyncManager(store, planner);
  return { store, planner, sync };
};
const task = (cmd: string, id: string, title: string) => ({ cmd, type: 'task.created', task: { id, title, placement: { kind: 'day', date: '2026-10-24' }, position: 1024 } });

describe('remote urls', () => {
  test('accepted and refused', () => {
    for (const url of ['git@github.com:qihang-zhang/planner-data.git', 'https://github.com/x/y.git', 'ssh://git@host/x.git', 'file:///srv/planner.git', '/home/node/planner.git']) expect(isRemoteUrl(url)).toBe(true);
    for (const url of ['', '--upload-pack=evil', 'ext::sh -c evil', 'https://x y', 'relative/path']) expect(isRemoteUrl(url)).toBe(false);
  });
});

describe('sync between two machines', () => {
  test('events from both sides merge, and the plan converges', async () => {
    const remote = join(temp(), 'remote.git');
    execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', remote]);
    const a = await replica(temp());
    const b = await replica(temp());
    await a.sync.setRemote(remote);
    await b.sync.setRemote(remote);

    a.planner.execute([task('a1', 'ta', 'From machine A')]);
    expect((await a.sync.run()).lastError).toBeNull();
    b.planner.execute([task('b1', 'tb', 'From machine B')]);
    expect((await b.sync.run()).lastError).toBeNull();
    expect(b.planner.state.tasks.ta?.title).toBe('From machine A');

    // Both write to the same month file before syncing again.
    a.planner.execute([task('a2', 'ta2', 'A again')]);
    b.planner.execute([task('b2', 'tb2', 'B again')]);
    expect((await b.sync.run()).lastError).toBeNull();
    expect((await a.sync.run()).lastError).toBeNull();
    expect((await b.sync.run()).lastError).toBeNull();
    const titles = (planner: Planner) => Object.values(planner.state.tasks).map((item) => item.title).sort();
    expect(titles(a.planner)).toEqual(['A again', 'B again', 'From machine A', 'From machine B']);
    expect(titles(b.planner)).toEqual(titles(a.planner));
    // The default channels both machines created merge into one each.
    expect(Object.keys(a.planner.state.channels).sort()).toEqual(['personal', 'work']);
  });

  test('a bad remote reports an error and changes nothing', async () => {
    const a = await replica(temp());
    await expect(a.sync.setRemote('--upload-pack=evil')).rejects.toThrow();
    await a.sync.setRemote(join(temp(), 'missing.git'));
    const status = await a.sync.run();
    expect(status.lastError).not.toBeNull();
    expect(a.planner.state.channels.work).toBeDefined();
  });
});
