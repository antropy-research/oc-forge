// The Linear page, Linear's way, in the dev container's OpenChamber with this checkout's
// build (see harness.mjs): saved views as saved (a completed-only view, a 320-issue view read
// page by page, a view of projects), the sidebar, filters from the keyboard sent to Linear as
// an IssueFilter, a chip's operator, the issue view's properties with S / A / L / P / Shift D
// and J / K, and a board of two teams' exact workflow states; Linear's advanced filters (all /
// any, nested groups, content, subscribers, relations) built from the UI, a saved view whose
// filter is an "or" of groups, and the page at 1024×768 with OpenChamber's sidebar open (its
// own sidebar behind a toggle, "/" into the header's search).
// Run on the host after `bun run build`: node extensions/planner/tests/e2e/linear.mjs [outDir]
import { startHarness } from './harness.mjs';
import { makeFilters, page } from './linearFake.mjs';

const out = process.argv[2] ?? '/tmp/opencode/planner-linear';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// ── A Linear workspace in memory ────────────────────────────────────────────
const ZONE = 'America/Los_Angeles';
const dayKey = (offset) => new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(new Date(Date.now() + offset * 86_400_000));
const ago = (hours) => new Date(Date.now() - hours * 3_600_000).toISOString();
const S = (id, name, type, position, color) => ({ id, name, type, color, position });
const har = { id: 'team-har', key: 'HAR', name: 'Harness' };
const ops = { id: 'team-ops', key: 'OPS', name: 'Operations' };
const harStates = [S('st-h-backlog', 'Backlog', 'backlog', 0, '#bec2c8'), S('st-h-todo', 'Todo', 'unstarted', 1, '#e2e2e2'), S('st-h-prog', 'In Progress', 'started', 2, '#f2c94c'), S('st-h-review', 'In Review', 'started', 3, '#0f783c'), S('st-h-done', 'Done', 'completed', 4, '#5e6ad2'), S('st-h-canceled', 'Canceled', 'canceled', 5, '#95a2b3')];
const opsStates = [S('st-o-triage', 'Triage', 'triage', 0, '#fc7840'), S('st-o-backlog', 'Backlog', 'backlog', 1, '#bec2c8'), S('st-o-ready', 'Ready', 'unstarted', 2, '#e2e2e2'), S('st-o-doing', 'Doing', 'started', 3, '#f2c94c'), S('st-o-shipped', 'Shipped', 'completed', 4, '#4cb782'), S('st-o-done', 'Done', 'completed', 5, '#5e6ad2'), S('st-o-wont', "Won't do", 'canceled', 6, '#95a2b3')];
const statesOf = (teamId) => (teamId === har.id ? harStates : opsStates);
const viewer = { id: 'u-h', name: 'Harness User' };
const members = [{ id: 'u-h', name: 'Harness User', displayName: 'harness', active: true }, { id: 'u-mate', name: 'Teammate', displayName: 'mate', active: true }, { id: 'u-ops', name: 'Ops Person', displayName: 'ops', active: true }];
const person = (id) => (id ? { id, name: members.find((member) => member.id === id).name } : null);
const labels = [
  { id: 'lbl-bug-h', name: 'Bug', color: '#eb5757', team: har },
  { id: 'lbl-bug-o', name: 'Bug', color: '#eb5757', team: ops },
  { id: 'lbl-feat', name: 'Feature', color: '#bb87fc', team: null },
  { id: 'lbl-inc', name: 'Incident', color: '#f2994a', team: ops },
];
const label = (id) => { const { team: _team, ...rest } = labels.find((item) => item.id === id); return rest; };
const project = (id, name, type, extra = {}) => ({
  id, name, url: `https://linear.app/harness/project/${id}`, color: { p1: '#26b5ce', p2: '#f2994a', p3: '#4cb782' }[id], icon: null, description: `${name} in one line`, progress: { p1: 0.4, p2: 0.1, p3: 1 }[id], health: type === 'started' ? 'onTrack' : null, priority: 2,
  startDate: dayKey(-30), targetDate: dayKey(30), createdAt: ago(900), updatedAt: ago(5), sortOrder: { p1: 1, p2: 2, p3: 3 }[id], completedAt: type === 'completed' ? ago(72) : null, canceledAt: null,
  status: { id: `ps-${type}`, name: { started: 'In Progress', planned: 'Planned', completed: 'Completed' }[type], type, color: '#f2c94c' }, lead: viewer, teams: { nodes: [id === 'p2' ? ops : har] }, ...extra,
});
const projects = [project('p1', 'Planner', 'started'), project('p2', 'Ops Revamp', 'planned'), project('p3', 'Shipped Thing', 'completed')];
const slimProject = (id) => { const p = projects.find((item) => item.id === id); return p ? { id: p.id, name: p.name, color: p.color, icon: null } : null; };
const cycles = [
  { id: 'c7', number: 7, name: null, startsAt: ago(24 * 5), endsAt: new Date(Date.now() + 9 * 86_400_000).toISOString(), isActive: true, isNext: false, team: har },
  { id: 'c8', number: 8, name: null, startsAt: new Date(Date.now() + 9 * 86_400_000).toISOString(), endsAt: new Date(Date.now() + 23 * 86_400_000).toISOString(), isActive: false, isNext: true, team: har },
];
const slimCycle = (id) => { const c = cycles.find((item) => item.id === id); return c ? { id: c.id, number: c.number, name: c.name, isActive: c.isActive, isNext: c.isNext } : null; };

let sequence = 0;
const issue = (team, number, title, stateId, extra = {}) => {
  sequence += 1;
  return {
    id: `iss-${team.key.toLowerCase()}-${number}`, identifier: `${team.key}-${number}`, title: `harness ${title}`, url: `https://linear.app/harness/issue/${team.key}-${number}/x`,
    priority: 3, prioritySortOrder: sequence, sortOrder: sequence, estimate: null, dueDate: null, createdAt: ago(400 - sequence), updatedAt: ago(sequence % 97), completedAt: null, canceledAt: null,
    branchName: `harness/${team.key.toLowerCase()}-${number}`, state: statesOf(team.id).find((state) => state.id === stateId), team, assignee: person('u-h'), creator: person('u-h'),
    project: null, cycle: null, parent: null, labels: { nodes: [] }, syncedWith: [], description: `Issue ${number}.\n\n- [ ] first\n- [x] second`,
    comments: { nodes: [] }, attachments: { nodes: [] }, history: { nodes: [] }, subscribers: [], ...extra,
  };
};
const milestones = [{ id: 'm1', name: 'Planner beta', targetDate: dayKey(14), project: { id: 'p1', name: 'Planner' } }];
const issues = [
  issue(har, 1, 'plan the launch', 'st-h-todo', { priority: 2, project: slimProject('p1'), cycle: slimCycle('c7'), labels: { nodes: [label('lbl-bug-h')] }, dueDate: dayKey(-2), subscribers: ['u-h'], estimate: 3,
    projectMilestone: { id: 'm1', name: 'Planner beta' }, relations: { blocking: ['iss-har-2'] },
    attachments: { nodes: [{ id: 'att-1', title: 'Pull request #12: Launch plan', subtitle: 'Open', url: 'https://github.com/harness/app/pull/12', sourceType: 'github' }] },
    comments: { nodes: [{ id: 'c-1', body: 'Looks good, **ship it**', createdAt: ago(30), editedAt: null, user: person('u-mate'), botActor: null, parent: null }] },
    history: { nodes: [{ id: 'h-1', createdAt: ago(48), actor: person('u-mate'), botActor: null, fromState: { name: 'Backlog', color: '#bec2c8', type: 'backlog' }, toState: { name: 'Todo', color: '#e2e2e2', type: 'unstarted' }, fromAssignee: null, toAssignee: null, fromPriority: null, toPriority: null, fromTitle: null, toTitle: null, addedLabels: null, removedLabels: null, fromDueDate: null, toDueDate: null, fromProject: null, toProject: null, fromCycle: null, toCycle: null, fromEstimate: null, toEstimate: null, updatedDescription: null }] } }),
  issue(har, 2, 'fix login', 'st-h-prog', { priority: 1, creator: person('u-mate'), labels: { nodes: [label('lbl-feat')] }, dueDate: dayKey(0), project: slimProject('p1'), relations: { blockedBy: ['iss-har-1'] } }),
  issue(har, 3, 'write docs', 'st-h-backlog', { priority: 3, description: 'Document the Login flow, step by step.' }),
  issue(har, 4, 'review api', 'st-h-review', { priority: 4, assignee: person('u-mate'), labels: { nodes: [label('lbl-feat'), label('lbl-bug-h')] }, subscribers: ['u-h'] }),
  issue(har, 5, 'shipped search', 'st-h-done', { completedAt: ago(48) }),
  issue(har, 6, 'dropped idea', 'st-h-canceled', { canceledAt: ago(24 * 40) }),
  issue(har, 7, 'unassigned task', 'st-h-todo', { priority: 0, assignee: null, labels: { nodes: [label('lbl-feat')] } }),
  issue(har, 8, 'sub task', 'st-h-todo', { parent: { id: 'iss-har-1', identifier: 'HAR-1', title: 'harness plan the launch' } }),
  issue(ops, 1, 'ops triage alert', 'st-o-triage', { priority: 1, labels: { nodes: [label('lbl-inc')] } }),
  issue(ops, 2, 'ops ready runbook', 'st-o-ready', { labels: { nodes: [label('lbl-bug-o')] } }),
  issue(ops, 3, 'ops doing migration', 'st-o-doing', { project: slimProject('p2') }),
  issue(ops, 4, 'ops shipped cache', 'st-o-shipped', { completedAt: ago(24) }),
  issue(ops, 5, 'ops done cleanup', 'st-o-done', { assignee: person('u-ops'), completedAt: ago(24 * 10) }),
  issue(ops, 6, 'ops urgent bug', 'st-o-ready', { priority: 1, assignee: person('u-ops'), labels: { nodes: [label('lbl-bug-o')] } }),
];
for (let n = 100; n < 420; n++) issues.push(issue(har, n, `bulk item ${n}`, n % 2 ? 'st-h-todo' : 'st-h-backlog', { assignee: person('u-mate'), creator: person('u-mate'), priority: n % 5, bulk: true }));
const byKey = (key) => issues.find((item) => item.identifier === key);

const view = (id, name, extra) => ({ id, name: `harness ${name}`, description: null, icon: null, color: null, shared: true, modelName: 'Issue', slugId: `slug-${id}`, updatedAt: ago(3), team: null, owner: viewer, filterData: {}, ...extra });
const OR_FILTER = { or: [{ priority: { eq: 1 } }, { and: [{ assignee: { isMe: { eq: true } } }, { labels: { some: { id: { in: ['lbl-bug-h'] } } } }] }] };
const views = [
  view('v-open', 'Open work', { team: har, description: 'Everything open in Harness', prefs: { layout: 'list', issueGrouping: 'workflowState', issueSubGrouping: null, viewOrdering: 'priority', showCompletedIssues: 'none', showSubIssues: true }, holds: (i) => i.team.id === har.id && !i.bulk && !['completed', 'canceled'].includes(i.state.type) }),
  view('v-done', 'Finished work', { prefs: { layout: 'list', issueGrouping: 'noGrouping', viewOrdering: 'updatedAt', showCompletedIssues: 'all' }, holds: (i) => ['completed', 'canceled'].includes(i.state.type) }),
  view('v-big', 'Bulk backlog', { team: har, prefs: { layout: 'list', issueGrouping: 'noGrouping', viewOrdering: 'createdAt', showCompletedIssues: 'all' }, holds: (i) => Boolean(i.bulk) }),
  view('v-board', 'Two-team board', { prefs: { layout: 'board', issueGrouping: 'workflowState', viewOrdering: 'priority', showCompletedIssues: 'all', showEmptyGroupsBoard: true }, holds: (i) => !i.bulk && i.state.type !== 'canceled' }),
  view('v-proj', 'Project portfolio', { modelName: 'Project', prefs: { projectLayout: 'list', projectGrouping: 'status', projectViewOrdering: 'priority', showCompletedProjects: 'all' }, holdsProject: () => true }),
  view('v-mine', 'My bugs', { shared: false, prefs: { layout: 'list', issueGrouping: 'priority', showCompletedIssues: 'week' }, holds: (i) => i.labels.nodes.some((l) => l.name === 'Bug') }),
  // Every issue, so a filter built in the page can be checked against the fake's own evaluation of the whole world.
  view('v-all', 'Everything', { prefs: { layout: 'list', issueGrouping: 'noGrouping', viewOrdering: 'createdAt', showCompletedIssues: 'all' }, holds: () => true }),
  // A view saved in Linear with an advanced filter: an "or" of a rule and a group (Linear keeps labels by id).
  view('v-or', 'Urgent or my bugs', { team: har, filterData: OR_FILTER, prefs: { layout: 'list', issueGrouping: 'noGrouping', viewOrdering: 'priority', showCompletedIssues: 'all' }, holds: (i) => i.team.id === har.id && matchIssue(i, OR_FILTER) }),
];
const world = { org: { id: 'org-h', name: 'Harness Org', urlKey: 'harness' }, viewer, teams: [har, ops], members, issues, views };

// Linear's filters, evaluated the way Linear does.
const { matchIssue, matchProject, issuesWhere: filtered } = makeFilters({ viewerId: viewer.id, cycleFlags: (id) => slimCycle(id) ?? {}, childrenOf: (item) => issues.filter((other) => other.parent?.id === item.id) });
const listed = ({ description: _d, comments: _c, attachments: _a, history: _h, subscribers: _s, relations: _r, bulk: _b, ...rest }) => rest;
const detailed = (item) => {
  const { subscribers: _s, relations: _r, bulk: _b, ...rest } = item;
  const children = issues.filter((other) => other.parent?.id === item.id).map((child) => ({ id: child.id, identifier: child.identifier, title: child.title, priority: child.priority, state: child.state, assignee: child.assignee }));
  return { ...rest, children: { nodes: children } };
};
const find = (id) => issues.find((item) => item.id === id || item.identifier === id);
const viewMeta = ({ prefs, holds: _h, holdsProject: _hp, ...meta }) => ({ ...meta, viewPreferencesValues: prefs });
const stateOf = (item, stateId) => statesOf(item.team.id).find((state) => state.id === stateId);

const answer = (op, variables) => {
  switch (op) {
    case 'PlannerWhoAmI': return { viewer, organization: world.org };
    case 'PlannerViews': return { customViews: page(views.map(({ prefs: _p, holds: _h, holdsProject: _hp, filterData: _f, ...meta }) => meta), 100, variables.after) };
    case 'PlannerFavoriteViews': return { favorites: { nodes: [
      { id: 'f1', type: 'customView', sortOrder: 1, customView: { id: 'v-open' }, project: null, issue: null },
      { id: 'f2', type: 'project', sortOrder: 2, customView: null, project: projects[0], issue: null },
      { id: 'f3', type: 'issue', sortOrder: 3, customView: null, project: null, issue: (({ id, identifier, title, url, state, team }) => ({ id, identifier, title, url, state, team }))(byKey('HAR-2')) },
    ] } };
    case 'PlannerView': {
      const found = views.find((item) => item.id === variables.id);
      return { customView: found ? viewMeta(found) : null };
    }
    case 'PlannerViewIssues': {
      const found = views.find((item) => item.id === variables.id);
      if (!found) return { customView: null };
      const held = found.holds ? issues.filter(found.holds) : [];
      return { customView: { id: found.id, issues: page(filtered(held, variables.filter).map(listed), 100, variables.after) } };
    }
    case 'PlannerSaveViewFilter': {
      // Linear's Save: the view keeps the filters sent, and holds what they match (within its team).
      const found = views.find((item) => item.id === variables.id);
      if (!found) return { customViewUpdate: null };
      found.filterData = variables.filterData;
      found.holds = (item) => (!found.team || item.team.id === found.team.id) && matchIssue(item, variables.filterData);
      return { customViewUpdate: { success: true, customView: { id: found.id, updatedAt: new Date().toISOString() } } };
    }
    case 'PlannerViewProjects': {
      const found = views.find((item) => item.id === variables.id);
      if (!found) return { customView: null };
      const held = found.holdsProject ? projects.filter(found.holdsProject) : [];
      return { customView: { id: found.id, projects: page(variables.filter ? held.filter((item) => matchProject(item, variables.filter)) : held, 50, variables.after) } };
    }
    case 'PlannerAssigned': return { viewer: { ...viewer, assignedIssues: page(filtered(issues.filter((item) => item.assignee?.id === viewer.id), variables.filter).map(listed), 100, variables.after) } };
    case 'PlannerCreated': return { viewer: { id: viewer.id, createdIssues: page(filtered(issues.filter((item) => item.creator?.id === viewer.id), variables.filter).map(listed), 100, variables.after) } };
    case 'PlannerIssues': return { issues: page(filtered(issues, variables.filter).map(listed), 100, variables.after) };
    case 'PlannerSearch': return { searchIssues: page(filtered(issues.filter((item) => item.title.includes(variables.term)), variables.filter).map(listed), 50, variables.after) };
    case 'PlannerLinked': return { issues: { nodes: issues.filter((item) => variables.ids.includes(item.id)).map(listed) } };
    case 'PlannerIssue': return { issue: find(variables.id) ? listed(find(variables.id)) : null };
    case 'PlannerIssueDetail': return { issue: find(variables.id) ? detailed(find(variables.id)) : null };
    case 'PlannerTeams': return { viewer: { id: viewer.id }, teams: { nodes: world.teams } };
    case 'PlannerTeamStates': return { team: { id: variables.id, states: { nodes: statesOf(variables.id) } } };
    case 'PlannerTeamOptions': return {
      team: {
        id: variables.id, cyclesEnabled: variables.id === har.id, issueEstimationType: 'fibonacci', issueEstimationAllowZero: false, issueEstimationExtended: false,
        states: { nodes: statesOf(variables.id) }, members: { nodes: members }, labels: { nodes: labels.filter((item) => item.team?.id === variables.id).map((item) => label(item.id)) },
        cycles: { nodes: cycles.filter((item) => item.team.id === variables.id).map(({ team: _t, ...rest }) => rest) },
        projects: { nodes: projects.filter((item) => item.status.type !== 'completed' && item.teams.nodes.some((team) => team.id === variables.id)).map((item) => slimProject(item.id)) },
      },
      issueLabels: { nodes: labels.filter((item) => !item.team).map((item) => label(item.id)) },
    };
    case 'PlannerFilterTeams': return { teams: page(world.teams.map((team) => ({ ...team, states: { nodes: statesOf(team.id) } })), 50, variables.after) };
    case 'PlannerFilterUsers': return { users: page(members.map((member) => ({ ...member, isMe: member.id === viewer.id })), 250, variables.after) };
    case 'PlannerFilterLabels': return { issueLabels: page(labels.map((item) => ({ ...label(item.id), isGroup: false, parent: null, team: item.team ? { id: item.team.id, key: item.team.key } : null })), 250, variables.after) };
    case 'PlannerFilterProjects': return { projects: page(projects.map((item) => ({ id: item.id, name: item.name, color: item.color, icon: null, status: { type: item.status.type } })), 250, variables.after) };
    case 'PlannerFilterCycles': return { cycles: page(cycles.map((item) => ({ ...item, team: { id: item.team.id, key: item.team.key } })), 250, variables.after) };
    case 'PlannerFilterMilestones': return { projectMilestones: page(milestones, 250, variables.after) };
    case 'PlannerProjects': return { projects: page(projects.filter((item) => !['completed', 'canceled'].includes(item.status.type)), 50, variables.after) };
    case 'PlannerProject': {
      const found = projects.find((item) => item.id === variables.id);
      return { project: found ? { ...found, content: `${found.name} long description`, projectMilestones: { nodes: [{ id: 'm1', name: `${found.name} beta`, targetDate: dayKey(14), progress: 0.5, sortOrder: 1 }] }, lastUpdate: null } : null };
    }
    case 'PlannerSetState': {
      const found = find(variables.id);
      const state = found && stateOf(found, variables.stateId);
      if (!found || !state) return null;
      found.state = state;
      found.completedAt = state.type === 'completed' ? new Date().toISOString() : null;
      found.updatedAt = new Date().toISOString();
      return { issueUpdate: { success: true, issue: listed(found) } };
    }
    case 'PlannerUpdateIssue': {
      const found = find(variables.id);
      const input = variables.input ?? {};
      if (!found) return null;
      if ('stateId' in input) {
        const state = stateOf(found, input.stateId);
        if (!state) return null;
        found.state = state;
      }
      for (const field of ['title', 'description', 'priority', 'dueDate', 'estimate']) if (field in input) found[field] = input[field];
      if ('assigneeId' in input) found.assignee = person(input.assigneeId);
      if ('projectId' in input) found.project = slimProject(input.projectId);
      if ('cycleId' in input) found.cycle = slimCycle(input.cycleId);
      for (const id of input.addedLabelIds ?? []) if (!found.labels.nodes.some((item) => item.id === id)) found.labels.nodes.push(label(id));
      if (input.removedLabelIds) found.labels.nodes = found.labels.nodes.filter((item) => !input.removedLabelIds.includes(item.id));
      found.updatedAt = new Date().toISOString();
      return { issueUpdate: { success: true, issue: detailed(found) } };
    }
    case 'PlannerAddComment': {
      const found = find(variables.input.issueId);
      if (!found) return null;
      const comment = { id: `c-${found.comments.nodes.length + 10}`, body: variables.input.body, createdAt: new Date().toISOString(), editedAt: null, user: viewer, botActor: null, parent: null };
      found.comments.nodes.push(comment);
      return { commentCreate: { success: true, comment } };
    }
    default: return undefined;
  }
};

// A second workspace, added with an API key: the service's workspace routes answer for it.
const sideWorkspace = { id: 'org-side', name: 'Side Org', urlKey: 'side', account: 'Side Me', addedAt: new Date().toISOString() };
const sideTeam = { id: 'team-side', key: 'SIDE', name: 'Side Team' };
const sideStates = [S('st-s-backlog', 'Backlog', 'backlog', 0, '#bec2c8'), S('st-s-todo', 'Todo', 'unstarted', 1, '#e2e2e2'), S('st-s-prog', 'In Progress', 'started', 2, '#f2c94c'), S('st-s-done', 'Done', 'completed', 3, '#5e6ad2')];
const sideViewer = { id: 'u-side', name: 'Side Me' };
const sideIssues = [1, 2].map((n) => ({
  id: `side-${n}`, identifier: `SIDE-${n}`, title: `harness side issue ${n}`, url: `https://linear.app/side/issue/SIDE-${n}/x`, priority: 2, prioritySortOrder: n, sortOrder: n, estimate: null, dueDate: null,
  createdAt: ago(10 + n), updatedAt: ago(n), completedAt: null, canceledAt: null, branchName: `side/side-${n}`, state: sideStates[1], team: sideTeam, assignee: sideViewer, creator: sideViewer,
  project: null, cycle: null, parent: null, labels: { nodes: [] }, syncedWith: [], description: '', comments: { nodes: [] }, attachments: { nodes: [] }, history: { nodes: [] }, subscribers: [],
}));
const sideFilters = makeFilters({ viewerId: sideViewer.id });
const answerSide = (op, variables) => {
  const where = (list) => sideFilters.issuesWhere(list, variables.filter ?? null).map(listed);
  switch (op) {
    case 'PlannerWhoAmI': return { viewer: sideViewer, organization: { id: sideWorkspace.id, name: sideWorkspace.name, urlKey: sideWorkspace.urlKey } };
    case 'PlannerAssigned': return { viewer: { ...sideViewer, assignedIssues: page(where(sideIssues), 100, variables.after) } };
    case 'PlannerCreated': return { viewer: { id: sideViewer.id, createdIssues: page(where(sideIssues), 100, variables.after) } };
    case 'PlannerIssues': return { issues: page(where(sideIssues), 100, variables.after) };
    case 'PlannerSearch': return { searchIssues: page(where(sideIssues.filter((item) => item.title.includes(variables.term))), 50, variables.after) };
    case 'PlannerViews': return { customViews: page([], 100, null) };
    case 'PlannerFavoriteViews': return { favorites: { nodes: [] } };
    case 'PlannerLinked': return { issues: { nodes: sideIssues.filter((item) => variables.ids.includes(item.id)).map(listed) } };
    case 'PlannerIssue': return { issue: sideIssues.find((item) => item.id === variables.id || item.identifier === variables.id) ? listed(sideIssues.find((item) => item.id === variables.id || item.identifier === variables.id)) : null };
    case 'PlannerTeamStates': return { team: { id: variables.id, states: { nodes: sideStates } } };
    case 'PlannerTeams': return { viewer: { id: sideViewer.id }, teams: { nodes: [sideTeam] } };
    case 'PlannerProjects': return { projects: page([], 50, null) };
    case 'PlannerFilterTeams': return { teams: page([{ ...sideTeam, states: { nodes: sideStates } }], 50, variables.after) };
    case 'PlannerFilterUsers': return { users: page([{ ...sideViewer, displayName: 'side', active: true, isMe: true }], 250, variables.after) };
    case 'PlannerFilterLabels': case 'PlannerFilterProjects': case 'PlannerFilterCycles': return { [{ PlannerFilterLabels: 'issueLabels', PlannerFilterProjects: 'projects', PlannerFilterCycles: 'cycles' }[op]]: page([], 250, variables.after) };
    default: return null;
  }
};
let sideConnected = false;
const sideCalls = [];
const serviceOverride = ({ method, path, body }) => {
  if (!path.startsWith('/linear/')) return undefined;
  if (path === '/linear/workspaces' && method === 'GET') return { workspaces: sideConnected ? [sideWorkspace] : [] };
  if (path === '/linear/workspaces' && method === 'POST') {
    sideConnected = true;
    return { workspace: sideWorkspace };
  }
  if (path === '/linear/graphql') {
    const op = /(?:query|mutation) (\w+)/.exec(body.query)?.[1];
    sideCalls.push({ op, variables: body.variables });
    const data = body.workspaceId === sideWorkspace.id ? answerSide(op, body.variables ?? {}) : null;
    return { status: 200, body: JSON.stringify(data ? { data } : { errors: [{ message: `harness: unexpected ${op} in ${body.workspaceId}` }] }) };
  }
  return undefined;
};

// ── The journey ─────────────────────────────────────────────────────────────
const h = await startHarness({ out, linearWorld: world, linear: (op, variables) => answer(op, variables), serviceOverride, timezoneId: ZONE, viewport: { width: 1920, height: 1080 } });
const { frame, page: browserPage } = h;
const calls = (op) => h.linearCalls.filter((call) => call.op === op);
const lastCall = (op, test = () => true) => calls(op).filter(test).at(-1);
const until = async (test, timeout = 10_000) => {
  for (const end = Date.now() + timeout; Date.now() < end; await browserPage.waitForTimeout(150)) {
    const value = await test();
    if (value) return value;
  }
  return null;
};
const rows = () => frame.locator('.linear-page li.lin-row');
const rowKeys = async () => (await rows().evaluateAll((items) => items.map((item) => item.getAttribute('aria-label') ?? ''))).map((text) => /^[A-Z]+-\d+/.exec(text)?.[0]).filter(Boolean);
const sidebar = () => frame.getByRole('navigation', { name: 'Linear sections' });
const openFromSidebar = async (name) => {
  await sidebar().getByRole('button', { name, exact: true }).first().click();
  await frame.locator('.lin-head h1', { hasText: name }).waitFor({ timeout: 10_000 });
};
const heading = async () => (await frame.locator('.lin-head h1').first().innerText().catch(() => '')).trim();

try {
  await h.openPlanner();
  await h.nav('Linear').click();
  await sidebar().waitFor({ timeout: 15_000 });

  // 1. The sidebar, as Linear's: My issues, Favorites, Views by team and workspace, Projects.
  await sidebar().getByRole('group', { name: 'Favorites' }).waitFor({ timeout: 15_000 });
  const favorites = await sidebar().getByRole('group', { name: 'Favorites' }).getByRole('button').allInnerTexts();
  const viewGroups = await sidebar().getByRole('group', { name: 'Views' }).getByRole('group').evaluateAll((groups) => groups.map((group) => `${group.getAttribute('aria-label')}: ${[...group.querySelectorAll('.lin-nav-label')].map((label) => label.textContent).join(', ')}`));
  const sections = await Promise.all(['Assigned', 'Created', 'Subscribed', 'Planned', 'All projects'].map((name) => sidebar().getByRole('button', { name, exact: true }).count()));
  check('the sidebar has My issues (Assigned, Created, Subscribed), Planned and Projects', sections.every((count) => count === 1), sections.join(','));
  check('Favorites lists the favorite view, project and issue in Linear’s order', favorites.map((text) => text.replace(/\s+/g, ' ').trim()).join(' | ').startsWith('harness Open work') && favorites.some((text) => text.includes('Planner')) && favorites.some((text) => text.includes('HAR-2')), favorites.join(' | '));
  check('Views lists every saved view, of issues and of projects, by team and workspace', viewGroups.join(' | ') === 'HAR · Harness: harness Bulk backlog, harness Open work, harness Urgent or my bugs | Workspace views: harness Everything, harness Finished work, harness Project portfolio, harness Two-team board | My views: harness My bugs', viewGroups.join(' | '));
  await rows().first().waitFor({ timeout: 15_000 });
  const myGroups = await frame.locator('.linear-page .lin-group-head .lin-group-name').allInnerTexts();
  check('My issues opens on Assigned, grouped by the exact workflow states of both teams', (await heading()) === 'Assigned' && ['In Progress', 'Todo', 'Ready', 'Backlog', 'Triage', 'Doing'].every((name) => myGroups.includes(name)), myGroups.join(' | '));
  check('My issues asks Linear for open issues only by its display, not by a fixed clause', JSON.stringify(lastCall('PlannerAssigned')?.variables.filter) === JSON.stringify({ state: { type: { nin: ['completed', 'canceled'] } } }), JSON.stringify(lastCall('PlannerAssigned')?.variables.filter));
  await h.shot('01-linear-my-issues');

  // 2. A completed-only view shows its issues: no open-only filter.
  await openFromSidebar('harness Finished work');
  await until(async () => (await rowKeys()).length === 4);
  const done = (await rowKeys()).sort();
  const doneCall = lastCall('PlannerViewIssues', (call) => call.variables.id === 'v-done');
  check('a completed-only saved view shows its completed and canceled issues', done.join(',') === 'HAR-5,HAR-6,OPS-4,OPS-5', done.join(','));
  check("…because the Planner sends the view no filter of its own (the view's display shows all completed issues)", doneCall && doneCall.variables.filter === null, JSON.stringify(doneCall?.variables ?? null));
  await h.shot('02-linear-completed-view');

  // 3. A view of 320 issues: three pages at once, the rest as the list scrolls.
  await openFromSidebar('harness Bulk backlog');
  await until(async () => (await rows().count()) === 300, 20_000);
  const firstCount = await rows().count();
  const moreText = await frame.locator('.lin-more').innerText().catch(() => '');
  check('a big view shows its first 300 issues and says Linear has more (no silent cap)', firstCount === 300 && /300 loaded/.test(moreText) && (await frame.locator('.lin-count').innerText()).includes('300+'), `${firstCount} rows · ${moreText.replace(/\s+/g, ' ')}`);
  await frame.locator('.lin-content').evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await until(async () => (await rows().count()) === 320, 20_000);
  const cursors = calls('PlannerViewIssues').filter((call) => call.variables.id === 'v-big').map((call) => call.variables.after);
  check('scrolling to the end reads the last page; all 320 issues show', (await rows().count()) === 320 && (await frame.locator('.lin-end').innerText()).includes('320 issues'), `${await rows().count()} rows`);
  check('pages follow Linear’s cursors to the end', JSON.stringify(cursors.slice(-4)) === JSON.stringify([null, '100', '200', '300']), JSON.stringify(cursors));
  await h.shot('03-linear-big-view-end');

  // 4. A view of projects lists projects; a project opens with its issues.
  await openFromSidebar('harness Project portfolio');
  await frame.getByRole('button', { name: 'Open project Shipped Thing' }).waitFor({ timeout: 10_000 });
  const projectGroups = await frame.locator('.linear-projects .lin-group-head .lin-group-name').allInnerTexts();
  check('a saved view of projects shows its projects, completed ones too, grouped by status', projectGroups.join('|') === 'In progress|Planned|Completed' && (await frame.getByRole('button', { name: /^Open project / }).count()) === 3, projectGroups.join(' | '));
  check('…asking Linear for the view’s projects with no extra filter', lastCall('PlannerViewProjects')?.variables.filter === null, JSON.stringify(lastCall('PlannerViewProjects')?.variables ?? null));
  await h.shot('04-linear-project-view');
  await frame.getByRole('button', { name: 'Open project Planner' }).click();
  const projectPage = frame.locator('.project-detail');
  await projectPage.getByRole('heading', { name: 'Planner' }).waitFor({ timeout: 10_000 });
  await until(async () => (await rowKeys()).length === 2);
  check('a project opens with its own issues as a full list', (await rowKeys()).sort().join(',') === 'HAR-1,HAR-2' && JSON.stringify(lastCall('PlannerIssues')?.variables.filter).includes('"project":{"id":{"eq":"p1"}}'), (await rowKeys()).join(','));
  await h.shot('05-linear-project');
  await projectPage.getByRole('button', { name: '← harness Project portfolio' }).click();
  await frame.getByRole('button', { name: 'Open project Planner' }).waitFor({ timeout: 10_000 });

  // 5. Filters from the keyboard, sent to Linear.
  await openFromSidebar('harness Open work');
  await until(async () => (await rowKeys()).length === 6);
  const openGroups = await frame.locator('.linear-page .lin-group-head .lin-group-name').allInnerTexts();
  check('a saved view opens as saved: grouped by exact status, closest to done first', openGroups.join('|') === 'In Review|In Progress|Todo|Backlog', openGroups.join(' | '));
  await browserPage.keyboard.press('f');
  const filterMenu = frame.getByRole('dialog', { name: 'Filter' });
  await filterMenu.waitFor({ timeout: 5000 });
  check('F on the Linear page opens the filter, not Focus', (await frame.getByRole('heading', { name: 'Focus' }).count()) === 0 && (await heading()) === 'harness Open work');
  await browserPage.keyboard.type('Status');
  await browserPage.keyboard.press('Enter');
  const statusMenu = frame.getByRole('dialog', { name: 'Filter by Status' });
  await statusMenu.getByRole('option', { name: 'Canceled' }).waitFor({ timeout: 5000 });
  const statusChoices = (await statusMenu.getByRole('option').allInnerTexts()).map((text) => text.trim());
  // The open view holds no Done or Canceled issue: the choices are the team's states, not the loaded issues'.
  check('a property’s values come from the team, not from the loaded issues (Done and Canceled too)', statusChoices.join('|') === 'Backlog|Todo|In Progress|In Review|Done|Canceled', statusChoices.join(' | '));
  await browserPage.keyboard.press('Backspace');
  await filterMenu.waitFor({ timeout: 5000 });
  check('Backspace in an empty search goes back to the properties', (await statusMenu.count()) === 0);
  await browserPage.keyboard.type('Todo');
  await filterMenu.getByRole('option', { name: 'Todo' }).waitFor({ timeout: 5000 });
  await browserPage.keyboard.press('Enter');
  await frame.getByRole('group', { name: 'Status is Todo' }).waitFor({ timeout: 5000 });
  await until(async () => (await rowKeys()).length === 3);
  const todoCall = lastCall('PlannerViewIssues', (call) => call.variables.id === 'v-open');
  check('typing a value and Enter filters: Linear gets an IssueFilter and answers with the matches', (await rowKeys()).sort().join(',') === 'HAR-1,HAR-7,HAR-8' && JSON.stringify(todoCall?.variables.filter) === JSON.stringify({ and: [{ state: { type: { nin: ['completed', 'canceled'] } } }, { state: { name: { in: ['Todo'] } } }] }), `${(await rowKeys()).join(',')} · ${JSON.stringify(todoCall?.variables.filter)}`);
  await browserPage.keyboard.press('f');
  await filterMenu.waitFor({ timeout: 5000 });
  await browserPage.keyboard.type('Labels');
  await browserPage.keyboard.press('Enter');
  const labelMenu = frame.getByRole('dialog', { name: 'Filter by Labels' });
  await labelMenu.waitFor({ timeout: 5000 });
  const labelChoices = await labelMenu.getByRole('option').allInnerTexts();
  await browserPage.keyboard.type('Feat');
  await browserPage.keyboard.press('Enter');
  await browserPage.keyboard.press('Escape');
  await frame.getByRole('group', { name: 'Labels include Feature' }).waitFor({ timeout: 5000 });
  check('a team view’s label choices are its team’s and the workspace’s labels', labelChoices.map((text) => text.trim()).join('|') === 'Bug|Feature', labelChoices.join(' | '));
  await until(async () => (await rowKeys()).join(',') === 'HAR-7');
  check('two filters both apply, in Linear', (await rowKeys()).join(',') === 'HAR-7' && JSON.stringify(lastCall('PlannerViewIssues')?.variables.filter).includes('{"labels":{"some":{"name":{"in":["Feature"]}}}}'), JSON.stringify(lastCall('PlannerViewIssues')?.variables.filter));
  await frame.getByRole('button', { name: 'Operator of Status: is' }).click();
  await frame.getByRole('dialog', { name: 'Status filter operator' }).getByRole('option', { name: 'is not' }).click();
  await frame.getByRole('group', { name: 'Status is not Todo' }).waitFor({ timeout: 5000 });
  await until(async () => (await rowKeys()).sort().join(',') === 'HAR-2,HAR-4');
  check('a chip’s operator can be changed: "is not" goes to Linear as nin', (await rowKeys()).sort().join(',') === 'HAR-2,HAR-4' && JSON.stringify(lastCall('PlannerViewIssues')?.variables.filter).includes('{"state":{"name":{"nin":["Todo"]}}}'), `${(await rowKeys()).join(',')}`);
  await h.shot('06-linear-filters');
  await frame.getByRole('button', { name: 'Clear filters' }).click();
  await until(async () => (await rowKeys()).length === 6);

  // A row's own buttons act on the row only: planning re-renders its plan bar away mid-click, and the click must not
  // then reach the row and open the issue; the row's Agent opens the assignee picker beside it, inside the window.
  const issueViews = () => frame.getByRole('dialog', { name: /^Linear issue / }).count();
  await rows().filter({ hasText: 'HAR-4' }).first().getByRole('button', { name: 'Plan HAR-4 today' }).click();
  const plannedPill = await rows().filter({ hasText: 'HAR-4' }).first().getByRole('button', { name: 'Open the task for HAR-4 (Today)' }).waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
  check('Today on a row plans the issue without opening it', plannedPill && (await issueViews()) === 0, `planned ${plannedPill}, issue views ${await issueViews()}`);
  const agentButton = rows().filter({ hasText: 'HAR-3' }).first().getByRole('button', { name: 'Assign HAR-3 to an agent' });
  await agentButton.click();
  const rowPicker = frame.getByRole('dialog', { name: 'Assign to an agent' });
  await rowPicker.getByRole('group', { name: 'Agents' }).waitFor({ timeout: 15_000 });
  const pickerBox = await rowPicker.boundingBox();
  const agentBox = await agentButton.boundingBox();
  const frameBox = await browserPage.locator('.inset-0 > iframe[title="Planner"]').boundingBox();
  const beside = Boolean(pickerBox && agentBox && frameBox) && (Math.abs(pickerBox.y - (agentBox.y + agentBox.height)) <= 8 || Math.abs(pickerBox.y + pickerBox.height - agentBox.y) <= 8);
  const inside = Boolean(pickerBox && frameBox) && pickerBox.y >= frameBox.y && pickerBox.y + pickerBox.height <= frameBox.y + frameBox.height && pickerBox.x >= frameBox.x && pickerBox.x + pickerBox.width <= frameBox.x + frameBox.width;
  check("a row's Agent opens the assignee picker beside the button, inside the window, and the issue stays closed", beside && inside && (await issueViews()) === 0, JSON.stringify({ pickerBox, agentBox }));
  await h.shot('06b-linear-row-agent-picker');
  await browserPage.keyboard.press('Escape');
  await rowPicker.waitFor({ state: 'detached', timeout: 5000 });

  // 6. Display options: sub-grouping, and the view's own display stays the view's.
  await browserPage.keyboard.press('Shift+V');
  const displayMenu = frame.getByRole('dialog', { name: 'Display options' });
  await displayMenu.waitFor({ timeout: 5000 });
  const displayButtons = await displayMenu.getByRole('button', { name: /^(Grouping|Sub-grouping|Ordering|Completed issues): / }).evaluateAll((items) => items.map((item) => item.getAttribute('aria-label')));
  check('Display shows the view’s saved grouping, ordering and completed issues', displayButtons.join(' | ') === 'Grouping: Status | Sub-grouping: No grouping | Ordering: Priority | Completed issues: None', displayButtons.join(' | '));
  await displayMenu.getByRole('button', { name: 'Sub-grouping: No grouping' }).click();
  await displayMenu.getByRole('dialog', { name: 'Sub-grouping' }).getByRole('option', { name: 'Assignee' }).click();
  await frame.locator('.lin-subgroup').first().waitFor({ timeout: 5000 });
  check('sub-grouping nests groups (status, then assignee)', (await frame.locator('.lin-subgroup').count()) >= 4);
  await h.shot('07-linear-display');
  await displayMenu.getByRole('button', { name: 'Sub-grouping: Assignee' }).click();
  await displayMenu.getByRole('dialog', { name: 'Sub-grouping' }).getByRole('option', { name: 'No grouping' }).click();
  await browserPage.keyboard.press('Escape');
  await displayMenu.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  const settings = (await h.call('GET', '/state')).json.state.settings;
  check("changing a view's display does not change the Planner's own settings", settings.linearLayout === 'list' && settings.linearDisplay.subGroupBy === 'none');

  // 7. The issue view: properties sidebar and Linear's keys.
  const updates = () => calls('PlannerUpdateIssue');
  await rows().filter({ hasText: 'HAR-1' }).first().click();
  const issueView = frame.getByRole('dialog', { name: 'Linear issue HAR-1' });
  await issueView.getByRole('complementary', { name: 'Properties' }).waitFor({ timeout: 10_000 });
  await issueView.getByRole('button', { name: 'Status: Todo' }).waitFor({ timeout: 10_000 });
  const properties = await issueView.getByRole('complementary', { name: 'Properties' }).getByRole('button', { name: /^(Status|Priority|Assignee|Labels|Project|Cycle|Estimate|Due date): / }).evaluateAll((items) => items.map((item) => item.getAttribute('aria-label')));
  check('the issue view has a properties sidebar: status, priority, assignee, labels, project, cycle, estimate, due date', properties.join(' | ') === `Status: Todo | Priority: High | Assignee: Harness User | Labels: Bug | Project: Planner | Cycle: Cycle 7 | Estimate: 3 points | Due date: ${new Date(`${dayKey(-2)}T12:00:00`).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}`, properties.join(' | '));
  check('…with links, sub-issues and the activity (history and comments)', (await issueView.getByRole('region', { name: 'Links' }).innerText()).includes('Pull request #12') && (await issueView.getByRole('region', { name: 'Sub-issues' }).innerText()).includes('HAR-8') && /changed status from Backlog to Todo[\s\S]*ship it/.test(await issueView.getByRole('region', { name: 'Activity' }).innerText()));
  await browserPage.keyboard.press('s');
  const statusPicker = issueView.getByRole('dialog', { name: 'Change status' });
  await statusPicker.waitFor({ timeout: 5000 });
  await browserPage.keyboard.type('In Rev');
  await browserPage.keyboard.press('Enter');
  await issueView.getByRole('button', { name: 'Status: In Review' }).waitFor({ timeout: 10_000 });
  check('S, type, Enter sets the status in Linear', Boolean(await until(() => updates().some((call) => call.variables.input.stateId === 'st-h-review'))) && byKey('HAR-1').state.id === 'st-h-review');
  await browserPage.keyboard.press('a');
  await issueView.getByRole('dialog', { name: 'Assign to' }).waitFor({ timeout: 5000 });
  await browserPage.keyboard.type('Team');
  await browserPage.keyboard.press('Enter');
  await issueView.getByRole('button', { name: 'Assignee: Teammate' }).waitFor({ timeout: 10_000 });
  check('A, type, Enter assigns', Boolean(await until(() => updates().some((call) => call.variables.input.assigneeId === 'u-mate'))));
  await browserPage.keyboard.press('l');
  await issueView.getByRole('dialog', { name: 'Change labels' }).waitFor({ timeout: 5000 });
  await browserPage.keyboard.type('Feat');
  await browserPage.keyboard.press('Enter');
  await issueView.getByRole('button', { name: 'Labels: Bug, Feature' }).waitFor({ timeout: 10_000 });
  const labelAdded = await until(() => updates().some((call) => JSON.stringify(call.variables.input) === JSON.stringify({ addedLabelIds: ['lbl-feat'] })));
  check('L, type, Enter adds a label and the menu stays for more', Boolean(labelAdded) && (await issueView.getByRole('dialog', { name: 'Change labels' }).count()) === 1);
  await browserPage.keyboard.press('Escape');
  await issueView.getByRole('dialog', { name: 'Change labels' }).waitFor({ state: 'detached', timeout: 5000 });
  check('Escape closes the menu, not the issue', await issueView.isVisible());
  await browserPage.keyboard.press('p');
  await issueView.getByRole('dialog', { name: 'Change priority' }).waitFor({ timeout: 5000 });
  await browserPage.keyboard.type('Urg');
  await browserPage.keyboard.press('Enter');
  await issueView.getByRole('button', { name: 'Priority: Urgent' }).waitFor({ timeout: 10_000 });
  await browserPage.keyboard.press('Shift+D');
  await issueView.getByRole('dialog', { name: 'Change due date' }).waitFor({ timeout: 5000 });
  await browserPage.keyboard.type('Tomorrow');
  await browserPage.keyboard.press('Enter');
  await until(() => updates().some((call) => call.variables.input.dueDate === dayKey(1)));
  check('P and Shift D set the priority and the due date', updates().some((call) => call.variables.input.priority === 1) && updates().some((call) => call.variables.input.dueDate === dayKey(1)), updates().map((call) => JSON.stringify(call.variables.input)).join(' '));
  const fieldsSent = [...new Set(updates().flatMap((call) => Object.keys(call.variables.input)))].sort();
  check('each change sends only the field it changes', updates().every((call) => Object.keys(call.variables.input).length === 1), fieldsSent.join(', '));
  await h.shot('08-linear-issue-view');
  const before = await issueView.getAttribute('aria-label');
  await browserPage.keyboard.press('j');
  const nextView = frame.getByRole('dialog', { name: /^Linear issue / });
  await until(async () => (await nextView.getAttribute('aria-label')) !== before);
  const afterJ = await nextView.getAttribute('aria-label');
  await browserPage.keyboard.press('k');
  await frame.getByRole('dialog', { name: 'Linear issue HAR-1' }).waitFor({ timeout: 10_000 });
  check('J and K move to the next and previous issue of the list', afterJ !== before && afterJ?.startsWith('Linear issue HAR-'), `${before} → ${afterJ} → back`);
  await browserPage.keyboard.press('Escape');
  await frame.getByRole('dialog', { name: /^Linear issue / }).waitFor({ state: 'detached', timeout: 5000 });
  check('Escape closes the issue view', true);

  // 8. A board of two teams: a column per exact workflow state; drops set exactly that state.
  await openFromSidebar('harness Two-team board');
  const columns = frame.locator('.lin-board section.board-column');
  await columns.first().waitFor({ timeout: 10_000 });
  await until(async () => (await columns.count()) === 11);
  const columnNames = await columns.evaluateAll((items) => items.map((item) => item.getAttribute('aria-label')));
  check('board columns are the teams’ exact states in workflow order, same names merged', columnNames.join('|') === "Triage|Backlog|Todo|Ready|In Progress|Doing|In Review|Done|Shipped|Canceled|Won't do", columnNames.join(' | '));
  const column = (name) => frame.locator(`.lin-board section.board-column[aria-label="${name}"]`);
  const card = (key) => frame.locator('.lin-board li.lin-card', { hasText: new RegExp(`${key}(?!\\d)`) }).first();
  const setStates = () => calls('PlannerSetState');
  // A drag cannot scroll the board on its way, so the source column goes to the left edge first.
  const drag = async (key, from, to) => {
    await column(from).evaluate((element) => element.scrollIntoView({ inline: 'start', block: 'nearest' }));
    await card(key).dragTo(column(to));
  };
  await drag('HAR-7', 'Todo', 'In Progress');
  await column('In Progress').locator('li.lin-card', { hasText: 'HAR-7' }).waitFor({ timeout: 10_000 });
  await drag('HAR-2', 'In Progress', 'In Review');
  await column('In Review').locator('li.lin-card', { hasText: 'HAR-2' }).waitFor({ timeout: 10_000 });
  await drag('OPS-2', 'Ready', 'Doing');
  await column('Doing').locator('li.lin-card', { hasText: 'OPS-2' }).waitFor({ timeout: 10_000 });
  await drag('OPS-3', 'Doing', 'Done');
  await column('Done').locator('li.lin-card', { hasText: 'OPS-3' }).waitFor({ timeout: 10_000 });
  const moved = setStates().map((call) => `${call.variables.id}→${call.variables.stateId}`);
  check('dropping a card sets exactly that state in its own team (In Review, not the first started state; OPS’s Done, not Shipped)', ['iss-har-7→st-h-prog', 'iss-har-2→st-h-review', 'iss-ops-2→st-o-doing', 'iss-ops-3→st-o-done'].every((item) => moved.includes(item)), moved.join(', '));
  const beforeRefused = setStates().length;
  await drag('HAR-1', 'Todo', 'Ready');
  const refusal = await frame.getByText(/HAR has no Ready status/).waitFor({ timeout: 8000 }).then(() => true).catch(() => false);
  check('a state the card’s team does not have is refused, not guessed', refusal && setStates().length === beforeRefused && byKey('HAR-1').state.id === 'st-h-review', `${refusal} · ${byKey('HAR-1').state.id}`);
  await column('Todo').evaluate((element) => element.scrollIntoView({ inline: 'start', block: 'nearest' }));
  await h.shot('09-linear-board');

  // 9. The side panel beside Today still lists, filters and plans Linear issues (a list of its own).
  await h.nav('Today').click();
  await frame.getByRole('tab', { name: 'Linear' }).click();
  const side = frame.locator('aside.side-panel');
  await side.locator('li.issue-row').first().waitFor({ timeout: 10_000 });
  const sideSource = await side.getByRole('combobox', { name: 'Linear issues to show' }).inputValue();
  await side.getByRole('button', { name: 'Filter' }).click();
  // The board moved OPS-2 out of Ready; OPS-1 is still in Triage.
  await browserPage.keyboard.type('Triage');
  await frame.getByRole('dialog', { name: 'Filter' }).getByRole('option', { name: 'Triage' }).waitFor({ timeout: 5000 });
  await browserPage.keyboard.press('Enter');
  await side.getByRole('group', { name: 'Status is Triage' }).waitFor({ timeout: 5000 });
  await until(async () => (await side.locator('li.issue-row').count()) === 1);
  const sideKeys = await side.locator('li.issue-row').evaluateAll((items) => items.map((item) => item.getAttribute('aria-label')));
  await side.getByRole('button', { name: 'Plan OPS-1 today' }).click();
  const planned = await until(async () => Object.values((await h.call('GET', '/state')).json.state.tasks).find((task) => task.source?.key === 'OPS-1' && !task.deletedAt));
  check('the side panel beside Today keeps its own list (My issues), filters it in Linear and plans an issue', sideSource === 'assigned' && sideKeys.length === 1 && sideKeys[0].startsWith('OPS-1') && Boolean(planned), `${sideSource} · ${sideKeys.join(', ')}`);
  await h.shot('10-today-side-panel');
  await h.nav('Linear').click();
  await frame.locator('.lin-head h1', { hasText: 'harness Two-team board' }).waitFor({ timeout: 10_000 });
  check('…while the Linear page still shows its own view', true);

  // 10. The page opens where it was.
  await browserPage.reload({ waitUntil: 'load' });
  await h.openPlanner();
  await h.nav('Linear').click();
  await frame.locator('.lin-head h1', { hasText: 'harness Two-team board' }).waitFor({ timeout: 15_000 }).catch(() => {});
  check('the view reopens after a reload (its identity is kept on this device)', (await heading()) === 'harness Two-team board', await heading());


  // 11. A second workspace, added with an API key: merged lists, grouping and filtering by workspace, one at a time.
  await h.nav('Settings').click();
  await frame.getByRole('textbox', { name: 'Linear API key' }).fill(`lin_api_${'harness'.repeat(4)}`);
  await frame.getByRole('button', { name: 'Add workspace' }).click();
  await frame.getByRole('list', { name: 'Linear workspaces' }).locator('li', { hasText: 'Side Org' }).waitFor({ timeout: 10_000 });
  await h.nav('Linear').click();
  await openFromSidebar('Assigned');
  const sideOrgRow = rows().filter({ hasText: 'SIDE-1' }).first();
  await sideOrgRow.waitFor({ timeout: 15_000 });
  check('All workspaces merges both workspaces’ issues, each marked with its workspace', (await sideOrgRow.locator('.ws-badge').innerText()) === 'Side Org' && (await rows().filter({ hasText: 'HAR-2' }).first().locator('.ws-badge').innerText()) === 'Harness Org');
  const displayButton = frame.locator('.linear-page').getByRole('button', { name: 'Display', exact: true });
  await displayButton.click();
  const display = frame.getByRole('dialog', { name: 'Display options' });
  await display.getByRole('button', { name: /^Grouping: / }).click();
  await display.getByRole('dialog', { name: 'Grouping' }).getByRole('option', { name: 'Workspace', exact: true }).click();
  await displayButton.click();
  await frame.locator('.linear-page .lin-group-head', { hasText: 'Side Org' }).waitFor({ timeout: 10_000 });
  const byWorkspace = await frame.locator('.linear-page .lin-group-head .lin-group-name').allInnerTexts();
  check('issues group by workspace', byWorkspace.join('|') === 'Harness Org|Side Org', byWorkspace.join(' | '));
  await displayButton.click();
  await display.getByRole('button', { name: /^Grouping: / }).click();
  await display.getByRole('dialog', { name: 'Grouping' }).getByRole('option', { name: 'Status', exact: true }).click();
  await displayButton.click();
  await frame.getByRole('button', { name: /^Linear workspace: / }).click();
  await frame.getByRole('dialog', { name: 'Linear workspace' }).getByRole('option', { name: /^Side Org/ }).click();
  await until(async () => (await rowKeys()).every((key) => key.startsWith('SIDE-')) && (await rowKeys()).length === 2);
  check('one workspace can be shown on its own', (await rowKeys()).sort().join(',') === 'SIDE-1,SIDE-2', (await rowKeys()).join(','));
  await frame.getByRole('button', { name: /^Linear workspace: / }).click();
  await frame.getByRole('dialog', { name: 'Linear workspace' }).getByRole('option', { name: 'All workspaces' }).click();
  await rows().filter({ hasText: 'HAR-2' }).first().waitFor({ timeout: 10_000 });
  await browserPage.keyboard.press('f');
  await browserPage.keyboard.type('Workspace');
  await browserPage.keyboard.press('Enter');
  await frame.getByRole('dialog', { name: 'Filter by Workspace' }).getByRole('option', { name: 'Side Org' }).click();
  await browserPage.keyboard.press('Escape');
  await frame.getByRole('group', { name: 'Workspace is Side Org' }).waitFor({ timeout: 5000 });
  await until(async () => (await rowKeys()).length === 2);
  const assignedAfter = calls('PlannerAssigned').length;
  await browserPage.waitForTimeout(500);
  check('a workspace filter asks only that workspace', (await rowKeys()).sort().join(',') === 'SIDE-1,SIDE-2' && calls('PlannerAssigned').length === assignedAfter && sideCalls.some((call) => call.op === 'PlannerAssigned'), (await rowKeys()).join(','));
  await h.shot('11-linear-two-workspaces');
  await frame.getByRole('button', { name: 'Clear filters' }).click();

  // 12. Linear's advanced filters, built in the page at 1440×900: (priority = Urgent or assignee = me) and label = Bug,
  // all / any at the top, content, subscribers and relations. Each goes to Linear as an IssueFilter, and the rows shown
  // are exactly the fake's own evaluation of that filter over its whole world (the view holds every issue).
  await browserPage.setViewportSize({ width: 1440, height: 900 });
  await browserPage.keyboard.press('[');
  await sidebar().waitFor({ state: 'detached', timeout: 5000 });
  const folded = await frame.getByRole('button', { name: 'Show the sidebar' }).isVisible();
  await browserPage.keyboard.press('[');
  await sidebar().waitFor({ timeout: 5000 });
  check('"[" folds the sidebar away (a toggle stays in the header) and brings it back, as in Linear', folded && (await sidebar().isVisible()) && (await frame.getByRole('button', { name: 'Show the sidebar' }).count()) === 0);
  await openFromSidebar('harness Everything');
  await rows().first().waitFor({ timeout: 15_000 });
  const bar = frame.locator('.linear-page .lin-filters').first();
  // A list's first page: what a new read asks (a replaced read may still have had a page on its way).
  const everything = () => calls('PlannerViewIssues').filter((call) => call.variables.id === 'v-all' && !call.variables.after);
  const keysOf = (list) => list.map((item) => item.identifier).sort();
  /** Wait for Linear to be asked for `filter`, then compare the rows with the fake's evaluation of it. */
  const shownFor = async (filter, base = issues) => {
    const expected = keysOf(filtered(base, filter));
    await until(async () => JSON.stringify(everything().at(-1)?.variables.filter) === JSON.stringify(filter) && (await rowKeys()).sort().join() === expected.join(), 15_000);
    return { sent: everything().at(-1)?.variables.filter, shown: (await rowKeys()).sort(), expected };
  };
  const same = (result, filter) => JSON.stringify(result.sent) === JSON.stringify(filter) && result.shown.join() === result.expected.join() && result.expected.length > 0;
  const summary = (result) => `sent ${JSON.stringify(result.sent)} · shown ${result.shown.join(',')} · fake ${result.expected.join(',')}${JSON.stringify(result.sent) === 'null' ? ` · last asks ${everything().slice(-5).map((call) => JSON.stringify([call.variables.after, call.variables.filter])).join(' ')}` : ''}`;
  await browserPage.keyboard.press('f');
  await frame.getByRole('dialog', { name: 'Filter' }).waitFor({ timeout: 5000 });
  await browserPage.keyboard.type('Labels');
  await browserPage.keyboard.press('Enter');
  await frame.getByRole('dialog', { name: 'Filter by Labels' }).waitFor({ timeout: 5000 });
  await browserPage.keyboard.type('Bug');
  await browserPage.keyboard.press('Enter');
  await browserPage.keyboard.press('Escape');
  await bar.getByRole('group', { name: 'Labels include Bug' }).waitFor({ timeout: 5000 });
  await bar.getByRole('button', { name: 'Filter', exact: true }).click();
  await frame.getByRole('dialog', { name: 'Filter' }).getByRole('option', { name: /^Advanced filter/ }).click();
  const builder = frame.getByRole('dialog', { name: 'Advanced filter' });
  await builder.waitFor({ timeout: 5000 });
  await builder.getByRole('button', { name: 'Add filter group' }).click();
  await browserPage.keyboard.type('Priority');
  await browserPage.keyboard.press('Enter');
  await frame.getByRole('dialog', { name: 'Filter by Priority' }).waitFor({ timeout: 5000 });
  await browserPage.keyboard.type('Urgent');
  await browserPage.keyboard.press('Enter');
  await browserPage.keyboard.press('Escape');
  const newGroup = builder.getByRole('group', { name: /^All of 1 filter/ });
  await newGroup.waitFor({ timeout: 5000 });
  await newGroup.getByRole('button', { name: 'Add filter', exact: true }).click();
  await browserPage.keyboard.type('Assignee');
  await browserPage.keyboard.press('Enter');
  await frame.getByRole('dialog', { name: 'Filter by Assignee' }).waitFor({ timeout: 5000 });
  await browserPage.keyboard.type('Me');
  await browserPage.keyboard.press('Enter');
  await browserPage.keyboard.press('Escape');
  await builder.getByRole('group', { name: /^All of 2 filters/ }).getByRole('button', { name: /^All of these filters/ }).click();
  const anyGroup = builder.getByRole('group', { name: 'Any of 2 filters: Priority is Urgent or Assignee is Me' });
  await anyGroup.waitFor({ timeout: 5000 });
  await h.shot('12-linear-advanced-filter-1440');
  await browserPage.keyboard.press('Escape');
  await builder.waitFor({ state: 'detached', timeout: 5000 });
  const urgentOrMine = { or: [{ priority: { in: [1] } }, { assignee: { isMe: { eq: true } } }] };
  const bugs = { labels: { some: { name: { in: ['Bug'] } } } };
  const built = await shownFor({ and: [bugs, urgentOrMine] });
  const groupChip = bar.getByRole('group', { name: 'Any of 2 filters: Priority is Urgent or Assignee is Me' });
  check('(priority = Urgent or assignee = me) and label = Bug, built from the UI, goes to Linear as and / or, and the rows are the fake’s own evaluation of it',
    same(built, { and: [bugs, urgentOrMine] }) && built.expected.join() === 'HAR-1,OPS-2,OPS-6' && (await groupChip.innerText()).includes('Any of 2 filters'), summary(built));
  await h.shot('13-linear-filters-1440');
  await bar.getByRole('button', { name: 'Match all filters' }).click();
  await frame.getByRole('dialog', { name: 'Match' }).getByRole('option', { name: 'Any filter' }).click();
  const anyOf = await shownFor({ or: [bugs, urgentOrMine] });
  check('"Match any" at the top sends an "or" of the top-level filters', same(anyOf, { or: [bugs, urgentOrMine] }) && anyOf.expected.length > built.expected.length, summary(anyOf));
  await bar.getByRole('button', { name: 'Match any filter' }).click();
  await frame.getByRole('dialog', { name: 'Match' }).getByRole('option', { name: 'All filters' }).click();
  await shownFor({ and: [bugs, urgentOrMine] });
  await bar.getByRole('button', { name: 'Clear filters' }).click();
  // Content: the title or the description contains the text (HAR-2's title, HAR-3's description).
  await browserPage.keyboard.press('f');
  await browserPage.keyboard.type('Content');
  await browserPage.keyboard.press('Enter');
  await frame.getByRole('dialog', { name: 'Filter by Content' }).waitFor({ timeout: 5000 });
  await browserPage.keyboard.type('login');
  await browserPage.keyboard.press('Enter');
  await bar.getByRole('group', { name: 'Content contains “login”' }).waitFor({ timeout: 5000 });
  const contentFilter = { or: [{ title: { containsIgnoreCase: 'login' } }, { description: { containsIgnoreCase: 'login' } }] };
  const content = await shownFor(contentFilter);
  check('a content filter: title or description contains the text', same(content, contentFilter) && content.expected.join() === 'HAR-2,HAR-3', summary(content));
  await bar.getByRole('button', { name: 'Clear filters' }).click();
  // Subscribers, me among them.
  await browserPage.keyboard.press('f');
  await browserPage.keyboard.type('Subscribers');
  await browserPage.keyboard.press('Enter');
  await frame.getByRole('dialog', { name: 'Filter by Subscribers' }).waitFor({ timeout: 5000 });
  await browserPage.keyboard.type('Me');
  await browserPage.keyboard.press('Enter');
  await browserPage.keyboard.press('Escape');
  await bar.getByRole('group', { name: 'Subscribers include Me' }).waitFor({ timeout: 5000 });
  const subscribedFilter = { subscribers: { some: { isMe: { eq: true } } } };
  const subscribed = await shownFor(subscribedFilter);
  check('a subscriber filter (Me)', same(subscribed, subscribedFilter) && subscribed.expected.join() === 'HAR-1,HAR-4', summary(subscribed));
  await bar.getByRole('button', { name: 'Clear filters' }).click();
  // Relations are top-level choices: typing finds them.
  await browserPage.keyboard.press('f');
  await browserPage.keyboard.type('Blocked');
  await frame.getByRole('dialog', { name: 'Filter' }).getByRole('option', { name: 'Blocked by' }).waitFor({ timeout: 5000 });
  await browserPage.keyboard.press('Enter');
  await bar.getByRole('group', { name: 'Relations include Blocked by' }).waitFor({ timeout: 5000 });
  const blockedFilter = { hasBlockedByRelations: { eq: true } };
  const blocked = await shownFor(blockedFilter);
  check('a relation filter (blocked by an issue)', same(blocked, blockedFilter) && blocked.expected.join() === 'HAR-2', summary(blocked));
  await bar.getByRole('button', { name: 'Clear filters' }).click();

  // 13. A view saved in Linear with an "or" of a rule and a group: shown as one group and applied by Linear; changed
  // here, the Planner sends the changed filter itself (the view's team's issues), and Reset brings the view back.
  await openFromSidebar('harness Urgent or my bugs');
  const savedChip = bar.getByRole('group', { name: 'Any of 2 filters: Priority is Urgent or (Assignee is Me and Labels include Bug)' });
  await savedChip.waitFor({ timeout: 10_000 });
  const viewOr = () => calls('PlannerViewIssues').filter((call) => call.variables.id === 'v-or');
  const savedRows = keysOf(issues.filter((item) => item.team.id === har.id && matchIssue(item, OR_FILTER)));
  await until(async () => (await rowKeys()).sort().join() === savedRows.join());
  check('a saved view whose filter is an "or" of a rule and a group loads with that group shown, and Linear applies it',
    (await rowKeys()).sort().join() === savedRows.join() && savedRows.includes('HAR-1') && savedRows.includes('HAR-2') && viewOr().at(-1)?.variables.filter === null && (await savedChip.innerText()).includes('Any of 2 filters'),
    `${(await rowKeys()).length} rows · ${JSON.stringify(viewOr().at(-1)?.variables.filter)}`);
  await savedChip.getByRole('button', { name: 'Edit filter group: Any of 2 filters' }).click();
  const groupBuilder = frame.getByRole('dialog', { name: 'Filter group' });
  await groupBuilder.waitFor({ timeout: 5000 });
  const nested = groupBuilder.getByRole('group', { name: 'All of 2 filters: Assignee is Me and Labels include Bug' });
  check('…its builder shows the nested group with its own "and"', (await nested.count()) === 1 && (await groupBuilder.getByRole('group', { name: 'Priority is Urgent' }).count()) === 1);
  await nested.getByRole('button', { name: /^All of these filters/ }).click();
  await groupBuilder.getByRole('group', { name: 'Any of 2 filters: Assignee is Me or Labels include Bug' }).waitFor({ timeout: 5000 });
  await h.shot('14-linear-saved-view-group-1440');
  await browserPage.keyboard.press('Escape');
  const changedFilter = { and: [{ team: { id: { eq: har.id } } }, { or: [{ priority: { in: [1] } }, { or: [{ assignee: { isMe: { eq: true } } }, { labels: { some: { name: { in: ['Bug'] } } } }] }] }] };
  const changedRows = keysOf(filtered(issues, changedFilter));
  const changedSent = await until(() => calls('PlannerIssues').some((call) => JSON.stringify(call.variables.filter) === JSON.stringify(changedFilter)));
  await until(async () => (await rowKeys()).sort().join() === changedRows.join());
  check("changing the view's group here sends the changed filter, with the view's team, and the rows follow the fake",
    Boolean(changedSent) && (await rowKeys()).sort().join() === changedRows.join() && changedRows.length > savedRows.length, `${(await rowKeys()).length} rows (fake ${changedRows.length})`);
  await bar.getByRole('button', { name: "Reset the view's filters" }).click();
  await until(async () => (await rowKeys()).sort().join() === savedRows.join());
  check('Reset brings the view’s own filter back', (await rowKeys()).sort().join() === savedRows.join() && (await savedChip.count()) === 1);

  // …and Save writes a changed filter to the view, as Linear's Save does: the view then reads as saved, without Reset or Save.
  await savedChip.getByRole('button', { name: 'Edit filter group: Any of 2 filters' }).click();
  await groupBuilder.waitFor({ timeout: 5000 });
  await groupBuilder.getByRole('group', { name: 'All of 2 filters: Assignee is Me and Labels include Bug' }).getByRole('button', { name: /^All of these filters/ }).click();
  await groupBuilder.getByRole('group', { name: 'Any of 2 filters: Assignee is Me or Labels include Bug' }).waitFor({ timeout: 5000 });
  await browserPage.keyboard.press('Escape');
  await bar.getByRole('button', { name: 'Save the filters to the view' }).click();
  const saveCall = await until(() => calls('PlannerSaveViewFilter').at(-1));
  const nowSaved = keysOf(issues.filter((item) => item.team.id === har.id && matchIssue(item, changedFilter.and[1])));
  await until(async () => (await bar.getByRole('button', { name: "Reset the view's filters" }).count()) === 0 && (await rowKeys()).sort().join() === nowSaved.join());
  check(
    "Save writes the changed filter to the view in Linear; the view then reads as saved (no Reset, Linear applies it)",
    saveCall?.variables.id === 'v-or' && JSON.stringify(saveCall.variables.filterData) === JSON.stringify(changedFilter.and[1])
      && (await bar.getByRole('button', { name: "Reset the view's filters" }).count()) === 0 && (await bar.getByRole('group', { name: /^Any of \d filters/ }).count()) >= 1
      && (await rowKeys()).sort().join() === nowSaved.join() && viewOr().at(-1)?.variables.filter === null,
    `${JSON.stringify(saveCall?.variables.filterData ?? null)} · ${(await rowKeys()).length} rows (fake ${nowSaved.length})`,
  );

  // 14. The page at 1024×768 with OpenChamber's sidebar open (the Planner gets about 700 px): Linear's sidebar folds
  // behind a toggle in the header and opens over the list; views, projects, My issues and Favorites are reachable by
  // mouse and keyboard; "/" lands in the header's search.
  await browserPage.setViewportSize({ width: 1024, height: 768 });
  await frame.locator('.lin-shell.is-narrow').waitFor({ timeout: 10_000 });
  const narrowFrame = await browserPage.locator('.inset-0 > iframe[title="Planner"]').boundingBox();
  const ocSidebar = await browserPage.locator('aside, nav').first().boundingBox().catch(() => null);
  const toggle = frame.getByRole('button', { name: 'Show the sidebar' });
  const overlay = frame.locator('#lin-sidebar');
  const visibleIn = async (locator) => {
    const box = await locator.boundingBox();
    const main = await frame.locator('.lin-main').boundingBox();
    return Boolean(box && main && box.x >= main.x - 1 && box.x + box.width <= main.x + main.width + 1 && box.y >= 0 && box.y + box.height <= 768);
  };
  check('at 1024×768 with OpenChamber’s sidebar open, the Planner is about 700 px and Linear’s sidebar folds behind a visible toggle',
    Boolean(narrowFrame && narrowFrame.width <= 720 && narrowFrame.x > 200) && (await toggle.isVisible()) && (await overlay.count()) === 0 && (await visibleIn(toggle)), `${JSON.stringify(narrowFrame)} · ${JSON.stringify(ocSidebar)}`);
  await h.shot('15-linear-1024-sidebar-closed');
  // The list at this width: each title keeps room (or shows whole), properties that do not fit go under it, none runs off.
  const rowFit = await frame.locator('.linear-page li.lin-row').evaluateAll((items) => items.slice(0, 40).map((row) => {
    const box = row.getBoundingClientRect();
    const title = row.querySelector('.lin-title-text');
    const props = row.querySelector('.lin-props')?.getBoundingClientRect();
    return { key: row.getAttribute('aria-label')?.split(' ')[0], title: title ? Math.round(title.clientWidth) : 0, whole: title ? title.scrollWidth <= title.clientWidth + 1 : false, overflow: props ? Math.round(props.right - box.right) : 0 };
  }));
  check('at this width each row keeps its title readable and nothing runs off its right edge', rowFit.length > 0 && rowFit.every((row) => (row.whole || row.title >= 120) && row.overflow <= 1), JSON.stringify(rowFit.filter((row) => !((row.whole || row.title >= 120) && row.overflow <= 1)).slice(0, 3)));
  const openOverlay = async () => {
    await toggle.click();
    await overlay.waitFor({ timeout: 5000 });
  };
  await openOverlay();
  check('the toggle opens the sidebar over the list, with everything the wide one has', (await sidebar().getByRole('group', { name: 'Favorites', exact: true }).isVisible()) && (await sidebar().getByRole('group', { name: 'Views', exact: true }).isVisible()) && (await sidebar().getByRole('button', { name: 'All projects', exact: true }).isVisible()) && (await overlay.getByRole('searchbox', { name: 'Search Linear issues' }).isVisible()));
  await h.shot('16-linear-1024-sidebar-open');
  await sidebar().getByRole('button', { name: 'harness Finished work', exact: true }).click();
  await frame.locator('.lin-head h1', { hasText: 'harness Finished work' }).waitFor({ timeout: 10_000 });
  // What the view holds now: the board above moved OPS-3 to Done.
  const finished = keysOf(issues.filter(views.find((item) => item.id === 'v-done').holds));
  await until(async () => (await rowKeys()).sort().join() === finished.join());
  check('picking a saved issue view opens it and closes the sidebar', (await overlay.count()) === 0 && (await rowKeys()).sort().join() === finished.join(), `${(await rowKeys()).join(',')} (fake ${finished.join(',')})`);
  await openOverlay();
  await sidebar().getByRole('button', { name: 'harness Project portfolio', exact: true }).click();
  await frame.getByRole('button', { name: 'Open project Shipped Thing' }).waitFor({ timeout: 10_000 });
  check('…and a view of projects', (await overlay.count()) === 0 && (await heading()) === 'harness Project portfolio');
  await openOverlay();
  await sidebar().getByRole('button', { name: 'Created', exact: true }).click();
  await frame.locator('.lin-head h1', { hasText: 'Created' }).waitFor({ timeout: 10_000 });
  check('Created is reachable with the visible toggle', (await overlay.count()) === 0 && (await heading()) === 'Created');
  // The keyboard: "[" opens it on the open section, ↑/↓ move, Enter opens, Escape closes.
  const focusedLabel = () => frame.locator(':focus').evaluate((element) => element.querySelector('.lin-nav-label')?.textContent ?? element.getAttribute('aria-label') ?? element.textContent ?? '').catch(() => '');
  await browserPage.keyboard.press('[');
  await overlay.waitFor({ timeout: 5000 });
  const firstFocus = await focusedLabel();
  await browserPage.keyboard.press('ArrowDown');
  const onSubscribed = await focusedLabel();
  await browserPage.keyboard.press('Enter');
  await frame.locator('.lin-head h1', { hasText: 'Subscribed' }).waitFor({ timeout: 10_000 });
  check('"[" opens the sidebar on the open section; ↓ and Enter open Subscribed', firstFocus === 'Created' && onSubscribed === 'Subscribed' && (await overlay.count()) === 0, `${firstFocus} → ${onSubscribed}`);
  await browserPage.keyboard.press('[');
  await overlay.waitFor({ timeout: 5000 });
  await browserPage.keyboard.press('ArrowDown');
  await browserPage.keyboard.press('ArrowDown');
  const onFavorite = await focusedLabel();
  const inFavorites = await frame.locator(':focus').evaluate((element) => Boolean(element.closest('[aria-label="Favorites"]'))).catch(() => false);
  await browserPage.keyboard.press('Enter');
  await frame.locator('.lin-head h1', { hasText: 'harness Open work' }).waitFor({ timeout: 10_000 });
  check('…and a favorite view, from the keyboard', onFavorite === 'harness Open work' && inFavorites && (await overlay.count()) === 0, onFavorite);
  await openOverlay();
  await sidebar().getByRole('group', { name: 'Favorites', exact: true }).getByRole('button', { name: 'Planner' }).click();
  await frame.locator('.project-detail').getByRole('heading', { name: 'Planner' }).waitFor({ timeout: 10_000 });
  check('a favorite project opens from the sidebar over the list', (await overlay.count()) === 0);
  await openOverlay();
  await browserPage.keyboard.press('Escape');
  await overlay.waitFor({ state: 'detached', timeout: 5000 });
  await browserPage.waitForTimeout(150);
  const escapeBack = await frame.locator(':focus').getAttribute('aria-label').catch(() => null);
  await openOverlay();
  await frame.locator('.lin-scrim').click({ position: { x: 460, y: 300 } });
  await overlay.waitFor({ state: 'detached', timeout: 5000 });
  check('Escape and a click outside close it; Escape gives the focus back to the toggle', escapeBack === 'Show the sidebar' && (await overlay.count()) === 0, String(escapeBack));
  await openOverlay();
  await sidebar().getByRole('button', { name: 'Assigned', exact: true }).click();
  await rows().first().waitFor({ timeout: 10_000 });
  await browserPage.keyboard.press('/');
  const headSearch = frame.locator('.lin-head-search input');
  await headSearch.waitFor({ timeout: 5000 });
  const searchFocused = await headSearch.evaluate((element) => element === document.activeElement);
  await browserPage.keyboard.type('fix');
  await frame.locator('.lin-head h1', { hasText: '“fix”' }).waitFor({ timeout: 10_000 });
  await until(async () => (await rowKeys()).join() === 'HAR-2');
  check('"/" focuses a visible search box in the header, and typing searches the issues', searchFocused && (await visibleIn(headSearch)) && (await rowKeys()).join() === 'HAR-2' && lastCall('PlannerSearch')?.variables.term === 'fix', `${searchFocused} · ${(await rowKeys()).join(',')}`);
  await h.shot('17-linear-1024-search');
  await headSearch.press('Escape');
  // The list's controls, a board, the filter menu and the issue view fit the narrow page.
  await openOverlay();
  await sidebar().getByRole('button', { name: 'harness Two-team board', exact: true }).click();
  await frame.locator('.lin-board section.board-column').first().waitFor({ timeout: 10_000 });
  const filterButton = frame.locator('.linear-page').getByRole('button', { name: 'Filter', exact: true });
  const displayButton1024 = frame.locator('.linear-page').getByRole('button', { name: 'Display', exact: true });
  check('on a board, the header and its Filter and Display stay on screen', (await visibleIn(filterButton)) && (await visibleIn(displayButton1024)) && (await visibleIn(frame.getByRole('button', { name: 'Refresh Linear' }))));
  await h.shot('18-linear-1024-board');
  await filterButton.click();
  const narrowMenu = frame.getByRole('dialog', { name: 'Filter' });
  await narrowMenu.waitFor({ timeout: 5000 });
  check('the filter menu opens inside the page', await visibleIn(narrowMenu), JSON.stringify(await narrowMenu.boundingBox()));
  await h.shot('19-linear-1024-filter-menu');
  await browserPage.keyboard.press('Escape');
  await frame.locator('.lin-board li.lin-card', { hasText: 'HAR-1' }).first().click();
  const narrowIssue = frame.getByRole('dialog', { name: 'Linear issue HAR-1' });
  await narrowIssue.getByRole('complementary', { name: 'Properties' }).waitFor({ timeout: 10_000 });
  const issueBox = await narrowIssue.boundingBox();
  check('the issue view fits the narrow page, its properties below the description', Boolean(issueBox && issueBox.width <= 702 && issueBox.x >= 0), JSON.stringify(issueBox));
  await h.shot('20-linear-1024-issue');
  await browserPage.keyboard.press('Escape');
  await narrowIssue.waitFor({ state: 'detached', timeout: 5000 });
  await browserPage.setViewportSize({ width: 1920, height: 1080 });

  // The host's own requests (such as its source-control binding) may fail in the dev container; those are not the Planner's.
  const errors = h.problems.filter((problem) => !/favicon|ERR_ABORTED|Failed to load resource/.test(problem));
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' · '));
} catch (error) {
  check('journey ran to the end', false, String(error).split('\n')[0]);
  await h.shot('99-linear-error').catch(() => {});
} finally {
  await h.close();
  const failed = results.filter((result) => !result.ok).length;
  console.log(`${results.length - failed}/${results.length} passed; screenshots in ${out}`);
  process.exitCode = failed ? 1 : 0;
}
