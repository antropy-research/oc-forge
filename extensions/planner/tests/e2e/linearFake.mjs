// Linear's filters for a fake Linear in the E2E journeys: the IssueFilter and ProjectFilter
// shapes the Planner sends, evaluated the way Linear does, and Linear's pages. Anything the
// Planner should not send throws, so a journey notices.

/** "-P1W" and other durations before now, as ISO times; anything else as it is. */
const since = (value) => {
  const match = /^-P(\d+)([DWMY])$/.exec(String(value));
  if (!match) return value;
  const date = new Date();
  const n = Number(match[1]);
  if (match[2] === 'D') date.setDate(date.getDate() - n);
  if (match[2] === 'W') date.setDate(date.getDate() - 7 * n);
  if (match[2] === 'M') date.setMonth(date.getMonth() - n);
  if (match[2] === 'Y') date.setFullYear(date.getFullYear() - n);
  return date.toISOString();
};

const lower = (value) => String(value).toLowerCase();

/** One comparator over one value, as SQL does it: a value that is not set matches only `null: true`. */
export const compare = (value, comparator) => Object.entries(comparator).every(([op, wanted]) => {
  if (op === 'null') return wanted ? value == null : value != null;
  if (value == null) return false;
  switch (op) {
    case 'eq': return value === wanted;
    case 'neq': return value !== wanted;
    case 'in': return wanted.includes(value);
    case 'nin': return !wanted.includes(value);
    case 'lt': return value < since(wanted);
    case 'lte': return value <= since(wanted);
    case 'gt': return value > since(wanted);
    case 'gte': return value >= since(wanted);
    case 'contains': return String(value).includes(wanted);
    case 'notContains': return !String(value).includes(wanted);
    case 'containsIgnoreCase': return lower(value).includes(lower(wanted));
    case 'notContainsIgnoreCase': return !lower(value).includes(lower(wanted));
    default: throw new Error(`fake Linear: comparator ${op}`);
  }
});

const fail = (what) => { throw new Error(`fake Linear: ${what}`); };

const RELATION_FLAGS = { hasBlockedByRelations: 'blockedBy', hasBlockingRelations: 'blocking', hasRelatedRelations: 'related', hasDuplicateRelations: 'duplicate' };

/**
 * Filters over issues shaped like the Planner reads them (state, team, assignee, creator,
 * project, cycle, projectMilestone, parent, labels.nodes, estimate, dates), plus what a
 * journey's world adds: `subscribers` (user ids), `description`, and `relations`
 * ({ blockedBy, blocking, related, duplicate }: lists of issue ids).
 * `cycleFlags(id)` says whether a cycle is the current or the next one; `childrenOf(issue)`
 * lists an issue's sub-issues.
 */
export const makeFilters = ({ viewerId, cycleFlags = () => ({}), childrenOf = () => [] }) => {
  // A relation that is not set matches only `null: true`, as a join in Linear does.
  const relation = (value, filter, fields) => {
    if (value == null) return filter.null === true;
    return Object.entries(filter).every(([key, comparator]) => {
      if (key === 'null') return comparator === false;
      if (key === 'and') return comparator.every((part) => relation(value, part, fields));
      if (key === 'or') return comparator.some((part) => relation(value, part, fields));
      if (!(key in fields)) fail(`relation field ${key}`);
      return fields[key](value, comparator);
    });
  };
  const idField = { id: (value, c) => compare(value.id, c) };
  const userFields = { ...idField, isMe: (value, c) => compare(value.id === viewerId, c) };
  const cycleFields = { ...idField, isActive: (value, c) => compare(Boolean(cycleFlags(value.id).isActive), c), isNext: (value, c) => compare(Boolean(cycleFlags(value.id).isNext), c) };
  const labelMatch = (item, filter) => Object.entries(filter).every(([key, c]) => (key === 'name' ? compare(item.name, c) : key === 'id' ? compare(item.id, c) : fail(`label field ${key}`)));
  // A collection (labels, subscribers, sub-issues): some, every, how many.
  const collection = (items, filter, match, what) => Object.entries(filter).every(([how, f]) => {
    if (how === 'some') return items.some((item) => match(item, f));
    if (how === 'every') return items.every((item) => match(item, f));
    if (how === 'length') return compare(items.length, f);
    return fail(`${what}.${how}`);
  });
  const matchIssue = (item, filter) => Object.entries(filter).every(([key, value]) => {
    switch (key) {
      case 'and': return value.every((part) => matchIssue(item, part));
      case 'or': return value.some((part) => matchIssue(item, part));
      case 'id': return compare(item.id, value);
      case 'state': return Object.entries(value).every(([field, c]) => compare(item.state[field], c));
      case 'team': return Object.entries(value).every(([field, c]) => compare(item.team[field], c));
      case 'assignee': case 'creator': return relation(item[key], value, userFields);
      case 'project': return relation(item.project, value, idField);
      case 'projectMilestone': return relation(item.projectMilestone ?? null, value, idField);
      case 'cycle': return relation(item.cycle, value, cycleFields);
      case 'priority': return compare(item.priority, value);
      case 'estimate': return compare(item.estimate ?? null, value);
      case 'dueDate': return compare(item.dueDate, value);
      case 'completedAt': case 'canceledAt': case 'createdAt': case 'updatedAt': return compare(item[key] ?? null, value);
      case 'title': return compare(item.title, value);
      case 'description': return compare(item.description ?? null, value);
      case 'searchableContent': {
        const text = `${item.title}\n${item.description ?? ''}`;
        return Object.entries(value).every(([op, wanted]) => (op === 'contains' ? lower(text).includes(lower(wanted)) : op === 'notContains' ? !lower(text).includes(lower(wanted)) : fail(`searchableContent.${op}`)));
      }
      case 'parent': return relation(item.parent, value, idField);
      case 'children': return collection(childrenOf(item), value, matchIssue, 'children');
      case 'labels': return collection(item.labels?.nodes ?? [], value, labelMatch, 'labels');
      case 'subscribers': return collection((item.subscribers ?? []).map((id) => ({ id })), value, (user, f) => relation(user, f, userFields), 'subscribers');
      case 'hasBlockedByRelations': case 'hasBlockingRelations': case 'hasRelatedRelations': case 'hasDuplicateRelations':
        return compare((item.relations?.[RELATION_FLAGS[key]] ?? []).length > 0, value);
      default: return fail(`IssueFilter.${key}`);
    }
  });
  const matchProject = (item, filter) => Object.entries(filter).every(([key, value]) => {
    switch (key) {
      case 'and': return value.every((part) => matchProject(item, part));
      case 'or': return value.some((part) => matchProject(item, part));
      case 'status': return Object.entries(value).every(([field, c]) => compare(item.status[field], c));
      case 'completedAt': case 'canceledAt': return compare(item[key] ?? null, value);
      default: return fail(`ProjectFilter.${key}`);
    }
  });
  const issuesWhere = (list, filter) => (filter ? list.filter((item) => matchIssue(item, filter)) : list);
  return { matchIssue, matchProject, issuesWhere };
};

/** One page of `nodes` from `after` on, with Linear's pageInfo. */
export const page = (nodes, first, after) => {
  const start = after ? Number(after) : 0;
  const slice = nodes.slice(start, start + first);
  const end = start + slice.length;
  return { nodes: slice, pageInfo: { hasNextPage: end < nodes.length, endCursor: end < nodes.length ? String(end) : null } };
};

/** A small Linear world: one workspace, four states, a team, issues, saved views, projects, members, labels. */
export const defaultLinearWorld = () => {
  const states = [
    { id: 'st-backlog', name: 'Backlog', type: 'backlog', color: '#bec2c8', position: 0 },
    { id: 'st-todo', name: 'Todo', type: 'unstarted', color: '#e2e2e2', position: 1 },
    { id: 'st-prog', name: 'In Progress', type: 'started', color: '#f2c94c', position: 2 },
    { id: 'st-review', name: 'In Review', type: 'started', color: '#0f783c', position: 3 },
    { id: 'st-done', name: 'Done', type: 'completed', color: '#5e6ad2', position: 4 },
    { id: 'st-canceled', name: 'Canceled', type: 'canceled', color: '#95a2b3', position: 5 },
  ];
  const team = { id: 'team-h', key: 'HAR', name: 'Harness Team' };
  const viewer = { id: 'u-h', name: 'Harness User' };
  const members = [{ id: 'u-h', name: 'Harness User', displayName: 'harness', active: true }, { id: 'u-mate', name: 'Teammate', displayName: 'mate', active: true }];
  const labels = [{ id: 'lbl-bug', name: 'Bug', color: '#eb5757' }, { id: 'lbl-feat', name: 'Feature', color: '#bb87fc' }];
  const issue = (n, title, stateId, extra = {}) => ({
    id: `iss-h-${n}`, identifier: `HAR-${n}`, title: `harness ${title}`, url: `https://linear.app/harness/issue/HAR-${n}/x`, priority: (n % 4) + 1, dueDate: null,
    branchName: `harness/har-${n}`, updatedAt: new Date(Date.now() - n * 3600_000).toISOString(), state: states.find((s) => s.id === stateId), team,
    assignee: viewer, project: { id: 'p1', name: 'Planner' }, cycle: null, assigned: true, description: `Issue ${n} description.\n\n- [ ] first\n- [x] second`,
    labels: { nodes: n % 2 ? [labels[0]] : [labels[1]] }, comments: { nodes: [] }, ...extra,
  });
  const issues = [
    issue(1, 'first', 'st-todo'), issue(2, 'second', 'st-prog'), issue(3, 'third', 'st-backlog'), issue(4, 'in review', 'st-review'),
    issue(5, 'finished', 'st-done'), issue(6, 'dropped', 'st-canceled'), issue(7, 'unassigned', 'st-todo', { assignee: null, assigned: false }),
  ];
  const view = (id, name, extra = {}) => ({ id, name: `harness ${name}`, description: null, icon: null, color: null, shared: true, modelName: 'Issue', slugId: `slug-${id}`, updatedAt: new Date().toISOString(), team, owner: viewer, ...extra });
  const project = (id, name, statusType, extra = {}) => ({
    id, name, url: `https://linear.app/harness/project/${id}`, color: '#26b5ce', icon: null, description: `${name} in one line`, progress: 0.25, health: 'onTrack', priority: 2, startDate: '2026-10-01', targetDate: '2026-11-30',
    updatedAt: new Date().toISOString(), status: { id: `ps-${statusType}`, name: statusType === 'started' ? 'In Progress' : 'Planned', type: statusType, color: '#f2c94c' }, lead: viewer, teams: { nodes: [team] }, ...extra,
  });
  return {
    org: { id: 'org-h', name: 'Harness Org', urlKey: 'harness' }, viewer, states, teams: [team], issues, members, labels, workspaceLabels: [],
    projects: [project('p1', 'Planner', 'started')],
    views: [view('v-open', 'Open work'), view('v-done', 'Finished work'), view('v-proj', 'Projects view', { modelName: 'Project' })],
    favorites: [{ type: 'customView', sortOrder: 1, customView: { id: 'v-open' } }],
    // Which issues each saved view holds; a real saved view may hold completed issues.
    viewIssues: { 'v-open': { prefs: { layout: 'list', issueGrouping: 'workflowState', viewOrdering: 'priority' }, ids: ['iss-h-1', 'iss-h-2', 'iss-h-3', 'iss-h-4'] }, 'v-done': { prefs: { layout: 'list', issueGrouping: 'none', viewOrdering: 'updatedAt' }, ids: ['iss-h-5', 'iss-h-6'] } },
  };
};

/** The default GraphQL answers for the Planner's documents, by operation name; null when unknown. */
export const answerLinear = (o, op, variables = {}) => {
  const strip = ({ assigned, ...rest }) => rest;
  const open = (i) => !['completed', 'canceled'].includes(i.state.type);
  const find = (id) => o.issues.find((i) => i.id === id || i.identifier === id);
  const page = (nodes) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
  switch (op) {
    case 'PlannerWhoAmI': return { viewer: o.viewer, organization: o.org };
    case 'PlannerAssigned': return { viewer: { ...o.viewer, assignedIssues: page(o.issues.filter((i) => i.assigned && open(i)).map(strip)) } };
    case 'PlannerViews': return { customViews: page(o.views) };
    case 'PlannerFavoriteViews': return { favorites: { nodes: o.favorites } };
    case 'PlannerSaveViewFilter': {
      const found = o.views.find((v) => v.id === variables.id);
      if (!found) return { customViewUpdate: null };
      found.filterData = variables.filterData;
      return { customViewUpdate: { success: true, customView: { id: found.id, updatedAt: new Date().toISOString() } } };
    }
    case 'PlannerViewIssues': {
      const saved = o.viewIssues[variables.id];
      if (!o.views.some((v) => v.id === variables.id)) return { customView: null };
      return { customView: { id: variables.id, viewPreferencesValues: saved?.prefs ?? null, issues: page((saved?.ids ?? []).map(find).filter(Boolean).map(strip)) } };
    }
    case 'PlannerLinked': return { issues: { nodes: o.issues.filter((i) => (variables.ids ?? []).includes(i.id)).map(strip) } };
    case 'PlannerIssue': case 'PlannerIssueDetail': return { issue: find(variables.id) ? strip(find(variables.id)) : null };
    case 'PlannerTeamStates': return { team: { id: variables.id, states: { nodes: o.states } } };
    case 'PlannerTeams': return { viewer: { id: o.viewer.id }, teams: { nodes: o.teams } };
    // Linear's search is a page like any list (the Planner reads pageInfo), and ignores case.
    case 'PlannerSearch': return { searchIssues: page(o.issues.filter((i) => i.title.toLowerCase().includes(String(variables.term ?? '').toLowerCase())).map(strip)) };
    case 'PlannerProjects': return { projects: page(o.projects) };
    case 'PlannerTeamOptions': return { team: { id: variables.id, states: { nodes: o.states }, members: { nodes: o.members }, labels: { nodes: o.labels } }, issueLabels: { nodes: o.workspaceLabels } };
    case 'PlannerSetState': {
      const i = find(variables.id); const s = o.states.find((x) => x.id === variables.stateId);
      if (!i || !s) return null; i.state = s; return { issueUpdate: { success: true, issue: strip(i) } };
    }
    case 'PlannerUpdateIssue': {
      const i = find(variables.id); const input = variables.input ?? {};
      if (!i) return null;
      if ('stateId' in input) i.state = o.states.find((x) => x.id === input.stateId) ?? i.state;
      for (const f of ['title', 'description', 'priority', 'dueDate']) if (f in input) i[f] = input[f];
      if ('assigneeId' in input) i.assignee = input.assigneeId ? o.members.find((m) => m.id === input.assigneeId) ?? null : null;
      for (const id of input.addedLabelIds ?? []) if (!i.labels.nodes.some((l) => l.id === id)) i.labels.nodes.push(o.labels.find((l) => l.id === id));
      if (input.removedLabelIds) i.labels.nodes = i.labels.nodes.filter((l) => !input.removedLabelIds.includes(l.id));
      i.updatedAt = new Date().toISOString();
      return { issueUpdate: { success: true, issue: strip(i) } };
    }
    case 'PlannerAddComment': {
      const i = find(variables.input.issueId); if (!i) return null;
      const comment = { id: `c-${i.comments.nodes.length + 1}`, body: variables.input.body, createdAt: new Date().toISOString(), editedAt: null, user: { id: o.viewer.id, name: o.viewer.name }, botActor: null, parent: null };
      i.comments.nodes.push(comment); return { commentCreate: { success: true, comment } };
    }
    default: return null;
  }
};
