import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import {
  ADD_COMMENT_MUTATION,
  ALL_DOCUMENTS,
  MUTATION_INPUT_KEYS,
  UPDATE_ISSUE_MUTATION,
  commentThreads,
  describeRule,
  favoriteOrder,
  filterIssues,
  filterOptions,
  groupViews,
  isIssueView,
  viewDisplay,
  type LinearSavedView,
  planTextSave,
  workflowOrder,
  groupIssues,
  groupProjects,
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
  sortIssues,
  stateOfType,
  taskFromIssue,
  type LinearIssue,
  type LinearProject,
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
  const state = (type: string, name = type) => ({ id: `st-${type}`, name, type, color: '#888888' });
  const make = (n: number, patch: Partial<LinearIssue>) => issue({ id: `i${n}`, identifier: `NEX-${n}`, updatedAt: `2026-10-${String(10 + n).padStart(2, '0')}T00:00:00.000Z`, ...patch });
  const issues = [
    make(1, { state: state('started'), priority: 0, project: { id: 'p2', name: 'Zeta' }, workspaceId: 'org-b', assignee: { id: 'u2', name: 'Bo' } }),
    make(2, { state: state('unstarted'), priority: 1, project: null, workspaceId: 'org-a', assignee: null }),
    make(10, { state: state('backlog'), priority: 3, project: { id: 'p1', name: 'Alpha' }, workspaceId: 'org-a', assignee: { id: 'u1', name: 'Al' } }),
    make(9, { state: state('started'), priority: 3, dueDate: '2026-10-26', project: { id: 'p1', name: 'Alpha' }, workspaceId: 'org-b', team: { id: 'team-2', key: 'OPS', name: 'Ops' } }),
  ];
  const keys = (groups: { key: string; issues: LinearIssue[] }[]) => groups.map((group) => `${group.key}:${group.issues.map((item) => item.identifier).join(',')}`);
  test('status groups: a list shows the non-empty ones, a board keeps its drop columns', () => {
    expect(keys(groupIssues(issues, 'status'))).toEqual(['started:NEX-1,NEX-9', 'unstarted:NEX-2', 'backlog:NEX-10']);
    const board = groupIssues(issues, 'status', { board: true });
    expect(board.map((group) => group.key)).toEqual(['backlog', 'unstarted', 'started', 'completed']);
    expect(board.find((group) => group.key === 'completed')).toMatchObject({ stateType: 'completed', issues: [] });
  });
  test('other groupings', () => {
    expect(keys(groupIssues(issues, 'priority'))).toEqual(['p1:NEX-2', 'p3:NEX-10,NEX-9', 'p0:NEX-1']);
    expect(keys(groupIssues(issues, 'project'))).toEqual(['p1:NEX-10,NEX-9', 'p2:NEX-1', ':NEX-2']);
    expect(keys(groupIssues(issues, 'assignee'))).toEqual(['u1:NEX-10', 'u2:NEX-1', ':NEX-2,NEX-9']);
    expect(groupIssues(issues, 'team').map((group) => group.label)).toEqual(['NEX · Nexus', 'OPS · Ops']);
    const names = new Map([['org-a', 'Antropy'], ['org-b', 'Side']]);
    expect(groupIssues(issues, 'workspace', { workspaceNames: names }).map((group) => `${group.label}:${group.issues.length}`)).toEqual(['Antropy:2', 'Side:2']);
    expect(keys(groupIssues(issues, 'none'))).toEqual(['all:NEX-1,NEX-2,NEX-10,NEX-9']);
    expect(groupIssues([], 'none')).toEqual([]);
  });
  test('orders', () => {
    const ids = (by: Parameters<typeof sortIssues>[1]) => sortIssues(issues, by).map((item) => item.identifier).join(',');
    // No priority sorts last; equal priorities put the most recently updated first.
    expect(ids('priority')).toBe('NEX-2,NEX-10,NEX-9,NEX-1');
    expect(ids('updated')).toBe('NEX-10,NEX-9,NEX-2,NEX-1');
    expect(ids('due')).toBe('NEX-9,NEX-2,NEX-10,NEX-1');
    expect(ids('identifier')).toBe('NEX-1,NEX-2,NEX-10,NEX-9');
  });
  test('projects by status, then priority and target date', () => {
    const project = (id: string, type: string, patch: Partial<LinearProject> = {}): LinearProject => ({
      id, name: id, url: `https://linear.app/a/project/${id}`, color: '#5e6ad2', icon: null, description: '', progress: 0.5, health: null, priority: 0,
      startDate: null, targetDate: null, updatedAt: '2026-10-01T00:00:00.000Z', status: { id: type, name: type, type, color: '#888888' }, lead: null, teams: { nodes: [] }, ...patch,
    });
    const groups = groupProjects([project('later', 'backlog'), project('b', 'started', { targetDate: '2026-12-01' }), project('a', 'started', { targetDate: '2026-11-01' }), project('urgent', 'started', { priority: 1 }), project('odd', 'mystery')]);
    expect(groups.map((group) => `${group.type}:${group.projects.map((item) => item.id).join(',')}`)).toEqual(['started:urgent,a,b', 'backlog:later', 'other:odd']);
  });
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
    expect(validateCommand({ cmd: 's3', type: 'settings.updated', patch: { linearGroupBy: 'cycle' } }, state)).toContain('linearGroupBy');
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
    expect(MUTATION_INPUT_KEYS.get(UPDATE_ISSUE_MUTATION)).toEqual(['title', 'description', 'stateId', 'priority', 'assigneeId', 'dueDate', 'addedLabelIds', 'removedLabelIds']);
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
  test('only views of issues are listed', () => {
    expect(isIssueView(view('a'))).toBe(true);
    expect(isIssueView(view('b', { modelName: 'Project' }))).toBe(false);
    expect(isIssueView(view('c', { modelName: 'initiative' }))).toBe(false);
    expect(isIssueView(view('d', { modelName: 'FeedItem' }))).toBe(false);
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
  test("a view's saved layout, grouping and ordering, where the Planner has them", () => {
    expect(viewDisplay({ layout: 'board', issueGrouping: 'workflowState', viewOrdering: 'priority' })).toEqual({ linearLayout: 'board', linearGroupBy: 'status', linearOrderBy: 'priority' });
    expect(viewDisplay({ layout: 'list', issueGrouping: 'noGrouping', viewOrdering: 'dueDate' })).toEqual({ linearLayout: 'list', linearGroupBy: 'none', linearOrderBy: 'due' });
    expect(viewDisplay({ layout: 'spreadsheet', issueGrouping: 'cycle', viewOrdering: 'manual' })).toEqual({});
    expect(viewDisplay(null)).toEqual({});
  });
});

describe('filters', () => {
  const today = '2026-10-24';
  const label = (name: string) => ({ id: `l-${name}`, name, color: '#123456' });
  const make = (n: number, patch: Partial<LinearIssue>) => issue({ id: `f${n}`, identifier: `NEX-${n}`, workspaceId: 'org-a', ...patch });
  const issues = [
    make(1, { state: { id: 's1', name: 'In Progress', type: 'started', color: '#f2c94c' }, priority: 1, assignee: { id: 'u1', name: 'Al' }, labels: { nodes: [label('Bug'), label('UI')] }, dueDate: '2026-10-20' }),
    make(2, { state: { id: 's2', name: 'Todo', type: 'unstarted', color: '#e2e2e2' }, priority: 0, assignee: null, labels: { nodes: [] }, dueDate: null, project: { id: 'p1', name: 'Alpha' } }),
    make(3, { state: { id: 's2', name: 'Todo', type: 'unstarted', color: '#e2e2e2' }, priority: 3, assignee: { id: 'u2', name: 'Bo' }, labels: { nodes: [label('UI')] }, dueDate: '2026-10-28', cycle: { id: 'c7', number: 7 } }),
    make(4, { state: { id: 's3', name: 'Backlog', type: 'backlog', color: '#bbbbbb' }, priority: 2, assignee: { id: 'u1', name: 'Al' }, dueDate: '2026-12-01', workspaceId: 'org-b' }),
  ];
  const context = { today, workspaceNames: new Map([['org-a', 'Antropy'], ['org-b', 'Side Org']]) };
  const ids = (list: LinearIssue[]) => list.map((item) => item.identifier);
  test('options come from the shown issues, with counts, in Linear-like order, "none" last', () => {
    expect(filterOptions(issues, 'status', context).map((option) => `${option.label}:${option.count}`)).toEqual(['Backlog:1', 'Todo:2', 'In Progress:1']);
    expect(filterOptions(issues, 'priority', context).map((option) => option.label)).toEqual(['Urgent', 'High', 'Medium', 'No priority']);
    expect(filterOptions(issues, 'label', context).map((option) => `${option.label}:${option.count}`)).toEqual(['Bug:1', 'UI:2', 'No labels:2']);
    expect(filterOptions(issues, 'assignee', context).map((option) => option.label)).toEqual(['Al', 'Bo', 'No assignee']);
    expect(filterOptions(issues, 'due', context).map((option) => option.label)).toEqual(['Overdue', 'Due within a week', 'Due later', 'No due date']);
    expect(filterOptions(issues, 'workspace', context).map((option) => `${option.label}:${option.count}`)).toEqual(['Antropy:3', 'Side Org:1']);
  });
  test('values of a rule are alternatives; rules all apply; "is not" excludes', () => {
    const todo = { field: 'status' as const, negate: false, values: [{ value: 'Todo', label: 'Todo' }] };
    expect(ids(filterIssues(issues, [todo], context))).toEqual(['NEX-2', 'NEX-3']);
    const ui = { field: 'label' as const, negate: false, values: [{ value: 'UI', label: 'UI' }] };
    expect(ids(filterIssues(issues, [todo, ui], context))).toEqual(['NEX-3']);
    const notAl = { field: 'assignee' as const, negate: true, values: [{ value: 'u1', label: 'Al' }] };
    expect(ids(filterIssues(issues, [notAl], context))).toEqual(['NEX-2', 'NEX-3']);
    const unlabeledOrBug = { field: 'label' as const, negate: false, values: [{ value: '', label: 'No labels' }, { value: 'Bug', label: 'Bug' }] };
    expect(ids(filterIssues(issues, [unlabeledOrBug], context))).toEqual(['NEX-1', 'NEX-2', 'NEX-4']);
    const overdue = { field: 'due' as const, negate: false, values: [{ value: 'overdue', label: 'Overdue' }] };
    expect(ids(filterIssues(issues, [overdue], context))).toEqual(['NEX-1']);
    expect(ids(filterIssues(issues, [{ field: 'cycle', negate: false, values: [] }], context))).toEqual(['NEX-1', 'NEX-2', 'NEX-3', 'NEX-4']);
  });
  test('a chip names the field, the sense and the values', () => {
    expect(describeRule({ field: 'status', negate: false, values: [{ value: 'Todo', label: 'Todo' }, { value: 'In Progress', label: 'In Progress' }] })).toBe('Status is Todo, In Progress');
    expect(describeRule({ field: 'assignee', negate: true, values: [{ value: '', label: 'No assignee' }] })).toBe('Assignee is not No assignee');
  });
});
