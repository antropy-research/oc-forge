// The Planner's own Undo: what takes an action back, and when an Undo would overwrite a change made since
// (`changedSince`), in the domain and in the service's core (the record it keeps, once, for a minute).
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../service/store.ts';
import { Planner } from '../service/planner.ts';
import type { EventBody, PlannerEvent } from '../src/domain/events.ts';
import { applyEvents } from '../src/domain/reducer.ts';
import { asEvents, changedSince, inverseOfBatch } from '../src/domain/undo.ts';
import { emptyState, type PlannerState } from '../src/domain/types.ts';

const at = (n: number) => new Date(Date.UTC(2026, 9, 29, 17, 0, n)).toISOString();
let n = 0;
const apply = (state: PlannerState, ...bodies: EventBody[]): PlannerState => applyEvents(state, bodies.map((body) => ({ v: 1, id: `e${++n}`, at: at(n), ...body }) as PlannerEvent));
const base = (): PlannerState =>
  apply(
    emptyState(),
    { type: 'settings.updated', patch: { timezone: 'UTC' } },
    { type: 'task.created', task: { id: 't1', title: 'Write', placement: { kind: 'day', date: '2026-10-29' }, position: 1024, plannedMinutes: 30 } },
    { type: 'task.created', task: { id: 't2', title: 'Read', placement: { kind: 'day', date: '2026-10-29' }, position: 2048 } },
  );
/** An action, then what others did since, then the Undo as the service checks it. */
const check = (state: PlannerState, action: EventBody[], since: EventBody[]) => {
  const inverse = inverseOfBatch(state, action)!;
  const after = apply(state, ...action);
  const now = since.length ? apply(after, ...since) : after;
  return changedSince(after, now, applyEvents(now, asEvents(inverse)));
};
const move = (taskId: string, date: string): EventBody => ({ type: 'task.moved', taskId, placement: { kind: 'day', date }, position: 4096 });

describe('changedSince: an Undo overwrites nothing changed since', () => {
  test('a move: nothing since, or another field changed since, may be undone; the task moved again, or archived, may not', () => {
    const state = base();
    expect(check(state, [move('t1', '2026-10-30')], [])).toEqual([]);
    expect(check(state, [move('t1', '2026-10-30')], [{ type: 'task.updated', taskId: 't1', patch: { title: 'Write it all' } }])).toEqual([]);
    expect(check(state, [move('t1', '2026-10-30')], [move('t1', '2026-11-02')])).toEqual(['tasks/t1/placement']);
    // The Undo's move would take it out of the archive: their archiving counts.
    expect(check(state, [move('t1', '2026-10-30')], [{ type: 'task.archived', taskId: 't1' }])).toEqual(['tasks/t1/archivedAt']);
    // Another task changed since never counts.
    expect(check(state, [move('t1', '2026-10-30')], [move('t2', '2026-11-02')])).toEqual([]);
  });

  test('a creation: undone only while the task is as it was made; its source syncing (state, due date) is not a change', () => {
    const state = base();
    const made: EventBody = { type: 'task.created', task: { id: 't9', title: 'New', placement: { kind: 'day', date: '2026-10-29' }, position: 9000, source: { kind: 'linear', id: 'i1', key: 'L-1', url: 'https://linear.app/x/issue/L-1/x' } } };
    expect(check(state, [made], [])).toEqual([]);
    expect(check(state, [made], [{ type: 'task.updated', taskId: 't9', patch: { title: 'Renamed' } }])).toEqual(['tasks/t9/title']);
    expect(check(state, [made], [{ type: 'task.sourceSynced', taskId: 't9', source: { kind: 'linear', id: 'i1', key: 'L-1', url: 'https://linear.app/x/issue/L-1/x', status: { name: 'Started', type: 'started', color: '#000000' } }, dueDate: '2026-11-01' }])).toEqual([]);
    // A timer started on it since stops with it: that counts.
    expect(check(state, [made], [{ type: 'timer.started', taskId: 't9' }])).toEqual(['timer']);
  });

  test('a working session: its Google Calendar link (the service writes it) is not a change; moved since is', () => {
    const state = base();
    const block: EventBody = { type: 'block.created', block: { id: 'b1', taskId: 't1', start: '2026-10-29T09:00:00.000Z', end: '2026-10-29T10:00:00.000Z' } };
    expect(check(state, [block], [{ type: 'block.linked', blockId: 'b1', google: { account: 'me@example.com', calendarId: 'primary', eventId: 'e1' } }])).toEqual([]);
    expect(check(state, [block], [{ type: 'block.updated', blockId: 'b1', start: '2026-10-29T11:00:00.000Z', end: '2026-10-29T12:00:00.000Z' }])).toEqual(['blocks/b1/start', 'blocks/b1/end']);
  });
});

describe('what an Undo puts back', () => {
  test("moved off its day: its sessions there and its planned time; from a folder: its folder; deleted from the archive: the archive", () => {
    const state = apply(base(), { type: 'block.created', block: { id: 'b1', taskId: 't1', start: '2026-10-29T09:00:00.000Z', end: '2026-10-29T10:00:00.000Z' } });
    const moved = apply(state, move('t1', '2026-10-30'));
    expect(moved.blocks.b1).toBeUndefined();
    const back = applyEvents(moved, asEvents(inverseOfBatch(state, [move('t1', '2026-10-30')])!));
    expect(back.blocks.b1).toEqual(state.blocks.b1);
    expect(back.tasks.t1).toMatchObject({ placement: state.tasks.t1!.placement, plannedMinutes: state.tasks.t1!.plannedMinutes });

    const filed = apply(base(), { type: 'folder.created', folder: { id: 'f1', name: 'Ideas' } }, { type: 'task.moved', taskId: 't2', placement: { kind: 'backlog', bucket: 'someday' }, position: 1 }, { type: 'task.updated', taskId: 't2', patch: { folderId: 'f1' } });
    const scheduled = apply(filed, move('t2', '2026-10-30'));
    expect(scheduled.tasks.t2!.folderId).toBeNull();
    expect(applyEvents(scheduled, asEvents(inverseOfBatch(filed, [move('t2', '2026-10-30')])!)).tasks.t2).toMatchObject({ placement: { kind: 'backlog', bucket: 'someday' }, folderId: 'f1' });

    const archived = apply(base(), { type: 'task.archived', taskId: 't2' });
    const deleted = apply(archived, { type: 'task.deleted', taskId: 't2' });
    const restored = applyEvents(deleted, asEvents(inverseOfBatch(archived, [{ type: 'task.deleted', taskId: 't2' }])!)).tasks.t2!;
    expect(restored.deletedAt).toBeNull();
    expect(restored.archivedAt).toBeTruthy();
  });

  test('an objective deleted comes back, and the tasks aligned with it are aligned again', () => {
    const state = apply(base(), { type: 'objective.created', objective: { id: 'o1', weekStart: '2026-10-26', title: 'Ship', carriedFrom: null } }, { type: 'task.updated', taskId: 't1', patch: { objectiveId: 'o1' } });
    const deleted = apply(state, { type: 'objective.deleted', objectiveId: 'o1' });
    expect(deleted.tasks.t1!.objectiveId).toBeNull();
    const back = applyEvents(deleted, asEvents(inverseOfBatch(state, [{ type: 'objective.deleted', objectiveId: 'o1' }])!));
    expect(back.objectives.o1!.deletedAt).toBeNull();
    expect(back.tasks.t1!.objectiveId).toBe('o1');
  });
});

describe("the service's Undo record", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const open = async (now: () => Date) => {
    const dir = mkdtempSync(join(tmpdir(), 'planner-undo-'));
    dirs.push(dir);
    const store = new EventStore({ dir, commitDelayMs: 5 });
    await store.init();
    const planner = new Planner(store, now);
    planner.execute([{ cmd: 'tz', type: 'settings.updated', patch: { timezone: 'UTC' } }, { cmd: 'c1', type: 'task.created', task: { id: 't1', title: 'Write', placement: { kind: 'day', date: '2026-10-29' }, position: 1024 } }]);
    return planner;
  };

  test('kept only when asked, once, for a minute; refused, nothing is written and what changed is said', async () => {
    let clock = Date.parse('2026-10-29T18:00:00Z');
    const planner = await open(() => new Date(clock));
    planner.execute([{ cmd: 'm1', ...move('t1', '2026-10-30') }]);
    expect(planner.undo('m1')).toEqual({ ok: false, reason: 'gone' });
    planner.execute([{ cmd: 'm2', ...move('t1', '2026-10-31') }], { undo: true });
    expect(planner.undo('m2')).toMatchObject({ ok: true, applied: 1 });
    expect(planner.state.tasks.t1!.placement).toEqual({ kind: 'day', date: '2026-10-30' });
    expect(planner.undo('m2')).toEqual({ ok: false, reason: 'gone' });

    planner.execute([{ cmd: 'm3', ...move('t1', '2026-11-01') }], { undo: true });
    planner.execute([{ cmd: 'm4', ...move('t1', '2026-11-02') }]);
    const version = planner.state.version;
    // Moved to the same place in its list, on another day: its day is what changed since.
    expect(planner.undo('m3')).toEqual({ ok: false, reason: 'changed', changed: ['tasks/t1/placement'] });
    expect(planner.state.version).toBe(version);

    planner.execute([{ cmd: 'm5', ...move('t1', '2026-11-03') }], { undo: true });
    clock += 61_000;
    expect(planner.undo('m5')).toEqual({ ok: false, reason: 'gone' });
  });

  test('a command of the Undo no longer valid (the session deleted since) is a change since too', async () => {
    const planner = await open(() => new Date('2026-10-29T18:00:00Z'));
    planner.execute([{ cmd: 'b1', type: 'block.created', block: { id: 'blk', taskId: 't1', start: '2026-10-29T09:00:00.000Z', end: '2026-10-29T10:00:00.000Z' } }]);
    planner.execute([{ cmd: 'u1', type: 'block.updated', blockId: 'blk', start: '2026-10-29T11:00:00.000Z', end: '2026-10-29T12:00:00.000Z' }], { undo: true });
    planner.execute([{ cmd: 'd1', type: 'block.deleted', blockId: 'blk' }]);
    expect(planner.undo('u1')).toEqual({ ok: false, reason: 'changed', changed: ['unknown block'] });
  });
});
