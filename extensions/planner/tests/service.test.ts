import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../service/store.ts';
import { Planner } from '../service/planner.ts';
import { tasksForDay } from '../src/domain/selectors.ts';

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'planner-test-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const open = async (dir: string, now: () => Date) => {
  const store = new EventStore({ dir, commitDelayMs: 5 });
  await store.init();
  return { store, planner: new Planner(store, now) };
};

describe('planner service core', () => {
  test('commands persist, reload, and commit to git', async () => {
    const dir = tempDir();
    const now = () => new Date('2026-10-24T18:00:00Z');
    const { store, planner } = await open(dir, now);
    expect(planner.execute([
      { cmd: 'c1', type: 'settings.updated', patch: { timezone: 'America/Los_Angeles' } },
      { cmd: 'c2', type: 'task.created', task: { id: 't1', title: 'Write plan', placement: { kind: 'day', date: '2026-10-24' }, position: 1024, plannedMinutes: 30 } },
      { cmd: 'c3', type: 'task.completed', taskId: 't1', on: '2026-10-24' },
    ])).toEqual({ ok: true, applied: 3 });
    await store.flush();

    const log = execFileSync('git', ['log', '--format=%B'], { cwd: dir, encoding: 'utf8' });
    expect(log).toContain('3 changes');
    expect(log).toContain('2 changes');
    expect(log).toContain('Initialize planner data');
    expect(readFileSync(join(dir, '.gitattributes'), 'utf8')).toContain('merge=union');

    const reopened = await open(dir, now);
    expect(reopened.planner.state.tasks.t1).toMatchObject({ title: 'Write plan', plannedMinutes: 30, completedOn: '2026-10-24' });
    expect(reopened.planner.snapshot().today).toBe('2026-10-24');
  });

  test('a repeated command id is applied once', async () => {
    const { planner } = await open(tempDir(), () => new Date('2026-10-24T18:00:00Z'));
    const command = { cmd: 'same', type: 'task.created', task: { id: 't1', title: 'Once', placement: { kind: 'backlog', bucket: 'someday' }, position: 1 } };
    expect(planner.execute([command])).toEqual({ ok: true, applied: 1 });
    expect(planner.execute([command])).toEqual({ ok: true, applied: 0 });
  });

  test('a bad command rejects the whole batch', async () => {
    const { planner } = await open(tempDir(), () => new Date('2026-10-24T18:00:00Z'));
    const result = planner.execute([
      { cmd: 'a', type: 'task.created', task: { id: 't1', title: 'Fine', placement: { kind: 'day', date: '2026-10-24' }, position: 1 } },
      { cmd: 'b', type: 'task.completed', taskId: 'missing', on: '2026-10-24' },
    ]);
    expect(result).toEqual({ ok: false, error: 'unknown task', index: 1 });
    expect(planner.state.tasks).toEqual({});
  });

  test('rollover runs once per day and survives a restart', async () => {
    const dir = tempDir();
    let now = new Date('2026-10-23T20:00:00Z');
    const first = await open(dir, () => now);
    first.planner.execute([
      { cmd: 'tz', type: 'settings.updated', patch: { timezone: 'America/Los_Angeles' } },
      { cmd: 'x', type: 'task.created', task: { id: 't1', title: 'Carry me', placement: { kind: 'day', date: '2026-10-23' }, position: 1024 } },
    ]);
    now = new Date('2026-10-24T18:00:00Z');
    const snap = first.planner.snapshot();
    expect(snap.today).toBe('2026-10-24');
    expect(tasksForDay(snap.state, '2026-10-24').map((task) => task.id)).toEqual(['t1']);
    const version = first.planner.state.version;
    first.planner.snapshot();
    expect(first.planner.state.version).toBe(version);
    await first.store.flush();

    const second = await open(dir, () => now);
    expect(second.planner.state.tasks.t1).toMatchObject({ placement: { kind: 'day', date: '2026-10-24' }, rolloverCount: 1 });
  });

  test('a torn line is skipped and the rest loads', async () => {
    const dir = tempDir();
    const { store, planner } = await open(dir, () => new Date('2026-10-24T18:00:00Z'));
    planner.execute([{ cmd: 'a', type: 'task.created', task: { id: 't1', title: 'Survives', placement: { kind: 'day', date: '2026-10-24' }, position: 1 } }]);
    await store.flush();
    appendFileSync(join(dir, 'events', '2026-10.jsonl'), '{"v":1,"id":"broken","at":');
    const reopened = await open(dir, () => new Date('2026-10-24T18:00:00Z'));
    expect(reopened.store.skippedLines).toBe(1);
    expect(reopened.planner.state.tasks.t1!.title).toBe('Survives');
  });
});
