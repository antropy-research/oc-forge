// Linear in the Planner, end to end: the real service, Planner windows made of the panel's own stores, and a fake
// Linear that answers every document and evaluates filters as Linear does (tests/support/linear.ts). A scenario opens
// views, filters, edits, drops and plans as the Linear page and the side panels do, and checks what the window shows,
// what the plan holds and what Linear was asked. How the page looks and its keys are tests/e2e/linear.mjs's.
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { startPlanner, until, usePlanner, type LinearCall, type Planner, type PlannerWindow } from './support/planner.ts';
import { KEYS, bigLinear, calmZone, fakeKey, harnessLinear, unreachable } from './support/linear.ts';
import type { LinearSource, ListId } from '../panel/lib/linear/store.ts';
import { addParsedTask } from '../panel/lib/core/addTask.ts';
import { parseQuickAdd } from '../src/domain/plan/quickAdd.ts';
import { addDays, startOfWeek } from '../src/domain/core/dates.ts';
import { ADD_COMMENT_MUTATION, ALL_DOCUMENTS, ASSIGNED_QUERY, UPDATE_ISSUE_MUTATION, issueDetailMore, issueSource, type LinearIssue } from '../src/domain/linear/linear.ts';
import type { LinearFilterGroup, LinearFilterNode, LinearFilterRule } from '../src/domain/linear/filter.ts';
import type { EventBody } from '../src/domain/core/events.ts';
import { mergeItemCommands } from '../src/domain/plan/merge.ts';
import { newId } from '../src/domain/core/ids.ts';

const ZONE = calmZone();
const planners: Planner[] = [];
const track = (planner: Planner) => (planners.push(planner), planner);
const natural = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });
const keysOf = (items: { identifier: string }[]) => items.map((item) => item.identifier).sort(natural);
const rule = (field: LinearFilterRule['field'], op: LinearFilterRule['op'], ...values: (string | [string, string])[]): LinearFilterRule => ({ field, op, values: values.map((value) => (typeof value === 'string' ? { value, label: value } : { value: value[0], label: value[1] })) });
const group = (join: 'and' | 'or', ...items: LinearFilterNode[]): LinearFilterGroup => ({ join, items });
const view = (id: string): LinearSource => ({ kind: 'view', id, workspaceId: 'org-h' });
const calls = (planner: Planner, op: string, test: (call: LinearCall) => boolean = () => true) => planner.linearCalls.filter((call) => call.op === op && test(call));
const vars = (call: LinearCall | undefined) => call?.variables as Record<string, any> | undefined;

/** A Planner window as the panel opens one: its Linear store started, OpenChamber's workspace and its views read. */
const open = async (planner: Planner) => {
  const window = await planner.window();
  window.linear.start();
  await until(() => window.linear.getView().viewsLoaded && window.linear.getView().workspaces.length > 0);
  return window;
};
const settled = async (window: PlannerWindow, id: ListId = 'page') => {
  await until(() => !window.linear.list(id).loading && !window.linear.list(id).loadingMore);
  return window.linear.list(id);
};
const show = (window: PlannerWindow, source: LinearSource, id: ListId = 'page') => {
  window.linear.setSource(source, id);
  return settled(window, id);
};
/** Something that reads a list again (a filter, a display): the list once Linear has answered that read. */
const reread = async (planner: Planner, window: PlannerWindow, act: () => unknown, id: ListId = 'page') => {
  const asked = planner.linearCalls.length;
  await act();
  await until(() => planner.linearCalls.length > asked);
  return settled(window, id);
};
const taskOf = async (planner: Planner, key: string) => Object.values((await planner.state()).tasks).find((task) => task.source?.key === key && !task.deletedAt);

describe('saved views, pages and filters, as Linear lists them', () => {
  const fake = harnessLinear(ZONE);
  const planner = track(usePlanner({ zone: ZONE, linear: fake.world, linearAnswer: fake.linearAnswer }));
  const TODAY = fake.today;
  const sent = (id: string) => vars(calls(planner, 'PlannerViewIssues', (call) => call.variables.id === id).at(-1));

  test('a saved view opens as saved in Linear: its own filter applied by Linear, its display, and the completed issues it shows', async () => {
    const window = await open(planner);
    expect(keysOf((await show(window, view('v-done'))).issues)).toEqual(['HAR-5', 'HAR-6', 'OPS-4', 'OPS-5']);
    expect(sent('v-done')).toEqual({ id: 'v-done', after: null, filter: null });
    const openWork = await show(window, view('v-open'));
    expect([keysOf(openWork.issues), sent('v-open')?.filter]).toEqual([['HAR-1', 'HAR-2', 'HAR-3', 'HAR-4', 'HAR-7', 'HAR-8', 'HAR-9'], { state: { type: { nin: ['completed', 'canceled'] } } }]);
    expect(openWork.display).toMatchObject({ layout: 'list', groupBy: 'status', orderBy: 'priority', showCompleted: 'none' });
    // Completed issues of the past week: HAR-5 (done two days ago), not HAR-6 (canceled 40 days ago).
    expect(keysOf((await show(window, view('v-week'))).issues)).toEqual(['HAR-1', 'HAR-2', 'HAR-3', 'HAR-4', 'HAR-5', 'HAR-7', 'HAR-8', 'HAR-9']);
    // A view that never chose which completed issues to show lists all its filter holds.
    const plain = await show(window, view('v-plain'));
    expect([plain.display?.layout, sent('v-plain')?.filter, plain.issues.length]).toEqual(['board', null, 9]);
    // What the Planner cannot show the same way is named; the rest still applies.
    const odd = await show(window, view('v-odd'));
    expect(odd.unsupported).toEqual(['the spreadsheet layout', 'grouping by parent', 'ordering by linkCount', 'completed issues "fortnight"']);
    expect(keysOf(odd.issues)).toEqual(['OPS-1', 'OPS-2', 'OPS-3', 'OPS-4', 'OPS-5', 'OPS-6']);
  });

  test("a view's display changed here reads it again and leaves the Planner's own alone; My issues use the Planner's display, and the panel beside a day its own list", async () => {
    const window = await open(planner);
    expect((await show(window, view('v-board'))).display).toMatchObject({ layout: 'board', groupBy: 'assignee', subGroupBy: 'priority', orderBy: 'created' });
    expect(keysOf((await reread(planner, window, () => window.linear.setDisplay({ showSubIssues: false }))).issues)).not.toContain('HAR-8');
    expect(keysOf((await reread(planner, window, () => window.linear.setDisplay({ showTriage: false }))).issues)).not.toContain('OPS-1');
    expect(sent('v-board')?.filter).toEqual({ and: [{ parent: { null: true } }, { state: { type: { neq: 'triage' } } }] });
    expect((await planner.state()).settings.linearDisplay).toMatchObject({ showSubIssues: true, subGroupBy: 'none' });
    const mine = ['HAR-1', 'HAR-2', 'HAR-3', 'HAR-8', 'HAR-9', 'OPS-1', 'OPS-2', 'OPS-3'];
    expect(keysOf((await show(window, { kind: 'assigned' })).issues)).toEqual(mine);
    const withWeek = await reread(planner, window, () => window.linear.setDisplay({ showCompleted: 'week' }));
    expect([keysOf(withWeek.issues), (await planner.state()).settings.linearDisplay.showCompleted]).toEqual([[...mine, 'HAR-5', 'OPS-4'].sort(natural), 'week']);
    await reread(planner, window, () => window.linear.setDisplay({ showCompleted: 'none' }));
    // Beside a day (Sunsama's panel), My issues keep the issues completed in the past five days; the page keeps its list.
    const side = await reread(planner, window, () => window.linear.use('side'), 'side');
    expect([side.source, keysOf(side.issues), keysOf(window.linear.list('page').issues)]).toEqual([{ kind: 'assigned' }, [...mine, 'HAR-5', 'OPS-4'].sort(natural), mine]);
    expect(vars(calls(planner, 'PlannerAssigned').at(-1))?.filter).toEqual({ or: [{ state: { type: { nin: ['completed', 'canceled'] } } }, { completedAt: { gte: '-P5D' } }, { canceledAt: { gte: '-P5D' } }] });
  });

  test('a view of 320 issues shows three pages at once and the rest with Load more, following Linear’s cursors; a page without a cursor ends the read', async () => {
    const window = await open(planner);
    const first = await show(window, view('v-big'));
    expect([first.issues.length, first.more]).toEqual([300, { 'org-h': '300' }]);
    await window.linear.loadMore();
    const all = window.linear.list('page');
    expect([all.issues.length, new Set(all.issues.map((issue) => issue.id)).size, all.more]).toEqual([320, 320, {}]);
    expect(calls(planner, 'PlannerViewIssues', (call) => call.variables.id === 'v-big').map((call) => vars(call)!.after)).toEqual([null, '100', '200', '300']);
    // Linear says there is more but gives no cursor: the read stops instead of asking forever.
    fake.intercept((call) => (call.op === 'PlannerSearch' ? { searchIssues: { nodes: [fake.find('HAR-1')], pageInfo: { hasNextPage: true, endCursor: null } } } : undefined));
    const searched = await show(window, { kind: 'search', term: 'launch' });
    fake.intercept(null);
    expect([keysOf(searched.issues), searched.more, calls(planner, 'PlannerSearch').length]).toEqual([['HAR-1'], {}, 1]);
  });

  test('a list read again while its Load more is on the way, the new read failing: nothing is left loading, the old page never joins, the list goes on from its own cursor (round 12)', async () => {
    const window = await open(planner);
    expect((await show(window, view('v-big'))).issues.length).toBe(300);
    const held = fake.hold((call) => call.op === 'PlannerViewIssues' && call.variables.after === '300');
    const more = window.linear.loadMore();
    await until(() => held.reached);
    expect(window.linear.list('page').loadingMore).toBe(true);
    const at = fake.views.findIndex((item) => item.id === 'v-big');
    const [big] = fake.views.splice(at, 1);
    void window.linear.refresh();
    await until(() => window.linear.list('page').error);
    expect(window.linear.list('page')).toMatchObject({ loading: false, loadingMore: false, error: 'Linear no longer has this view', issues: [], more: {} });
    fake.views.splice(at, 0, big!);
    held.release();
    await more;
    expect(window.linear.list('page')).toMatchObject({ loading: false, loadingMore: false, issues: [], more: {} });
    void window.linear.refresh();
    await until(() => window.linear.list('page').issues.length === 300 && !window.linear.list('page').loading);
    await window.linear.loadMore();
    expect([window.linear.list('page').issues.length, window.linear.list('page').more, window.linear.list('page').loadingMore]).toEqual([320, {}, false]);
  });

  test('a view of projects lists its projects, completed ones too until its display hides them; a project opens with its own issues', async () => {
    const window = await open(planner);
    const portfolio = await show(window, view('v-proj'));
    expect([portfolio.projects?.map((project) => project.name), portfolio.projectDisplay]).toEqual([['Planner', 'Ops Revamp', 'Shipped Thing'], { groupBy: 'status', orderBy: 'priority', showCompleted: 'all' }]);
    expect([vars(calls(planner, 'PlannerViewProjects').at(-1)), sent('v-proj')]).toEqual([{ id: 'v-proj', after: null, filter: null }, undefined]);
    const shown = await reread(planner, window, () => window.linear.setProjectDisplay({ showCompleted: 'none' }));
    expect(shown.projects?.map((project) => project.name)).toEqual(['Planner', 'Ops Revamp']);
    await window.linear.openProject(shown.projects![0]!);
    expect(keysOf((await settled(window)).issues)).toEqual(['HAR-1', 'HAR-2']);
  });

  test('filtering like Linear: what the filter bar sends selects exactly the issues Linear would, and the window shows them', async () => {
    const window = await open(planner);
    await show(window, view('v-all'));
    const ALL = keysOf(fake.issues.filter((issue) => !issue.bulk) as LinearIssue[]);
    const allBut = (...keys: string[]) => ALL.filter((key) => !keys.includes(key));
    const urgent = rule('priority', 'is', ['1', 'Urgent']);
    const mine = rule('assignee', 'is', ['@me', 'Me']);
    const bug = rule('label', 'includesAny', 'Bug');
    const cases: [string, LinearFilterNode[], string[], ('and' | 'or')?][] = [
      ['Status is Todo, a name of one team', [rule('status', 'is', 'Todo')], ['HAR-1', 'HAR-7', 'HAR-8', 'HAR-9']],
      ['Status is neither Todo nor Done (both teams have a Done)', [rule('status', 'isNot', 'Todo', 'Done')], ['HAR-2', 'HAR-3', 'HAR-4', 'HAR-6', 'OPS-1', 'OPS-2', 'OPS-3', 'OPS-4', 'OPS-6']],
      ['Assignee is not Teammate keeps the unassigned', [rule('assignee', 'isNot', ['u-mate', 'Teammate'])], allBut('HAR-4')],
      ['Assignee is nobody', [rule('assignee', 'is', ['', 'No assignee'])], ['HAR-7']],
      ['Assignee is neither me nor nobody', [rule('assignee', 'isNot', ['@me', 'Me'], ['', 'No assignee'])], ['HAR-4', 'OPS-5', 'OPS-6']],
      ['Creator is me', [rule('creator', 'is', ['@me', 'Me'])], allBut('HAR-2')],
      ['Priority is Urgent', [urgent], ['HAR-2', 'OPS-1', 'OPS-6']],
      ['Priority is No priority', [rule('priority', 'is', ['0', 'No priority'])], ['HAR-7']],
      ['Labels include all of Bug and Feature', [rule('label', 'includesAll', 'Bug', 'Feature')], ['HAR-4']],
      ['Labels do not include Bug, issues without labels too', [rule('label', 'excludes', 'Bug')], allBut('HAR-1', 'HAR-4', 'OPS-2', 'OPS-6')],
      ['Cycle is the current one', [rule('cycle', 'is', ['@active', 'Current cycle'])], ['HAR-1']],
      ['Cycle is not the current one keeps those without a cycle', [rule('cycle', 'isNot', ['@active', 'Current cycle'])], allBut('HAR-1')],
      ['Overdue leaves out completed issues', [rule('due', 'is', ['overdue', 'Overdue'])], ['HAR-1']],
      ['Due today', [rule('due', 'is', ['today', 'Due today'])], ['HAR-2']],
      ['Due before today', [rule('due', 'before', TODAY)], ['HAR-1', 'HAR-5']],
      ['Due after the first day of next week', [rule('due', 'after', addDays(fake.mondayWeek, 7))], ['HAR-4']],
      ['No due date', [rule('due', 'is', ['none', 'No due date'])], allBut('HAR-1', 'HAR-2', 'HAR-4', 'HAR-5', 'OPS-6')],
      ['Project is Planner or none', [rule('project', 'is', ['p1', 'Planner'], ['', 'No project'])], allBut('OPS-3')],
      ['Team is not Harness', [rule('team', 'isNot', ['team-har', 'Harness'])], ['OPS-1', 'OPS-2', 'OPS-3', 'OPS-4', 'OPS-5', 'OPS-6']],
      ['(Urgent or mine) and labels include Bug', [group('or', urgent, mine), bug], ['HAR-1', 'OPS-2', 'OPS-6']],
      ['…matching any of them at the top', [group('or', urgent, mine), bug], allBut('HAR-7', 'OPS-5'), 'or'],
      ['Urgent, or mine and about login: a group in a group', [group('or', urgent, group('and', mine, rule('content', 'contains', 'login')))], ['HAR-2', 'HAR-3', 'OPS-1', 'OPS-6']],
      ['Content contains "login", in a title or a description', [rule('content', 'contains', 'login')], ['HAR-2', 'HAR-3']],
      ['Content does not contain "login", no description too', [rule('content', 'notContains', 'login')], allBut('HAR-2', 'HAR-3')],
      ['Subscribers include me', [rule('subscriber', 'includesAny', ['@me', 'Me'])], ['HAR-1', 'HAR-4']],
      ['Blocked by an issue', [rule('relation', 'includesAny', ['blocked', 'Blocked by'])], ['HAR-2']],
      ['A parent issue or sub-issues', [rule('relation', 'includesAny', ['parent', 'Parent issue'], ['children', 'Sub-issues'])], ['HAR-1', 'HAR-8']],
      ['Neither a parent nor sub-issues', [rule('relation', 'excludes', ['parent', 'Parent issue'], ['children', 'Sub-issues'])], allBut('HAR-1', 'HAR-8')],
      ['Created in the past week', [rule('created', 'after', ['-P1W', '1 week ago'])], ['HAR-8']],
      ['Completed in the past week', [rule('completed', 'after', ['-P1W', '1 week ago'])], ['HAR-5', 'OPS-4']],
      ['Estimate at least 3 points', [rule('estimate', 'atLeast', ['3', '3 points'])], ['HAR-1']],
      ['Estimate is not 3 points keeps those without one', [rule('estimate', 'isNot', ['3', '3 points'])], allBut('HAR-1')],
      ['Milestone is Planner beta', [rule('milestone', 'is', ['m1', 'Planner beta'])], ['HAR-1']],
    ];
    for (const [name, filters, expected, match] of cases) {
      const list = await reread(planner, window, () => window.linear.setFilters(filters, 'page', match ?? 'and'));
      expect([name, keysOf(list.issues)]).toEqual([name, expected]);
    }
    // A rule without values is dropped, and the same filters do not read Linear again.
    const asked = planner.linearCalls.length;
    window.linear.setFilters([rule('milestone', 'is', ['m1', 'Planner beta']), rule('label', 'includesAny')]);
    await Bun.sleep(50);
    expect(planner.linearCalls.length).toBe(asked);
    // "Next week" follows the week the plan starts on.
    for (const weekStartsOn of [1, 0] as const) {
      await window.client.dispatch([{ type: 'settings.updated', patch: { weekStartsOn } }]);
      await reread(planner, window, () => window.linear.setFilters([]));
      const from = addDays(startOfWeek(TODAY, weekStartsOn), 7);
      const to = addDays(from, 6);
      const list = await reread(planner, window, () => window.linear.setFilters([rule('due', 'is', ['nextWeek', 'Due next week'])]));
      expect([sent('v-all')?.filter, keysOf(list.issues)]).toEqual([{ dueDate: { gte: from, lte: to } }, ALL.filter((key) => { const due = fake.find(key)!.dueDate; return due && due >= from && due <= to; })]);
    }
  });

  test("a view saved with an “or” of filter groups: Linear applies it; changed here, the Planner asks for the view's team itself; Reset puts it back, Save writes it to the view", async () => {
    const window = await open(planner);
    const saved = await show(window, view('v-or'));
    // One group, read from Linear's ids and named as the chips name it.
    expect(saved.filters).toMatchObject([{ join: 'or', items: [{ field: 'priority' }, { join: 'and', items: [{ field: 'assignee' }, { field: 'label', values: [{ label: 'Bug' }] }] }] }]);
    expect([keysOf(saved.issues), sent('v-or')?.filter]).toEqual([['HAR-1', 'HAR-2'], null]);
    // A filter added while the view's own still hold: read through the view, with only the one added.
    const narrowed = await reread(planner, window, () => window.linear.setFilters([...saved.filters, rule('status', 'is', 'Todo')]));
    expect([keysOf(narrowed.issues), sent('v-or')?.filter]).toEqual([['HAR-1'], { state: { name: { in: ['Todo'] } } }]);
    // The view's own group changed (its "and" made an "or"): the Planner asks for the team's issues with all of it.
    const changed = structuredClone(saved.filters) as LinearFilterGroup[];
    (changed[0]!.items[1] as LinearFilterGroup).join = 'or';
    const wider = ['HAR-1', 'HAR-2', 'HAR-3', 'HAR-4', 'HAR-5', 'HAR-6', 'HAR-8', 'HAR-9'];
    expect(keysOf((await reread(planner, window, () => window.linear.setFilters(changed))).issues)).toEqual(wider);
    const changedFilter = { or: [{ priority: { in: [1] } }, { or: [{ assignee: { isMe: { eq: true } } }, { labels: { some: { name: { in: ['Bug'] } } } }] }] };
    expect(vars(calls(planner, 'PlannerIssues').at(-1))?.filter).toEqual({ and: [{ team: { id: { eq: 'team-har' } } }, changedFilter] });
    expect(keysOf((await reread(planner, window, () => window.linear.resetFilters())).issues)).toEqual(['HAR-1', 'HAR-2']);
    // A filter on today's date cannot be saved (it would stay that date in Linear); the changed group can.
    await reread(planner, window, () => window.linear.setFilters([...changed, rule('due', 'is', ['today', 'Due today'])]));
    expect(window.linear.canSaveFilters()).toBe(false);
    await reread(planner, window, () => window.linear.setFilters(changed));
    expect(window.linear.canSaveFilters()).toBe(true);
    await window.linear.saveFilters();
    const now = await settled(window);
    expect(vars(calls(planner, 'PlannerSaveViewFilter').at(-1))).toEqual({ id: 'v-or', filterData: changedFilter });
    // The view now reads as saved: its own filters, applied by Linear, nothing to reset.
    expect([JSON.stringify(now.filters) === JSON.stringify(now.viewFilters), sent('v-or')?.filter, keysOf(now.issues)]).toEqual([true, null, wider]);
  });

  test("a part of a saved view's filter the Planner cannot edit shows in words and goes to Linear unchanged, also once the parts it can edit are changed and saved", async () => {
    const window = await open(planner);
    const saved = await show(window, view('v-raw'));
    const notStarted = { state: { type: { nin: ['started'] } } };
    expect(saved.filters).toMatchObject([{ raw: notStarted, label: 'Status type is not started' }, { field: 'label', op: 'includesAny', values: [{ label: 'Bug' }] }]);
    expect([keysOf(saved.issues), sent('v-raw')?.filter]).toEqual([['HAR-1'], null]);
    // Labels made "Bug or Feature": the Planner asks for the team's issues itself, the status type part as it was saved.
    const [kept, labels] = saved.filters as [LinearFilterNode, LinearFilterRule];
    const edited = [kept, { ...labels, values: [...labels.values, { value: 'Feature', label: 'Feature' }] }];
    const either = await reread(planner, window, () => window.linear.setFilters(edited));
    const changed = { and: [notStarted, { labels: { some: { name: { in: ['Bug', 'Feature'] } } } }] };
    expect([vars(calls(planner, 'PlannerIssues').at(-1))?.filter, keysOf(either.issues)]).toEqual([{ and: [{ team: { id: { eq: 'team-har' } } }, changed] }, ['HAR-1', 'HAR-7']]);
    // Saved to the view, it keeps the part too, and reads back with it in words.
    await window.linear.saveFilters();
    const now = await settled(window);
    expect(vars(calls(planner, 'PlannerSaveViewFilter').at(-1))).toEqual({ id: 'v-raw', filterData: changed });
    expect([now.filters[0], sent('v-raw')?.filter, keysOf(now.issues)]).toEqual([{ raw: notStarted, label: 'Status type is not started' }, null, ['HAR-1', 'HAR-7']]);
  });
});

describe('changing issues in Linear: the issue view, the board, and Sunsama’s prompts', () => {
  const fake = harnessLinear(ZONE);
  const planner = track(usePlanner({ zone: ZONE, linear: fake.world, linearAnswer: fake.linearAnswer }));
  const TODAY = fake.today;
  const issuesOf = async (window: PlannerWindow) => {
    const list = await show(window, view('v-all'));
    return (key: string) => list.issues.find((issue) => issue.identifier === key)!;
  };
  const since = () => {
    const from = planner.linearCalls.length;
    return (op: string) => planner.linearCalls.slice(from).filter((call) => call.op === op).map((call) => vars(call)!);
  };

  test("the issue view's changes reach Linear one field at a time; a teammate's change to another field stays, the same field changed on both sides is asked about; lists and the task follow", async () => {
    const window = await open(planner);
    const issue = await issuesOf(window);
    await window.linear.plan(issue('HAR-3'), { kind: 'day', date: TODAY });
    const ref = { id: issue('HAR-3').id, workspaceId: 'org-h' };
    const asked = since();
    const inputs = () => asked('PlannerUpdateIssue').map((variables) => variables.input);
    // Filtered to Backlog, the list lets HAR-3 go once it is In Progress, without reading Linear again.
    expect(keysOf((await reread(planner, window, () => window.linear.setFilters([rule('status', 'is', 'Backlog')]))).issues)).toEqual(['HAR-3']);
    const reads = asked('PlannerViewIssues').length;
    await window.linear.updateIssue(ref, { stateId: 'st-h-prog' });
    expect([window.linear.list('page').issues, asked('PlannerViewIssues').length, fake.find('HAR-3')!.state.name, (await taskOf(planner, 'HAR-3'))?.source?.status?.name]).toEqual([[], reads, 'In Progress', 'In Progress']);
    const due = addDays(TODAY, 1);
    const changes = [{ priority: 1 }, { assigneeId: 'u-mate' }, { addedLabelIds: ['lbl-feat'] }, { removedLabelIds: ['lbl-feat'] }, { dueDate: due }, { estimate: 2 }, { projectId: 'p1' }, { cycleId: 'c7' }];
    for (const input of changes) await window.linear.updateIssue(ref, input);
    expect(inputs()).toEqual([{ stateId: 'st-h-prog' }, ...changes]);
    expect(fake.find('HAR-3')).toMatchObject({ priority: 1, assignee: { id: 'u-mate' }, labels: { nodes: [] }, dueDate: due, estimate: 2, project: { id: 'p1' }, cycle: { id: 'c7' } });
    // Title and description: only what I changed is sent; a teammate's description meanwhile is kept.
    const detail = await window.linear.issueDetail(ref);
    const base = { title: detail.title, description: detail.description ?? '' };
    fake.find('HAR-3')!.description = 'Rewritten by a teammate';
    expect('saved' in (await window.linear.saveIssueText(ref, base, { ...base, title: 'harness write the docs' }))).toBe(true);
    expect([inputs().at(-1), fake.find('HAR-3')!.description, (await taskOf(planner, 'HAR-3'))?.title]).toEqual([{ title: 'harness write the docs' }, 'Rewritten by a teammate', 'harness write the docs']);
    const sent = inputs().length;
    const clash = await window.linear.saveIssueText(ref, base, { ...base, description: 'Mine' });
    expect(['conflict' in clash ? clash.conflict.description : null, inputs().length]).toEqual(['Rewritten by a teammate', sent]);
    await window.linear.saveIssueText(ref, base, { ...base, description: 'Mine' }, true);
    // Both sides with the same change: nothing to send, nothing lost.
    await window.linear.saveIssueText(ref, base, { ...base, description: 'Mine' });
    expect([inputs().slice(sent), fake.find('HAR-3')!.title]).toEqual([[{ description: 'Mine' }], 'harness write the docs']);
    const comment = await window.linear.addComment(ref, '**LGTM**');
    expect([comment.body, asked('PlannerAddComment'), fake.find('HAR-3')!.comments.nodes.at(-1).body]).toEqual(['**LGTM**', [{ input: { issueId: ref.id, body: '**LGTM**' } }], '**LGTM**']);
  });

  test('a task becomes a Linear issue of the team picked, assigned to me, and links to it', async () => {
    const window = await open(planner);
    await window.client.dispatch([{ type: 'task.created', task: { id: 'release-notes', title: 'Write the release notes', placement: { kind: 'day', date: TODAY }, position: 1, priority: 'high', notes: 'For 2.6', dueDate: addDays(TODAY, 2) } } as EventBody]);
    const team = (await window.linear.teams()).find((item) => item.key === 'HAR')!;
    await window.linear.createIssue(window.client.getView().state.tasks['release-notes']!, team);
    expect(vars(calls(planner, 'PlannerCreateIssue').at(-1))?.input).toEqual({ teamId: 'team-har', title: 'Write the release notes', assigneeId: 'u-h', priority: 2, description: 'For 2.6', dueDate: addDays(TODAY, 2) });
    const link = (await planner.state()).tasks['release-notes']!.source!;
    expect([link.kind, link.workspaceId, /^HAR-\d+$/.test(link.key), window.client.getView().error]).toEqual(['linear', 'org-h', true, `Created ${link.key} in Linear`]);
  });

  test("a card dropped on a board column takes exactly that state of its own team; on other groupings, that property; what the team lacks is refused, not guessed", async () => {
    const window = await open(planner);
    await show(window, view('v-board'));
    const card = (key: string) => window.linear.list('page').issues.find((issue) => issue.identifier === key)!;
    const asked = since();
    const moves = () => asked('PlannerSetState').map((variables) => `${variables.id}→${variables.stateId}`);
    // OPS's board has Shipped before Done: "Done" is its Done, not its first completed state.
    expect(await window.linear.moveToGroup(card('OPS-3'), { kind: 'state', name: 'Done', type: 'completed' })).toBe(true);
    expect(await window.linear.moveToGroup(card('HAR-8'), { kind: 'state', name: 'In Review', type: 'started' })).toBe(true);
    expect([moves(), card('OPS-3').state.name, window.client.getView().error]).toEqual([['iss-ops-3→st-o-done', 'iss-har-8→st-h-review'], 'Done', 'HAR-8 is now In Review in Linear']);
    expect(await window.linear.moveToGroup(card('OPS-6'), { kind: 'state', name: 'In Review', type: 'started' })).toBe(false);
    expect(window.client.getView().error).toBe("Couldn't move OPS-6 in Linear: OPS has no In Review status");
    expect(await window.linear.moveToGroup(card('OPS-6'), { kind: 'state', name: 'Ready', type: 'unstarted' })).toBe(false);
    expect(moves().length).toBe(2);
    for (const [key, target] of [['HAR-7', { kind: 'priority', priority: 1 }], ['HAR-7', { kind: 'assignee', id: 'u-mate' }], ['OPS-3', { kind: 'project', id: null }], ['HAR-7', { kind: 'cycle', id: 'c8', teamId: 'team-har' }]] as const) {
      expect(await window.linear.moveToGroup(card(key), target)).toBe(true);
    }
    expect(await window.linear.moveToGroup(card('HAR-7'), { kind: 'cycle', id: 'c-ops', teamId: 'team-ops' })).toBe(false);
    expect(window.client.getView().error).toContain('another team');
    expect(await window.linear.moveToGroup(card('HAR-7'), { kind: 'priority', priority: 1 })).toBe(false);
    expect(asked('PlannerUpdateIssue').map((variables) => variables.input)).toEqual([{ priority: 1 }, { assigneeId: 'u-mate' }, { projectId: null }, { cycleId: 'c8' }]);
    expect([fake.find('HAR-7'), fake.find('OPS-3')!.project]).toMatchObject([{ priority: 1, assignee: { id: 'u-mate' }, cycle: { id: 'c8' } }, null]);
  });

  test("importing an issue asks to update its status in Linear when that automation is on, and moves it to the state picked; completing asks again and moves it to its team's first completed state (round 12)", async () => {
    const window = await open(planner);
    const issue = await issuesOf(window);
    const asked = since();
    await window.linear.plan(issue('OPS-5'), { kind: 'day', date: TODAY });
    expect(window.linear.getView().prompt).toBeNull();
    await window.client.dispatch([{ type: 'settings.updated', patch: { linearImportPrompt: true } }]);
    await window.linear.plan(issue('OPS-2'), { kind: 'day', date: TODAY });
    const task = (await taskOf(planner, 'OPS-2'))!;
    const prompt = window.linear.getView().prompt!;
    expect(prompt).toEqual({ kind: 'import', taskId: task.id, key: 'OPS-2' });
    expect((await window.linear.statesForSource(window.linear.promptSource(prompt))).map((state) => state.name)).toEqual(['Triage', 'Backlog', 'Ready', 'Doing', 'Shipped', 'Done', "Won't do"]);
    window.linear.answerPrompt('yes', 'st-o-doing');
    await until(async () => (await taskOf(planner, 'OPS-2'))?.source?.status?.name === 'Doing');
    await window.client.dispatch([{ type: 'task.completed', taskId: task.id, on: TODAY }]);
    expect(window.linear.getView().prompt).toEqual({ kind: 'complete', taskId: task.id, key: 'OPS-2' });
    window.linear.answerPrompt('yes');
    await until(() => asked('PlannerSetState').length === 2);
    expect([asked('PlannerSetState'), fake.find('OPS-2')!.state.name]).toEqual([[{ id: 'iss-ops-2', stateId: 'st-o-doing' }, { id: 'iss-ops-2', stateId: 'st-o-shipped' }], 'Shipped']);
  });

  test('issues merged into a task are completed with it, as checking each off would: not one checked off already, nor one closed; asked about, once for all; reopening it asks nothing (round 12)', async () => {
    const window = await open(planner);
    const issue = await issuesOf(window);
    await window.client.dispatch([{ type: 'settings.updated', patch: { linearImportPrompt: false, linearOnComplete: 'complete' } }]);
    const merged = (taskId: string, ...keys: string[]): EventBody[] => [
      { type: 'task.created', task: { id: taskId, title: taskId, placement: { kind: 'day', date: TODAY }, position: 5 } } as EventBody,
      ...keys.map((key) => ({ type: 'subtask.added', taskId, subtask: { id: `${taskId}-${key}`, title: key, done: false, source: issueSource(issue(key)) } }) as EventBody),
    ];
    const tick = (taskId: string, key: string): EventBody => ({ type: 'subtask.updated', taskId, subtaskId: `${taskId}-${key}`, patch: { done: true }, seen: { done: false } } as EventBody);
    const asked = since();
    const moved = () => asked('PlannerSetState').map((variables) => `${variables.id}→${variables.stateId}`);
    await window.client.dispatch(merged('triage', 'HAR-2', 'HAR-9', 'HAR-4', 'OPS-4'));
    await window.client.dispatch([tick('triage', 'HAR-4')]);
    await until(() => moved().length === 1);
    await window.client.dispatch([{ type: 'task.completed', taskId: 'triage', on: TODAY }]);
    await until(() => moved().length === 3);
    await window.client.dispatch([{ type: 'task.reopened', taskId: 'triage' }]);
    await Bun.sleep(100);
    // HAR-4 when checked off on its own; then HAR-2 and HAR-9 with the task, not HAR-4 again nor OPS-4 (shipped).
    expect([moved()[0], moved().slice(1).sort()]).toEqual(['iss-har-4→st-h-done', ['iss-har-2→st-h-done', 'iss-har-9→st-h-done']]);
    // Asked: one checked off on its own asks about it; completing the task asks once about the rest, each then going
    // to its own team's first completed state; reopening asks nothing.
    await window.client.dispatch([{ type: 'settings.updated', patch: { linearOnComplete: 'ask' } }, ...merged('review', 'HAR-1', 'OPS-1', 'OPS-6')]);
    await window.client.dispatch([tick('review', 'OPS-6')]);
    expect(window.linear.getView().prompt).toEqual({ kind: 'complete', taskId: 'review', key: 'OPS-6', subtaskId: 'review-OPS-6' });
    window.linear.answerPrompt('yes');
    await until(() => moved().length === 4);
    await window.client.dispatch([{ type: 'task.completed', taskId: 'review', on: TODAY }]);
    const many = window.linear.getView().prompt!;
    expect([many, window.linear.promptSource(many)]).toEqual([{ kind: 'complete', taskId: 'review', key: 'HAR-1 and 1 more', many: { own: false, subtaskIds: ['review-HAR-1', 'review-OPS-1'] } }, null]);
    window.linear.answerPrompt('yes');
    await until(() => moved().length === 6);
    await window.client.dispatch([{ type: 'task.reopened', taskId: 'review' }]);
    await Bun.sleep(100);
    expect([moved().slice(3, 4), moved().slice(4).sort(), window.linear.getView().prompt]).toEqual([['iss-ops-6→st-o-shipped'], ['iss-har-1→st-h-done', 'iss-ops-1→st-o-shipped'], null]);
  });

  test('a pasted issue whose status was picked in the add field moves there as it is added, and is not asked about again', async () => {
    const window = await open(planner);
    await window.client.dispatch([{ type: 'settings.updated', patch: { linearImportPrompt: true } }]);
    const asked = since();
    const sources = { client: window.client, linear: window.linear, github: window.github, google: window.google };
    await addParsedTask(sources, parseQuickAdd('https://linear.app/harness/issue/HAR-6/x', TODAY), { kind: 'day', date: TODAY }, 'bottom', TODAY, null, { linearStateId: 'st-h-todo' });
    expect([(await taskOf(planner, 'HAR-6'))?.title, asked('PlannerSetState'), window.linear.getView().prompt]).toEqual(['harness dropped idea', [{ id: 'iss-har-6', stateId: 'st-h-todo' }], null]);
  });
});

describe('issues planned as tasks keep in step with Linear', () => {
  const fake = harnessLinear(ZONE);
  const planner = track(usePlanner({ zone: ZONE, linear: fake.world, linearAnswer: fake.linearAnswer }));
  const TODAY = fake.today;
  const state = (team: 'team-har', name: string) => fake.states[team]!.find((item) => item.name === name)!;

  test('planning an issue makes one task of it, with its title, priority, due date and link; planned again, that task moves', async () => {
    const window = await open(planner);
    const list = await show(window, view('v-all'));
    const issue = (key: string) => list.issues.find((item) => item.identifier === key)!;
    await window.linear.plan(issue('HAR-1'), { kind: 'day', date: TODAY });
    const launch = (await taskOf(planner, 'HAR-1'))!;
    expect(launch).toMatchObject({ title: 'harness plan the launch', priority: 'high', dueDate: addDays(TODAY, -2), placement: { kind: 'day', date: TODAY } });
    expect(launch.source).toEqual({ kind: 'linear', id: 'iss-har-1', key: 'HAR-1', url: 'https://linear.app/harness/issue/HAR-1/x', title: 'harness plan the launch', teamId: 'team-har', workspaceId: 'org-h', branch: 'harness/har-1', status: { name: 'Todo', type: 'unstarted', color: '#888888' } });
    await window.linear.plan(issue('HAR-1'), { kind: 'day', date: addDays(TODAY, 1) });
    const tasks = Object.values((await planner.state()).tasks).filter((task) => task.source?.key === 'HAR-1');
    expect(tasks.map((task) => [task.id, task.placement])).toEqual([[launch.id, { kind: 'day', date: addDays(TODAY, 1) }]]);
    await window.linear.plan(issue('HAR-7'), { kind: 'backlog', bucket: 'someday' });
    expect(await taskOf(planner, 'HAR-7')).toMatchObject({ title: 'harness unassigned task', priority: null, dueDate: null });
  });

  test("Linear's changes reach the tasks on the next refresh: status, and the title unless the task was renamed; completion only when that setting is on; completed tasks are no longer read", async () => {
    const window = await open(planner);
    Object.assign(fake.find('HAR-1')!, { title: 'harness plan the big launch', state: state('team-har', 'In Progress') });
    Object.assign(fake.find('HAR-7')!, { title: 'harness renamed in Linear', state: state('team-har', 'In Review') });
    await window.client.dispatch([{ type: 'task.updated', taskId: (await taskOf(planner, 'HAR-7'))!.id, patch: { title: 'My own name' } }]);
    await window.linear.refresh();
    expect([(await taskOf(planner, 'HAR-1'))?.title, (await taskOf(planner, 'HAR-1'))?.source?.status?.name, (await taskOf(planner, 'HAR-7'))?.title, (await taskOf(planner, 'HAR-7'))?.source?.status?.name]).toEqual(['harness plan the big launch', 'In Progress', 'My own name', 'In Review']);
    // Nothing changed in Linear: nothing is written.
    const version = (await planner.state()).version;
    await window.linear.refresh();
    expect((await planner.state()).version).toBe(version);
    Object.assign(fake.find('HAR-1')!, { state: state('team-har', 'Done'), completedAt: new Date().toISOString() });
    await window.linear.refresh();
    expect([(await taskOf(planner, 'HAR-1'))?.completedAt ?? null, (await taskOf(planner, 'HAR-1'))?.source?.status?.name]).toEqual([null, 'Done']);
    await window.client.dispatch([{ type: 'settings.updated', patch: { linearImportCompletion: true } }]);
    await window.linear.refresh();
    expect((await taskOf(planner, 'HAR-1'))?.completedAt).toBeTruthy();
    const read = calls(planner, 'PlannerLinked').length;
    await window.linear.refresh();
    expect(calls(planner, 'PlannerLinked').slice(read).flatMap((call) => vars(call)!.ids)).toEqual(['iss-har-7']);
  });

  test('links made before workspaces gain their workspace and branch on the next refresh, then stay quiet; an issue Linear syncs with GitHub is planned once; a link that would run a script is refused', async () => {
    const window = await open(planner);
    const old = { kind: 'linear', id: 'iss-har-8', key: 'HAR-8', url: 'https://linear.app/harness/issue/HAR-8/x', title: 'harness sub task' };
    await window.client.dispatch([{ type: 'task.created', task: { id: 'old-link', title: 'harness sub task', placement: { kind: 'backlog', bucket: 'someday' }, position: 1, source: old } } as EventBody]);
    await window.linear.refresh();
    expect((await planner.state()).tasks['old-link']!.source).toMatchObject({ workspaceId: 'org-h', branch: 'harness/har-8', status: { name: 'Todo' } });
    const version = (await planner.state()).version;
    await window.linear.refresh();
    expect((await planner.state()).version).toBe(version);
    // HAR-9 is synced with GitHub's acme/app#12, planned from GitHub already: planning HAR-9 moves that task.
    await window.client.dispatch([{ type: 'task.created', task: { id: 'from-github', title: 'Crash', placement: { kind: 'backlog', bucket: 'someday' }, position: 2, source: { kind: 'github', id: 'I_12', key: 'acme/app#12', url: 'https://github.com/acme/app/issues/12' } } } as EventBody]);
    const synced = (await show(window, view('v-all'))).issues.find((issue) => issue.identifier === 'HAR-9')!;
    await window.linear.plan(synced, { kind: 'day', date: TODAY });
    expect([(await planner.state()).tasks['from-github']!.placement, await taskOf(planner, 'HAR-9')]).toEqual([{ kind: 'day', date: TODAY }, undefined]);
    // Planned from Linear, the link carries the GitHub key, so GitHub's side finds the same task.
    await window.client.dispatch([{ type: 'task.deleted', taskId: 'from-github' }]);
    await window.linear.plan(synced, { kind: 'day', date: TODAY });
    expect((await taskOf(planner, 'HAR-9'))?.source?.mirrors).toEqual(['acme/app#12']);
    const refused = await planner.call('POST', '/commands', { commands: [{ cmd: 'evil-link', type: 'task.updated', taskId: 'old-link', patch: { source: { ...old, url: 'javascript:alert(1)' } } }] });
    expect([refused.status, JSON.stringify(refused.body)]).toEqual([400, expect.stringContaining('source is invalid')]);
  });

  test('issues merged into a task follow Linear on the next refresh: a subtask takes the new title unless renamed by hand, the status, and is checked off once Linear closes it, never unchecked; nothing else changes', async () => {
    const window = await open(planner);
    const list = await show(window, view('v-all'));
    await window.client.dispatch([{ type: 'task.created', task: { id: 'triage', title: 'Triage', placement: { kind: 'day', date: TODAY }, position: 9 } } as EventBody]);
    // Alt/Option + drop from the panel (TaskCard's merge): the issue as its row drags it, merged straight in.
    for (const key of ['HAR-2', 'HAR-3', 'OPS-2']) {
      const issue = JSON.parse(JSON.stringify(list.issues.find((item) => item.identifier === key))) as LinearIssue;
      const merge = mergeItemCommands(window.client.getView().state, 'triage', { title: issue.title, source: issueSource(issue) }, () => newId());
      await window.client.dispatch(merge as EventBody[], { undo: 'Merged into "Triage"' });
    }
    const subtask = async (key: string) => (await planner.state()).tasks['triage']!.subtasks.find((item) => item.source?.key === key)!;
    const docs = await subtask('HAR-3');
    await window.client.dispatch([{ type: 'subtask.updated', taskId: 'triage', subtaskId: docs.id, patch: { title: 'Write the docs, my way' }, seen: { title: docs.title } }]);
    await window.linear.refresh();
    const before = await planner.state();
    const asked = planner.linearCalls.length;
    Object.assign(fake.find('HAR-2')!, { title: 'harness fix the login', state: state('team-har', 'Done'), completedAt: new Date().toISOString() });
    Object.assign(fake.find('HAR-3')!, { title: 'harness write the docs', state: state('team-har', 'In Progress') });
    await window.linear.refresh();
    const after = await planner.state();
    expect(await subtask('HAR-2')).toMatchObject({ title: 'harness fix the login', done: true, source: { title: 'harness fix the login', status: { name: 'Done', type: 'completed' } } });
    expect(await subtask('HAR-3')).toMatchObject({ title: 'Write the docs, my way', done: false, source: { title: 'harness write the docs', status: { name: 'In Progress', type: 'started' } } });
    // Nothing else: OPS-2's subtask, the task itself, the other tasks; Linear is only read, never written to.
    const rest = (plan: typeof before) => ({ tasks: Object.values(plan.tasks).filter((task) => task.id !== 'triage'), triage: { ...plan.tasks['triage']!, subtasks: plan.tasks['triage']!.subtasks.filter((item) => item.source?.key === 'OPS-2'), updatedAt: null } });
    expect(rest(after)).toEqual(rest(before));
    expect(planner.linearCalls.slice(asked).filter((call) => call.query.trimStart().startsWith('mutation'))).toEqual([]);
    // Checked off, a merged issue is no longer read (as a completed task's is not): reopened in Linear, its subtask stays
    // as it is, and nothing is written; the open ones are still read.
    Object.assign(fake.find('HAR-2')!, { state: state('team-har', 'Todo'), completedAt: null });
    const read = planner.linearCalls.length;
    await window.linear.refresh();
    const ids = planner.linearCalls.slice(read).filter((call) => call.op === 'PlannerLinked').flatMap((call) => vars(call)!.ids as string[]);
    expect([['iss-har-2', 'iss-har-3', 'iss-ops-2'].map((id) => ids.includes(id)), (await planner.state()).version]).toEqual([[false, true, true], after.version]);
    expect(await subtask('HAR-2')).toEqual(after.tasks['triage']!.subtasks.find((item) => item.source?.key === 'HAR-2')!);
  });
});

describe('a second Linear workspace, added with an API key', () => {
  const fake = harnessLinear(ZONE);
  const planner = track(usePlanner({ zone: ZONE, linear: fake.world, linearAnswer: fake.linearAnswer }));
  const TODAY = fake.today;
  const file = () => join(planner.home, 'linear-workspaces.json');
  const listed = async () => ((await planner.call('GET', '/linear/workspaces')).body.workspaces as { id: string }[]).map((item) => item.id);

  test('a key is checked with Linear and kept on this machine only: never in an answer, a window or the log, in a file only the user can read', async () => {
    const window = await open(planner);
    const added = await window.linear.addWorkspace(`  ${KEYS.side}\n`);
    expect(added).toMatchObject({ id: 'org-side', name: 'Side Org', urlKey: 'side', account: 'Side Me', via: 'key' });
    expect(planner.linearCalls.find((call) => call.key !== null)).toMatchObject({ op: 'PlannerWhoAmI', key: KEYS.side });
    expect([await listed(), statSync(file()).mode & 0o777, readFileSync(file(), 'utf8').includes(KEYS.side)]).toEqual([['org-side'], 0o600, true]);
    await until(() => window.linear.getView().workspaces.length === 2);
    const seen = JSON.stringify([added, (await planner.call('GET', '/linear/workspaces')).body, (await planner.call('GET', '/state')).body, window.linear.getView(), planner.log]);
    expect(seen.includes(KEYS.side)).toBe(false);
    await planner.restart();
    expect(await listed()).toEqual(['org-side']);
  });

  test("both workspaces' issues in one list, each marked with its own; one workspace on its own; a workspace filter asks only that one", async () => {
    const window = await open(planner);
    await until(() => window.linear.getView().workspaces.length === 2);
    const mine = await show(window, { kind: 'assigned' });
    expect([mine.issues.filter((issue) => issue.workspaceId === 'org-side').map((issue) => issue.identifier), mine.issues.find((issue) => issue.identifier === 'HAR-1')?.workspaceId]).toEqual([['SIDE-1', 'SIDE-2'], 'org-h']);
    window.linear.setScope('org-side');
    expect(keysOf((await settled(window)).issues)).toEqual(['SIDE-1', 'SIDE-2']);
    window.linear.setScope('all');
    await settled(window);
    const throughConnection = () => calls(planner, 'PlannerAssigned', (call) => call.key === null).length;
    const before = throughConnection();
    const sideOnly = await reread(planner, window, () => window.linear.setFilters([rule('workspace', 'is', ['org-side', 'Side Org'])]));
    expect([keysOf(sideOnly.issues), throughConnection()]).toEqual([['SIDE-1', 'SIDE-2'], before]);
  });

  test('a pasted issue URL is looked up in the workspace it names and nowhere else; the task reads it back there', async () => {
    const window = await open(planner);
    await until(() => window.linear.getView().workspaces.length === 2);
    const sources = { client: window.client, linear: window.linear, github: window.github, google: window.google };
    const add = (url: string) => addParsedTask(sources, parseQuickAdd(url, TODAY), { kind: 'day', date: TODAY }, 'bottom', TODAY);
    const from = planner.linearCalls.length;
    await add('https://linear.app/side/issue/side-2/x');
    expect(planner.linearCalls.slice(from).filter((call) => call.op === 'PlannerIssue').map((call) => [call.key, vars(call)!.id])).toEqual([[KEYS.side, 'SIDE-2']]);
    expect((await taskOf(planner, 'SIDE-2'))?.source).toMatchObject({ workspaceId: 'org-side', url: 'https://linear.app/side/issue/SIDE-2/x' });
    await add('https://linear.app/harness/issue/SIDE-1/x');
    expect([window.client.getView().error, await taskOf(planner, 'SIDE-1')]).toEqual(['SIDE-1 was not found in your connected Linear workspaces; added the link as a task', undefined]);
    const read = planner.linearCalls.length;
    await window.linear.refresh();
    expect(planner.linearCalls.slice(read).filter((call) => call.op === 'PlannerLinked').map((call) => [call.key, vars(call)!.ids])).toEqual([[KEYS.side, ['side-2']]]);
  });

  test('a second key for a workspace replaces the first; OAuth tokens go as bearer tokens; a key for the workspace OpenChamber connects is not kept', async () => {
    const window = await open(planner);
    await window.linear.addWorkspace(KEYS.side2);
    expect([await listed(), readFileSync(file(), 'utf8').includes(KEYS.side2), readFileSync(file(), 'utf8').includes(KEYS.side)]).toEqual([['org-side'], true, false]);
    const from = planner.linearCalls.length;
    await window.linear.refresh();
    expect(new Set(planner.linearCalls.slice(from).filter((call) => call.key !== null).map((call) => call.key))).toEqual(new Set([KEYS.side2]));
    await window.linear.addWorkspace(KEYS.third);
    expect(planner.linearCalls.filter((call) => call.key?.endsWith(KEYS.third)).map((call) => call.key)[0]).toBe(`Bearer ${KEYS.third}`);
    await expect(window.linear.addWorkspace(KEYS.host)).rejects.toThrow('Harness Org is already connected through OpenChamber');
    expect([await listed(), readFileSync(file(), 'utf8').includes(KEYS.host)]).toEqual([['org-side', 'org-third'], false]);
  });

  test('keys Linear does not take are refused and not kept; with Linear out of reach, adding one says so', async () => {
    const asked = planner.linearCalls.length;
    const notAKey = await planner.call('POST', '/linear/workspaces', { key: 'not a key' });
    expect([notAKey.status, notAKey.body.error, planner.linearCalls.length]).toEqual([400, expect.stringContaining('does not look like a Linear API key'), asked]);
    const unknown = await planner.call('POST', '/linear/workspaces', { key: fakeKey('api', 'zz') });
    expect([unknown.status, unknown.body.error, readFileSync(file(), 'utf8').includes(fakeKey('api', 'zz'))]).toEqual([400, expect.stringContaining('Linear answered'), false]);
    const offline = await startPlanner({ zone: ZONE, env: { PLANNER_LINEAR_API_BASE: await unreachable() } });
    try {
      const answer = await offline.call('POST', '/linear/workspaces', { key: KEYS.side });
      expect([answer.status, answer.body.error]).toEqual([502, expect.stringContaining('Could not reach Linear')]);
    } finally {
      await offline.stop();
    }
  });

  test("a key runs only the Planner's own documents, and a change may carry only the fields the Planner edits", async () => {
    const graphql = (variables: Record<string, unknown>, query = UPDATE_ISSUE_MUTATION, workspaceId = 'org-side') => planner.call('POST', '/linear/graphql', { workspaceId, query, variables });
    const asked = planner.linearCalls.length;
    const refused = await Promise.all([
      graphql({}, 'mutation { issueDelete(id: "x") { success } }'),
      graphql({ id: 'side-1', input: { teamId: 'team-other' } }),
      graphql({ id: 'side-1', input: ['title'] }),
      graphql({ id: 'side-1' }),
      graphql({ input: { issueId: 'side-1', body: 'x', createAsUser: 'Someone' } }, ADD_COMMENT_MUTATION),
      graphql({}, ASSIGNED_QUERY, 'org-nowhere'),
    ]);
    expect([refused.map((answer) => answer.status), planner.linearCalls.length]).toEqual([[400, 400, 400, 400, 400, 404], asked]);
    const allowed = await graphql({ id: 'side-1', input: { title: 'New', description: '- [x] done', addedLabelIds: ['l1'] } });
    expect([allowed.status, planner.linearCalls.length]).toEqual([200, asked + 1]);
  });

  test("a workspace taken off while its Load more is on the way: its page never comes back; its key is forgotten, also after a restart (round 12)", async () => {
    fake.addSideIssues(318);
    const window = await open(planner);
    await until(() => window.linear.getView().workspaces.length === 3);
    expect((await show(window, { kind: 'assigned' })).more).toEqual({ 'org-side': '300' });
    const held = fake.hold((call) => call.op === 'PlannerAssigned' && call.key === KEYS.side2 && call.variables.after === '300');
    const more = window.linear.loadMore();
    await until(() => held.reached);
    await window.linear.removeWorkspace('org-side');
    held.release();
    await more;
    const list = window.linear.list('page');
    expect([list.issues.some((issue) => issue.workspaceId === 'org-side'), list.more, list.loadingMore, readFileSync(file(), 'utf8').includes(KEYS.side2)]).toEqual([false, {}, false, false]);
    expect((await planner.call('DELETE', '/linear/workspaces/org-side')).body).toEqual({ removed: false });
    await planner.restart();
    expect(await listed()).toEqual(['org-third']);
  });
});

describe("a big workspace: what Linear has more of than one read is a Load more away, or said (round 12's audit)", () => {
  const big = bigLinear();
  const planner = track(usePlanner({ zone: ZONE, linear: big.world, linearAnswer: big.linearAnswer }));
  const afters = (op: string) => calls(planner, op).map((call) => vars(call)!.after ?? null);

  test("projects past 500, saved views past 1,000 and favorites past 250 read on; the team picker and an issue's options have every team, person and label", async () => {
    const window = await planner.window();
    await window.linear.loadProjects();
    expect([window.linear.getView().projects.length, window.linear.getView().projectsMore]).toEqual([500, { 'org-big': '500' }]);
    await window.linear.loadMoreProjects();
    expect([window.linear.getView().projects.length, new Set(window.linear.getView().projects.map((item) => item.id)).size, window.linear.getView().projectsMore, afters('PlannerProjects').slice(-2)]).toEqual([560, 560, {}, ['500', '550']]);
    await window.linear.refresh(true);
    await until(() => window.linear.getView().viewsLoaded);
    expect([window.linear.getView().views.length, window.linear.getView().viewsMore, window.linear.getView().favorites.length, afters('PlannerFavoriteViews')]).toEqual([1000, { 'org-big': '1000' }, 260, [null, '250']]);
    await window.linear.loadMoreViews();
    expect([window.linear.getView().views.length, window.linear.getView().viewsMore]).toEqual([1030, {}]);
    // A view read by Load more views keeps its place among the favorites.
    expect(window.linear.getView().views.find((item) => item.id === 'v1029')).toMatchObject({ favoriteOrder: 0, workspaceId: 'org-big' });
    expect([(await window.linear.teams()).length, afters('PlannerTeams')]).toEqual([130, [null, '100']]);
    const options = await window.linear.teamOptions('org-big', 'team-big');
    expect([options.members.length, options.members.at(-1)?.name, options.labels.length]).toEqual([300, 'Member 299', 260 + 255]);
    expect([calls(planner, 'PlannerTeamOptionPage').map(vars), afters('PlannerWorkspaceLabels')]).toEqual([[{ id: 'team-big', after: '250' }, { id: 'team-big', after: '250' }], ['250']]);
  });

  test("filter menus know Linear has more labels and states than they list; past a read's bounds the sidebar and the team picker say Linear has more; an issue's page says what it left out", async () => {
    const window = await planner.window();
    await window.linear.refresh();
    await window.linear.loadCatalogs(['org-big']);
    const catalog = window.linear.getView().catalogs['org-big']!;
    expect([catalog.labels.length, [...(catalog.partial ?? [])].sort()]).toEqual([5000, ['labels', 'states']]);
    const { favorites, teams } = big.world;
    big.world.favorites = Array.from({ length: 2600 }, (_, n) => ({ id: `f${n}`, type: 'customView', sortOrder: n, customView: { id: `v${n % 1030}` }, project: null, issue: null }));
    big.world.teams = Array.from({ length: 2050 }, (_, n) => ({ id: `t${n}`, key: `T${n}`, name: `Team ${n}` }));
    await window.linear.refresh(true);
    await until(() => window.linear.getView().favoritesCut);
    expect([window.linear.getView().favoritesCut, (await window.linear.teams()).length, [...window.linear.teamsCut]]).toEqual([true, 2000, ['org-big']]);
    Object.assign(big.world, { favorites, teams });
    // What the issue view says under its sections (IssueEditor): Linear has more sub-issues, comments and activity.
    expect(issueDetailMore(await window.linear.issueDetail({ id: 'big-1', workspaceId: 'org-big' }))).toEqual(['sub-issues', 'comments', 'activity']);
  });

  test('saved views read again while Load more views is on the way: its old page never joins the views read since (round 12)', async () => {
    const window = await planner.window();
    await window.linear.refresh(true);
    await until(() => window.linear.getView().viewsLoaded);
    const held = big.hold((call) => call.op === 'PlannerViews' && call.variables.after === '1000');
    const more = window.linear.loadMoreViews();
    await until(() => held.reached);
    big.world.views = big.world.views.filter((item) => item.id !== 'v1020');
    const shown = window.linear.getView().views;
    void window.linear.refresh(true);
    await until(() => window.linear.getView().views !== shown);
    held.release();
    await more;
    expect([window.linear.getView().views.length, window.linear.getView().viewsMore]).toEqual([1000, { 'org-big': '1000' }]);
    await window.linear.loadMoreViews();
    expect([window.linear.getView().views.length, window.linear.getView().views.some((item) => item.id === 'v1020'), window.linear.getView().viewsMore]).toEqual([1029, false, {}]);
  });
});

// Rubric 3, opt-in (README, Develop): the contract that keeps the fake Linear honest. With LINEAR_SCHEMA set to Linear's
// schema.graphql (github.com/linear/linear, packages/sdk/src), every one of the Planner's documents validates, and the
// variables of every request the scenarios above sent (their filters and inputs) coerce as Linear's own types. Run the
// whole file: LINEAR_SCHEMA=/tmp/linear-schema.graphql bun test tests/linear.test.ts
const schemaPath = process.env.LINEAR_SCHEMA;
describe.skipIf(!schemaPath || !existsSync(schemaPath))('Linear schema', () => {
  test("every document validates, and every request the scenarios sent has variables Linear's types accept", async () => {
    const { buildSchema, getVariableValues, parse, validate } = await import('graphql');
    const schema = buildSchema(readFileSync(schemaPath!, 'utf8'), { assumeValidSDL: true });
    const sent = planners.flatMap((planner) => planner.linearCalls);
    const documents = new Set([...ALL_DOCUMENTS, ...sent.map((call) => call.query)]);
    for (const document of documents) expect(validate(schema, parse(document)).map((error) => error.message)).toEqual([]);
    const coerce = (query: string, variables: Record<string, unknown>) => {
      const operation = parse(query).definitions.find((definition) => definition.kind === 'OperationDefinition');
      return (getVariableValues(schema, (operation as { variableDefinitions?: never[] }).variableDefinitions ?? [], variables).errors ?? []).map((error) => error.message);
    };
    const problems = new Set(sent.flatMap((call) => coerce(call.query, call.variables).map((message) => `${call.op}: ${message}`)));
    expect([...problems]).toEqual([]);
    expect(sent.filter((call) => vars(call)?.filter || vars(call)?.input || vars(call)?.filterData).length).toBeGreaterThan(50);
    // The check itself catches a field Linear does not have.
    expect(coerce(ASSIGNED_QUERY, { filter: { status: { name: { in: ['Todo'] } } } }).length).toBeGreaterThan(0);
  });
});
