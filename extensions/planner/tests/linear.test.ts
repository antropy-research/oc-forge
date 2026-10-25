import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import {
  ALL_DOCUMENTS,
  isLinearIssue,
  issueSource,
  linkedIssueIds,
  linkedTask,
  parseLinearUrl,
  planLinearSync,
  priorityFromLinear,
  priorityToLinear,
  readGraphql,
  stateOfType,
  taskFromIssue,
  type LinearIssue,
} from '../src/domain/linear.ts';
import { applyEvents, foldEvents } from '../src/domain/reducer.ts';
import { validateCommand, type EventBody, type PlannerEvent } from '../src/domain/events.ts';

const issue = (patch: Partial<LinearIssue> = {}): LinearIssue => ({
  id: 'iss-1',
  identifier: 'NEX-110',
  title: 'Fix the agent backend',
  url: 'https://linear.app/antropy/issue/NEX-110/fix-the-agent-backend',
  priority: 2,
  dueDate: '2026-10-30',
  updatedAt: '2026-10-24T10:00:00.000Z',
  state: { id: 'st-todo', name: 'Todo', type: 'unstarted', color: '#e2e2e2' },
  team: { id: 'team-1', key: 'NEX', name: 'Nexus' },
  project: null,
  cycle: null,
  ...patch,
});

let clock = Date.parse('2026-10-24T16:00:00Z');
const ev = (body: EventBody): PlannerEvent => {
  clock += 1000;
  return { v: 1, id: `e${clock}`, at: new Date(clock).toISOString(), ...body } as PlannerEvent;
};
const withLinked = (title?: string) =>
  foldEvents([
    ev({ type: 'task.created', task: taskFromIssue(issue(), 't1', { kind: 'day', date: '2026-10-24' }, 1024) }),
    ...(title ? [ev({ type: 'task.updated', taskId: 't1', patch: { title } })] : []),
  ]);

describe('mapping', () => {
  test('issue to task', () => {
    const task = taskFromIssue(issue(), 't1', { kind: 'day', date: '2026-10-24' }, 5);
    expect(task).toMatchObject({ title: 'Fix the agent backend', priority: 'high', dueDate: '2026-10-30' });
    expect(task.source).toEqual({ kind: 'linear', id: 'iss-1', key: 'NEX-110', url: issue().url, title: 'Fix the agent backend', teamId: 'team-1', status: { name: 'Todo', type: 'unstarted', color: '#e2e2e2' } });
    expect(taskFromIssue(issue({ dueDate: null, priority: 0 }), 't2', { kind: 'backlog', bucket: 'someday' }, 1)).toMatchObject({ priority: null, dueDate: null });
  });
  test('priority both ways', () => {
    expect([0, 1, 2, 3, 4].map(priorityFromLinear)).toEqual([null, 'urgent', 'high', 'medium', 'low']);
    expect(priorityToLinear('urgent')).toBe(1);
    expect(priorityToLinear(null)).toBe(0);
  });
  test('team states: first by board order', () => {
    const states = [
      { id: 'a', name: 'Canceled', type: 'canceled', color: '', position: 5 },
      { id: 'b', name: 'Shipped', type: 'completed', color: '', position: 4 },
      { id: 'c', name: 'Done', type: 'completed', color: '', position: 3 },
      { id: 'd', name: 'In Progress', type: 'started', color: '', position: 2 },
    ];
    expect(stateOfType(states, 'completed')?.id).toBe('c');
    expect(stateOfType(states, 'started')?.id).toBe('d');
    expect(stateOfType([], 'completed')).toBeNull();
  });
  test('issue URLs', () => {
    expect(parseLinearUrl('https://linear.app/antropy/issue/NEX-110/fix-the-agent-backend')).toBe('NEX-110');
    expect(parseLinearUrl('  https://linear.app/antropy/issue/nex-7  ')).toBe('NEX-7');
    expect(parseLinearUrl('https://linear.app/antropy/project/whatever')).toBeNull();
    expect(parseLinearUrl('see https://linear.app/antropy/issue/NEX-110')).toBeNull();
  });
  test('GraphQL answers and drag payloads', () => {
    expect(readGraphql<{ viewer: { id: string } }>('{"data":{"viewer":{"id":"u"}}}').viewer.id).toBe('u');
    expect(() => readGraphql('{"errors":[{"message":"bad","extensions":{"userPresentableMessage":"Entity not found"}}]}')).toThrow('Entity not found');
    expect(isLinearIssue(issue())).toBe(true);
    expect(isLinearIssue({ ...issue(), team: null })).toBe(false);
    expect(isLinearIssue('NEX-110')).toBe(false);
  });
});

describe('linked tasks', () => {
  test('one live task per issue; completed tasks are not refetched', () => {
    let state = withLinked();
    expect(linkedTask(state, 'iss-1')?.id).toBe('t1');
    expect(linkedIssueIds(state)).toEqual(['iss-1']);
    state = applyEvents(state, [ev({ type: 'task.completed', taskId: 't1', on: '2026-10-24' })]);
    expect(linkedIssueIds(state)).toEqual([]);
    state = applyEvents(state, [ev({ type: 'task.deleted', taskId: 't1' })]);
    expect(linkedTask(state, 'iss-1')).toBeNull();
  });
});

describe('sync', () => {
  const options = { today: '2026-10-24', importCompletion: false };
  test('nothing changed, nothing to do', () => {
    expect(planLinearSync(withLinked(), new Map([['iss-1', issue()]]), options)).toEqual([]);
  });
  test('a state change is recorded; a rename follows an unrenamed task', () => {
    const remote = issue({ title: 'Fix the agent backend (v2)', state: { id: 'st-prog', name: 'In Progress', type: 'started', color: '#f2c94c' } });
    const bodies = planLinearSync(withLinked(), new Map([['iss-1', remote]]), options);
    expect(bodies).toEqual([{ type: 'task.sourceSynced', taskId: 't1', source: issueSource(remote), title: 'Fix the agent backend (v2)' }]);
    const state = applyEvents(withLinked(), bodies.map(ev));
    expect(state.tasks.t1).toMatchObject({ title: 'Fix the agent backend (v2)', source: { status: { name: 'In Progress' } } });
  });
  test('a title the user changed is kept', () => {
    const remote = issue({ title: 'Renamed in Linear' });
    const bodies = planLinearSync(withLinked('My own name'), new Map([['iss-1', remote]]), options);
    expect(bodies).toEqual([{ type: 'task.sourceSynced', taskId: 't1', source: issueSource(remote) }]);
    expect(applyEvents(withLinked('My own name'), bodies.map(ev)).tasks.t1!.title).toBe('My own name');
  });
  test('closing in Linear completes the task only when that setting is on', () => {
    const done = issue({ state: { id: 'st-done', name: 'Done', type: 'completed', color: '#5e6ad2' } });
    expect(planLinearSync(withLinked(), new Map([['iss-1', done]]), options).map((body) => body.type)).toEqual(['task.sourceSynced']);
    expect(planLinearSync(withLinked(), new Map([['iss-1', done]]), { ...options, importCompletion: true }).map((body) => body.type)).toEqual(['task.sourceSynced', 'task.completed']);
  });
});

describe('validation', () => {
  const state = withLinked();
  test('links and settings', () => {
    expect(validateCommand({ cmd: 'a', type: 'task.updated', taskId: 't1', patch: { source: null } }, state)).toBeNull();
    expect(validateCommand({ cmd: 'b', type: 'task.updated', taskId: 't1', patch: { source: { kind: 'linear', id: 'x', key: 'K-1', url: 'javascript:alert(1)' } } }, state)).toBe('source is invalid');
    expect(validateCommand({ cmd: 'c', type: 'task.sourceSynced', taskId: 't1', source: issueSource(issue()), title: 'New' }, state)).toBeNull();
    expect(validateCommand({ cmd: 'd', type: 'settings.updated', patch: { linearOnComplete: 'complete', linearOnPlan: 'start', linearImportCompletion: true } }, state)).toBeNull();
    expect(validateCommand({ cmd: 'e', type: 'settings.updated', patch: { linearOnComplete: 'always' } }, state)).toContain('linearOnComplete');
  });
});

// Set LINEAR_SCHEMA to Linear's schema.graphql (github.com/linear/linear, packages/sdk/src) to check every document.
const schemaPath = process.env.LINEAR_SCHEMA;
describe.skipIf(!schemaPath || !existsSync(schemaPath))('Linear schema', () => {
  test('every document validates', async () => {
    const { buildSchema, parse, validate } = await import('graphql');
    const schema = buildSchema(readFileSync(schemaPath!, 'utf8'), { assumeValidSDL: true });
    for (const document of ALL_DOCUMENTS) expect(validate(schema, parse(document)).map((error) => error.message)).toEqual([]);
  });
});
