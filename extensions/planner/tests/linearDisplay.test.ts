import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_DISPLAY_PREFS,
  completedWindow,
  displayFilter,
  dropInput,
  groupIssues,
  groupProjects,
  linearDisplayProblem,
  projectDisplayFilter,
  projectViewDisplay,
  readPages,
  settingsDisplay,
  sortIssues,
  stateGroups,
  viewDisplay,
  type IssueDisplay,
  type Page,
} from '../src/domain/linearDisplay.ts';
import { VIEW_ISSUES_QUERY, isIssueView, isProjectView, type LinearIssue, type LinearProject, type LinearState } from '../src/domain/linear.ts';
import { DEFAULT_SETTINGS } from '../src/domain/types.ts';
import { validateCommand } from '../src/domain/events.ts';
import { foldEvents } from '../src/domain/reducer.ts';

const st = (id: string, name: string, type: string, position: number, color = '#888888'): LinearState => ({ id, name, type, color, position });
// Two teams with different workflows: HAR has In Review, OPS has Triage and its own names.
const HAR = [st('h-back', 'Backlog', 'backlog', 0), st('h-todo', 'Todo', 'unstarted', 1), st('h-prog', 'In Progress', 'started', 2), st('h-rev', 'In Review', 'started', 3), st('h-done', 'Done', 'completed', 4), st('h-canc', 'Canceled', 'canceled', 5)];
const OPS = [st('o-tri', 'Triage', 'triage', 0), st('o-back', 'Backlog', 'backlog', 1), st('o-ready', 'Ready', 'unstarted', 2), st('o-doing', 'Doing', 'started', 3), st('o-ship', 'Shipped', 'completed', 4), st('o-done', 'Done', 'completed', 5)];
const har = { id: 'team-har', key: 'HAR', name: 'Harness' };
const ops = { id: 'team-ops', key: 'OPS', name: 'Ops' };

const issue = (n: number, state: LinearState, patch: Partial<LinearIssue> = {}): LinearIssue => ({
  id: `i${n}`,
  identifier: `${state.id.startsWith('o-') ? 'OPS' : 'HAR'}-${n}`,
  title: `issue ${n}`,
  url: `https://linear.app/x/issue/${n}`,
  priority: 3,
  dueDate: null,
  updatedAt: `2026-10-${String(10 + (n % 20)).padStart(2, '0')}T00:00:00.000Z`,
  state,
  team: state.id.startsWith('o-') ? ops : har,
  project: null,
  cycle: null,
  ...patch,
});
const base = settingsDisplay(DEFAULT_SETTINGS);
const labels = (groups: { label: string; issues: LinearIssue[] }[]) => groups.map((group) => `${group.label}:${group.issues.map((item) => item.identifier).join(',')}`);

describe('a saved view keeps its own filter and display', () => {
  test('the view query has no open-only clause: Linear applies the view filter, the Planner adds only $filter', () => {
    expect(VIEW_ISSUES_QUERY).not.toContain('"completed"');
    expect(VIEW_ISSUES_QUERY).not.toContain('nin');
    expect(VIEW_ISSUES_QUERY).toContain('filter: $filter');
    expect(VIEW_ISSUES_QUERY).toContain('pageInfo { hasNextPage endCursor }');
  });
  test('"show completed issues: all" sends no filter, so a completed-only view shows its issues', () => {
    const { display } = viewDisplay({ layout: 'list', issueGrouping: 'noGrouping', viewOrdering: 'updatedAt', showCompletedIssues: 'all', showSubIssues: true }, base);
    expect(displayFilter(display)).toBeNull();
  });
  test('a view without a completed-issues choice shows everything its filter holds', () => {
    expect(displayFilter(viewDisplay({ layout: 'list' }, base).display)).toBeNull();
    expect(displayFilter(viewDisplay({}, base).display)).toBeNull();
  });
  test('completed issues within a window, none, sub-issues and triage become filter parts', () => {
    const week = viewDisplay({ showCompletedIssues: 'week' }, base).display;
    expect(displayFilter(week)).toEqual({ or: [{ state: { type: { nin: ['completed', 'canceled'] } } }, { completedAt: { gte: '-P1W' } }, { canceledAt: { gte: '-P1W' } }] });
    expect(displayFilter({ ...week, showCompleted: 'none' })).toEqual({ state: { type: { nin: ['completed', 'canceled'] } } });
    expect(displayFilter({ ...week, showCompleted: 'all', showSubIssues: false, showTriage: false })).toEqual({ and: [{ parent: { null: true } }, { state: { type: { neq: 'triage' } } }] });
    expect(displayFilter({ ...week, showCompleted: '3months' })).toMatchObject({ or: [{}, { completedAt: { gte: '-P3M' } }, { canceledAt: { gte: '-P3M' } }] });
  });
  test("Linear's completed-issue choices", () => {
    expect(['all', 'none', 'week', 'month', '3months', '6months', 'year', 'pastWeek', 'past_month', '3 months', 'hide'].map(completedWindow)).toEqual(['all', 'none', 'week', 'month', '3months', '6months', 'year', 'week', 'month', '3months', 'none']);
    expect(completedWindow('fortnight')).toBeNull();
    expect(completedWindow(null)).toBeNull();
  });
  test('layout, grouping, sub-grouping, ordering, empty groups and properties are read from the view', () => {
    const { display, unsupported } = viewDisplay(
      { layout: 'board', issueGrouping: 'assignee', issueSubGrouping: 'priority', viewOrdering: 'createdAt', viewOrderingDirection: 'asc', showEmptyGroupsBoard: false, fieldId: true, fieldStatus: true, fieldLabels: true, fieldDueDate: false },
      base,
    );
    expect(display).toMatchObject({ layout: 'board', groupBy: 'assignee', subGroupBy: 'priority', orderBy: 'created', orderReverse: true, showEmptyColumns: false, showEmptyGroups: false, properties: ['id', 'status', 'labels'] });
    expect(viewDisplay({ layout: 'board' }, base).display).toMatchObject({ showEmptyColumns: true, showEmptyGroups: false });
    expect(unsupported).toEqual([]);
    expect(viewDisplay({ layout: 'list', issueGrouping: 'workflowState', issueSubGrouping: null, viewOrdering: 'priority' }, { ...base, subGroupBy: 'team' }).display).toMatchObject({ groupBy: 'status', subGroupBy: 'none', orderBy: 'priority', orderReverse: false });
  });
  test('what the Planner cannot show the same way is named, and the rest still applies', () => {
    const { display, unsupported } = viewDisplay({ layout: 'spreadsheet', issueGrouping: 'parent', viewOrdering: 'linkCount', showCompletedIssues: 'fortnight' }, base);
    expect(unsupported).toEqual(['the spreadsheet layout', 'grouping by parent', 'ordering by linkCount', 'completed issues "fortnight"']);
    expect(display).toMatchObject({ layout: base.layout, groupBy: base.groupBy, showCompleted: 'all' });
  });
  test('views of projects are told apart from views of issues', () => {
    expect(isProjectView({ modelName: 'Project' })).toBe(true);
    expect(isProjectView({ modelName: 'Issue' })).toBe(false);
    expect(isIssueView({ modelName: 'Project' })).toBe(false);
  });
});

describe('pages', () => {
  const pages = (total: number, size: number) => {
    const asked: (string | null)[] = [];
    const fetchPage = async (after: string | null): Promise<Page<number>> => {
      asked.push(after);
      const start = after ? Number(after) : 0;
      const nodes = Array.from({ length: Math.min(size, total - start) }, (_, index) => start + index);
      const end = start + nodes.length;
      return { nodes, pageInfo: { hasNextPage: end < total, endCursor: end < total ? String(end) : null } };
    };
    return { asked, fetchPage };
  };
  test('pagination follows pageInfo to the end', async () => {
    const { asked, fetchPage } = pages(320, 100);
    const read = await readPages(fetchPage, { maxPages: 100 });
    expect(read.nodes).toHaveLength(320);
    expect(read.hasMore).toBe(false);
    expect(asked).toEqual([null, '100', '200', '300']);
  });
  test('a first read stops after its pages and says where to go on; the rest follows from there', async () => {
    const { fetchPage } = pages(320, 100);
    const first = await readPages(fetchPage, { maxPages: 3 });
    expect(first).toMatchObject({ hasMore: true, endCursor: '300' });
    expect(first.nodes).toHaveLength(300);
    const rest = await readPages(fetchPage, { after: first.endCursor, maxPages: 1 });
    expect(rest).toMatchObject({ hasMore: false, endCursor: null });
    expect([...first.nodes, ...rest.nodes]).toEqual(Array.from({ length: 320 }, (_, index) => index));
  });
  test('a next page without a cursor ends the read instead of looping', async () => {
    let calls = 0;
    const read = await readPages(async () => {
      calls += 1;
      return { nodes: [1], pageInfo: { hasNextPage: true, endCursor: null } };
    }, { maxPages: 10 });
    expect(calls).toBe(1);
    expect(read.hasMore).toBe(false);
  });
});

describe('status groups are exact workflow states', () => {
  test('a board has a column per state of the team, in workflow order, empty ones too', () => {
    const issues = [issue(1, HAR[1]!), issue(2, HAR[3]!)];
    const groups = groupIssues(issues, 'status', { layout: 'board', states: HAR, showEmpty: true });
    expect(groups.map((group) => group.label)).toEqual(['Backlog', 'Todo', 'In Progress', 'In Review', 'Done', 'Canceled']);
    expect(groups.find((group) => group.label === 'In Review')).toMatchObject({ stateType: 'started', target: { kind: 'state', name: 'In Review', type: 'started' } });
    // In Progress and In Review are two columns, not one "started" bucket.
    expect(labels(groups).filter((text) => text.startsWith('In '))).toEqual(['In Progress:', 'In Review:HAR-2']);
  });
  test('a list puts the work closest to done first, then completed and canceled; empty groups only when asked', () => {
    const issues = [issue(1, HAR[0]!), issue(2, HAR[1]!), issue(3, HAR[2]!), issue(4, HAR[3]!), issue(5, HAR[4]!), issue(6, HAR[5]!)];
    expect(groupIssues(issues, 'status', { layout: 'list' }).map((group) => group.label)).toEqual(['In Review', 'In Progress', 'Todo', 'Backlog', 'Done', 'Canceled']);
    expect(groupIssues([issue(1, HAR[1]!)], 'status', { layout: 'list', states: HAR }).map((group) => group.label)).toEqual(['Todo']);
  });
  test('two teams: same-named states share a column, the others keep their own', () => {
    const groups = stateGroups([...HAR, ...OPS], 'board');
    expect(groups.map((group) => group.name)).toEqual(['Triage', 'Backlog', 'Todo', 'Ready', 'In Progress', 'Doing', 'In Review', 'Done', 'Shipped', 'Canceled']);
    expect(groups.find((group) => group.name === 'Backlog')!.stateIds).toEqual(['h-back', 'o-back']);
    expect(groups.find((group) => group.name === 'Done')!.stateIds).toEqual(['h-done', 'o-done']);
  });
  test("a drop sets the card's own team's state of that exact name", () => {
    const card = issue(7, OPS[2]!);
    expect(dropInput(card, { kind: 'state', name: 'Doing', type: 'started' }, OPS)).toEqual({ input: { stateId: 'o-doing' } });
    // "Done" exists in both teams: an OPS card gets OPS's Done, not HAR's, and not Shipped (the first completed state).
    expect(dropInput(card, { kind: 'state', name: 'Done', type: 'completed' }, OPS)).toEqual({ input: { stateId: 'o-done' } });
    expect(dropInput(issue(8, HAR[1]!), { kind: 'state', name: 'In Review', type: 'started' }, HAR)).toEqual({ input: { stateId: 'h-rev' } });
    expect(dropInput(card, { kind: 'state', name: 'In Review', type: 'started' }, OPS)).toEqual({ error: 'OPS has no In Review status' });
    expect(dropInput(card, { kind: 'state', name: 'Ready', type: 'unstarted' }, OPS)).toBeNull();
  });
  test('drops on other groupings set that property', () => {
    const card = issue(9, HAR[1]!, { priority: 3, assignee: null, project: { id: 'p1', name: 'Alpha' }, cycle: { id: 'c1', number: 1 } });
    expect(dropInput(card, { kind: 'priority', priority: 1 }, [])).toEqual({ input: { priority: 1 } });
    expect(dropInput(card, { kind: 'assignee', id: 'u1' }, [])).toEqual({ input: { assigneeId: 'u1' } });
    expect(dropInput(card, { kind: 'project', id: null }, [])).toEqual({ input: { projectId: null } });
    expect(dropInput(card, { kind: 'cycle', id: 'c2', teamId: 'team-ops' }, [])).toMatchObject({ error: expect.stringContaining('another team') });
    expect(dropInput(card, { kind: 'cycle', id: 'c2', teamId: 'team-har' }, [])).toEqual({ input: { cycleId: 'c2' } });
    expect(dropInput(card, { kind: 'priority', priority: 3 }, [])).toBeNull();
  });
});

describe('other groupings and orders', () => {
  const people = [
    issue(1, HAR[2]!, { priority: 0, assignee: { id: 'u2', name: 'Bo' }, project: { id: 'p2', name: 'Zeta' }, labels: { nodes: [{ id: 'l1', name: 'Bug', color: '#f00' }, { id: 'l2', name: 'UI', color: '#0f0' }] } }),
    issue(2, HAR[1]!, { priority: 1, assignee: null, labels: { nodes: [] } }),
    issue(10, HAR[0]!, { priority: 3, assignee: { id: 'u1', name: 'Al' }, project: { id: 'p1', name: 'Alpha' }, dueDate: '2026-11-02', cycle: { id: 'c7', number: 7 } }),
    issue(9, OPS[3]!, { priority: 3, dueDate: '2026-10-26', project: { id: 'p1', name: 'Alpha' }, cycle: { id: 'c3', number: 3 } }),
  ];
  test('priority, assignee, project, label, cycle, team, none', () => {
    expect(labels(groupIssues(people, 'priority', { layout: 'list' }))).toEqual(['Urgent:HAR-2', 'Medium:HAR-10,OPS-9', 'No priority:HAR-1']);
    expect(labels(groupIssues(people, 'assignee', { layout: 'list' }))).toEqual(['Al:HAR-10', 'Bo:HAR-1', 'No assignee:HAR-2,OPS-9']);
    expect(labels(groupIssues(people, 'project', { layout: 'list' }))).toEqual(['Alpha:HAR-10,OPS-9', 'Zeta:HAR-1', 'No project:HAR-2']);
    // An issue with two labels is in both label groups.
    expect(labels(groupIssues(people, 'label', { layout: 'list' }))).toEqual(['Bug:HAR-1', 'UI:HAR-1', 'No labels:HAR-2,HAR-10,OPS-9']);
    expect(labels(groupIssues(people, 'cycle', { layout: 'list' }))).toEqual(['HAR · Cycle 7:HAR-10', 'OPS · Cycle 3:OPS-9', 'No cycle:HAR-1,HAR-2']);
    expect(groupIssues(people, 'team', { layout: 'list' }).map((group) => group.label)).toEqual(['HAR · Harness', 'OPS · Ops']);
    expect(labels(groupIssues(people, 'none', { layout: 'list' }))).toEqual(['Issues:HAR-1,HAR-2,HAR-10,OPS-9']);
    expect(groupIssues(people, 'priority', { layout: 'board', showEmpty: true }).map((group) => group.label)).toEqual(['Urgent', 'High', 'Medium', 'Low', 'No priority']);
  });
  test('orders, reversed; issues without a value stay last', () => {
    const ids = (by: Parameters<typeof sortIssues>[1], reverse = false) => sortIssues(people, by, reverse).map((item) => item.identifier).join(',');
    expect(ids('priority')).toBe('HAR-2,HAR-10,OPS-9,HAR-1');
    expect(ids('priority', true)).toBe('HAR-10,OPS-9,HAR-2,HAR-1');
    expect(ids('due')).toBe('OPS-9,HAR-10,HAR-2,HAR-1');
    expect(ids('due', true)).toBe('HAR-10,OPS-9,HAR-2,HAR-1');
    // Status order, as Linear's lists: closest to done first.
    expect(ids('status')).toBe('OPS-9,HAR-1,HAR-2,HAR-10');
    expect(ids('identifier')).toBe('HAR-1,HAR-2,HAR-10,OPS-9');
    expect(sortIssues([issue(1, HAR[1]!, { sortOrder: 5 }), issue(2, HAR[1]!, { sortOrder: -2 })], 'manual').map((item) => item.id)).toEqual(['i2', 'i1']);
    expect(sortIssues([issue(1, HAR[1]!, { createdAt: '2026-01-01' }), issue(2, HAR[1]!, { createdAt: '2026-05-01' })], 'created').map((item) => item.id)).toEqual(['i2', 'i1']);
  });
});

describe('views of projects', () => {
  const project = (id: string, type: string, patch: Partial<LinearProject> = {}): LinearProject => ({
    id, name: id, url: `https://linear.app/a/project/${id}`, color: '#5e6ad2', icon: null, description: '', progress: 0.5, health: null, priority: 0,
    startDate: null, targetDate: null, updatedAt: '2026-10-01T00:00:00.000Z', status: { id: type, name: type, type, color: '#888888' }, lead: null, teams: { nodes: [] }, ...patch,
  });
  test('a project view reads its grouping, ordering and completed projects', () => {
    expect(projectViewDisplay({ projectGrouping: 'lead', projectViewOrdering: 'targetDate', showCompletedProjects: 'month' }).display).toEqual({ groupBy: 'lead', orderBy: 'target', showCompleted: 'month' });
    expect(projectViewDisplay({ projectLayout: 'timeline' }).unsupported).toEqual(['the timeline layout']);
    expect(projectViewDisplay(null).display.showCompleted).toBe('all');
    expect(projectDisplayFilter({ showCompleted: 'all' })).toBeNull();
    expect(projectDisplayFilter({ showCompleted: 'none' })).toEqual({ status: { type: { nin: ['completed', 'canceled'] } } });
  });
  test('projects group by status (completed too), lead or health', () => {
    const projects = [project('later', 'backlog'), project('b', 'started', { targetDate: '2026-12-01' }), project('a', 'started', { targetDate: '2026-11-01' }), project('urgent', 'started', { priority: 1 }), project('shipped', 'completed', { lead: { id: 'u1', name: 'Al' } })];
    expect(groupProjects(projects).map((group) => `${group.key}:${group.projects.map((item) => item.id).join(',')}`)).toEqual(['started:urgent,a,b', 'backlog:later', 'completed:shipped']);
    expect(groupProjects(projects, { groupBy: 'lead', orderBy: 'name' }).map((group) => group.label)).toEqual(['Al', 'No lead']);
  });
});

describe('the display setting', () => {
  test('validates, and old plans get the default', () => {
    const state = foldEvents([]);
    expect(state.settings.linearDisplay).toEqual(DEFAULT_DISPLAY_PREFS);
    expect(validateCommand({ cmd: 'd1', type: 'settings.updated', patch: { linearDisplay: { ...DEFAULT_DISPLAY_PREFS, subGroupBy: 'priority', showCompleted: 'week' } } }, state)).toBeNull();
    expect(validateCommand({ cmd: 'd2', type: 'settings.updated', patch: { linearDisplay: { ...DEFAULT_DISPLAY_PREFS, showCompleted: 'forever' } } }, state)).toContain('showCompleted');
    expect(validateCommand({ cmd: 'd3', type: 'settings.updated', patch: { linearDisplay: { ...DEFAULT_DISPLAY_PREFS, properties: ['id', 'secret'] } } }, state)).toContain('properties');
    expect(linearDisplayProblem({ ...DEFAULT_DISPLAY_PREFS, extra: 1 })).toBe('unknown linearDisplay.extra');
    expect(validateCommand({ cmd: 'd4', type: 'settings.updated', patch: { linearGroupBy: 'cycle', linearOrderBy: 'manual' } }, state)).toBeNull();
  });
  test("the Planner's lists use the settings", () => {
    const display: IssueDisplay = settingsDisplay({ ...DEFAULT_SETTINGS, linearLayout: 'board', linearDisplay: { ...DEFAULT_DISPLAY_PREFS, showCompleted: 'week' } });
    expect(display).toMatchObject({ layout: 'board', groupBy: 'status', orderBy: 'priority', showCompleted: 'week', showTriage: true });
  });
});
