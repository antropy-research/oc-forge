// The Linear the Linear scenarios run against, as tests/e2e/linear.mjs builds it: OpenChamber's workspace (two teams
// with their own workflows, people, labels, cycles, projects, a milestone, saved views of issues and of projects, one of
// 320 issues, favorites), a second workspace reached with an API key, and a big workspace for reads that page. Every one
// of the Planner's documents is answered, and filters are evaluated as Linear does (tests/e2e/linearFake.mjs), so what a
// window shows is what the filter it sent selects there.
import { makeFilters, page } from '../e2e/linearFake.mjs';
import { addDays, startOfWeek, todayIn } from '../../src/domain/core/dates.ts';
import { createServer, type AddressInfo } from 'node:net';
import type { LinearAnswer, LinearCall } from './planner.ts';

/** A zone whose midnight is hours away, so "today" holds while the scenarios run. */
export const calmZone = (): string =>
  ['UTC', 'Pacific/Kiritimati', 'Etc/GMT+12'].find((zone) => {
    const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
    return hour >= 1 && hour <= 21;
  }) ?? 'UTC';

const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
const S = (id: string, name: string, type: string, position: number) => ({ id, name, type, color: '#888888', position });
const strip = (issue: any) => {
  const { description: _d, comments: _c, attachments: _a, history: _h, subscribers: _s, relations: _r, bulk: _b, syncedWith = [], ...rest } = issue;
  return { ...rest, syncedWith };
};
/** Answers held until the test lets them through: as Linear had it when asked, but late. */
type Hold = { pick: (call: LinearCall) => boolean; release: () => void; reached: boolean; gate: Promise<void> };

/** Made-up keys in Linear's shapes, built at run time so secret scanners do not take them for real ones. */
export const fakeKey = (kind: 'api' | 'oauth', fill: string) => `lin_${kind}_${fill.repeat(40).slice(0, 40)}`;
export const KEYS = { side: fakeKey('api', 'side'), side2: fakeKey('api', 'sid2'), third: fakeKey('oauth', 'th'), host: fakeKey('api', 'host') };

export const harnessLinear = (zone: string) => {
  const today = todayIn(zone);
  const har = { id: 'team-har', key: 'HAR', name: 'Harness' };
  const ops = { id: 'team-ops', key: 'OPS', name: 'Operations' };
  const states: Record<string, ReturnType<typeof S>[]> = {
    [har.id]: [S('st-h-backlog', 'Backlog', 'backlog', 0), S('st-h-todo', 'Todo', 'unstarted', 1), S('st-h-prog', 'In Progress', 'started', 2), S('st-h-review', 'In Review', 'started', 3), S('st-h-done', 'Done', 'completed', 4), S('st-h-canceled', 'Canceled', 'canceled', 5)],
    // Shipped comes before Done on OPS's board: its first completed state.
    [ops.id]: [S('st-o-triage', 'Triage', 'triage', 0), S('st-o-backlog', 'Backlog', 'backlog', 1), S('st-o-ready', 'Ready', 'unstarted', 2), S('st-o-doing', 'Doing', 'started', 3), S('st-o-shipped', 'Shipped', 'completed', 4), S('st-o-done', 'Done', 'completed', 5), S('st-o-wont', "Won't do", 'canceled', 6)],
  };
  const viewer = { id: 'u-h', name: 'Harness User' };
  const members = [{ id: 'u-h', name: 'Harness User', displayName: 'harness', active: true }, { id: 'u-mate', name: 'Teammate', displayName: 'mate', active: true }, { id: 'u-ops', name: 'Ops Person', displayName: 'ops', active: true }];
  const person = (id: string | null) => (id ? { id, name: members.find((member) => member.id === id)!.name } : null);
  const labels = [
    { id: 'lbl-bug-h', name: 'Bug', color: '#eb5757', team: har },
    { id: 'lbl-bug-o', name: 'Bug', color: '#eb5757', team: ops },
    { id: 'lbl-feat', name: 'Feature', color: '#bb87fc', team: null },
    { id: 'lbl-inc', name: 'Incident', color: '#f2994a', team: ops },
  ];
  const label = (id: string) => (({ team: _team, ...rest }) => rest)(labels.find((item) => item.id === id)!);
  const project = (id: string, name: string, type: string, team: typeof har) => ({
    id, name, url: `https://linear.app/harness/project/${id}`, color: '#26b5ce', icon: null, description: `${name} in one line`, progress: 0.4, health: null, priority: 2, startDate: null, targetDate: null,
    createdAt: ago(900), updatedAt: ago(5), sortOrder: 1, completedAt: type === 'completed' ? ago(72) : null, canceledAt: null,
    status: { id: `ps-${type}`, name: type, type, color: '#f2c94c' }, lead: viewer, teams: { nodes: [team] },
  });
  const projects = [project('p1', 'Planner', 'started', har), project('p2', 'Ops Revamp', 'planned', ops), project('p3', 'Shipped Thing', 'completed', har)];
  const slimProject = (id: string | null) => (id ? (({ id: pid, name, color }) => ({ id: pid, name, color, icon: null }))(projects.find((item) => item.id === id)!) : null);
  const cycles = [
    { id: 'c7', number: 7, name: null, startsAt: ago(120), endsAt: ago(-216), isActive: true, isNext: false, team: har },
    { id: 'c8', number: 8, name: null, startsAt: ago(-216), endsAt: ago(-552), isActive: false, isNext: true, team: har },
  ];
  const slimCycle = (id: string | null) => (id ? (({ team: _team, startsAt: _s, endsAt: _e, ...rest }) => rest)(cycles.find((item) => item.id === id)!) : null);
  const milestones = [{ id: 'm1', name: 'Planner beta', targetDate: addDays(today, 14), project: { id: 'p1', name: 'Planner' } }];
  // Due dates around this week and the next, whichever day the week starts on.
  const mondayWeek = startOfWeek(today, 1);
  let sequence = 0;
  const issue = (team: typeof har, n: number, title: string, stateId: string, extra: Record<string, unknown> = {}) => {
    sequence += 1;
    return {
      id: `iss-${team.key.toLowerCase()}-${n}`, identifier: `${team.key}-${n}`, title: `harness ${title}`, url: `https://linear.app/harness/issue/${team.key}-${n}/x`,
      priority: 3, prioritySortOrder: sequence, sortOrder: sequence, estimate: null, dueDate: null, createdAt: ago(400 - sequence), updatedAt: ago(sequence), completedAt: null, canceledAt: null,
      branchName: `harness/${team.key.toLowerCase()}-${n}`, state: states[team.id]!.find((state) => state.id === stateId)!, team, assignee: person('u-h'), creator: person('u-h'),
      project: null, cycle: null, projectMilestone: null, parent: null, labels: { nodes: [] as any[] }, description: `Issue ${n}.`,
      comments: { nodes: [] as any[] }, attachments: { nodes: [] }, history: { nodes: [] }, subscribers: [] as string[], ...extra,
    } as Record<string, any>;
  };
  const issues = [
    issue(har, 1, 'plan the launch', 'st-h-todo', { priority: 2, project: slimProject('p1'), cycle: slimCycle('c7'), labels: { nodes: [label('lbl-bug-h')] }, dueDate: addDays(today, -2), subscribers: ['u-h'], estimate: 3, projectMilestone: { id: 'm1', name: 'Planner beta' }, relations: { blocking: ['iss-har-2'] } }),
    issue(har, 2, 'fix login', 'st-h-prog', { priority: 1, creator: person('u-mate'), labels: { nodes: [label('lbl-feat')] }, dueDate: today, project: slimProject('p1'), relations: { blockedBy: ['iss-har-1'] } }),
    issue(har, 3, 'write docs', 'st-h-backlog', { description: 'Document the Login flow, step by step.' }),
    issue(har, 4, 'review api', 'st-h-review', { priority: 4, assignee: person('u-mate'), labels: { nodes: [label('lbl-feat'), label('lbl-bug-h')] }, subscribers: ['u-h'], dueDate: addDays(mondayWeek, 13) }),
    issue(har, 5, 'shipped search', 'st-h-done', { completedAt: ago(48), dueDate: addDays(today, -3) }),
    issue(har, 6, 'dropped idea', 'st-h-canceled', { canceledAt: ago(24 * 40) }),
    issue(har, 7, 'unassigned task', 'st-h-todo', { priority: 0, assignee: null, labels: { nodes: [label('lbl-feat')] }, description: null }),
    issue(har, 8, 'sub task', 'st-h-todo', { parent: { id: 'iss-har-1', identifier: 'HAR-1', title: 'harness plan the launch' }, createdAt: ago(30) }),
    issue(har, 9, 'synced crash', 'st-h-todo', { syncedWith: [{ service: 'github', metadata: { owner: 'acme', repo: 'app', number: 12 } }] }),
    issue(ops, 1, 'ops triage alert', 'st-o-triage', { priority: 1, labels: { nodes: [label('lbl-inc')] } }),
    issue(ops, 2, 'ops ready runbook', 'st-o-ready', { labels: { nodes: [label('lbl-bug-o')] } }),
    issue(ops, 3, 'ops doing migration', 'st-o-doing', { project: slimProject('p2') }),
    issue(ops, 4, 'ops shipped cache', 'st-o-shipped', { completedAt: ago(24) }),
    issue(ops, 5, 'ops done cleanup', 'st-o-done', { assignee: person('u-ops'), completedAt: ago(24 * 10) }),
    issue(ops, 6, 'ops urgent bug', 'st-o-ready', { priority: 1, assignee: person('u-ops'), labels: { nodes: [label('lbl-bug-o')] }, dueDate: addDays(mondayWeek, 6) }),
  ];
  for (let n = 100; n < 420; n++) issues.push(issue(har, n, `bulk item ${n}`, n % 2 ? 'st-h-todo' : 'st-h-backlog', { assignee: person('u-mate'), bulk: true }));
  const find = (id: string) => issues.find((item) => item.id === id || item.identifier === String(id).toUpperCase());
  const filters = makeFilters({ viewerId: viewer.id, cycleFlags: (id) => slimCycle(id) ?? {}, childrenOf: (item: any) => issues.filter((other) => other.parent?.id === item.id) });
  const open = (item: any) => !['completed', 'canceled'].includes(item.state.type);
  const OR_FILTER = { or: [{ priority: { eq: 1 } }, { and: [{ assignee: { isMe: { eq: true } } }, { labels: { some: { id: { in: ['lbl-bug-h'] } } } }] }] };
  const view = (id: string, name: string, extra: Record<string, any>) => ({ id, name: `harness ${name}`, description: null, icon: null, color: null, shared: true, modelName: 'Issue', slugId: `slug-${id}`, updatedAt: ago(3), team: null, owner: viewer, filterData: {}, ...extra });
  const views: Record<string, any>[] = [
    view('v-open', 'Open work', { team: har, prefs: { layout: 'list', issueGrouping: 'workflowState', viewOrdering: 'priority', showCompletedIssues: 'none', showSubIssues: true }, holds: (i: any) => i.team.id === har.id && !i.bulk && open(i) }),
    view('v-done', 'Finished work', { prefs: { layout: 'list', issueGrouping: 'noGrouping', viewOrdering: 'updatedAt', showCompletedIssues: 'all' }, holds: (i: any) => !open(i) }),
    view('v-big', 'Bulk backlog', { team: har, prefs: { layout: 'list', issueGrouping: 'noGrouping', showCompletedIssues: 'all' }, holds: (i: any) => Boolean(i.bulk) }),
    view('v-board', 'Two-team board', { prefs: { layout: 'board', issueGrouping: 'assignee', issueSubGrouping: 'priority', viewOrdering: 'createdAt', viewOrderingDirection: 'asc', showCompletedIssues: 'all' }, holds: (i: any) => !i.bulk && i.state.type !== 'canceled' }),
    view('v-week', 'This week in Harness', { team: har, prefs: { layout: 'list', showCompletedIssues: 'week' }, holds: (i: any) => i.team.id === har.id && !i.bulk }),
    // A view that never chose which completed issues to show lists all its filter holds.
    view('v-plain', 'Plain', { team: har, prefs: { layout: 'board' }, holds: (i: any) => i.team.id === har.id && !i.bulk }),
    view('v-odd', 'Odd layout', { prefs: { layout: 'spreadsheet', issueGrouping: 'parent', viewOrdering: 'linkCount', showCompletedIssues: 'fortnight' }, holds: (i: any) => i.team.id === ops.id }),
    view('v-all', 'Everything', { prefs: { layout: 'list', showCompletedIssues: 'all' }, holds: (i: any) => !i.bulk }),
    view('v-or', 'Urgent or my bugs', { team: har, filterData: OR_FILTER, prefs: { layout: 'list', showCompletedIssues: 'all' }, holds: (i: any) => i.team.id === har.id && filters.matchIssue(i, views.find((v) => v.id === 'v-or')!.filterData) }),
    // Saved in Linear with a part the Planner's filters cannot edit (a status type) beside one they can (a label, by id).
    view('v-raw', 'Bugs not started', { team: har, filterData: { and: [{ state: { type: { nin: ['started'] } } }, { labels: { some: { id: { in: ['lbl-bug-h'] } } } }] }, prefs: { layout: 'list', showCompletedIssues: 'all' }, holds: (i: any) => i.team.id === har.id && !i.bulk && filters.matchIssue(i, views.find((v) => v.id === 'v-raw')!.filterData) }),
    view('v-proj', 'Project portfolio', { modelName: 'Project', prefs: { projectGrouping: 'status', projectViewOrdering: 'priority', showCompletedProjects: 'all' } }),
  ];
  const where = (list: any[], filter: unknown) => filters.issuesWhere(list, filter ?? null).map(strip);
  const meta = ({ prefs, holds: _h, ...rest }: Record<string, any>) => ({ ...rest, viewPreferencesValues: prefs });
  const detailed = (item: any) => ({
    ...strip(item), description: item.description,
    comments: { nodes: item.comments.nodes, pageInfo: { hasNextPage: false } }, attachments: { nodes: [], pageInfo: { hasNextPage: false } }, history: { nodes: [], pageInfo: { hasNextPage: false } },
    children: { nodes: issues.filter((other) => other.parent?.id === item.id).map((child) => ({ id: child.id, identifier: child.identifier, title: child.title, priority: child.priority, state: child.state, assignee: child.assignee })), pageInfo: { hasNextPage: false } },
  });
  const answer = (op: string | undefined, v: Record<string, any>): unknown => {
    switch (op) {
      case 'PlannerWhoAmI': return { viewer, organization: { id: 'org-h', name: 'Harness Org', urlKey: 'harness' } };
      case 'PlannerViews': return { customViews: page(views.map(({ prefs: _p, holds: _h, filterData: _f, ...rest }) => rest), 100, v.after) };
      case 'PlannerFavoriteViews': return { favorites: page([{ id: 'f1', type: 'customView', sortOrder: 1, customView: { id: 'v-open' }, project: null, issue: null }, { id: 'f2', type: 'project', sortOrder: 2, customView: null, project: projects[0], issue: null }], 250, v.after) };
      case 'PlannerView': { const found = views.find((item) => item.id === v.id); return { customView: found ? meta(found) : null }; }
      case 'PlannerViewIssues': { const found = views.find((item) => item.id === v.id); return { customView: found ? { id: found.id, issues: page(where(found.holds ? issues.filter(found.holds) : [], v.filter), 100, v.after) } : null }; }
      case 'PlannerViewProjects': { const found = views.find((item) => item.id === v.id); return { customView: found ? { id: found.id, projects: page(v.filter ? projects.filter((item) => filters.matchProject(item, v.filter)) : projects, 50, v.after) } : null }; }
      case 'PlannerSaveViewFilter': {
        const found = views.find((item) => item.id === v.id);
        if (!found) return { customViewUpdate: null };
        found.filterData = v.filterData;
        found.holds = (item: any) => (!found.team || item.team.id === found.team.id) && !item.bulk && filters.matchIssue(item, v.filterData);
        return { customViewUpdate: { success: true, customView: { id: found.id, updatedAt: new Date().toISOString() } } };
      }
      case 'PlannerAssigned': return { viewer: { ...viewer, assignedIssues: page(where(issues.filter((item) => item.assignee?.id === viewer.id), v.filter), 100, v.after) } };
      case 'PlannerCreated': return { viewer: { id: viewer.id, createdIssues: page(where(issues.filter((item) => item.creator?.id === viewer.id), v.filter), 100, v.after) } };
      case 'PlannerIssues': return { issues: page(where(issues, v.filter), 100, v.after) };
      case 'PlannerSearch': return { searchIssues: page(where(issues.filter((item) => item.title.toLowerCase().includes(String(v.term).toLowerCase())), v.filter), 50, v.after) };
      case 'PlannerLinked': return { issues: { nodes: issues.filter((item) => v.ids.includes(item.id)).map(strip) } };
      case 'PlannerIssue': return { issue: find(v.id) ? strip(find(v.id)) : null };
      case 'PlannerIssueDetail': return { issue: find(v.id) ? detailed(find(v.id)) : null };
      case 'PlannerTeams': return { viewer: { id: viewer.id }, teams: page([har, ops], 100, v.after) };
      case 'PlannerTeamStates': return { team: { id: v.id, states: { nodes: states[v.id] ?? [] } } };
      case 'PlannerTeamOptions': return {
        team: { id: v.id, cyclesEnabled: v.id === har.id, issueEstimationType: 'fibonacci', issueEstimationAllowZero: false, issueEstimationExtended: false,
          states: page(states[v.id] ?? [], 100), members: page(members, 250), labels: page(labels.filter((item) => item.team?.id === v.id).map((item) => label(item.id)), 250),
          cycles: page(cycles.filter((item) => item.team.id === v.id).map((item) => slimCycle(item.id)), 25), projects: page(projects.filter((item) => item.status.type !== 'completed').map((item) => slimProject(item.id)), 100) },
        issueLabels: page(labels.filter((item) => !item.team).map((item) => label(item.id)), 250),
      };
      case 'PlannerFilterTeams': return { teams: page([har, ops].map((team) => ({ ...team, states: { nodes: states[team.id], pageInfo: { hasNextPage: false } } })), 50, v.after) };
      case 'PlannerFilterUsers': return { users: page(members.map((member) => ({ ...member, isMe: member.id === viewer.id })), 250, v.after) };
      case 'PlannerFilterLabels': return { issueLabels: page(labels.map((item) => ({ ...label(item.id), isGroup: false, parent: null, team: item.team ? { id: item.team.id, key: item.team.key } : null })), 250, v.after) };
      case 'PlannerFilterProjects': return { projects: page(projects.map((item) => ({ ...slimProject(item.id), status: { type: item.status.type } })), 250, v.after) };
      case 'PlannerFilterCycles': return { cycles: page(cycles.map((item) => ({ ...item, team: { id: item.team.id, key: item.team.key } })), 250, v.after) };
      case 'PlannerFilterMilestones': return { projectMilestones: page(milestones, 250, v.after) };
      case 'PlannerProjects': return { projects: page(projects.filter((item) => item.status.type !== 'completed'), 50, v.after) };
      case 'PlannerProject': { const found = projects.find((item) => item.id === v.id); return { project: found ? { ...found, content: '', projectMilestones: { nodes: [], pageInfo: { hasNextPage: false } }, lastUpdate: null } : null }; }
      case 'PlannerSetState': {
        const found = find(v.id);
        const state = found && states[found.team.id]!.find((item) => item.id === v.stateId);
        if (!found || !state) return null;
        Object.assign(found, { state, completedAt: state.type === 'completed' ? new Date().toISOString() : null, updatedAt: new Date().toISOString() });
        return { issueUpdate: { success: true, issue: strip(found) } };
      }
      case 'PlannerUpdateIssue': {
        const found = find(v.id);
        const input = v.input ?? {};
        if (!found) return null;
        if ('stateId' in input) found.state = states[found.team.id]!.find((item) => item.id === input.stateId) ?? found.state;
        for (const field of ['title', 'description', 'priority', 'dueDate', 'estimate']) if (field in input) found[field] = input[field];
        if ('assigneeId' in input) found.assignee = person(input.assigneeId);
        if ('projectId' in input) found.project = slimProject(input.projectId);
        if ('cycleId' in input) found.cycle = slimCycle(input.cycleId);
        for (const id of input.addedLabelIds ?? []) if (!found.labels.nodes.some((item: any) => item.id === id)) found.labels.nodes.push(label(id));
        if (input.removedLabelIds) found.labels.nodes = found.labels.nodes.filter((item: any) => !input.removedLabelIds.includes(item.id));
        found.updatedAt = new Date().toISOString();
        return { issueUpdate: { success: true, issue: detailed(found) } };
      }
      case 'PlannerAddComment': {
        const found = find(v.input.issueId);
        if (!found) return null;
        const comment = { id: `c-${found.comments.nodes.length + 1}`, body: v.input.body, createdAt: new Date().toISOString(), editedAt: null, user: viewer, botActor: null, parent: null };
        found.comments.nodes.push(comment);
        return { commentCreate: { success: true, comment } };
      }
      case 'PlannerCreateIssue': {
        const team = [har, ops].find((item) => item.id === v.input.teamId)!;
        const made = issue(team, 50 + issues.filter((item) => item.team.id === team.id && !item.bulk).length, '', team.id === har.id ? 'st-h-todo' : 'st-o-ready', { title: v.input.title, priority: v.input.priority, assignee: person(v.input.assigneeId ?? null), dueDate: v.input.dueDate ?? null, description: v.input.description ?? '' });
        issues.push(made);
        return { issueCreate: { success: true, issue: strip(made) } };
      }
      default: return undefined;
    }
  };

  // The second workspace, reached with an API key (the service's own requests); OAuth tokens reach a third.
  const sideTeam = { id: 'team-side', key: 'SIDE', name: 'Side Team' };
  const sideStates = [S('st-s-todo', 'Todo', 'unstarted', 0), S('st-s-prog', 'In Progress', 'started', 1), S('st-s-done', 'Done', 'completed', 2)];
  const sideViewer = { id: 'u-side', name: 'Side Me' };
  const sideIssue = (n: number) => ({ ...strip(issue(har, n, '', 'st-h-todo')), id: `side-${n}`, identifier: `SIDE-${n}`, title: `side issue ${n}`, url: `https://linear.app/side/issue/SIDE-${n}/x`, branchName: `side/side-${n}`, state: sideStates[0], team: sideTeam, assignee: sideViewer, creator: sideViewer, labels: { nodes: [] } });
  const side = { issues: [sideIssue(1), sideIssue(2)] as any[] };
  const sideFilters = makeFilters({ viewerId: sideViewer.id });
  const orgs: Record<string, { id: string; name: string; urlKey: string }> = { side: { id: 'org-side', name: 'Side Org', urlKey: 'side' }, third: { id: 'org-third', name: 'Third Org', urlKey: 'third' }, host: { id: 'org-h', name: 'Harness Org', urlKey: 'harness' } };
  const orgOf = (key: string | null) => {
    const raw = String(key ?? '').replace(/^Bearer /, '');
    return raw === KEYS.side || raw === KEYS.side2 ? orgs.side : raw === KEYS.third ? orgs.third : raw === KEYS.host ? orgs.host : null;
  };
  const answerKeyed = (call: LinearCall): unknown => {
    const org = orgOf(call.key);
    const v = call.variables as Record<string, any>;
    if (!org) return null;
    if (call.op === 'PlannerWhoAmI') return { viewer: sideViewer, organization: org };
    if (org !== orgs.side) return call.op === 'PlannerViews' ? { customViews: page([], 100) } : call.op === 'PlannerFavoriteViews' ? { favorites: page([], 250) } : call.op === 'PlannerLinked' ? { issues: { nodes: [] } } : call.op === 'PlannerAssigned' ? { viewer: { ...sideViewer, assignedIssues: page([], 100) } } : null;
    const listed = (filter: unknown) => sideFilters.issuesWhere(side.issues, filter ?? null);
    switch (call.op) {
      case 'PlannerAssigned': return { viewer: { ...sideViewer, assignedIssues: page(listed(v.filter), 100, v.after) } };
      case 'PlannerViews': return { customViews: page([], 100) };
      case 'PlannerFavoriteViews': return { favorites: page([], 250) };
      case 'PlannerLinked': return { issues: { nodes: side.issues.filter((item) => v.ids.includes(item.id)) } };
      case 'PlannerIssue': return { issue: side.issues.find((item) => item.id === v.id || item.identifier === v.id) ?? null };
      case 'PlannerTeamStates': return { team: { id: v.id, states: { nodes: sideStates } } };
      case 'PlannerSetState': {
        const found = side.issues.find((item) => item.id === v.id);
        if (found) found.state = sideStates.find((item) => item.id === v.stateId) ?? found.state;
        return found ? { issueUpdate: { success: true, issue: found } } : null;
      }
      case 'PlannerUpdateIssue': return { issueUpdate: { success: true, issue: { ...side.issues[0], description: '', comments: { nodes: [] }, children: { nodes: [] }, attachments: { nodes: [] }, history: { nodes: [] } } } };
      case 'PlannerAddComment': return { commentCreate: { success: true, comment: { id: 'c-side', body: v.input.body, createdAt: new Date().toISOString(), editedAt: null, user: sideViewer, botActor: null, parent: null } } };
      case 'PlannerFilterTeams': return { teams: page([{ ...sideTeam, states: { nodes: sideStates, pageInfo: { hasNextPage: false } } }], 50) };
      case 'PlannerFilterUsers': return { users: page([{ ...sideViewer, displayName: 'side', active: true, isMe: true }], 250) };
      case 'PlannerFilterLabels': return { issueLabels: page([], 250) };
      case 'PlannerFilterProjects': return { projects: page([], 250) };
      case 'PlannerFilterCycles': return { cycles: page([], 250) };
      case 'PlannerFilterMilestones': return { projectMilestones: page([], 250) };
      default: return null;
    }
  };

  const control = controlled((call) => (call.key === null ? answer(call.op, call.variables as Record<string, any>) : answerKeyed(call)));
  /** More of the second workspace's issues, assigned to me there (SIDE-100 on). */
  const addSideIssues = (count: number) => side.issues.push(...Array.from({ length: count }, (_, n) => sideIssue(100 + n)));
  return { today, har, ops, states, viewer, issues, views, side, find, mondayWeek, addSideIssues, world: { org: orgs.host!, viewer, issues, views } as any, ...control };
};

/**
 * A world's answers, with a test's say first: `intercept` answers instead (null: Linear answers with an error,
 * undefined: the world's own), and the first answer a `hold` picks waits, as Linear had it when asked, until released.
 */
const controlled = (base: (call: LinearCall) => unknown) => {
  const holds: Hold[] = [];
  let intercept: ((call: LinearCall) => unknown) | null = null;
  const linearAnswer: LinearAnswer = async (call) => {
    const custom = intercept?.(call);
    const data = custom !== undefined ? custom : base(call);
    const held = holds.find((item) => !item.reached && item.pick(call));
    if (held) {
      held.reached = true;
      await held.gate;
    }
    return data ?? null;
  };
  return {
    linearAnswer,
    intercept: (next: typeof intercept) => void (intercept = next),
    hold: (pick: Hold['pick']): Hold => {
      let release = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      const held: Hold = { pick, release: () => release(), reached: false, gate };
      holds.push(held);
      return held;
    },
  };
};

/** A big workspace: 560 open projects, 1,030 views, 260 favorites, 130 teams; a team of 300 people and 260 labels; 255 workspace labels; 5,100 labels in all. */
export const bigLinear = () => {
  const team = { id: 'team-big', key: 'BIG', name: 'Big Team' };
  const states = [S('b-todo', 'Todo', 'unstarted', 0), S('b-done', 'Done', 'completed', 1)];
  const named = (prefix: string, n: number) => ({ id: `${prefix}${n}`, name: `${prefix} ${String(n).padStart(4, '0')}`, color: '#123456' });
  const world = {
    org: { id: 'org-big', name: 'Big Org', urlKey: 'big' }, viewer: { id: 'u-big', name: 'Big Me' }, issues: [] as any[],
    projects: Array.from({ length: 560 }, (_, n) => ({ id: `p${n}`, name: `Project ${n}`, url: `https://linear.app/big/project/p${n}`, color: '#000', icon: null, description: '', progress: 0, health: null, priority: 0, startDate: null, targetDate: null, updatedAt: '', status: { id: 's', name: 'Started', type: 'started', color: '#000' }, lead: null, teams: { nodes: [] } })),
    views: Array.from({ length: 1030 }, (_, n) => ({ id: `v${n}`, name: `View ${String(n).padStart(4, '0')}`, description: null, icon: null, color: null, shared: true, modelName: 'Issue', slugId: `s${n}`, updatedAt: '', team, owner: null })),
    favorites: Array.from({ length: 260 }, (_, n) => ({ id: `f${n}`, type: 'customView', sortOrder: n, customView: { id: `v${1029 - n}` }, project: null, issue: null })),
    teams: Array.from({ length: 130 }, (_, n) => ({ id: `t${n}`, key: `T${n}`, name: `Team ${n}` })),
    members: Array.from({ length: 300 }, (_, n) => ({ id: `m${n}`, name: `Member ${String(n).padStart(3, '0')}`, displayName: `m${n}`, active: true })),
    teamLabels: Array.from({ length: 260 }, (_, n) => named('team', n)),
    workspaceLabels: Array.from({ length: 255 }, (_, n) => named('ws', n)),
    allLabels: Array.from({ length: 5100 }, (_, n) => ({ ...named('all', n), isGroup: false, parent: null, team: null })),
  };
  const more = { hasNextPage: true };
  const control = controlled((call) => {
    const v = call.variables as Record<string, any>;
    switch (call.op) {
      case 'PlannerWhoAmI': return { viewer: world.viewer, organization: world.org };
      case 'PlannerLinked': return { issues: { nodes: [] } };
      case 'PlannerProjects': return { projects: page(world.projects, 50, v.after) };
      case 'PlannerViews': return { customViews: page(world.views, 100, v.after) };
      case 'PlannerFavoriteViews': return { favorites: page(world.favorites, 250, v.after) };
      case 'PlannerTeams': return { viewer: { id: world.viewer.id }, teams: page(world.teams, 100, v.after) };
      case 'PlannerTeamOptions': return { team: { id: v.id, states: page(states, 100), members: page(world.members, 250), labels: page(world.teamLabels, 250), cycles: page([], 25), projects: page([], 100) }, issueLabels: page(world.workspaceLabels, 250) };
      case 'PlannerTeamOptionPage': {
        const field = /team\(id: \$id\) \{ id (\w+)\(/.exec(call.query)![1]!;
        const all: Record<string, unknown[]> = { members: world.members, labels: world.teamLabels, states, cycles: [], projects: [] };
        return { team: { id: v.id, [field]: page(all[field]!, 250, v.after) } };
      }
      case 'PlannerWorkspaceLabels': return { issueLabels: page(world.workspaceLabels, 250, v.after) };
      case 'PlannerFilterTeams': return { teams: page([{ ...team, states: { nodes: states, pageInfo: more } }], 50, v.after) };
      case 'PlannerFilterUsers': return { users: page([{ ...world.members[0], isMe: true }], 250, v.after) };
      case 'PlannerFilterLabels': return { issueLabels: page(world.allLabels, 250, v.after) };
      case 'PlannerFilterProjects': return { projects: page([], 250) };
      case 'PlannerFilterCycles': return { cycles: page([], 250) };
      case 'PlannerFilterMilestones': return { projectMilestones: page([], 250) };
      // An issue with more comments, sub-issues and activity than its page reads.
      case 'PlannerIssueDetail': return { issue: { id: 'big-1', identifier: 'BIG-1', title: 'big', url: 'https://linear.app/big/issue/BIG-1', priority: 0, dueDate: null, updatedAt: '', state: states[0], team, project: null, cycle: null, description: '', labels: { nodes: [], pageInfo: { hasNextPage: false } }, comments: { nodes: [], pageInfo: more }, children: { nodes: [], pageInfo: more }, attachments: { nodes: [], pageInfo: { hasNextPage: false } }, history: { nodes: [], pageInfo: more } } };
      default: return null;
    }
  });
  return { world, team, ...control };
};

/** A loopback address nothing listens on: Linear is out of reach. */
export const unreachable = async (): Promise<string> => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}/`;
};
