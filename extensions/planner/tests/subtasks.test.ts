// Review 12's P0: a task's subtasks changed in two windows at once. Each change is a command by identity (`subtask.*`)
// the service applies to the plan as it has it then, so another window's change to another subtask stays; a rename, or
// a delete, of a subtask renamed or deleted elsewhere since is a conflict (409, nothing written), and a tick never is.
// Through the reducer (old logs' whole lists replay as they were), and through the real service with two windows (the
// panel's own PlannerClient), one window's command held on its way while the other's is accepted, as the reviewer did.
// (No new names are imported, so the same file runs against an older build as a negative control.)
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostClient } from '@openchamber/sdk';
import { todayIn } from '../src/domain/dates.ts';
import { validateCommand, type EventBody, type PlannerEvent } from '../src/domain/events.ts';
import { applyEvents, foldEvents } from '../src/domain/reducer.ts';
import { describe as describeEvent } from '../src/domain/activity.ts';
import { emptyState, type PlannerState, type Subtask } from '../src/domain/types.ts';
import { PlannerClient } from '../panel/lib/client.ts';

const ZONE = 'America/Los_Angeles';
const today = todayIn(ZONE);
let clock = Date.parse('2026-10-30T15:00:00Z');
const ev = (body: EventBody): PlannerEvent => ({ v: 1, id: `e${(clock += 1000)}`, at: new Date(clock).toISOString(), ...body }) as PlannerEvent;
/** Bodies as the service applies them: each checked against the plan the ones before it made. */
const run = (state: PlannerState, bodies: readonly unknown[]): PlannerState => {
  for (const body of bodies) {
    expect(validateCommand({ cmd: `c${clock}`, ...(body as object) }, state)).toBeNull();
    state = applyEvents(state, [ev(body as EventBody)]);
  }
  return state;
};
const sub = (id: string, title: string, done = false): Subtask => ({ id, title, done });
const titles = (state: PlannerState, taskId = 't') => state.tasks[taskId]!.subtasks.map((subtask) => `${subtask.title}${subtask.done ? ' ✓' : ''}`);
const created = (subtasks: Subtask[] = []) => ({ type: 'task.created', task: { id: 't', title: 'Harness parent', placement: { kind: 'day', date: today }, position: 1024, subtasks } });

describe('the reducer: an old log replays as it was; subtask commands change one subtask, by identity', () => {
  test("an old log's whole lists replace the list, as they did; then commands apply by identity", () => {
    const old = foldEvents([
      ev(created([sub('a', 'Alpha')]) as EventBody),
      ev({ type: 'task.updated', taskId: 't', patch: { subtasks: [sub('a', 'Alpha', true), sub('b', 'Beta')] } } as unknown as EventBody),
      ev({ type: 'task.updated', taskId: 't', patch: { subtasks: [sub('b', 'Beta renamed')] } } as unknown as EventBody),
    ]);
    expect(titles(old)).toEqual(['Beta renamed']);
    const next = applyEvents(old, [ev({ type: 'subtask.added', taskId: 't', subtask: sub('c', 'Gamma') } as unknown as EventBody), ev({ type: 'subtask.updated', taskId: 't', subtaskId: 'b', patch: { done: true } } as unknown as EventBody)]);
    expect(titles(next)).toEqual(['Beta renamed ✓', 'Gamma']);
  });

  test('added last, after one, first, or last when the one it goes after is gone; changed, deleted and moved by id; one not there is left alone', () => {
    let state = run(emptyState(), [created([sub('a', 'Alpha'), sub('b', 'Beta')])]);
    state = run(state, [
      { type: 'subtask.added', taskId: 't', subtask: sub('z', 'Last') },
      { type: 'subtask.added', taskId: 't', subtask: sub('m', 'After alpha'), after: 'a' },
      { type: 'subtask.added', taskId: 't', subtask: sub('f', 'First'), after: null },
      { type: 'subtask.added', taskId: 't', subtask: sub('g', 'After a gone one'), after: 'gone' },
    ]);
    expect(titles(state)).toEqual(['First', 'Alpha', 'After alpha', 'Beta', 'Last', 'After a gone one']);
    state = run(state, [
      { type: 'subtask.updated', taskId: 't', subtaskId: 'b', patch: { title: 'Beta 2', done: true }, seen: { title: 'Beta', done: false } },
      { type: 'subtask.deleted', taskId: 't', subtaskId: 'm', seen: { title: 'After alpha' } },
      { type: 'subtask.moved', taskId: 't', subtaskId: 'z', after: null },
      { type: 'subtask.moved', taskId: 't', subtaskId: 'f', after: 'g' },
    ]);
    expect(titles(state)).toEqual(['Last', 'Alpha', 'Beta 2 ✓', 'After a gone one', 'First']);
    const updatedAt = state.tasks.t!.updatedAt;
    const same = applyEvents(state, [ev({ type: 'subtask.updated', taskId: 't', subtaskId: 'gone', patch: { done: true } } as unknown as EventBody), ev({ type: 'subtask.deleted', taskId: 't', subtaskId: 'gone' } as unknown as EventBody)]);
    expect([titles(same), same.tasks.t!.updatedAt]).toEqual([titles(state), updatedAt]);
  });

  test('a whole list is refused now, saying to reload; a subtask is checked as one is (its id new, at most 200)', () => {
    const state = run(emptyState(), [created([sub('a', 'Alpha')])]);
    expect(validateCommand({ cmd: 'w1', type: 'task.updated', taskId: 't', patch: { subtasks: [sub('a', 'Alpha', true)] } }, state)).toBe('Subtasks are changed one at a time now: reload the Planner and try again');
    expect(validateCommand({ cmd: 'w2', type: 'subtask.added', taskId: 't', subtask: sub('a', 'Again') }, state)).toBe('subtask id already exists');
    expect(validateCommand({ cmd: 'w3', type: 'subtask.added', taskId: 't', subtask: { id: 'n', title: ' ', done: false } }, state)).toBe('subtask is invalid');
    expect(validateCommand({ cmd: 'w4', type: 'subtask.updated', taskId: 't', subtaskId: 'a', patch: {} }, state)).toBe('patch must set a field of the subtask');
    expect(validateCommand({ cmd: 'w5', type: 'subtask.updated', taskId: 't', subtaskId: 'a', patch: { id: 'b' } }, state)).toBe('unknown field id');
    expect(validateCommand({ cmd: 'w6', type: 'subtask.updated', taskId: 't', subtaskId: 'a', patch: { done: 'yes' } }, state)).toBe('subtask patch is invalid');
    const full = run(emptyState(), [created(Array.from({ length: 200 }, (_, index) => sub(`s${index}`, `Step ${index}`)))]);
    expect(validateCommand({ cmd: 'w7', type: 'subtask.added', taskId: 't', subtask: sub('more', 'One more') }, full)).toBe('a task has at most 200 subtasks');
  });

  test('the activity says what changed in the subtasks', () => {
    const state = run(emptyState(), [created([sub('a', 'Alpha')])]);
    const line = (body: object) => describeEvent(ev(body as EventBody), 't', state);
    expect(line({ type: 'subtask.added', taskId: 't', subtask: sub('b', 'Beta') })).toBe('updated subtasks: added “Beta”');
    expect(line({ type: 'subtask.updated', taskId: 't', subtaskId: 'a', patch: { done: true }, seen: { done: false } })).toBe('updated subtasks: checked off “Alpha”');
    expect(line({ type: 'subtask.updated', taskId: 't', subtaskId: 'a', patch: { title: 'Alpha 2' }, seen: { title: 'Alpha' } })).toBe('updated subtasks: renamed “Alpha” to “Alpha 2”');
    expect(line({ type: 'subtask.deleted', taskId: 't', subtaskId: 'gone', seen: { title: 'Gone' } })).toBe('updated subtasks: deleted “Gone”');
  });
});

// ── The real service, two windows ─────────────────────────────────────────────

const token = 'subtasks-test-token';
let child: ChildProcess;
let base = '';
let root = '';
let seq = 0;
const next = (prefix: string) => `${prefix}${String(++seq).padStart(6, '0')}`;

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
const plan = async (): Promise<PlannerState> => (await call('GET', '/state')).body.state;

/**
 * A Planner window, its commands to the service held on their way while `held` (sent once released, unchanged, in
 * order), as the reviewer held one after its freshness read.
 */
const openWindow = async () => {
  let gate: { promise: Promise<void>; open: () => void } | null = null;
  const host = {
    serviceRequest: async ({ method, path, body }: { method: string; path: string; body?: string }) => {
      if (gate && method === 'POST' && path === '/commands') await gate.promise;
      const response = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body }) });
      return { status: response.status, body: await response.text() };
    },
  } as unknown as HostClient;
  const client = new PlannerClient(host);
  await client.load();
  return {
    client,
    hold: () => {
      let open = () => {};
      const promise = new Promise<void>((resolve) => (open = resolve));
      gate = { promise, open };
    },
    release: () => {
      gate?.open();
      gate = null;
    },
  };
};

/** A task of the test's own with these subtasks, and two windows that have read it. */
const twoWindows = async (...names: string[]) => {
  const taskId = next('t');
  const subtasks = names.map((title) => sub(next('s'), title));
  const answer = await call('POST', '/commands', { commands: [{ cmd: next('c'), type: 'task.created', task: { id: taskId, title: 'Harness two windows', placement: { kind: 'day', date: today }, position: 1024 + seq, subtasks } }] });
  expect(answer.status).toBe(200);
  return { taskId, subtasks, a: await openWindow(), b: await openWindow() };
};
const subtasksOf = (state: PlannerState, taskId: string) => state.tasks[taskId]!.subtasks;

/**
 * A's command held on its way while B's is accepted, then A's sent as it was: what each window was told of a conflict,
 * and the plan after both, as the service and both windows (reloaded) have it.
 */
const race = async (windows: Awaited<ReturnType<typeof twoWindows>>, mine: EventBody[], theirs: EventBody[]) => {
  const { a, b } = windows;
  const told: { a: unknown[]; b: unknown[] } = { a: [], b: [] };
  a.hold();
  const sentA = a.client.dispatch(mine, { onConflict: (conflict: unknown) => told.a.push(conflict) } as never);
  await b.client.dispatch(theirs, { onConflict: (conflict: unknown) => told.b.push(conflict) } as never);
  const accepted = await plan();
  a.release();
  await sentA;
  const [service] = [await plan(), await a.client.refresh(), await b.client.refresh()];
  return { told, accepted, service, a: a.client.getView(), b: b.client.getView() };
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'planner-subtasks-'));
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
  await call('POST', '/commands', { commands: [{ cmd: next('c'), type: 'settings.updated', patch: { timezone: ZONE } }] });
});

afterAll(async () => {
  const exited = new Promise((resolve) => child?.once('exit', resolve));
  child?.kill('SIGTERM');
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
  rmSync(root, { recursive: true, force: true });
});

describe('two windows change the same task\'s subtasks at once (the real service; one window\'s command held on its way)', () => {
  test("the reviewer's case: A ticks child A while B adds a subtask; both are kept, the new one's id and text too, and both windows agree", async () => {
    const w = await twoWindows('child A', 'child B');
    const [childA] = w.subtasks;
    const added = sub(next('s'), 'review12-newly-accepted-subtask');
    const result = await race(w, [{ type: 'subtask.updated', taskId: w.taskId, subtaskId: childA!.id, patch: { done: true }, seen: { done: false } } as unknown as EventBody], [
      { type: 'subtask.added', taskId: w.taskId, subtask: added } as unknown as EventBody,
    ]);
    expect(subtasksOf(result.accepted, w.taskId).length).toBe(3);
    expect(subtasksOf(result.service, w.taskId)).toEqual([{ ...childA!, done: true }, w.subtasks[1]!, added]);
    expect(subtasksOf(result.a.state, w.taskId)).toEqual(subtasksOf(result.service, w.taskId));
    expect(subtasksOf(result.b.state, w.taskId)).toEqual(subtasksOf(result.service, w.taskId));
    expect([result.told, result.a.error, result.b.error]).toEqual([{ a: [], b: [] }, null, null]);
  });

  test("the second probe: A ticks child A while B ticks child B; B's tick stays", async () => {
    const w = await twoWindows('child A', 'child B');
    const [childA, childB] = w.subtasks;
    const result = await race(
      w,
      [{ type: 'subtask.updated', taskId: w.taskId, subtaskId: childA!.id, patch: { done: true }, seen: { done: false } } as unknown as EventBody],
      [{ type: 'subtask.updated', taskId: w.taskId, subtaskId: childB!.id, patch: { done: true }, seen: { done: false } } as unknown as EventBody],
    );
    expect(subtasksOf(result.service, w.taskId).map((subtask) => subtask.done)).toEqual([true, true]);
    expect(result.told).toEqual({ a: [], b: [] });
  });

  test('both tick the same child: no conflict, it is done; A renames one while B renames another, or ticks the one A renames: both kept', async () => {
    const w = await twoWindows('child A', 'child B');
    const [childA, childB] = w.subtasks;
    const same = await race(
      w,
      [{ type: 'subtask.updated', taskId: w.taskId, subtaskId: childA!.id, patch: { done: true }, seen: { done: false } } as unknown as EventBody],
      [{ type: 'subtask.updated', taskId: w.taskId, subtaskId: childA!.id, patch: { done: true }, seen: { done: false } } as unknown as EventBody],
    );
    expect([same.told, subtasksOf(same.service, w.taskId)[0]!.done]).toEqual([{ a: [], b: [] }, true]);
    const renames = await race(
      w,
      [{ type: 'subtask.updated', taskId: w.taskId, subtaskId: childB!.id, patch: { title: 'child B, renamed in A' }, seen: { title: 'child B' } } as unknown as EventBody],
      [{ type: 'subtask.updated', taskId: w.taskId, subtaskId: childB!.id, patch: { done: true }, seen: { done: false } } as unknown as EventBody],
    );
    expect(renames.told).toEqual({ a: [], b: [] });
    expect(subtasksOf(renames.service, w.taskId)[1]).toEqual({ ...childB!, title: 'child B, renamed in A', done: true });
  });

  test('B renames the child A deletes: a conflict; nothing of A written, it stays with their title, and A is told what it is now', async () => {
    const w = await twoWindows('child A', 'child B');
    const [, childB] = w.subtasks;
    const version = (await plan()).version;
    const result = await race(
      w,
      [{ type: 'subtask.deleted', taskId: w.taskId, subtaskId: childB!.id, seen: { title: 'child B' } } as unknown as EventBody],
      [{ type: 'subtask.updated', taskId: w.taskId, subtaskId: childB!.id, patch: { title: 'child B, renamed in B' }, seen: { title: 'child B' } } as unknown as EventBody],
    );
    expect(result.service.version - version).toBe(1);
    expect(subtasksOf(result.service, w.taskId).map((subtask) => subtask.title)).toEqual(['child A', 'child B, renamed in B']);
    expect(result.told).toEqual({ a: [{ taskId: w.taskId, subtaskId: childB!.id, now: { ...childB!, title: 'child B, renamed in B' } }], b: [] });
    // Told, not shown as an error; the window shows theirs.
    expect(result.a.error).toBeNull();
    expect(subtasksOf(result.a.state, w.taskId)[1]!.title).toBe('child B, renamed in B');
    // Save mine: deleted, as it is now.
    await w.a.client.dispatch([{ type: 'subtask.deleted', taskId: w.taskId, subtaskId: childB!.id, seen: { title: 'child B, renamed in B' } } as unknown as EventBody]);
    expect(subtasksOf(await plan(), w.taskId).map((subtask) => subtask.title)).toEqual(['child A']);
  });

  test('both rename the same child: the second is a conflict (to the same name, not one); A ticks one B deleted: a conflict, nothing written', async () => {
    const w = await twoWindows('child A', 'child B');
    const [childA, childB] = w.subtasks;
    const rename = (title: string): EventBody => ({ type: 'subtask.updated', taskId: w.taskId, subtaskId: childA!.id, patch: { title }, seen: { title: 'child A' } }) as unknown as EventBody;
    const both = await race(w, [rename('child A, renamed in A')], [rename('child A, renamed in B')]);
    expect(subtasksOf(both.service, w.taskId)[0]!.title).toBe('child A, renamed in B');
    expect((both.told.a[0] as { now: Subtask }).now.title).toBe('child A, renamed in B');
    const again = await twoWindows('child A');
    const agreed = await race(again, [{ ...rename('the same'), taskId: again.taskId, subtaskId: again.subtasks[0]!.id } as EventBody], [{ ...rename('the same'), taskId: again.taskId, subtaskId: again.subtasks[0]!.id } as EventBody]);
    expect([agreed.told, subtasksOf(agreed.service, again.taskId)[0]!.title]).toEqual([{ a: [], b: [] }, 'the same']);
    const gone = await race(
      w,
      [{ type: 'subtask.updated', taskId: w.taskId, subtaskId: childB!.id, patch: { done: true }, seen: { done: false } } as unknown as EventBody],
      [{ type: 'subtask.deleted', taskId: w.taskId, subtaskId: childB!.id, seen: { title: 'child B' } } as unknown as EventBody],
    );
    expect(gone.told.a).toEqual([{ taskId: w.taskId, subtaskId: childB!.id, now: null }]);
    expect(subtasksOf(gone.service, w.taskId).map((subtask) => subtask.id)).toEqual([childA!.id]);
  });

  test("a whole list from a window that read it before another window's accepted add is refused, so the add stays (the old way lost it)", async () => {
    const w = await twoWindows('child A', 'child B');
    const added = sub(next('s'), 'review12-newly-accepted-subtask');
    const seenByA = (await plan()).tasks[w.taskId]!.subtasks;
    // B adds as its build adds: a command; a build from before them (the negative control), the whole list as B read it.
    const byCommand = await call('POST', '/commands', { commands: [{ cmd: next('c'), type: 'subtask.added', taskId: w.taskId, subtask: added }] });
    if (byCommand.status !== 200) expect((await call('POST', '/commands', { commands: [{ cmd: next('c'), type: 'task.updated', taskId: w.taskId, patch: { subtasks: [...seenByA, added] } }] })).status).toBe(200);
    expect(subtasksOf(await plan(), w.taskId).length).toBe(3);
    // A's tick, the whole list as A read it before B's add (the reviewer's held command).
    const stale = await call('POST', '/commands', { commands: [{ cmd: next('c'), type: 'task.updated', taskId: w.taskId, patch: { subtasks: seenByA.map((subtask, index) => (index === 0 ? { ...subtask, done: true } : subtask)) } }] });
    expect(subtasksOf(await plan(), w.taskId).map((subtask) => subtask.title)).toContain('review12-newly-accepted-subtask');
    expect([stale.status, stale.body.error]).toEqual([400, 'Subtasks are changed one at a time now: reload the Planner and try again']);
  });

  test('a conflict answers 409 with what the subtask is now and the plan as it is; the batch it was in is written not at all', async () => {
    const w = await twoWindows('child A');
    const [childA] = w.subtasks;
    await call('POST', '/commands', { commands: [{ cmd: next('c'), type: 'subtask.updated', taskId: w.taskId, subtaskId: childA!.id, patch: { title: 'renamed first' }, seen: { title: 'child A' } }] });
    const made = next('t');
    const answer = await call('POST', '/commands', {
      commands: [
        { cmd: next('c'), type: 'task.created', task: { id: made, title: 'child A', placement: { kind: 'day', date: today }, position: 1 } },
        { cmd: next('c'), type: 'subtask.deleted', taskId: w.taskId, subtaskId: childA!.id, seen: { title: 'child A' } },
      ],
    });
    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({ error: 'This subtask was changed in another window since', index: 1, conflict: { taskId: w.taskId, subtaskId: childA!.id, now: { title: 'renamed first' } } });
    expect(answer.body.state.tasks[made]).toBeUndefined();
    expect((await plan()).tasks[made]).toBeUndefined();
  });
});
