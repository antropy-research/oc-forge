// Linear as a task source: GraphQL documents, issue → task mapping, and the
// rules for keeping a linked task in step with its issue.
import type { DateKey, LinearGroupBy, LinearOrderBy, Placement, PlannerState, Priority, Task, TaskSourceRef } from './types.ts';
import type { EventBody, NewTask } from './events.ts';
import { isDateKey } from './dates.ts';

export interface LinearState {
  id: string;
  name: string;
  /** triage, backlog, unstarted, started, completed or canceled. */
  type: string;
  color: string;
  position?: number;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  /** 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
  priority: number;
  dueDate: string | null;
  updatedAt: string;
  /** The git branch Linear suggests for the issue. */
  branchName?: string;
  state: LinearState;
  team: { id: string; key: string; name: string };
  assignee?: { id: string; name: string } | null;
  project: { id: string; name: string } | null;
  cycle: { id: string; number: number } | null;
  /** External items Linear keeps in sync with this issue (its GitHub Issues sync). */
  syncedWith?: { service: string; metadata?: { owner?: string | null; repo?: string | null; number?: number | null } | null }[] | null;
  /** The workspace the Planner read it from; the Planner sets this, Linear does not. */
  workspaceId?: string;
}

/**
 * A Linear workspace the Planner reads: OpenChamber's own Linear connection, or
 * one added with a personal API key (OpenChamber connects a single workspace).
 */
export interface LinearWorkspace {
  /** Linear organization id. */
  id: string;
  name: string;
  /** The workspace part of its URLs: linear.app/<urlKey>/… */
  urlKey: string;
  /** Who the Planner acts as there. */
  account: string;
  via: 'host' | 'key';
}

export interface LinearProject {
  id: string;
  name: string;
  url: string;
  color: string;
  icon: string | null;
  description: string;
  /** Completed share of the project's scope, 0 to 1. */
  progress: number;
  health: 'onTrack' | 'atRisk' | 'offTrack' | null;
  /** 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
  priority: number;
  startDate: string | null;
  targetDate: string | null;
  updatedAt: string;
  /** Status type: backlog, planned, started, paused, completed or canceled. */
  status: { id: string; name: string; type: string; color: string };
  lead: { id: string; name: string } | null;
  teams: { nodes: { id: string; key: string; name: string }[] };
  /** The workspace the Planner read it from. */
  workspaceId?: string;
}

export interface LinearProjectDetail extends LinearProject {
  content: string | null;
  projectMilestones: { nodes: { id: string; name: string; targetDate: string | null; progress: number; sortOrder: number }[] };
  lastUpdate: { id: string; body: string; health: string; createdAt: string; url: string; user: { id: string; name: string } } | null;
  issues: { nodes: LinearIssue[] };
}

const ISSUE_FIELDS = `id identifier title url priority dueDate updatedAt branchName
    state { id name type color }
    team { id key name }
    assignee { id name }
    project { id name }
    cycle { id number }
    syncedWith { service metadata { ... on ExternalEntityInfoGithubMetadata { owner repo number } } }`;

const OPEN_FILTER = `{ state: { type: { nin: ["completed", "canceled"] } } }`;

const PROJECT_FIELDS = `id name url color icon description progress health priority startDate targetDate updatedAt
    status { id name type color }
    lead { id name }
    teams(first: 10) { nodes { id key name } }`;

export const ASSIGNED_QUERY = `query PlannerAssigned($after: String) {
  viewer {
    id
    name
    assignedIssues(first: 100, after: $after, orderBy: updatedAt, filter: ${OPEN_FILTER}) {
      nodes { ${ISSUE_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

export const VIEWS_QUERY = `query PlannerViews {
  customViews(first: 50) { nodes { id name } }
}`;

export const VIEW_ISSUES_QUERY = `query PlannerViewIssues($id: String!) {
  customView(id: $id) {
    id
    issues(first: 100, filter: ${OPEN_FILTER}) { nodes { ${ISSUE_FIELDS} } }
  }
}`;

export const SEARCH_QUERY = `query PlannerSearch($term: String!) {
  searchIssues(term: $term, first: 25) { nodes { ${ISSUE_FIELDS} } }
}`;

export const LINKED_QUERY = `query PlannerLinked($ids: [ID!]!) {
  issues(first: 100, filter: { id: { in: $ids } }) { nodes { ${ISSUE_FIELDS} } }
}`;

/** `id` takes the issue's UUID or its identifier, such as NEX-110. */
export const ISSUE_QUERY = `query PlannerIssue($id: String!) {
  issue(id: $id) { ${ISSUE_FIELDS} }
}`;

export const TEAM_STATES_QUERY = `query PlannerTeamStates($id: String!) {
  team(id: $id) { id states(first: 100) { nodes { id name type color position } } }
}`;

export const TEAMS_QUERY = `query PlannerTeams {
  viewer { id }
  teams(first: 100) { nodes { id key name } }
}`;

/** Which workspace a connection or key reaches, and as whom. */
export const WHOAMI_QUERY = `query PlannerWhoAmI {
  viewer { id name }
  organization { id name urlKey }
}`;

/** The workspace's projects that are not completed or canceled. */
export const PROJECTS_QUERY = `query PlannerProjects($after: String) {
  projects(first: 50, after: $after, orderBy: updatedAt, filter: { status: { type: { nin: ["completed", "canceled"] } } }) {
    nodes { ${PROJECT_FIELDS} }
    pageInfo { hasNextPage endCursor }
  }
}`;

/** One project with its overview and its open issues. */
export const PROJECT_QUERY = `query PlannerProject($id: String!) {
  project(id: $id) {
    ${PROJECT_FIELDS}
    content
    projectMilestones(first: 25) { nodes { id name targetDate progress sortOrder } }
    lastUpdate { id body health createdAt url user { id name } }
    issues(first: 100, filter: ${OPEN_FILTER}) { nodes { ${ISSUE_FIELDS} } }
  }
}`;

export const SET_STATE_MUTATION = `mutation PlannerSetState($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) { success issue { ${ISSUE_FIELDS} } }
}`;

export const CREATE_ISSUE_MUTATION = `mutation PlannerCreateIssue($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } }
}`;

export const ALL_DOCUMENTS = [
  ASSIGNED_QUERY,
  VIEWS_QUERY,
  VIEW_ISSUES_QUERY,
  SEARCH_QUERY,
  LINKED_QUERY,
  ISSUE_QUERY,
  TEAM_STATES_QUERY,
  TEAMS_QUERY,
  WHOAMI_QUERY,
  PROJECTS_QUERY,
  PROJECT_QUERY,
  SET_STATE_MUTATION,
  CREATE_ISSUE_MUTATION,
];

const FROM_LINEAR_PRIORITY: Record<number, Priority | null> = { 0: null, 1: 'urgent', 2: 'high', 3: 'medium', 4: 'low' };
const TO_LINEAR_PRIORITY: Record<Priority, number> = { urgent: 1, high: 2, medium: 3, low: 4 };

export const priorityFromLinear = (value: number): Priority | null => FROM_LINEAR_PRIORITY[value] ?? null;
export const priorityToLinear = (value: Priority | null): number => (value ? TO_LINEAR_PRIORITY[value] : 0);

export const isClosedType = (type: string | undefined): boolean => type === 'completed' || type === 'canceled';

/** GitHub issues Linear keeps in sync with this issue, as `owner/repo#number`. */
export const githubMirrors = (issue: Pick<LinearIssue, 'syncedWith'>): string[] =>
  (issue.syncedWith ?? []).flatMap((entry) => {
    const meta = entry.metadata;
    return entry.service === 'github' && meta?.owner && meta.repo && meta.number ? [`${meta.owner}/${meta.repo}#${meta.number}`] : [];
  });

/** The same issue read from the workspace `workspaceId`. */
export const inWorkspace = <T extends { workspaceId?: string }>(item: T, workspaceId: string): T => ({ ...item, workspaceId });

/**
 * The link a task keeps to its issue, with the title and state last seen there.
 * An issue read without its workspace keeps the workspace of the link it updates.
 */
export const issueSource = (issue: LinearIssue, previous?: TaskSourceRef | null): TaskSourceRef => {
  const mirrors = githubMirrors(issue);
  const workspaceId = issue.workspaceId ?? (previous?.kind === 'linear' && previous.id === issue.id ? previous.workspaceId : undefined);
  return {
    kind: 'linear',
    id: issue.id,
    key: issue.identifier,
    url: issue.url,
    title: issue.title,
    teamId: issue.team.id,
    status: { name: issue.state.name, type: issue.state.type, color: issue.state.color },
    ...(mirrors.length ? { mirrors } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(issue.branchName ? { branch: issue.branchName } : {}),
  };
};

export const taskFromIssue = (issue: LinearIssue, id: string, placement: Placement, position: number): NewTask => ({
  id,
  title: issue.title,
  placement,
  position,
  priority: priorityFromLinear(issue.priority),
  dueDate: issue.dueDate && isDateKey(issue.dueDate) ? issue.dueDate : null,
  source: issueSource(issue),
});

/**
 * The live task planning an issue, if any (an open one before a completed one):
 * linked to the issue itself, or to a GitHub issue Linear keeps in sync with it.
 */
export const linkedTask = (state: PlannerState, issueId: string, mirrors: readonly string[] = []): Task | null => {
  const linked = Object.values(state.tasks).filter(
    (task) =>
      !task.deletedAt &&
      !task.archivedAt &&
      ((task.source?.kind === 'linear' && task.source.id === issueId) || (task.source?.kind === 'github' && mirrors.includes(task.source.key))),
  );
  return linked.find((task) => !task.completedAt) ?? linked[0] ?? null;
};

const openLinked = (state: PlannerState): Task[] =>
  Object.values(state.tasks).filter((task) => task.source?.kind === 'linear' && !task.deletedAt && !task.archivedAt && !task.completedAt);

/** Issues behind open linked tasks; completed tasks keep the state they last saw. */
export const linkedIssueIds = (state: PlannerState): string[] => [...new Set(openLinked(state).map((task) => task.source!.id))];

/**
 * The same, by workspace. Links made before workspaces belong to `fallback`
 * (OpenChamber's own connection); without one they are left out.
 */
export const linkedIssueIdsByWorkspace = (state: PlannerState, fallback: string | null): Map<string, string[]> => {
  const out = new Map<string, Set<string>>();
  for (const task of openLinked(state)) {
    const workspaceId = task.source!.workspaceId ?? fallback;
    if (!workspaceId) continue;
    const ids = out.get(workspaceId) ?? new Set<string>();
    ids.add(task.source!.id);
    out.set(workspaceId, ids);
  }
  return new Map([...out].map(([workspaceId, ids]) => [workspaceId, [...ids]]));
};

/** The team's first state of `type` by its board order. */
export const stateOfType = (states: readonly LinearState[], type: string): LinearState | null =>
  [...states].filter((state) => state.type === type).sort((a, b) => (a.position ?? 0) - (b.position ?? 0))[0] ?? null;

export interface SyncOptions {
  today: DateKey;
  /** Complete the task when its issue is completed or canceled in Linear. */
  importCompletion: boolean;
}

/**
 * Events that bring linked tasks up to date with their issues. The task title
 * follows a rename in Linear only while it still equals the title last seen
 * there, so a title the user changed in the Planner is never overwritten.
 */
export const planLinearSync = (state: PlannerState, issues: ReadonlyMap<string, LinearIssue>, options: SyncOptions): EventBody[] => {
  const bodies: EventBody[] = [];
  for (const task of Object.values(state.tasks)) {
    const source = task.source;
    if (source?.kind !== 'linear' || task.deletedAt || task.archivedAt) continue;
    const issue = issues.get(source.id);
    if (!issue) continue;
    const next = issueSource(issue, source);
    const titleFollows = source.title !== undefined && task.title === source.title && issue.title !== source.title;
    const changed =
      source.title !== next.title ||
      source.key !== next.key ||
      source.url !== next.url ||
      source.teamId !== next.teamId ||
      source.status?.name !== next.status?.name ||
      source.status?.type !== next.status?.type ||
      source.status?.color !== next.status?.color ||
      (source.mirrors ?? []).join(' ') !== (next.mirrors ?? []).join(' ') ||
      source.workspaceId !== next.workspaceId ||
      source.branch !== next.branch;
    if (changed) bodies.push({ type: 'task.sourceSynced', taskId: task.id, source: next, ...(titleFollows ? { title: issue.title } : {}) });
    if (options.importCompletion && isClosedType(issue.state.type) && !task.completedAt) {
      bodies.push({ type: 'task.completed', taskId: task.id, on: options.today });
    }
  }
  return bodies;
};

/** Shape check for an issue that arrives through drag data. */
export const isLinearIssue = (value: unknown): value is LinearIssue => {
  if (typeof value !== 'object' || value === null) return false;
  const issue = value as Record<string, unknown>;
  const state = issue.state as Record<string, unknown> | undefined;
  const team = issue.team as Record<string, unknown> | undefined;
  return (
    typeof issue.id === 'string' && typeof issue.identifier === 'string' && typeof issue.title === 'string' && typeof issue.url === 'string' &&
    typeof issue.priority === 'number' && typeof state?.name === 'string' && typeof state.type === 'string' && typeof state.color === 'string' &&
    typeof team?.id === 'string' && (issue.workspaceId === undefined || typeof issue.workspaceId === 'string')
  );
};

/** The workspace and key of a Linear issue URL, such as https://linear.app/acme/issue/NEX-110/some-title. */
export const parseLinearUrl = (text: string): { urlKey: string; key: string } | null => {
  const match = /^https:\/\/linear\.app\/([^/\s]+)\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:[/?#]\S*)?$/.exec(text.trim());
  return match ? { urlKey: match[1]!.toLowerCase(), key: match[2]!.toUpperCase() } : null;
};

/** GraphQL answer → data, or the first error's message. */
export const readGraphql = <T>(body: string): T => {
  const parsed = JSON.parse(body) as { data?: T; errors?: { message?: string; extensions?: { userPresentableMessage?: string } }[] };
  if (parsed.errors?.length) {
    const error = parsed.errors[0]!;
    throw new Error(error.extensions?.userPresentableMessage ?? error.message ?? 'Linear returned an error');
  }
  if (!parsed.data) throw new Error('Linear returned no data');
  return parsed.data;
};

// ── Views: grouping, ordering, projects ─────────────────────────────────────

export interface IssueGroup {
  key: string;
  label: string;
  color?: string;
  /** A status group's state type; a board card dropped there moves to the team's first state of it. */
  stateType?: string;
  issues: LinearIssue[];
}

/** Status groups for a list, most active first. */
const LIST_STATUSES = [
  { type: 'started', label: 'In progress' },
  { type: 'unstarted', label: 'Todo' },
  { type: 'backlog', label: 'Backlog' },
  { type: 'triage', label: 'Triage' },
];

/** Board columns in workflow order; Done takes drops even though lists hold open issues only. */
const BOARD_STATUSES = [
  { type: 'triage', label: 'Triage' },
  { type: 'backlog', label: 'Backlog' },
  { type: 'unstarted', label: 'Todo' },
  { type: 'started', label: 'In progress' },
  { type: 'completed', label: 'Done' },
];

export const PRIORITY_LABELS: Record<number, string> = { 1: 'Urgent', 2: 'High', 3: 'Medium', 4: 'Low', 0: 'No priority' };
const PRIORITY_ORDER = [1, 2, 3, 4, 0];
/** No priority sorts after Low, as in Linear. */
const priorityRank = (priority: number): number => (priority >= 1 && priority <= 4 ? priority : 5);

const byLabel = (a: IssueGroup, b: IssueGroup): number => a.label.localeCompare(b.label);

/** Collect issues under `keyOf`, keeping the first label seen per key. */
const collect = (issues: readonly LinearIssue[], keyOf: (issue: LinearIssue) => { key: string; label: string; color?: string }): IssueGroup[] => {
  const groups = new Map<string, IssueGroup>();
  for (const issue of issues) {
    const { key, label, color } = keyOf(issue);
    const group = groups.get(key) ?? { key, label, ...(color ? { color } : {}), issues: [] };
    group.issues.push(issue);
    groups.set(key, group);
  }
  return [...groups.values()];
};

/**
 * Issues in groups, in display order. A board keeps every status column (even
 * empty) so a card can be dropped there; a list shows non-empty groups only.
 * `workspaceNames` names the workspace groups, in the order given.
 */
export const groupIssues = (issues: readonly LinearIssue[], by: LinearGroupBy, options: { board?: boolean; workspaceNames?: ReadonlyMap<string, string> } = {}): IssueGroup[] => {
  switch (by) {
    case 'status': {
      const statuses = options.board ? BOARD_STATUSES : LIST_STATUSES;
      const groups = statuses.map((status) => ({ key: status.type, label: status.label, stateType: status.type, issues: issues.filter((issue) => issue.state.type === status.type) }));
      const known = new Set(statuses.map((status) => status.type));
      const other = issues.filter((issue) => !known.has(issue.state.type));
      if (other.length) groups.push({ key: 'other', label: 'Other', stateType: '', issues: other });
      return options.board ? groups.filter((group) => group.issues.length > 0 || group.key !== 'triage') : groups.filter((group) => group.issues.length > 0);
    }
    case 'priority':
      return PRIORITY_ORDER.map((priority) => ({ key: `p${priority}`, label: PRIORITY_LABELS[priority]!, issues: issues.filter((issue) => (priorityRank(issue.priority) === 5 ? 0 : issue.priority) === priority) })).filter((group) => group.issues.length > 0);
    case 'project': {
      const groups = collect(issues, (issue) => (issue.project ? { key: issue.project.id, label: issue.project.name } : { key: '', label: 'No project' }));
      return [...groups.filter((group) => group.key).sort(byLabel), ...groups.filter((group) => !group.key)];
    }
    case 'team':
      return collect(issues, (issue) => ({ key: issue.team.id, label: `${issue.team.key} · ${issue.team.name}` })).sort(byLabel);
    case 'assignee': {
      const groups = collect(issues, (issue) => (issue.assignee ? { key: issue.assignee.id, label: issue.assignee.name } : { key: '', label: 'Unassigned' }));
      return [...groups.filter((group) => group.key).sort(byLabel), ...groups.filter((group) => !group.key)];
    }
    case 'workspace': {
      const names = options.workspaceNames ?? new Map<string, string>();
      const order = [...names.keys()];
      const groups = collect(issues, (issue) => ({ key: issue.workspaceId ?? '', label: names.get(issue.workspaceId ?? '') ?? 'Linear' }));
      const rank = (key: string) => (order.includes(key) ? order.indexOf(key) : order.length);
      return groups.sort((a, b) => rank(a.key) - rank(b.key) || byLabel(a, b));
    }
    default:
      return issues.length ? [{ key: 'all', label: 'Issues', issues: [...issues] }] : [];
  }
};

const issueNumber = (identifier: string): number => Number(/-(\d+)$/.exec(identifier)?.[1] ?? 0);
const newestFirst = (a: LinearIssue, b: LinearIssue): number => b.updatedAt.localeCompare(a.updatedAt);

/** Issues in the chosen order; ties fall back to the most recently updated. */
export const sortIssues = (issues: readonly LinearIssue[], by: LinearOrderBy): LinearIssue[] =>
  [...issues].sort((a, b) => {
    switch (by) {
      case 'priority':
        return priorityRank(a.priority) - priorityRank(b.priority) || newestFirst(a, b);
      case 'due':
        return (a.dueDate ?? '9999-12-31').localeCompare(b.dueDate ?? '9999-12-31') || priorityRank(a.priority) - priorityRank(b.priority) || newestFirst(a, b);
      case 'identifier':
        return a.team.key.localeCompare(b.team.key) || issueNumber(a.identifier) - issueNumber(b.identifier);
      default:
        return newestFirst(a, b);
    }
  });

/** Project status groups, the active ones first. */
export const PROJECT_STATUSES = [
  { type: 'started', label: 'In progress' },
  { type: 'planned', label: 'Planned' },
  { type: 'paused', label: 'Paused' },
  { type: 'backlog', label: 'Backlog' },
];

export const HEALTH_LABELS: Record<string, string> = { onTrack: 'On track', atRisk: 'At risk', offTrack: 'Off track' };

/** Projects in status groups; within one, by priority, then the nearest target date, then name. */
export const groupProjects = (projects: readonly LinearProject[]): { type: string; label: string; projects: LinearProject[] }[] => {
  const sorted = [...projects].sort(
    (a, b) => priorityRank(a.priority) - priorityRank(b.priority) || (a.targetDate ?? '9999-12-31').localeCompare(b.targetDate ?? '9999-12-31') || a.name.localeCompare(b.name),
  );
  const known = new Set(PROJECT_STATUSES.map((status) => status.type));
  const groups = PROJECT_STATUSES.map((status) => ({ ...status, projects: sorted.filter((project) => project.status.type === status.type) }));
  groups.push({ type: 'other', label: 'Other', projects: sorted.filter((project) => !known.has(project.status.type)) });
  return groups.filter((group) => group.projects.length > 0);
};

/** Open tasks that plan Linear issues: on today, on a later day, or in the backlog. */
export const plannedLinearTasks = (state: PlannerState, today: DateKey): { key: 'today' | 'upcoming' | 'earlier' | 'backlog'; label: string; tasks: Task[] }[] => {
  const tasks = openLinked(state).sort((a, b) => (a.placement.kind === 'day' && b.placement.kind === 'day' ? a.placement.date.localeCompare(b.placement.date) : 0) || a.position - b.position);
  const on = (test: (task: Task) => boolean) => tasks.filter(test);
  const groups = [
    { key: 'today' as const, label: 'Today', tasks: on((task) => task.placement.kind === 'day' && task.placement.date === today) },
    { key: 'upcoming' as const, label: 'Upcoming', tasks: on((task) => task.placement.kind === 'day' && task.placement.date > today) },
    { key: 'earlier' as const, label: 'Earlier', tasks: on((task) => task.placement.kind === 'day' && task.placement.date < today) },
    { key: 'backlog' as const, label: 'Backlog', tasks: on((task) => task.placement.kind === 'backlog') },
  ];
  return groups.filter((group) => group.tasks.length > 0);
};
