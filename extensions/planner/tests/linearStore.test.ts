// The panel's Linear store against a fake Linear behind the host's connection: which
// documents it sends with which variables for saved views, pages, filters, views of
// projects and board drops, and how its lists follow.
import { describe, expect, test } from 'bun:test';
import type { HostClient } from '@openchamber/sdk';
import { LinearStore } from '../panel/lib/linear.ts';
import type { PlannerClient } from '../panel/lib/client.ts';
import { emptyState } from '../src/domain/types.ts';
import { issueDetailMore, type LinearIssue, type LinearIssueDetail, type LinearState } from '../src/domain/linear.ts';
import { partialNote } from '../src/domain/linearFilter.ts';

const st = (id: string, name: string, type: string, position: number): LinearState => ({ id, name, type, color: '#888888', position });
const STATES = [st('s-back', 'Backlog', 'backlog', 0), st('s-todo', 'Todo', 'unstarted', 1), st('s-prog', 'In Progress', 'started', 2), st('s-rev', 'In Review', 'started', 3), st('s-done', 'Done', 'completed', 4)];
const team = { id: 'team-1', key: 'HAR', name: 'Harness' };
const issue = (n: number, state: LinearState): LinearIssue => ({
  id: `i${n}`, identifier: `HAR-${n}`, title: `issue ${n}`, url: `https://linear.app/x/issue/HAR-${n}`, priority: 3, dueDate: null,
  updatedAt: new Date(Date.UTC(2026, 9, 1) + n * 60_000).toISOString(), state, team, project: null, cycle: null, labels: { nodes: [] },
});

/** A fake Linear: a few views, 320 issues in one of them, pages of 100, every call recorded. */
const fakeLinear = () => {
  const calls: { op: string; variables: Record<string, unknown> }[] = [];
  const big = Array.from({ length: 320 }, (_, index) => issue(100 + index, STATES[1]!));
  const small = [issue(1, STATES[1]!), issue(2, STATES[2]!), issue(3, STATES[4]!)];
  const views: Record<string, { modelName: string; prefs: Record<string, unknown>; issues: LinearIssue[] }> = {
    'v-done': { modelName: 'Issue', prefs: { layout: 'list', issueGrouping: 'noGrouping', showCompletedIssues: 'all' }, issues: [small[2]!] },
    'v-open': { modelName: 'Issue', prefs: { layout: 'board', issueGrouping: 'workflowState', showCompletedIssues: 'none' }, issues: small },
    'v-big': { modelName: 'Issue', prefs: { layout: 'list', showCompletedIssues: 'all' }, issues: big },
    'v-proj': { modelName: 'Project', prefs: { projectGrouping: 'status', showCompletedProjects: 'all' }, issues: [] },
  };
  const page = <T,>(nodes: T[], first: number, after: unknown) => {
    const start = typeof after === 'string' ? Number(after) : 0;
    const slice = nodes.slice(start, start + first);
    const end = start + slice.length;
    return { nodes: slice, pageInfo: { hasNextPage: end < nodes.length, endCursor: end < nodes.length ? String(end) : null } };
  };
  const answer = (op: string, variables: Record<string, unknown>): unknown => {
    switch (op) {
      case 'PlannerWhoAmI':
        return { viewer: { id: 'u1', name: 'Me' }, organization: { id: 'org-1', name: 'Org', urlKey: 'org' } };
      case 'PlannerView': {
        const view = views[variables.id as string];
        return { customView: view ? { id: variables.id, name: `view ${variables.id}`, description: null, icon: null, color: null, shared: true, modelName: view.modelName, slugId: 'slug', updatedAt: '', team, owner: null, viewPreferencesValues: view.prefs } : null };
      }
      case 'PlannerViewIssues':
        return { customView: { id: variables.id, issues: page(views[variables.id as string]!.issues, 100, variables.after) } };
      case 'PlannerViewProjects':
        return { customView: { id: variables.id, projects: page([{ id: 'p1', name: 'Planner', url: '', color: '#000', icon: null, description: '', progress: 0, health: null, priority: 0, startDate: null, targetDate: null, updatedAt: '', status: { id: 's', name: 'Completed', type: 'completed', color: '#000' }, lead: null, teams: { nodes: [] } }], 50, variables.after) } };
      case 'PlannerAssigned':
        return { viewer: { id: 'u1', name: 'Me', assignedIssues: page(small, 100, variables.after) } };
      case 'PlannerTeamStates':
        return { team: { id: variables.id, states: { nodes: STATES } } };
      case 'PlannerSetState': {
        const found = [...small, ...big].find((item) => item.id === variables.id)!;
        found.state = STATES.find((state) => state.id === variables.stateId)!;
        return { issueUpdate: { success: true, issue: found } };
      }
      case 'PlannerLinked':
        return { issues: { nodes: [] } };
      default:
        return null;
    }
  };
  const host = {
    request: async ({ body }: { body: string }) => {
      const { query, variables } = JSON.parse(body) as { query: string; variables: Record<string, unknown> };
      const op = /(?:query|mutation) (\w+)/.exec(query)![1]!;
      calls.push({ op, variables });
      const data = answer(op, variables);
      return { status: 200, body: JSON.stringify(data ? { data } : { errors: [{ message: `unexpected ${op}` }] }) };
    },
    storage: { get: async () => undefined, set: async () => {}, delete: async () => {}, keys: async () => [] },
  } as unknown as HostClient;
  const state = emptyState();
  const client = {
    getView: () => ({ state, today: '2026-10-26' }),
    call: async () => ({ workspaces: [] }),
    dispatch: async () => {},
    notify: () => {},
    onCommitted: () => () => {},
  } as unknown as PlannerClient;
  return { calls, host, client, views, small };
};

const settle = async (store: LinearStore) => {
  for (let i = 0; i < 50 && (store.list('page').loading || store.list('page').loadingMore); i++) await new Promise((resolve) => setTimeout(resolve, 5));
};

describe('the Linear store reads lists the way Linear lists them', () => {
  test('a saved view is read with its own filter: nothing added for "all completed issues", open issues only for "none"', async () => {
    const fake = fakeLinear();
    const store = new LinearStore(fake.host, fake.client, 'page');
    store.setSource({ kind: 'view', id: 'v-done', workspaceId: 'org-1' });
    await settle(store);
    expect(store.list('page').issues.map((item) => item.identifier)).toEqual(['HAR-3']);
    expect(fake.calls.filter((call) => call.op === 'PlannerViewIssues').at(-1)!.variables).toEqual({ id: 'v-done', after: null, filter: null });
    store.setSource({ kind: 'view', id: 'v-open', workspaceId: 'org-1' });
    await settle(store);
    expect(fake.calls.filter((call) => call.op === 'PlannerViewIssues').at(-1)!.variables.filter).toEqual({ state: { type: { nin: ['completed', 'canceled'] } } });
    // The view opens with its saved layout and grouping.
    expect(store.list('page').display).toMatchObject({ layout: 'board', groupBy: 'status', showCompleted: 'none' });
  });

  test('pages follow Linear’s cursors: three at once, then each Load more, to the end', async () => {
    const fake = fakeLinear();
    const store = new LinearStore(fake.host, fake.client, 'page');
    store.setSource({ kind: 'view', id: 'v-big', workspaceId: 'org-1' });
    await settle(store);
    expect(store.list('page').issues).toHaveLength(300);
    expect(store.list('page').more).toEqual({ 'org-1': '300' });
    await store.loadMore('page');
    expect(store.list('page').issues).toHaveLength(320);
    expect(store.list('page').more).toEqual({});
    expect(fake.calls.filter((call) => call.op === 'PlannerViewIssues').map((call) => call.variables.after)).toEqual([null, '100', '200', '300']);
    expect(new Set(store.list('page').issues.map((item) => item.id)).size).toBe(320);
  });

  test('temporary filters go to Linear as an IssueFilter, with the display’s part', async () => {
    const fake = fakeLinear();
    const store = new LinearStore(fake.host, fake.client, 'page');
    store.setSource({ kind: 'view', id: 'v-open', workspaceId: 'org-1' });
    await settle(store);
    store.setFilters([{ field: 'status', op: 'isNot', values: [{ value: 'Todo', label: 'Todo' }] }]);
    await settle(store);
    expect(fake.calls.filter((call) => call.op === 'PlannerViewIssues').at(-1)!.variables.filter).toEqual({ and: [{ state: { type: { nin: ['completed', 'canceled'] } } }, { state: { name: { nin: ['Todo'] } } }] });
    // Rules without values are dropped; the same rules do not read the list again.
    const before = fake.calls.length;
    store.setFilters([{ field: 'status', op: 'isNot', values: [{ value: 'Todo', label: 'Todo' }] }, { field: 'label', op: 'includesAny', values: [] }]);
    expect(fake.calls.length).toBe(before);
  });

  test('a view of projects lists its projects, with nothing added to its filter', async () => {
    const fake = fakeLinear();
    const store = new LinearStore(fake.host, fake.client, 'page');
    store.setSource({ kind: 'view', id: 'v-proj', workspaceId: 'org-1' });
    await settle(store);
    expect(store.list('page').projects?.map((project) => project.name)).toEqual(['Planner']);
    expect(store.list('page').projectDisplay).toEqual({ groupBy: 'status', orderBy: 'priority', showCompleted: 'all' });
    expect(fake.calls.filter((call) => call.op === 'PlannerViewProjects').at(-1)!.variables).toEqual({ id: 'v-proj', after: null, filter: null });
    expect(fake.calls.some((call) => call.op === 'PlannerViewIssues')).toBe(false);
  });

  test('a card dropped on a status column moves to exactly that state of its team', async () => {
    const fake = fakeLinear();
    const store = new LinearStore(fake.host, fake.client, 'page');
    store.setSource({ kind: 'view', id: 'v-open', workspaceId: 'org-1' });
    await settle(store);
    const todo = store.list('page').issues.find((item) => item.identifier === 'HAR-1')!;
    expect(await store.moveToGroup(todo, { kind: 'state', name: 'In Review', type: 'started' })).toBe(true);
    expect(fake.calls.filter((call) => call.op === 'PlannerSetState').at(-1)!.variables).toEqual({ id: 'i1', stateId: 's-rev' });
    expect(store.list('page').issues.find((item) => item.id === 'i1')!.state.name).toBe('In Review');
    // A state the team does not have is refused without asking Linear.
    const asked = fake.calls.length;
    expect(await store.moveToGroup(store.list('page').issues.find((item) => item.id === 'i1')!, { kind: 'state', name: 'Shipped', type: 'completed' })).toBe(false);
    expect(fake.calls.length).toBe(asked);
  });

  test('the page and the side panels keep lists of their own', async () => {
    const fake = fakeLinear();
    const store = new LinearStore(fake.host, fake.client, 'page');
    store.use('side');
    store.setSource({ kind: 'view', id: 'v-done', workspaceId: 'org-1' });
    await settle(store);
    for (let i = 0; i < 50 && store.list('side').loading; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(store.list('side').source).toEqual({ kind: 'assigned' });
    expect(store.list('side').issues.map((item) => item.identifier)).toEqual(['HAR-1', 'HAR-2', 'HAR-3']);
    expect(store.list('page').issues.map((item) => item.identifier)).toEqual(['HAR-3']);
    // The side panel lists open issues of mine: its display asks Linear for open ones.
    expect(fake.calls.filter((call) => call.op === 'PlannerAssigned').at(-1)!.variables.filter).toEqual({ state: { type: { nin: ['completed', 'canceled'] } } });
  });
});

// Round 12's audit (review 11 found the GitHub source stopping at 50 unsaid): every Linear read that stopped at a
// bound without a word now reads on, has a Load more, or says Linear has more.
describe('nothing of Linear is left out unsaid', () => {
  const project = (n: number) => ({ id: `p${n}`, name: `Project ${n}`, url: `https://linear.app/org/project/p${n}`, color: '#000', icon: null, description: '', progress: 0, health: null, priority: 0, startDate: null, targetDate: null, updatedAt: '', status: { id: 's', name: 'Started', type: 'started', color: '#000' }, lead: null, teams: { nodes: [] } });
  const view = (n: number) => ({ id: `v${n}`, name: `View ${String(n).padStart(4, '0')}`, description: null, icon: null, color: null, shared: true, modelName: 'Issue', slugId: `s${n}`, updatedAt: '', team, owner: null });
  const member = (n: number) => ({ id: `m${n}`, name: `Member ${String(n).padStart(3, '0')}`, displayName: `m${n}`, active: true });
  const label = (prefix: string, n: number) => ({ id: `${prefix}${n}`, name: `${prefix} ${String(n).padStart(4, '0')}`, color: '#123456' });
  const page = <T,>(nodes: T[], first: number, after: unknown) => {
    const start = typeof after === 'string' ? Number(after) : 0;
    const slice = nodes.slice(start, start + first);
    const end = start + slice.length;
    return { nodes: slice, pageInfo: { hasNextPage: end < nodes.length, endCursor: end < nodes.length ? String(end) : null } };
  };
  /** A big workspace: 560 open projects, 1,030 views, 260 favorites, 130 teams; a team of 300 people and 260 labels; 5,100 labels in all. */
  const bigLinear = () => {
    const calls: { op: string; variables: Record<string, unknown> }[] = [];
    const world = {
      projects: Array.from({ length: 560 }, (_, n) => project(n)),
      views: Array.from({ length: 1030 }, (_, n) => view(n)),
      favorites: Array.from({ length: 260 }, (_, n) => ({ id: `f${n}`, type: 'customView', sortOrder: n, customView: { id: `v${1029 - n}` }, project: null, issue: null })),
      teams: Array.from({ length: 130 }, (_, n) => ({ id: `t${n}`, key: `T${n}`, name: `Team ${n}` })),
      members: Array.from({ length: 300 }, (_, n) => member(n)),
      teamLabels: Array.from({ length: 260 }, (_, n) => label('team', n)),
      workspaceLabels: Array.from({ length: 255 }, (_, n) => label('ws', n)),
      allLabels: Array.from({ length: 5100 }, (_, n) => ({ ...label('all', n), isGroup: false, parent: null, team: null })),
    };
    const answer = (op: string, variables: Record<string, unknown>, query: string): unknown => {
      switch (op) {
        case 'PlannerWhoAmI':
          return { viewer: { id: 'u1', name: 'Me' }, organization: { id: 'org-1', name: 'Org', urlKey: 'org' } };
        case 'PlannerLinked':
          return { issues: { nodes: [] } };
        case 'PlannerProjects':
          return { projects: page(world.projects, 50, variables.after) };
        case 'PlannerViews':
          return { customViews: page(world.views, 100, variables.after) };
        case 'PlannerFavoriteViews':
          return { favorites: page(world.favorites, 250, variables.after) };
        case 'PlannerTeams':
          return { viewer: { id: 'u1' }, teams: page(world.teams, 100, variables.after) };
        case 'PlannerTeamOptions':
          return { team: { id: variables.id, states: page(STATES, 100, null), members: page(world.members, 250, null), labels: page(world.teamLabels, 250, null), cycles: page([], 25, null), projects: page([], 100, null) }, issueLabels: page(world.workspaceLabels, 250, null) };
        case 'PlannerTeamOptionPage': {
          const field = /team\(id: \$id\) \{ id (\w+)\(/.exec(query)![1]!;
          const all: Record<string, unknown[]> = { members: world.members, labels: world.teamLabels, states: STATES, cycles: [], projects: [] };
          return { team: { id: variables.id, [field]: page(all[field]!, 250, variables.after) } };
        }
        case 'PlannerWorkspaceLabels':
          return { issueLabels: page(world.workspaceLabels, 250, variables.after) };
        case 'PlannerFilterTeams':
          return { teams: page([{ ...team, states: { nodes: STATES, pageInfo: { hasNextPage: true } } }], 50, variables.after) };
        case 'PlannerFilterUsers':
          return { users: page([{ ...member(1), isMe: true }], 250, variables.after) };
        case 'PlannerFilterLabels':
          return { issueLabels: page(world.allLabels, 250, variables.after) };
        case 'PlannerFilterProjects':
          return { projects: page([], 250, variables.after) };
        case 'PlannerFilterCycles':
          return { cycles: page([], 250, variables.after) };
        case 'PlannerFilterMilestones':
          return { projectMilestones: page([], 250, variables.after) };
        default:
          return null;
      }
    };
    const host = {
      request: async ({ body }: { body: string }) => {
        const { query, variables } = JSON.parse(body) as { query: string; variables: Record<string, unknown> };
        const op = /(?:query|mutation) (\w+)/.exec(query)![1]!;
        calls.push({ op, variables });
        const data = answer(op, variables, query);
        return { status: 200, body: JSON.stringify(data ? { data } : { errors: [{ message: `unexpected ${op}` }] }) };
      },
      storage: { get: async () => undefined, set: async () => {}, delete: async () => {}, keys: async () => [] },
    } as unknown as HostClient;
    const state = emptyState();
    const client = { getView: () => ({ state, today: '2026-10-26' }), call: async () => ({ workspaces: [] }), dispatch: async () => {}, notify: () => {}, onCommitted: () => () => {} } as unknown as PlannerClient;
    const store = new LinearStore(host, client, 'page');
    const afters = (op: string) => calls.filter((call) => call.op === op).map((call) => call.variables.after ?? null);
    return { store, calls, afters, world };
  };
  const until = async (test: () => boolean) => {
    for (let i = 0; i < 200 && !test(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  };

  test('projects: the first 500 open ones and "Load more projects" for the rest (they used to stop at 500 unsaid)', async () => {
    const { store, afters } = bigLinear();
    await store.loadProjects();
    expect([store.getView().projects.length, store.getView().projectsMore]).toEqual([500, { 'org-1': '500' }]);
    await store.loadMoreProjects();
    expect([store.getView().projects.length, store.getView().projectsMore, new Set(store.getView().projects.map((item) => item.id)).size]).toEqual([560, {}, 560]);
    expect(afters('PlannerProjects').slice(-2)).toEqual(['500', '550']);
  });

  test('saved views: the first 1,000 and "Load more views" for the rest; favorites a page at a time, past 250', async () => {
    const { store, afters } = bigLinear();
    await store.refresh(true);
    await until(() => store.getView().viewsLoaded);
    expect([store.getView().views.length, store.getView().viewsMore]).toEqual([1000, { 'org-1': '1000' }]);
    // A favorite of a view not read yet stays (it may come with Load more views); 260 of them, over two pages.
    expect([store.getView().favorites.length, afters('PlannerFavoriteViews')]).toEqual([260, [null, '250']]);
    await store.loadMoreViews();
    expect([store.getView().views.length, store.getView().viewsMore]).toEqual([1030, {}]);
    // A view read by Load more keeps its place among the favorites.
    expect(store.getView().views.find((item) => item.id === 'v1029')).toMatchObject({ favoriteOrder: 0, workspaceId: 'org-1' });
  });

  test('the team picker for a new issue has every team (it stopped at the first 100)', async () => {
    const { store, afters } = bigLinear();
    await store.refresh();
    expect((await store.teams()).length).toBe(130);
    expect(afters('PlannerTeams')).toEqual([null, '100']);
  });

  test("an issue's team options: every person and label, page by page past 250 (they stopped at the first page)", async () => {
    const { store, calls } = bigLinear();
    await store.refresh();
    const options = await store.teamOptions('org-1', 'team-1');
    expect([options.members.length, options.labels.length, options.states.length]).toEqual([300, 260 + 255, STATES.length]);
    expect(options.members.at(-1)!.name).toBe('Member 299');
    expect(calls.filter((call) => call.op === 'PlannerTeamOptionPage').map((call) => call.variables)).toEqual([
      { id: 'team-1', after: '250' },
      { id: 'team-1', after: '250' },
    ]);
    expect(calls.filter((call) => call.op === 'PlannerWorkspaceLabels').map((call) => call.variables.after)).toEqual(['250']);
  });

  test("filter menus: a catalog says what Linear has more of than it read (5,100 labels; a team's states past 50)", async () => {
    const { store } = bigLinear();
    await store.refresh();
    await store.loadCatalogs(['org-1']);
    const catalog = store.getView().catalogs['org-1']!;
    expect([catalog.labels.length, [...(catalog.partial ?? [])].sort()]).toEqual([5000, ['labels', 'states']]);
    expect(partialNote('label', [catalog])).toBe('Linear has more labels than this menu lists; a view saved in Linear filters by any of them');
    expect(partialNote('status', [catalog])).toContain('more workflow states');
    expect(partialNote('assignee', [catalog])).toBeNull();
    expect(partialNote('priority', [catalog])).toBeNull();
  });

  test('past the bounds of a read (2,500 favorites, 2,000 teams) the sidebar and the team picker say Linear has more', async () => {
    const { store, world } = bigLinear();
    await store.refresh(true);
    await until(() => store.getView().viewsLoaded);
    expect([store.getView().favoritesCut, store.teamsCut.size]).toEqual([false, 0]);
    world.favorites = Array.from({ length: 2600 }, (_, n) => ({ id: `f${n}`, type: 'customView', sortOrder: n, customView: { id: `v${n % 1030}` }, project: null, issue: null }));
    world.teams = Array.from({ length: 2050 }, (_, n) => ({ id: `t${n}`, key: `T${n}`, name: `Team ${n}` }));
    await store.refresh(true);
    await until(() => store.getView().favoritesCut === true);
    expect(store.getView().favoritesCut).toBe(true);
    expect((await store.teams()).length).toBe(2000);
    expect([...store.teamsCut]).toEqual(['org-1']);
  });

  test("an issue's page says what Linear has more of than it read with it (labels, sub-issues, links, comments, activity)", () => {
    const more = { hasNextPage: true };
    const none = { hasNextPage: false };
    const detail = { ...issue(1, STATES[1]!), description: '', labels: { nodes: [], pageInfo: none }, comments: { nodes: [], pageInfo: more }, children: { nodes: [], pageInfo: more }, attachments: { nodes: [] }, history: { nodes: [], pageInfo: more } } as unknown as LinearIssueDetail;
    expect(issueDetailMore(detail)).toEqual(['sub-issues', 'comments', 'activity']);
    expect(issueDetailMore({ ...detail, comments: { nodes: [] }, children: { nodes: [] }, history: { nodes: [] } } as unknown as LinearIssueDetail)).toEqual([]);
  });
});
