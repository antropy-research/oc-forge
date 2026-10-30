// The Planner's own Undo, through the real service: two windows (the panel's own PlannerClient, each over HTTP to the
// service process) where one acts and offers Undo, and the other changes the same thing meanwhile. An Undo goes ahead
// only while nothing it would put back was changed since; else it leaves theirs, writes nothing and says so.
// (No new names are imported, so the same file runs against an older build as a negative control.)
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostClient } from '@openchamber/sdk';
import { addDays, instantAt, todayIn } from '../src/domain/dates.ts';
import type { EventBody } from '../src/domain/events.ts';
import type { Placement, PlannerState } from '../src/domain/types.ts';
import { PlannerClient } from '../panel/lib/client.ts';

const CHANGED = 'Changed in another window since; not undone';
const token = 'undo-service-test-token';
const ZONE = 'America/Los_Angeles';
const today = todayIn(ZONE);
const tomorrow = addDays(today, 1);
const day = (date: string): Placement => ({ kind: 'day', date });
const backlog: Placement = { kind: 'backlog', bucket: 'next-weeks' };
let child: ChildProcess;
let base = '';
let root = '';

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });

const call = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
};
let seq = 0;
const next = (prefix: string) => `${prefix}${String(++seq).padStart(6, '0')}`;
const commands = async (...bodies: EventBody[]) => {
  const answer = await call('POST', '/commands', { commands: bodies.map((body) => ({ cmd: next('uc'), ...body })) });
  if (answer.status !== 200) throw new Error(answer.body.error);
};
const plan = async (): Promise<PlannerState> => (await call('GET', '/state')).body.state;

/** A Planner window: the panel's own client, talking to the service as OpenChamber relays it. */
const openWindow = async (): Promise<PlannerClient> => {
  const host = {
    serviceRequest: async ({ method, path, body }: { method: string; path: string; body?: string }) => {
      const response = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body }) });
      return { status: response.status, body: await response.text() };
    },
  } as unknown as HostClient;
  const client = new PlannerClient(host);
  await client.load();
  return client;
};

/** A task of the test's own, on a day (or as given). */
const task = async (title: string, extra: Record<string, unknown> = {}) => {
  const id = next('t');
  await commands({ type: 'task.created', task: { id, title, placement: day(today), position: 1024 + seq, ...extra } } as EventBody);
  return id;
};
const block = async (taskId: string, startMinutes: number, endMinutes: number, date = today) => {
  const id = next('b');
  await commands({ type: 'block.created', block: { id, taskId, start: instantAt(date, startMinutes, ZONE), end: instantAt(date, endMinutes, ZONE) } });
  return id;
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'planner-undo-service-'));
  const port = await freePort();
  child = spawn(process.execPath, [join(import.meta.dir, '../service/main.ts')], {
    env: { ...process.env, OPENCHAMBER_SERVICE_PORT: String(port), OPENCHAMBER_SERVICE_TOKEN: token, PLANNER_DATA_DIR: join(root, 'data'), HOME: root },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      if ((await fetch(`${base}/health`, { headers: { Authorization: `Bearer ${token}` } })).ok) break;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await commands({ type: 'settings.updated', patch: { timezone: ZONE } });
});

afterAll(async () => {
  const exited = new Promise((resolve) => child?.once('exit', resolve));
  child?.kill('SIGTERM');
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
  rmSync(root, { recursive: true, force: true });
});

/**
 * One Undo of the inventory: window A acts (offering Undo), window B (which has looked since) changes something,
 * then A's Undo. `refused`: B changed something the Undo would put back, so it leaves theirs and says so, writing
 * nothing; else it goes ahead and B's change stays.
 */
const undoAfter = async (act: (a: PlannerClient) => EventBody[], label: string, theirs: (b: PlannerClient) => EventBody[]) => {
  const a = await openWindow();
  const b = await openWindow();
  await a.dispatch(act(a), { undo: label });
  const offered = a.getView().undoLabel;
  await b.refresh();
  const change = theirs(b);
  if (change.length) await b.dispatch(change);
  const version = (await plan()).version;
  await a.undo();
  return { offered, said: a.getView().error, written: (await plan()).version - version, a, b, state: await plan() };
};

describe("the Planner's own Undo goes ahead only while nothing it would put back was changed since (two windows, the real service)", () => {
  test('Task moved: undone when nothing changed; moved again in another window, theirs stays, nothing is written, and it says so', async () => {
    const t = await task('Harness move');
    const plain = await undoAfter((a) => [{ type: 'task.moved', taskId: t, placement: day(tomorrow), position: 2048 }], 'Task moved', () => []);
    expect(plain.offered).toBe('Task moved');
    expect(plain.said).toBeNull();
    expect(plain.state.tasks[t]!.placement).toEqual(day(today));

    const moved = await undoAfter((a) => [{ type: 'task.moved', taskId: t, placement: day(tomorrow), position: 2048 }], 'Task moved', () => [{ type: 'task.moved', taskId: t, placement: backlog, position: 1 }]);
    expect(moved.written).toBe(0);
    expect(moved.state.tasks[t]!.placement).toEqual(backlog);
    // The window that offered it shows theirs, as the service has it.
    expect(moved.a.getView().state.tasks[t]!.placement).toEqual(backlog);
    expect(moved.said).toBe(CHANGED);
  });

  test('Task moved, then renamed in another window: the move is undone and their title stays (only what the Undo puts back counts)', async () => {
    const t = await task('Harness move and rename');
    const result = await undoAfter(() => [{ type: 'task.moved', taskId: t, placement: day(tomorrow), position: 2048 }], 'Task moved', () => [{ type: 'task.updated', taskId: t, patch: { title: 'Harness renamed in B' } }]);
    expect(result.said).toBeNull();
    expect(result.state.tasks[t]).toMatchObject({ placement: day(today), title: 'Harness renamed in B' });
  });

  test('Task moved off its day, then timeboxed on the new day in another window: not undone (the Undo would drop their session)', async () => {
    const t = await task('Harness move and timebox');
    let session = '';
    const result = await undoAfter(
      () => [{ type: 'task.moved', taskId: t, placement: day(tomorrow), position: 2048 }],
      'Task moved',
      () => {
        session = next('b');
        return [{ type: 'block.created', block: { id: session, taskId: t, start: instantAt(tomorrow, 600, ZONE), end: instantAt(tomorrow, 660, ZONE) } }];
      },
    );
    expect(result.state.blocks[session]).toBeDefined();
    expect(result.state.tasks[t]!.placement).toEqual(day(tomorrow));
    expect(result.said).toBe(CHANGED);
  });

  test("Task archived, then deleted in another window: not undone (it would bring their deleted task back)", async () => {
    const t = await task('Harness archive');
    const result = await undoAfter(() => [{ type: 'task.archived', taskId: t }], 'Task archived', () => [{ type: 'task.deleted', taskId: t }]);
    expect(result.state.tasks[t]!.deletedAt).toBeTruthy();
    expect(result.said).toBe(CHANGED);
  });

  test('Task completed, then reopened and completed again in another window: not undone (their completion stays)', async () => {
    const t = await task('Harness complete');
    const result = await undoAfter(() => [{ type: 'task.completed', taskId: t, on: today }], 'Task completed', () => [{ type: 'task.reopened', taskId: t }, { type: 'task.completed', taskId: t, on: tomorrow }]);
    expect(result.state.tasks[t]!.completedOn).toBe(tomorrow);
    expect(result.said).toBe(CHANGED);
  });

  test('Task added (and Duplicate, Braindump, Planned…: a creation), then renamed in another window: not undone, the task stays', async () => {
    let made = '';
    const result = await undoAfter(
      () => {
        made = next('t');
        return [{ type: 'task.created', task: { id: made, title: 'Harness added', placement: day(today), position: 9999 } }];
      },
      'Task added',
      () => [{ type: 'task.updated', taskId: made, patch: { title: 'Harness added, renamed in B' } }],
    );
    expect(result.state.tasks[made]).toMatchObject({ title: 'Harness added, renamed in B', deletedAt: null });
    expect(result.said).toBe(CHANGED);
  });

  test('a linked task planned, then its source synced (its state there, its due date): undone, as nothing a person changed', async () => {
    let made = '';
    const source = { kind: 'linear' as const, id: 'iss-undo-1', key: 'UNDO-1', url: 'https://linear.app/harness/issue/UNDO-1/x', status: { name: 'Todo', type: 'unstarted', color: '#e2e2e2' } };
    const result = await undoAfter(
      () => {
        made = next('t');
        return [{ type: 'task.created', task: { id: made, title: 'Harness planned issue', placement: day(today), position: 9998, source } }];
      },
      'Planned UNDO-1',
      () => [{ type: 'task.sourceSynced', taskId: made, source: { ...source, status: { name: 'In Progress', type: 'started', color: '#f2c94c' } }, dueDate: tomorrow }],
    );
    expect(result.said).toBeNull();
    expect(result.state.tasks[made]!.deletedAt).toBeTruthy();
  });

  test('Timeboxed, then the session moved in another window: not undone; linked to Google Calendar by the service meanwhile: undone', async () => {
    const t = await task('Harness timebox');
    let session = '';
    const timebox = () => {
      session = next('b');
      return [{ type: 'block.created', block: { id: session, taskId: t, start: instantAt(today, 540, ZONE), end: instantAt(today, 600, ZONE) } }] as EventBody[];
    };
    const moved = await undoAfter(timebox, 'Timeboxed', () => [{ type: 'block.updated', blockId: session, start: instantAt(today, 600, ZONE), end: instantAt(today, 660, ZONE) }]);
    expect(moved.state.blocks[session]).toBeDefined();
    expect(moved.said).toBe(CHANGED);
    const linked = await undoAfter(timebox, 'Timeboxed', () => [{ type: 'block.linked', blockId: session, google: { account: 'harness@example.com', calendarId: 'primary', eventId: 'evt1' } }]);
    expect(linked.said).toBeNull();
    expect(linked.state.blocks[session]).toBeUndefined();
  });

  test('Session moved, then moved again in another window: not undone, theirs stays', async () => {
    const t = await task('Harness session');
    const session = await block(t, 480, 540);
    const result = await undoAfter(
      () => [{ type: 'block.updated', blockId: session, start: instantAt(today, 600, ZONE), end: instantAt(today, 660, ZONE) }],
      'Session moved',
      () => [{ type: 'block.updated', blockId: session, start: instantAt(today, 720, ZONE), end: instantAt(today, 780, ZONE) }],
    );
    expect(result.state.blocks[session]!.start).toBe(instantAt(today, 720, ZONE));
    expect(result.said).toBe(CHANGED);
  });

  test('Session removed, then its task moved to another day in another window: not undone (it would move the task back)', async () => {
    const t = await task('Harness session removed');
    const session = await block(t, 480, 540);
    const result = await undoAfter(() => [{ type: 'block.deleted', blockId: session }], 'Session removed', () => [{ type: 'task.moved', taskId: t, placement: day(tomorrow), position: 1 }]);
    expect(result.state.blocks[session]).toBeUndefined();
    expect(result.state.tasks[t]!.placement).toEqual(day(tomorrow));
    expect(result.said).toBe(CHANGED);
  });

  test('Link removed, then linked to another item in another window: not undone', async () => {
    const source = { kind: 'github' as const, id: 'gh-undo-1', key: 'harness/repo#1', url: 'https://github.com/harness/repo/issues/1' };
    const t = await task('Harness linked', { source });
    const other = { ...source, id: 'gh-undo-2', key: 'harness/repo#2', url: 'https://github.com/harness/repo/issues/2' };
    const result = await undoAfter(() => [{ type: 'task.updated', taskId: t, patch: { source: null } }], 'Link removed', () => [{ type: 'task.updated', taskId: t, patch: { source: other } }]);
    expect(result.state.tasks[t]!.source?.id).toBe('gh-undo-2');
    expect(result.said).toBe(CHANGED);
  });

  test('List sorted, then one of its tasks moved to another day in another window: not undone, none of it', async () => {
    const date = addDays(today, 3);
    const ids = [await task('Harness sort c', { placement: day(date), position: 3 }), await task('Harness sort a', { placement: day(date), position: 2 }), await task('Harness sort b', { placement: day(date), position: 1 })];
    const result = await undoAfter(
      () => ids.map((id, index): EventBody => ({ type: 'task.moved', taskId: id, placement: day(date), position: (index + 1) * 1024 })),
      'List sorted',
      () => [{ type: 'task.moved', taskId: ids[1]!, placement: day(tomorrow), position: 1 }],
    );
    expect(result.state.tasks[ids[0]!]!.position).toBe(1024);
    expect(result.state.tasks[ids[1]!]!.placement).toEqual(day(tomorrow));
    expect(result.said).toBe(CHANGED);
  });

  test('Estimates filled, then one estimate changed in another window: not undone', async () => {
    const ids = [await task('Harness estimate 1'), await task('Harness estimate 2')];
    const result = await undoAfter(
      () => ids.map((id): EventBody => ({ type: 'task.updated', taskId: id, patch: { plannedMinutes: 30 } })),
      'Estimates filled',
      () => [{ type: 'task.updated', taskId: ids[0]!, patch: { plannedMinutes: 45 } }],
    );
    expect(result.state.tasks[ids[0]!]!.plannedMinutes).toBe(45);
    expect(result.state.tasks[ids[1]!]!.plannedMinutes).toBe(30);
    expect(result.said).toBe(CHANGED);
  });

  test('Subtask became a task, then another subtask ticked in another window: not undone (the subtask list would go back)', async () => {
    const subtasks = [{ id: next('s'), title: 'Harness sub one', done: false }, { id: next('s'), title: 'Harness sub two', done: false }];
    const t = await task('Harness parent', { subtasks });
    let made = '';
    const result = await undoAfter(
      () => {
        made = next('t');
        return [
          { type: 'task.created', task: { id: made, title: 'Harness sub one', placement: day(today), position: 5000 } },
          { type: 'task.updated', taskId: t, patch: { subtasks: [subtasks[1]!] } },
        ];
      },
      'Subtask became a task',
      () => [{ type: 'task.updated', taskId: t, patch: { subtasks: [{ ...subtasks[1]!, done: true }] } }],
    );
    expect(result.state.tasks[t]!.subtasks).toEqual([{ ...subtasks[1]!, done: true }]);
    expect(result.state.tasks[made]!.deletedAt).toBeNull();
    expect(result.said).toBe(CHANGED);
  });

  test('Objective deleted (now undoable: back with its tasks aligned), then one of them aligned elsewhere in another window: not undone', async () => {
    const week = today;
    const objective = next('o');
    const other = next('o');
    await commands({ type: 'objective.created', objective: { id: objective, weekStart: week, title: 'Harness objective', carriedFrom: null } }, { type: 'objective.created', objective: { id: other, weekStart: week, title: 'Harness other objective', carriedFrom: null } });
    const aligned = await task('Harness aligned', { objectiveId: objective });
    const plain = await undoAfter(() => [{ type: 'objective.deleted', objectiveId: objective }], 'Objective deleted', () => []);
    expect(plain.offered).toBe('Objective deleted');
    expect(plain.said).toBeNull();
    expect(plain.state.objectives[objective]!.deletedAt).toBeNull();
    expect(plain.state.tasks[aligned]!.objectiveId).toBe(objective);

    const realigned = await undoAfter(() => [{ type: 'objective.deleted', objectiveId: objective }], 'Objective deleted', () => [{ type: 'task.updated', taskId: aligned, patch: { objectiveId: other } }]);
    expect(realigned.state.objectives[objective]!.deletedAt).toBeTruthy();
    expect(realigned.state.tasks[aligned]!.objectiveId).toBe(other);
    expect(realigned.said).toBe(CHANGED);
  });

  test('a task deleted from the archive comes back into the archive; moved from a folder to a day, Undo puts it back in its folder', async () => {
    const archived = await task('Harness archived then deleted');
    await commands({ type: 'task.archived', taskId: archived });
    const deleted = await undoAfter(() => [{ type: 'task.deleted', taskId: archived }], 'Task deleted', () => []);
    expect(deleted.said).toBeNull();
    expect(deleted.state.tasks[archived]).toMatchObject({ deletedAt: null });
    expect(deleted.state.tasks[archived]!.archivedAt).toBeTruthy();

    const folder = next('f');
    await commands({ type: 'folder.created', folder: { id: folder, name: 'Harness folder' } });
    const filed = await task('Harness filed', { placement: backlog, folderId: folder });
    const moved = await undoAfter(() => [{ type: 'task.moved', taskId: filed, placement: day(today), position: 1 }], 'Moved to today', () => []);
    expect(moved.said).toBeNull();
    expect(moved.state.tasks[filed]).toMatchObject({ placement: backlog, folderId: folder });
  });

  test('moved off its day, Undo gives back the working sessions the move dropped there, and its planned time', async () => {
    const t = await task('Harness sessions back', { plannedMinutes: 45 });
    const session = await block(t, 480, 540);
    const before = (await plan()).tasks[t]!;
    const result = await undoAfter(() => [{ type: 'task.moved', taskId: t, placement: day(tomorrow), position: 1 }], 'Task moved', () => []);
    expect(result.said).toBeNull();
    expect(result.state.blocks[session]).toMatchObject({ taskId: t, start: instantAt(today, 480, ZONE), end: instantAt(today, 540, ZONE) });
    expect(result.state.tasks[t]).toMatchObject({ placement: day(today), plannedMinutes: before.plannedMinutes });
  });

  test('this window changing the same thing again ends its Undo (no toast saying another window did it); a sync does not', async () => {
    const t = await task('Harness own change');
    const a = await openWindow();
    await a.dispatch([{ type: 'task.moved', taskId: t, placement: day(tomorrow), position: 1 }], { undo: 'Task moved' });
    await a.dispatch([{ type: 'task.updated', taskId: t, patch: { notes: 'Notes typed after the move' } }]);
    expect(a.getView().undoLabel).toBe('Task moved');
    await a.dispatch([{ type: 'task.updated', taskId: t, patch: { notes: 'A sync' } }], { origin: 'linear' });
    expect(a.getView().undoLabel).toBe('Task moved');
    await a.dispatch([{ type: 'task.moved', taskId: t, placement: backlog, position: 1 }]);
    expect(a.getView().undoLabel).toBeNull();
  });

  test('Undo clicked before the action has even reached the service waits its turn, and is undone', async () => {
    const t = await task('Harness quick undo');
    const a = await openWindow();
    void a.dispatch([{ type: 'task.moved', taskId: t, placement: day(tomorrow), position: 1 }], { undo: 'Task moved' });
    await a.undo();
    expect(a.getView().error).toBeNull();
    expect((await plan()).tasks[t]!.placement).toEqual(day(today));
  });

  test('the service keeps an Undo once: a second one for the same batch, or one it never offered, is refused as no longer possible', async () => {
    const t = await task('Harness once');
    const cmd = next('uc');
    expect((await call('POST', '/commands', { commands: [{ cmd, type: 'task.moved', taskId: t, placement: day(tomorrow), position: 1 }], undo: true })).status).toBe(200);
    expect((await call('POST', '/undo', { batch: cmd })).status).toBe(200);
    const again = await call('POST', '/undo', { batch: cmd });
    expect(again.status).toBe(410);
    expect(again.body.error).toBe('This can no longer be undone');
    expect((await call('POST', '/undo', { batch: 'never-offered' })).status).toBe(410);
    // What a refused one answers: why, what changed, and the plan as it is.
    const moved = next('uc');
    await call('POST', '/commands', { commands: [{ cmd: moved, type: 'task.moved', taskId: t, placement: day(tomorrow), position: 1 }], undo: true });
    await commands({ type: 'task.moved', taskId: t, placement: backlog, position: 1 });
    const refused = await call('POST', '/undo', { batch: moved });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(CHANGED);
    expect(refused.body.changed).toContain(`tasks/${t}/placement`);
    expect(refused.body.state.tasks[t].placement).toEqual(backlog);
  });
});
