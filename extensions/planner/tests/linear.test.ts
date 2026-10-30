import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import {
  ADD_COMMENT_MUTATION,
  ALL_DOCUMENTS,
  MUTATION_INPUT_KEYS,
  UPDATE_ISSUE_MUTATION,
  commentThreads,
  estimateChoices,
  estimateLabel,
  favoriteOrder,
  favoritesOf,
  groupViews,
  historyText,
  isIssueView,
  isProjectView,
  type LinearHistoryEntry,
  type LinearSavedView,
  planTextSave,
  workflowOrder,
  inWorkspace,
  isLinearIssue,
  issueSource,
  linkedIssueIds,
  linkedIssueIdsByWorkspace,
  linkedTask,
  parseLinearUrl,
  planLinearSync,
  plannedLinearTasks,
  priorityFromLinear,
  priorityToLinear,
  readGraphql,
  stateOfType,
  taskFromIssue,
  type LinearIssue,
  type LinearProject,
} from '../src/domain/linear.ts';
import { applyEvents, foldEvents } from '../src/domain/reducer.ts';
import { validateCommand, type EventBody, type PlannerEvent } from '../src/domain/events.ts';
import { displayFilter, projectDisplayFilter, settingsDisplay } from '../src/domain/linearDisplay.ts';
import { compileFilter, readFilter, type LinearFilterNode, type LinearFilterRule } from '../src/domain/linearFilter.ts';
import { DEFAULT_SETTINGS } from '../src/domain/types.ts';

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
  test('issue URLs name the workspace and the issue', () => {
    expect(parseLinearUrl('https://linear.app/antropy/issue/NEX-110/fix-the-agent-backend')).toEqual({ urlKey: 'antropy', key: 'NEX-110' });
    expect(parseLinearUrl('  https://linear.app/Antropy/issue/nex-7  ')).toEqual({ urlKey: 'antropy', key: 'NEX-7' });
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
  test('the filters the Planner sends are valid IssueFilter and ProjectFilter values', async () => {
    const { buildSchema, coerceInputValue } = await import('graphql');
    const schema = buildSchema(readFileSync(schemaPath!, 'utf8'), { assumeValidSDL: true });
    const check = (typeName: string, value: unknown) => {
      const errors: string[] = [];
      coerceInputValue(value, schema.getType(typeName) as never, (path, _invalid, error) => errors.push(`${path.join('.')}: ${error.message}`));
      return errors;
    };
    const context = { today: '2026-10-26', weekStartsOn: 1 as const };
    const value = (v: string, label = v) => ({ value: v, label });
    const rules: LinearFilterRule[][] = [
      [{ field: 'status', op: 'is', values: [value('Todo'), value('In Progress')] }],
      [{ field: 'status', op: 'isNot', values: [value('Done')] }],
      [{ field: 'assignee', op: 'is', values: [value('u1'), value('', 'No assignee')] }],
      [{ field: 'assignee', op: 'isNot', values: [value('u1'), value('', 'No assignee')] }],
      [{ field: 'creator', op: 'isNot', values: [value('u1')] }],
      [{ field: 'priority', op: 'is', values: [value('0'), value('1')] }],
      [{ field: 'label', op: 'includesAny', values: [value('Bug')] }],
      [{ field: 'label', op: 'includesAll', values: [value('Bug'), value('UI')] }],
      [{ field: 'label', op: 'excludes', values: [value('Bug')] }],
      [{ field: 'project', op: 'is', values: [value('p1'), value('', 'No project')] }],
      [{ field: 'team', op: 'isNot', values: [value('t1')] }],
      [{ field: 'cycle', op: 'is', values: [value('c1'), value('@active'), value('', 'No cycle')] }],
      [{ field: 'cycle', op: 'isNot', values: [value('@next')] }],
      [{ field: 'due', op: 'is', values: [value('overdue'), value('today'), value('thisWeek'), value('nextWeek'), value('none')] }],
      [{ field: 'due', op: 'before', values: [value('2026-11-02')] }],
      [{ field: 'due', op: 'after', values: [value('2026-11-02')] }],
      // Linear's further properties.
      [{ field: 'assignee', op: 'is', values: [value('u1'), value('@me', 'Me'), value('', 'No assignee')] }],
      [{ field: 'creator', op: 'isNot', values: [value('u1'), value('@me', 'Me')] }],
      [{ field: 'creator', op: 'isNot', values: [value('@me', 'Me'), value('', 'No creator')] }],
      [{ field: 'content', op: 'contains', values: [value('login')] }],
      [{ field: 'content', op: 'notContains', values: [value('login')] }],
      [{ field: 'subscriber', op: 'includesAny', values: [value('@me', 'Me')] }],
      [{ field: 'subscriber', op: 'includesAny', values: [value('u2'), value('@me', 'Me')] }],
      [{ field: 'subscriber', op: 'includesAll', values: [value('u2'), value('@me', 'Me')] }],
      [{ field: 'subscriber', op: 'excludes', values: [value('u2'), value('@me', 'Me')] }],
      [{ field: 'relation', op: 'includesAny', values: [value('blocked'), value('blocking'), value('related'), value('duplicate'), value('parent'), value('children')] }],
      [{ field: 'relation', op: 'includesAll', values: [value('blocked'), value('parent'), value('children')] }],
      [{ field: 'relation', op: 'excludes', values: [value('duplicate'), value('parent'), value('children')] }],
      [{ field: 'created', op: 'after', values: [value('-P1W')] }],
      [{ field: 'updated', op: 'before', values: [value('2026-10-01')] }],
      [{ field: 'completed', op: 'after', values: [value('-P3M')] }],
      [{ field: 'estimate', op: 'is', values: [value('3'), value('', 'No estimate')] }],
      [{ field: 'estimate', op: 'isNot', values: [value('3')] }],
      [{ field: 'estimate', op: 'isNot', values: [value('3'), value('', 'No estimate')] }],
      [{ field: 'estimate', op: 'atLeast', values: [value('5')] }],
      [{ field: 'estimate', op: 'atMost', values: [value('2')] }],
      [{ field: 'milestone', op: 'is', values: [value('m1'), value('', 'No milestone')] }],
      [{ field: 'milestone', op: 'isNot', values: [value('m1')] }],
      [{ field: 'cycle', op: 'isNot', values: [value('c1'), value('@active')] }],
    ];
    for (const set of rules) expect(check('IssueFilter', compileFilter(set, context))).toEqual([]);
    // All or any at the top, and groups nested in groups, as Linear's advanced filter builds them.
    const urgent: LinearFilterNode = { field: 'priority', op: 'is', values: [value('1', 'Urgent')] };
    const mine: LinearFilterNode = { field: 'assignee', op: 'is', values: [value('@me', 'Me')] };
    const bug: LinearFilterNode = { field: 'label', op: 'includesAny', values: [value('Bug')] };
    const nested: LinearFilterNode[] = [{ join: 'or', items: [urgent, { join: 'and', items: [mine, { join: 'or', items: [bug, rules[20]![0]!] }] }] }, bug];
    expect(check('IssueFilter', compileFilter(nested, context))).toEqual([]);
    expect(check('IssueFilter', compileFilter([urgent, mine, bug], context, 'or'))).toEqual([]);
    expect(check('IssueFilter', compileFilter(rules.flat(), context, 'or'))).toEqual([]);
    expect(check('IssueFilter', compileFilter([{ join: 'and', items: rules.flat() }], context))).toEqual([]);
    // A saved view's filter, read back and sent again (when its filters were changed here).
    const saved = { or: [{ priority: { eq: 1 } }, { and: [{ assignee: { isMe: { eq: true } } }, { labels: { some: { name: { in: ['Bug'] } } } }] }, { slaStatus: { eq: 'Breached' } }] };
    expect(check('IssueFilter', saved)).toEqual([]);
    expect(check('IssueFilter', compileFilter(readFilter(saved, [], context), context))).toEqual([]);
    const display = settingsDisplay(DEFAULT_SETTINGS);
    for (const window of ['none', 'week', '3months', 'year'] as const) {
      expect(check('IssueFilter', displayFilter({ ...display, showCompleted: window, showSubIssues: false, showTriage: false }))).toEqual([]);
      expect(check('ProjectFilter', projectDisplayFilter({ showCompleted: window }))).toEqual([]);
    }
    expect(check('IssueFilter', { subscribers: { some: { isMe: { eq: true } } } })).toEqual([]);
    expect(check('IssueFilter', { project: { id: { eq: 'p1' } } })).toEqual([]);
    // The check itself catches a field Linear does not have.
    expect(check('IssueFilter', { status: { name: { in: ['Todo'] } } }).length).toBeGreaterThan(0);
  });
});

describe('workspaces', () => {
  const tagged = issue({ workspaceId: 'org-a', branchName: 'qihang/nex-110-fix-the-agent-backend' });
  test('a link keeps its workspace and Linear branch', () => {
    expect(issueSource(tagged)).toMatchObject({ workspaceId: 'org-a', branch: 'qihang/nex-110-fix-the-agent-backend' });
    // An issue read without its workspace keeps the one its link already has.
    expect(issueSource(issue(), issueSource(tagged)).workspaceId).toBe('org-a');
    expect(issueSource(issue({ id: 'other' }), issueSource(tagged)).workspaceId).toBeUndefined();
    expect(inWorkspace(issue(), 'org-b').workspaceId).toBe('org-b');
  });
  test('links made before workspaces gain one on the next sync, then stay quiet', () => {
    const bodies = planLinearSync(withLinked(), new Map([['iss-1', tagged]]), { today: '2026-10-24', importCompletion: false });
    expect(bodies).toEqual([{ type: 'task.sourceSynced', taskId: 't1', source: issueSource(tagged) }]);
    const migrated = applyEvents(withLinked(), bodies.map(ev));
    expect(migrated.tasks.t1!.source).toMatchObject({ workspaceId: 'org-a', branch: 'qihang/nex-110-fix-the-agent-backend' });
    expect(planLinearSync(migrated, new Map([['iss-1', tagged]]), { today: '2026-10-24', importCompletion: false })).toEqual([]);
  });
  test('linked issues by workspace; older links belong to OpenChamber’s connection', () => {
    let state = withLinked();
    state = applyEvents(state, [ev({ type: 'task.created', task: taskFromIssue(issue({ id: 'iss-2', workspaceId: 'org-b' }), 't2', { kind: 'backlog', bucket: 'someday' }, 1) })]);
    expect([...linkedIssueIdsByWorkspace(state, 'org-host')]).toEqual([['org-host', ['iss-1']], ['org-b', ['iss-2']]]);
    expect([...linkedIssueIdsByWorkspace(state, null)]).toEqual([['org-b', ['iss-2']]]);
  });
  test('drag payloads and links validate the new fields', () => {
    expect(isLinearIssue(tagged)).toBe(true);
    expect(isLinearIssue({ ...tagged, workspaceId: 7 })).toBe(false);
    const state = withLinked();
    expect(validateCommand({ cmd: 'w1', type: 'task.sourceSynced', taskId: 't1', source: issueSource(tagged) }, state)).toBeNull();
    expect(validateCommand({ cmd: 'w2', type: 'task.sourceSynced', taskId: 't1', source: { ...issueSource(tagged), workspaceId: '' } }, state)).toBe('source is invalid');
    expect(validateCommand({ cmd: 'w3', type: 'task.sourceSynced', taskId: 't1', source: { ...issueSource(tagged), branch: 'x'.repeat(201) } }, state)).toBe('source is invalid');
  });
});

describe('views', () => {
  test('planned issues by when they are planned', () => {
    let planned = withLinked();
    planned = applyEvents(planned, [
      ev({ type: 'task.created', task: taskFromIssue(issue({ id: 'iss-2' }), 't2', { kind: 'day', date: '2026-10-27' }, 1) }),
      ev({ type: 'task.created', task: taskFromIssue(issue({ id: 'iss-3' }), 't3', { kind: 'backlog', bucket: 'someday' }, 1) }),
      ev({ type: 'task.created', task: taskFromIssue(issue({ id: 'iss-4' }), 't4', { kind: 'day', date: '2026-10-24' }, 5) }),
      ev({ type: 'task.completed', taskId: 't4', on: '2026-10-24' }),
      ev({ type: 'task.created', task: { id: 't5', title: 'Plain', placement: { kind: 'day', date: '2026-10-24' }, position: 9 } }),
    ]);
    expect(plannedLinearTasks(planned, '2026-10-24').map((group) => `${group.key}:${group.tasks.map((task) => task.id).join(',')}`)).toEqual(['today:t1', 'upcoming:t2', 'backlog:t3']);
  });
  test('display settings validate', () => {
    const state = withLinked();
    expect(validateCommand({ cmd: 's1', type: 'settings.updated', patch: { linearLayout: 'board', linearGroupBy: 'workspace', linearOrderBy: 'due' } }, state)).toBeNull();
    expect(validateCommand({ cmd: 's2', type: 'settings.updated', patch: { linearLayout: 'grid' } }, state)).toContain('linearLayout');
    expect(validateCommand({ cmd: 's3', type: 'settings.updated', patch: { linearGroupBy: 'parent' } }, state)).toContain('linearGroupBy');
    expect(validateCommand({ cmd: 's4', type: 'settings.updated', patch: { linearOrderBy: 'random' } }, state)).toContain('linearOrderBy');
  });
});

describe('editing', () => {
  const base = { title: 'Fix the agent', description: '- [ ] tests' };
  test('only what I changed is sent', () => {
    expect(planTextSave(base, base, { ...base, title: 'Fix the agent backend' })).toEqual({ input: { title: 'Fix the agent backend' }, conflict: false });
    expect(planTextSave(base, base, base)).toEqual({ input: {}, conflict: false });
  });
  test("a teammate's change to another field is kept, not reverted", () => {
    const theirs = { ...base, description: 'Rewritten by a teammate' };
    expect(planTextSave(base, theirs, { ...base, title: 'New title' })).toEqual({ input: { title: 'New title' }, conflict: false });
  });
  test('the same field changed on both sides is a conflict', () => {
    const theirs = { ...base, description: 'Theirs' };
    expect(planTextSave(base, theirs, { ...base, description: 'Mine' })).toEqual({ input: { description: 'Mine' }, conflict: true });
    // Both made the same change: nothing to send, nothing lost.
    expect(planTextSave(base, theirs, { ...base, description: 'Theirs' })).toEqual({ input: {}, conflict: false });
  });
  test('states in workflow order and comment threads', () => {
    const states = [
      { id: 'd', name: 'Done', type: 'completed', color: '', position: 0 },
      { id: 'r', name: 'In Review', type: 'started', color: '', position: 2 },
      { id: 'p', name: 'In Progress', type: 'started', color: '', position: 1 },
      { id: 'b', name: 'Backlog', type: 'backlog', color: '', position: 9 },
      { id: 't', name: 'Triage', type: 'triage', color: '', position: 0 },
    ];
    expect(workflowOrder(states).map((state) => state.id)).toEqual(['t', 'b', 'p', 'r', 'd']);
    const comment = (id: string, at: string, parent: string | null = null) => ({ id, body: id, createdAt: `2026-10-25T0${at}:00:00.000Z`, editedAt: null, user: null, botActor: null, parent: parent ? { id: parent } : null });
    const threads = commentThreads([comment('c3', '3', 'c1'), comment('c1', '1'), comment('c2', '2'), comment('c4', '4', 'c3'), comment('c5', '5', 'missing')]);
    expect(threads.map((item) => `${item.comment.id}${item.reply ? '↳' : ''}`)).toEqual(['c1', 'c3↳', 'c4↳', 'c2', 'c5']);
  });
  test('the service lets each mutation carry only the fields the Planner edits', () => {
    expect(MUTATION_INPUT_KEYS.get(UPDATE_ISSUE_MUTATION)).toEqual(['title', 'description', 'stateId', 'priority', 'assigneeId', 'dueDate', 'addedLabelIds', 'removedLabelIds', 'projectId', 'cycleId', 'estimate']);
    expect(MUTATION_INPUT_KEYS.get(ADD_COMMENT_MUTATION)).toEqual(['issueId', 'body']);
    expect(ALL_DOCUMENTS).toEqual(expect.arrayContaining([...MUTATION_INPUT_KEYS.keys()]));
  });
});

import { taskForGitHub } from '../src/domain/github.ts';

describe('Linear issues synced with GitHub', () => {
  const synced = issue({ syncedWith: [{ service: 'github', metadata: { owner: 'acme', repo: 'app', number: 12 } }, { service: 'slack', metadata: null }] });
  test('the GitHub key travels with the link and updates on sync', () => {
    expect(issueSource(synced).mirrors).toEqual(['acme/app#12']);
    expect(issueSource(issue()).mirrors).toBeUndefined();
    const bodies = planLinearSync(withLinked(), new Map([['iss-1', synced]]), { today: '2026-10-24', importCompletion: false });
    expect(bodies).toEqual([{ type: 'task.sourceSynced', taskId: 't1', source: issueSource(synced) }]);
  });
  test('planned once, from either side', () => {
    const viaLinear = foldEvents([ev({ type: 'task.created', task: taskFromIssue(synced, 'tl', { kind: 'day', date: '2026-10-24' }, 1) })]);
    expect(taskForGitHub(viaLinear, { id: 'I_12', key: 'acme/app#12' })?.id).toBe('tl');
    expect(taskForGitHub(viaLinear, { id: 'I_13', key: 'acme/app#13' })).toBeNull();
    const viaGitHub = foldEvents([ev({ type: 'task.created', task: { id: 'tg', title: 'Crash', placement: { kind: 'day', date: '2026-10-24' }, position: 1, source: { kind: 'github', id: 'I_12', key: 'acme/app#12', url: 'https://github.com/acme/app/issues/12' } } })]);
    expect(linkedTask(viaGitHub, synced.id, ['acme/app#12'])?.id).toBe('tg');
    expect(linkedTask(viaGitHub, synced.id)).toBeNull();
  });
});

describe('saved views', () => {
  const view = (id: string, patch: Partial<LinearSavedView> = {}): LinearSavedView => ({
    id,
    name: id,
    description: null,
    icon: null,
    color: null,
    shared: true,
    modelName: 'Issue',
    slugId: `slug-${id}`,
    updatedAt: '2026-10-20T00:00:00.000Z',
    team: null,
    owner: { id: 'u1', name: 'Al' },
    workspaceId: 'org-a',
    ...patch,
  });
  const nex = { id: 'team-1', key: 'NEX', name: 'Nexus' };
  const ops = { id: 'team-2', key: 'OPS', name: 'Ops' };
  test('views of issues and views of projects are both kept, told apart by what they list', () => {
    expect(isIssueView(view('a'))).toBe(true);
    expect(isProjectView(view('b', { modelName: 'Project' }))).toBe(true);
    expect(isIssueView(view('b', { modelName: 'Project' }))).toBe(false);
    expect(isIssueView(view('c', { modelName: 'initiative' }))).toBe(false);
    expect(isProjectView(view('d', { modelName: 'FeedItem' }))).toBe(false);
  });
  test('favorites: views, projects and issues, in the sidebar order', () => {
    const project = { id: 'p1', name: 'Planner', url: 'https://linear.app/a/project/p1', color: '#000', icon: null, description: '', progress: 0, health: null, priority: 0, startDate: null, targetDate: null, updatedAt: '', status: { id: 's', name: 'Started', type: 'started', color: '#000' }, lead: null, teams: { nodes: [] } };
    const favorites = favoritesOf([
      { type: 'project', sortOrder: 3, customView: null, project },
      { type: 'customView', sortOrder: 1, customView: { id: 'v1' } },
      { type: 'issue', sortOrder: 2, customView: null, issue: { id: 'i1', identifier: 'NEX-1', title: 'One', url: 'https://linear.app/a/issue/NEX-1', state: { id: 's', name: 'Todo', type: 'unstarted', color: '#ccc' }, team: { id: 't', key: 'NEX', name: 'Nexus' } } },
      { type: 'cycle', sortOrder: 0, customView: null },
    ], 'org-a');
    expect(favorites.map((favorite) => `${favorite.kind}:${favorite.id}`)).toEqual(['view:v1', 'issue:i1', 'project:p1']);
    expect(favorites.every((favorite) => favorite.workspaceId === 'org-a')).toBe(true);
  });
  test('favorites first in their sidebar order, then team, workspace and my views', () => {
    const order = favoriteOrder([
      { type: 'customView', sortOrder: 2, customView: { id: 'bugs' } },
      { type: 'project', sortOrder: 0, customView: null },
      { type: 'customView', sortOrder: 1, customView: { id: 'triage' } },
    ]);
    expect([...order]).toEqual([['bugs', 2], ['triage', 1]]);
    const views = [
      view('Ops board', { team: ops }),
      view('bugs', { team: nex, favoriteOrder: order.get('bugs') }),
      view('Mine', { shared: false }),
      view('Nexus sprint', { team: nex }),
      view('triage', { favoriteOrder: order.get('triage') }),
      view('Company', {}),
      view('Side', { workspaceId: 'org-b', shared: false }),
    ];
    const one = groupViews(views);
    expect(one.map((group) => `${group.label}: ${group.views.map((item) => item.name).join(', ')}`)).toEqual([
      'Favorites: triage, bugs',
      'NEX · Nexus: Nexus sprint',
      'OPS · Ops: Ops board',
      'Workspace views: Company',
      'My views: Mine',
      'My views: Side',
    ]);
    const names = new Map([['org-a', 'Antropy'], ['org-b', 'Side Org']]);
    expect(groupViews(views, names).map((group) => group.label)).toEqual(['Favorites', 'Antropy · NEX · Nexus', 'Antropy · OPS · Ops', 'Antropy · Workspace views', 'Antropy · My views', 'Side Org · My views']);
  });
  test('the Views section lists favorites in their own place when asked', () => {
    const views = [view('fav', { favoriteOrder: 1 }), view('other')];
    expect(groupViews(views, undefined, { favoritesFirst: false }).map((group) => `${group.label}: ${group.views.map((item) => item.name).join(', ')}`)).toEqual(['Workspace views: fav, other']);
  });
});

describe('the issue view', () => {
  test("estimates follow the team's scale", () => {
    expect(estimateChoices({ type: 'fibonacci', allowZero: false, extended: false }).map((item) => item.value)).toEqual([1, 2, 3, 5, 8]);
    expect(estimateChoices({ type: 'exponential', allowZero: true, extended: true }).map((item) => item.value)).toEqual([0, 1, 2, 4, 8, 16, 32, 64]);
    expect(estimateChoices({ type: 'tShirt', allowZero: false, extended: false }).map((item) => item.label)).toEqual(['XS', 'S', 'M', 'L', 'XL']);
    expect(estimateChoices({ type: 'notUsed', allowZero: false, extended: false })).toEqual([]);
    expect(estimateLabel(3)).toBe('3 points');
    expect(estimateLabel(5, { type: 'tShirt', allowZero: false, extended: false })).toBe('L');
    expect(estimateLabel(null)).toBe('No estimate');
  });
  test('activity reads like Linear', () => {
    const entry = (patch: Partial<LinearHistoryEntry>): LinearHistoryEntry => ({
      id: 'h', createdAt: '2026-10-25T10:00:00.000Z', actor: { id: 'u', name: 'Al' }, botActor: null, fromState: null, toState: null, fromAssignee: null, toAssignee: null,
      fromPriority: null, toPriority: null, fromTitle: null, toTitle: null, addedLabels: null, removedLabels: null, fromDueDate: null, toDueDate: null,
      fromProject: null, toProject: null, fromCycle: null, toCycle: null, fromEstimate: null, toEstimate: null, updatedDescription: null, ...patch,
    });
    expect(historyText(entry({ fromState: { name: 'Todo', color: '', type: 'unstarted' }, toState: { name: 'In Progress', color: '', type: 'started' } }))).toBe('changed status from Todo to In Progress');
    expect(historyText(entry({ toAssignee: { name: 'Bo' } }))).toBe('assigned Bo');
    expect(historyText(entry({ fromPriority: 3, toPriority: 1 }))).toBe('changed priority from Medium to Urgent');
    expect(historyText(entry({ addedLabels: [{ name: 'Bug', color: '' }] }))).toBe('added label Bug');
    expect(historyText(entry({ toDueDate: '2026-11-02' }))).toBe('set the due date to 2026-11-02');
    expect(historyText(entry({ updatedDescription: true }))).toBe('updated the description');
    expect(historyText(entry({}))).toBeNull();
  });
});
