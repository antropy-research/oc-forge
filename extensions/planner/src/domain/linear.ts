// Linear as a task source: GraphQL documents, issue → task mapping, and the
// rules for keeping a linked task in step with its issue.
import type { DateKey, Placement, PlannerState, Priority, Task, TaskSourceRef } from './types.ts';
import type { EventBody, NewTask } from './events.ts';
import { isDateKey } from './dates.ts';
import { PRIORITY_NAMES, VIEW_PREF_FIELDS, type GraphFilter, type ViewPrefs } from './linearDisplay.ts';

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
  createdAt?: string;
  completedAt?: string | null;
  canceledAt?: string | null;
  /** Linear's manual order, and the manual order within a priority. */
  sortOrder?: number;
  prioritySortOrder?: number;
  estimate?: number | null;
  /** The git branch Linear suggests for the issue. */
  branchName?: string;
  state: LinearState;
  team: { id: string; key: string; name: string };
  assignee?: { id: string; name: string } | null;
  creator?: { id: string; name: string } | null;
  project: { id: string; name: string; color?: string; icon?: string | null } | null;
  cycle: { id: string; number: number; name?: string | null; isActive?: boolean; isNext?: boolean } | null;
  /** Its project milestone; absent on issues read before lists carried it. */
  projectMilestone?: { id: string; name: string } | null;
  /** The issue this one is a sub-issue of. */
  parent?: { id: string; identifier: string; title: string } | null;
  /** Its labels, for filtering; absent on issues read before lists carried them. The first 25: `pageInfo` says when it has more. */
  labels?: { nodes: LinearLabel[]; pageInfo?: { hasNextPage: boolean } };
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
  createdAt?: string;
  /** Linear's manual order of projects. */
  sortOrder?: number;
  /** Status type: backlog, planned, started, paused, completed or canceled. */
  status: { id: string; name: string; type: string; color: string };
  lead: { id: string; name: string } | null;
  teams: { nodes: { id: string; key: string; name: string }[] };
  /** The workspace the Planner read it from. */
  workspaceId?: string;
}

export interface LinearLabel {
  id: string;
  name: string;
  color: string;
}

export interface LinearComment {
  id: string;
  /** Markdown. */
  body: string;
  createdAt: string;
  editedAt: string | null;
  user: { id: string; name: string } | null;
  botActor: { name: string | null } | null;
  parent: { id: string } | null;
}

/** One change in an issue's history, as its activity shows it. */
export interface LinearHistoryEntry {
  id: string;
  createdAt: string;
  actor: { id: string; name: string } | null;
  botActor: { name: string | null } | null;
  fromState: { name: string; color: string; type: string } | null;
  toState: { name: string; color: string; type: string } | null;
  fromAssignee: { name: string } | null;
  toAssignee: { name: string } | null;
  fromPriority: number | null;
  toPriority: number | null;
  fromTitle: string | null;
  toTitle: string | null;
  addedLabels: { name: string; color: string }[] | null;
  removedLabels: { name: string; color: string }[] | null;
  fromDueDate: string | null;
  toDueDate: string | null;
  fromProject: { name: string } | null;
  toProject: { name: string } | null;
  fromCycle: { number: number; name: string | null } | null;
  toCycle: { number: number; name: string | null } | null;
  fromEstimate: number | null;
  toEstimate: number | null;
  updatedDescription: boolean | null;
}

export interface LinearSubIssue {
  id: string;
  identifier: string;
  title: string;
  priority: number;
  state: { id: string; name: string; type: string; color: string };
  assignee: { id: string; name: string } | null;
}

export interface LinearAttachment {
  id: string;
  title: string;
  subtitle: string | null;
  url: string;
  sourceType: string | null;
}

/** An issue as the issue view shows it: description, sub-issues, links, activity and comments. */
export interface LinearIssueDetail extends LinearIssue {
  description: string | null;
  labels: { nodes: LinearLabel[]; pageInfo?: { hasNextPage: boolean } };
  comments: { nodes: LinearComment[]; pageInfo?: { hasNextPage: boolean } };
  children?: { nodes: LinearSubIssue[]; pageInfo?: { hasNextPage: boolean } };
  attachments?: { nodes: LinearAttachment[]; pageInfo?: { hasNextPage: boolean } };
  history?: { nodes: LinearHistoryEntry[]; pageInfo?: { hasNextPage: boolean } };
}

/**
 * What an issue's page shows the first of while Linear has more (its labels, sub-issues, links, comments and
 * activity are read with it, a page of each), so the page says so instead of leaving the rest out unsaid.
 */
export const issueDetailMore = (issue: LinearIssueDetail): string[] =>
  ([
    [issue.labels.pageInfo, 'labels'],
    [issue.children?.pageInfo, 'sub-issues'],
    [issue.attachments?.pageInfo, 'links'],
    [issue.comments.pageInfo, 'comments'],
    [issue.history?.pageInfo, 'activity'],
  ] as const).filter(([page]) => page?.hasNextPage).map(([, name]) => name);

export interface LinearCycle {
  id: string;
  number: number;
  name: string | null;
  startsAt: string;
  endsAt: string;
  isActive: boolean;
  isNext: boolean;
}

/** What an issue of a team can be set to. */
export interface TeamOptions {
  states: LinearState[];
  members: { id: string; name: string; displayName: string; active: boolean }[];
  /** The team's labels and the workspace's, without label groups. */
  labels: LinearLabel[];
  /** The team's current and coming cycles, when it uses cycles. */
  cycles: LinearCycle[];
  /** The open projects the team is part of. */
  projects: { id: string; name: string; color: string; icon: string | null }[];
  /** Linear's estimate scale for the team: notUsed, exponential, fibonacci, linear or tShirt. */
  estimation: { type: string; allowZero: boolean; extended: boolean };
}

/** The fields the Planner edits; Linear takes the description as Markdown. */
export interface IssueInput {
  title?: string;
  description?: string;
  stateId?: string;
  priority?: number;
  assigneeId?: string | null;
  dueDate?: string | null;
  addedLabelIds?: string[];
  removedLabelIds?: string[];
  projectId?: string | null;
  cycleId?: string | null;
  estimate?: number | null;
}

export const ISSUE_INPUT_KEYS: readonly (keyof IssueInput)[] = ['title', 'description', 'stateId', 'priority', 'assigneeId', 'dueDate', 'addedLabelIds', 'removedLabelIds', 'projectId', 'cycleId', 'estimate'];

export interface LinearProjectDetail extends LinearProject {
  content: string | null;
  /** The first 100; `pageInfo` says when the project has more. */
  projectMilestones: { nodes: { id: string; name: string; targetDate: string | null; progress: number; sortOrder: number }[]; pageInfo?: { hasNextPage: boolean } };
  lastUpdate: { id: string; body: string; health: string; createdAt: string; url: string; user: { id: string; name: string } } | null;
}

const ISSUE_FIELDS = `id identifier title url priority prioritySortOrder sortOrder estimate dueDate createdAt updatedAt completedAt canceledAt branchName
    state { id name type color position }
    team { id key name }
    assignee { id name }
    creator { id name }
    project { id name color icon }
    cycle { id number name isActive isNext }
    projectMilestone { id name }
    parent { id identifier title }
    labels(first: 25) { nodes { id name color } pageInfo { hasNextPage } }
    syncedWith { service metadata { ... on ExternalEntityInfoGithubMetadata { owner repo number } } }`;

const PAGE = 'pageInfo { hasNextPage endCursor }';

const PROJECT_FIELDS = `id name url color icon description progress health priority startDate targetDate createdAt updatedAt sortOrder
    status { id name type color }
    lead { id name }
    teams(first: 10) { nodes { id key name } }`;

/** Issue lists are read 100 at a time, newest change first, until Linear says there are no more. */
export const ISSUE_PAGE_SIZE = 100;

/** Issues assigned to me; `filter` adds the display's and the temporary filters. */
export const ASSIGNED_QUERY = `query PlannerAssigned($after: String, $filter: IssueFilter) {
  viewer {
    id
    name
    assignedIssues(first: 100, after: $after, orderBy: updatedAt, filter: $filter) {
      nodes { ${ISSUE_FIELDS} }
      ${PAGE}
    }
  }
}`;

/** Issues I created. */
export const CREATED_QUERY = `query PlannerCreated($after: String, $filter: IssueFilter) {
  viewer {
    id
    createdIssues(first: 100, after: $after, orderBy: updatedAt, filter: $filter) {
      nodes { ${ISSUE_FIELDS} }
      ${PAGE}
    }
  }
}`;

/** Any issues by filter: the ones I subscribe to, or a project's. */
export const ISSUES_QUERY = `query PlannerIssues($after: String, $filter: IssueFilter) {
  issues(first: 100, after: $after, orderBy: updatedAt, filter: $filter) {
    nodes { ${ISSUE_FIELDS} }
    ${PAGE}
  }
}`;

const VIEW_FIELDS = `id name description icon color shared modelName slugId updatedAt
    team { id key name }
    owner { id name }`;

/** The views saved in the workspace that I can see: mine, my teams' and the workspace's, of issues and of projects. */
export const VIEWS_QUERY = `query PlannerViews($after: String) {
  customViews(first: 100, after: $after) {
    nodes { ${VIEW_FIELDS} }
    ${PAGE}
  }
}`;

/** My favorites in Linear's sidebar: views, projects and issues, in its order. */
export const FAVORITE_VIEWS_QUERY = `query PlannerFavoriteViews($after: String) {
  favorites(first: 250, after: $after) {
    nodes {
      id type sortOrder
      customView { id }
      project { ${PROJECT_FIELDS} }
      issue { id identifier title url state { id name type color } team { id key name } }
    }
    ${PAGE}
  }
}`;

/** One saved view: its filter, what it lists and the display saved with it (layout, grouping, ordering, completed issues…). */
export const VIEW_QUERY = `query PlannerView($id: String!) {
  customView(id: $id) {
    ${VIEW_FIELDS}
    filterData
    viewPreferencesValues { ${VIEW_PREF_FIELDS} }
  }
}`;

/**
 * A saved view's issues: Linear applies the view's own filter; `filter` adds
 * only what the view's display hides (completed issues, sub-issues) and the
 * temporary filters.
 */
export const VIEW_ISSUES_QUERY = `query PlannerViewIssues($id: String!, $after: String, $filter: IssueFilter) {
  customView(id: $id) {
    id
    issues(first: 100, after: $after, orderBy: updatedAt, filter: $filter) {
      nodes { ${ISSUE_FIELDS} }
      ${PAGE}
    }
  }
}`;

/** A saved view of projects: the projects its filter selects. */
export const VIEW_PROJECTS_QUERY = `query PlannerViewProjects($id: String!, $after: String, $filter: ProjectFilter) {
  customView(id: $id) {
    id
    projects(first: 50, after: $after, filter: $filter) {
      nodes { ${PROJECT_FIELDS} }
      ${PAGE}
    }
  }
}`;

export const SEARCH_QUERY = `query PlannerSearch($term: String!, $after: String, $filter: IssueFilter) {
  searchIssues(term: $term, first: 50, after: $after, filter: $filter) {
    nodes { ${ISSUE_FIELDS} }
    ${PAGE}
  }
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

export const TEAMS_QUERY = `query PlannerTeams($after: String) {
  viewer { id }
  teams(first: 100, after: $after) { nodes { id key name } ${PAGE} }
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
    ${PAGE}
  }
}`;

/** One project's overview: description, milestones and latest update (its issues are a list of their own). */
export const PROJECT_QUERY = `query PlannerProject($id: String!) {
  project(id: $id) {
    ${PROJECT_FIELDS}
    content
    projectMilestones(first: 100) { nodes { id name targetDate progress sortOrder } pageInfo { hasNextPage } }
    lastUpdate { id body health createdAt url user { id name } }
  }
}`;

// What filters offer: every team with its states and estimate scale, the people,
// labels, projects, milestones and recent and coming cycles of the workspace,
// page by page.
export const FILTER_TEAMS_QUERY = `query PlannerFilterTeams($after: String) {
  teams(first: 50, after: $after) {
    nodes { id key name issueEstimationType issueEstimationAllowZero issueEstimationExtended states(first: 50) { nodes { id name type color position } pageInfo { hasNextPage } } }
    ${PAGE}
  }
}`;

export const FILTER_MILESTONES_QUERY = `query PlannerFilterMilestones($after: String) {
  projectMilestones(first: 250, after: $after) {
    nodes { id name targetDate project { id name } }
    ${PAGE}
  }
}`;

export const FILTER_USERS_QUERY = `query PlannerFilterUsers($after: String) {
  users(first: 250, after: $after, filter: { active: { eq: true } }) {
    nodes { id name displayName active isMe }
    ${PAGE}
  }
}`;

export const FILTER_LABELS_QUERY = `query PlannerFilterLabels($after: String) {
  issueLabels(first: 250, after: $after) {
    nodes { id name color isGroup parent { id name } team { id key } }
    ${PAGE}
  }
}`;

export const FILTER_PROJECTS_QUERY = `query PlannerFilterProjects($after: String) {
  projects(first: 250, after: $after) {
    nodes { id name color icon status { type } }
    ${PAGE}
  }
}`;

export const FILTER_CYCLES_QUERY = `query PlannerFilterCycles($after: String) {
  cycles(first: 250, after: $after, filter: { endsAt: { gt: "-P8W" } }) {
    nodes { id number name startsAt endsAt isActive isNext team { id key } }
    ${PAGE}
  }
}`;

const COMMENT_FIELDS = `id body createdAt editedAt user { id name } botActor { name } parent { id }`;

const HISTORY_FIELDS = `id createdAt actor { id name } botActor { name }
      fromState { name color type } toState { name color type }
      fromAssignee { name } toAssignee { name }
      fromPriority toPriority fromTitle toTitle
      addedLabels { name color } removedLabels { name color }
      fromDueDate toDueDate fromProject { name } toProject { name }
      fromCycle { number name } toCycle { number name }
      fromEstimate toEstimate updatedDescription`;

// ISSUE_FIELDS carries the labels already.
const DETAIL_FIELDS = `${ISSUE_FIELDS}
    description
    comments(first: 100) { nodes { ${COMMENT_FIELDS} } pageInfo { hasNextPage } }
    children(first: 50) { nodes { id identifier title priority state { id name type color } assignee { id name } } pageInfo { hasNextPage } }
    attachments(first: 25) { nodes { id title subtitle url sourceType } pageInfo { hasNextPage } }
    history(first: 50) { nodes { ${HISTORY_FIELDS} } pageInfo { hasNextPage } }`;

/** One issue with its description, sub-issues, links, activity and comments, for the issue view. */
export const ISSUE_DETAIL_QUERY = `query PlannerIssueDetail($id: String!) {
  issue(id: $id) { ${DETAIL_FIELDS} }
}`;

/** What an issue of a team can be set to: states, active members, labels (its own and the workspace's), cycles, projects, estimates. */
export const TEAM_OPTIONS_QUERY = `query PlannerTeamOptions($id: String!) {
  team(id: $id) {
    id
    cyclesEnabled
    issueEstimationType
    issueEstimationAllowZero
    issueEstimationExtended
    states(first: 100) { nodes { id name type color position } ${PAGE} }
    members(first: 250) { nodes { id name displayName active } ${PAGE} }
    labels(first: 250, filter: { isGroup: { eq: false } }) { nodes { id name color } ${PAGE} }
    cycles(first: 25, filter: { endsAt: { gt: "-P1D" } }) { nodes { id number name startsAt endsAt isActive isNext } ${PAGE} }
    projects(first: 100, filter: { status: { type: { nin: ["completed", "canceled"] } } }) { nodes { id name color icon } ${PAGE} }
  }
  issueLabels(first: 250, filter: { team: { null: true }, isGroup: { eq: false } }) { nodes { id name color } ${PAGE} }
}`;

/** The rest of one of a team's options, after TEAM_OPTIONS_QUERY's first page of it, with the same filter. */
const TEAM_OPTION_PAGES = {
  states: `states(first: 250, after: $after) { nodes { id name type color position } ${PAGE} }`,
  members: `members(first: 250, after: $after) { nodes { id name displayName active } ${PAGE} }`,
  labels: `labels(first: 250, after: $after, filter: { isGroup: { eq: false } }) { nodes { id name color } ${PAGE} }`,
  cycles: `cycles(first: 250, after: $after, filter: { endsAt: { gt: "-P1D" } }) { nodes { id number name startsAt endsAt isActive isNext } ${PAGE} }`,
  projects: `projects(first: 250, after: $after, filter: { status: { type: { nin: ["completed", "canceled"] } } }) { nodes { id name color icon } ${PAGE} }`,
} as const;

export type TeamOptionField = keyof typeof TEAM_OPTION_PAGES;

export const teamOptionPageQuery = (field: TeamOptionField): string => `query PlannerTeamOptionPage($id: String!, $after: String) {
  team(id: $id) { id ${TEAM_OPTION_PAGES[field]} }
}`;

/** The rest of the workspace's own labels (no team's), after TEAM_OPTIONS_QUERY's first page of them. */
export const WORKSPACE_LABELS_QUERY = `query PlannerWorkspaceLabels($after: String) {
  issueLabels(first: 250, after: $after, filter: { team: { null: true }, isGroup: { eq: false } }) { nodes { id name color } ${PAGE} }
}`;

export const UPDATE_ISSUE_MUTATION = `mutation PlannerUpdateIssue($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success issue { ${DETAIL_FIELDS} } }
}`;

/** A comment's body is Markdown. */
export const ADD_COMMENT_MUTATION = `mutation PlannerAddComment($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { ${COMMENT_FIELDS} } }
}`;

export const SET_STATE_MUTATION = `mutation PlannerSetState($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) { success issue { ${ISSUE_FIELDS} } }
}`;

export const CREATE_ISSUE_MUTATION = `mutation PlannerCreateIssue($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } }
}`;

/** A saved view's filters written back, as Linear's "Save" does after its filters were changed. */
export const SAVE_VIEW_FILTER_MUTATION = `mutation PlannerSaveViewFilter($id: String!, $filterData: IssueFilter!) {
  customViewUpdate(id: $id, input: { filterData: $filterData }) { success customView { id updatedAt } }
}`;

export const ALL_DOCUMENTS = [
  SAVE_VIEW_FILTER_MUTATION,
  ASSIGNED_QUERY,
  CREATED_QUERY,
  ISSUES_QUERY,
  VIEWS_QUERY,
  FAVORITE_VIEWS_QUERY,
  VIEW_QUERY,
  VIEW_ISSUES_QUERY,
  VIEW_PROJECTS_QUERY,
  SEARCH_QUERY,
  LINKED_QUERY,
  ISSUE_QUERY,
  TEAM_STATES_QUERY,
  TEAMS_QUERY,
  WHOAMI_QUERY,
  PROJECTS_QUERY,
  PROJECT_QUERY,
  FILTER_TEAMS_QUERY,
  FILTER_USERS_QUERY,
  FILTER_LABELS_QUERY,
  FILTER_PROJECTS_QUERY,
  FILTER_CYCLES_QUERY,
  FILTER_MILESTONES_QUERY,
  ISSUE_DETAIL_QUERY,
  TEAM_OPTIONS_QUERY,
  SET_STATE_MUTATION,
  CREATE_ISSUE_MUTATION,
  UPDATE_ISSUE_MUTATION,
  ADD_COMMENT_MUTATION,
];

/**
 * The input fields each mutation may carry. The service checks these before it
 * runs a mutation with a workspace's API key.
 */
export const MUTATION_INPUT_KEYS: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
  [UPDATE_ISSUE_MUTATION, ISSUE_INPUT_KEYS],
  [ADD_COMMENT_MUTATION, ['issueId', 'body']],
  [CREATE_ISSUE_MUTATION, ['teamId', 'title', 'assigneeId', 'priority', 'description', 'dueDate']],
]);

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

/** Linear's priority names, by its numbers (0 none, 1 urgent … 4 low). */
export const PRIORITY_LABELS: Record<number, string> = PRIORITY_NAMES;

// ── Saved views ──────────────────────────────────────────────────────────────

/** A view saved in Linear (a custom view), as the source picker lists it. */
export interface LinearSavedView {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  /** Shared with its team or the workspace; otherwise only its owner sees it. */
  shared: boolean;
  /** What the view lists, such as issues or projects. */
  modelName: string;
  slugId: string;
  updatedAt: string;
  team: { id: string; key: string; name: string } | null;
  owner: { id: string; name: string } | null;
  /** The workspace the Planner read it from. */
  workspaceId?: string;
  /** Its place among my favorites in Linear's sidebar, when I favorited it. */
  favoriteOrder?: number;
}

/** A saved view as opened: its filter, what it lists and the display saved with it. */
export interface LinearViewMeta extends LinearSavedView {
  viewPreferencesValues: ViewPrefs | null;
  /** The view's own filter of issues, as Linear keeps it (an IssueFilter). */
  filterData?: GraphFilter | null;
}

const NON_ISSUE_MODELS = new Set(['project', 'projects', 'initiative', 'initiatives', 'feeditem', 'feeditems', 'customer', 'customers', 'document', 'documents', 'release', 'releases']);

/** Views that list issues; Linear also saves views of projects, initiatives and the like. */
export const isIssueView = (view: Pick<LinearSavedView, 'modelName'>): boolean => !NON_ISSUE_MODELS.has(view.modelName.replace(/[^a-z]/gi, '').toLowerCase());

/** A saved view of projects (`modelName` "Project"), shown as a list of projects. */
export const isProjectView = (view: Pick<LinearSavedView, 'modelName'>): boolean => view.modelName.replace(/[^a-z]/gi, '').toLowerCase() === 'project';

/** A favorite in Linear's sidebar, as Linear answers it. */
export interface LinearFavoriteNode {
  id?: string;
  type: string;
  sortOrder: number;
  customView: { id: string } | null;
  project?: LinearProject | null;
  issue?: { id: string; identifier: string; title: string; url: string; state: { id: string; name: string; type: string; color: string }; team: { id: string; key: string; name: string } } | null;
}

/** What the Planner opens from my favorites: views, projects and issues. */
export type LinearFavorite =
  | { kind: 'view'; id: string; sortOrder: number; workspaceId: string }
  | { kind: 'project'; id: string; sortOrder: number; workspaceId: string; project: LinearProject }
  | { kind: 'issue'; id: string; sortOrder: number; workspaceId: string; identifier: string; title: string; state: { name: string; type: string; color: string } };

/** My favorites' order, by view id, from Linear's favorites. */
export const favoriteOrder = (favorites: readonly Pick<LinearFavoriteNode, 'type' | 'sortOrder' | 'customView'>[]): Map<string, number> =>
  new Map(favorites.flatMap((favorite) => (favorite.customView ? [[favorite.customView.id, favorite.sortOrder] as const] : [])));

/** The favorites the Planner can open, in Linear's sidebar order. */
export const favoritesOf = (nodes: readonly LinearFavoriteNode[], workspaceId: string): LinearFavorite[] =>
  [...nodes]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .flatMap((node): LinearFavorite[] => {
      if (node.customView) return [{ kind: 'view', id: node.customView.id, sortOrder: node.sortOrder, workspaceId }];
      if (node.project) return [{ kind: 'project', id: node.project.id, sortOrder: node.sortOrder, workspaceId, project: { ...node.project, workspaceId } }];
      if (node.issue) return [{ kind: 'issue', id: node.issue.id, sortOrder: node.sortOrder, workspaceId, identifier: node.issue.identifier, title: node.issue.title, state: node.issue.state }];
      return [];
    });

export interface ViewGroup {
  key: string;
  label: string;
  views: LinearSavedView[];
}

/**
 * Saved views as the picker groups them: my favorites first, in Linear's order;
 * then, per workspace, each team's views, the workspace's shared views and my
 * own; by name within a group. `workspaceNames`, given while several workspaces
 * are shown, names the workspace in each group's label.
 */
export const groupViews = (views: readonly LinearSavedView[], workspaceNames?: ReadonlyMap<string, string>, options: { favoritesFirst?: boolean } = {}): ViewGroup[] => {
  const byName = (a: LinearSavedView, b: LinearSavedView) => a.name.localeCompare(b.name);
  const prefix = (workspaceId: string | undefined) => {
    const name = workspaceNames && workspaceNames.size > 1 ? workspaceNames.get(workspaceId ?? '') : undefined;
    return name ? `${name} · ` : '';
  };
  const firsts = options.favoritesFirst !== false;
  const favorites = firsts ? views.filter((view) => view.favoriteOrder !== undefined).sort((a, b) => a.favoriteOrder! - b.favoriteOrder! || byName(a, b)) : [];
  const groups: ViewGroup[] = favorites.length ? [{ key: 'favorites', label: 'Favorites', views: favorites }] : [];
  const rest = firsts ? views.filter((view) => view.favoriteOrder === undefined) : [...views];
  const workspaceOrder = [...new Set([...(workspaceNames?.keys() ?? []), ...rest.map((view) => view.workspaceId ?? '')])];
  for (const workspaceId of workspaceOrder) {
    const inWorkspaceViews = rest.filter((view) => (view.workspaceId ?? '') === workspaceId);
    const teams = new Map<string, { key: string; name: string; views: LinearSavedView[] }>();
    for (const view of inWorkspaceViews.filter((item) => item.team)) {
      const team = teams.get(view.team!.id) ?? { key: view.team!.key, name: view.team!.name, views: [] };
      team.views.push(view);
      teams.set(view.team!.id, team);
    }
    for (const [teamId, team] of [...teams].sort((a, b) => a[1].key.localeCompare(b[1].key))) {
      groups.push({ key: `${workspaceId}:team:${teamId}`, label: `${prefix(workspaceId)}${team.key} · ${team.name}`, views: team.views.sort(byName) });
    }
    const shared = inWorkspaceViews.filter((view) => !view.team && view.shared).sort(byName);
    if (shared.length) groups.push({ key: `${workspaceId}:workspace`, label: `${prefix(workspaceId)}Workspace views`, views: shared });
    const mine = inWorkspaceViews.filter((view) => !view.team && !view.shared).sort(byName);
    if (mine.length) groups.push({ key: `${workspaceId}:mine`, label: `${prefix(workspaceId)}My views`, views: mine });
  }
  return groups;
};

// ── Editing ──────────────────────────────────────────────────────────────────

export interface IssueText {
  title: string;
  /** Markdown; an issue without a description has ''. */
  description: string;
}

/**
 * What saving an edit sends, given the text the edit started from (`base`),
 * what Linear has now (`current`) and the edit (`next`). Only fields the user
 * changed are sent; it is a conflict when someone changed one of those same
 * fields in Linear meanwhile, so their change is never overwritten silently.
 */
export const planTextSave = (base: IssueText, current: IssueText, next: IssueText): { input: Pick<IssueInput, 'title' | 'description'>; conflict: boolean } => {
  const input: Pick<IssueInput, 'title' | 'description'> = {};
  let conflict = false;
  for (const field of ['title', 'description'] as const) {
    if (next[field] === base[field] || next[field] === current[field]) continue;
    input[field] = next[field];
    if (current[field] !== base[field]) conflict = true;
  }
  return { input, conflict };
};

const STATE_ORDER = ['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled'];

/** Workflow states in Linear's order: by type, then by position on the board. */
export const workflowOrder = (states: readonly LinearState[]): LinearState[] =>
  [...states].sort((a, b) => {
    const rank = (state: LinearState) => (STATE_ORDER.includes(state.type) ? STATE_ORDER.indexOf(state.type) : STATE_ORDER.length);
    return rank(a) - rank(b) || (a.position ?? 0) - (b.position ?? 0);
  });

/** A saved view's address in Linear. */
export const viewUrl = (urlKey: string, view: Pick<LinearSavedView, 'slugId'>): string => `https://linear.app/${urlKey}/view/${view.slugId}`;

const T_SHIRT: Record<number, string> = { 0: 'None', 1: 'XS', 2: 'S', 3: 'M', 5: 'L', 8: 'XL', 13: 'XXL', 21: 'XXXL' };

/** The estimates a team's scale offers (Linear's exponential, Fibonacci, linear or T-shirt), with their names. */
export const estimateChoices = (estimation: TeamOptions['estimation']): { value: number; label: string }[] => {
  const scales: Record<string, { base: number[]; more: number[] }> = {
    exponential: { base: [1, 2, 4, 8, 16], more: [32, 64] },
    fibonacci: { base: [1, 2, 3, 5, 8], more: [13, 21] },
    linear: { base: [1, 2, 3, 4, 5], more: [6, 7] },
    tShirt: { base: [1, 2, 3, 5, 8], more: [13, 21] },
  };
  const scale = scales[estimation.type];
  if (!scale) return [];
  const values = [...(estimation.allowZero ? [0] : []), ...scale.base, ...(estimation.extended ? scale.more : [])];
  return values.map((value) => ({ value, label: estimation.type === 'tShirt' ? T_SHIRT[value] ?? String(value) : `${value} point${value === 1 ? '' : 's'}` }));
};

/** An estimate as its team names it, such as "3 points" or "M". */
export const estimateLabel = (value: number | null | undefined, estimation?: TeamOptions['estimation']): string => {
  if (value === null || value === undefined) return 'No estimate';
  if (estimation?.type === 'tShirt') return T_SHIRT[value] ?? String(value);
  return `${value} point${value === 1 ? '' : 's'}`;
};

/** What one history entry says changed, as Linear's activity reads ("changed status from Todo to In Progress"). */
export const historyText = (entry: LinearHistoryEntry): string | null => {
  const named = (value: { name: string } | null | undefined, none: string) => value?.name ?? none;
  const cycle = (value: LinearHistoryEntry['fromCycle']) => (value ? value.name || `Cycle ${value.number}` : 'no cycle');
  if (entry.fromState || entry.toState) return `changed status from ${named(entry.fromState, 'none')} to ${named(entry.toState, 'none')}`;
  if (entry.fromAssignee !== entry.toAssignee && (entry.fromAssignee || entry.toAssignee)) {
    if (!entry.toAssignee) return `removed the assignee ${named(entry.fromAssignee, '')}`.trim();
    return entry.fromAssignee ? `reassigned from ${entry.fromAssignee.name} to ${entry.toAssignee.name}` : `assigned ${entry.toAssignee.name}`;
  }
  if (entry.fromPriority !== null && entry.toPriority !== null && entry.fromPriority !== entry.toPriority) return `changed priority from ${PRIORITY_NAMES[entry.fromPriority] ?? entry.fromPriority} to ${PRIORITY_NAMES[entry.toPriority] ?? entry.toPriority}`;
  if (entry.addedLabels?.length) return `added label${entry.addedLabels.length > 1 ? 's' : ''} ${entry.addedLabels.map((label) => label.name).join(', ')}`;
  if (entry.removedLabels?.length) return `removed label${entry.removedLabels.length > 1 ? 's' : ''} ${entry.removedLabels.map((label) => label.name).join(', ')}`;
  if (entry.fromTitle && entry.toTitle && entry.fromTitle !== entry.toTitle) return `changed the title to "${entry.toTitle}"`;
  if (entry.fromDueDate !== entry.toDueDate && (entry.fromDueDate || entry.toDueDate)) return entry.toDueDate ? `set the due date to ${entry.toDueDate}` : 'removed the due date';
  if (entry.fromProject || entry.toProject) return entry.toProject ? `moved to project ${entry.toProject.name}` : `removed from project ${named(entry.fromProject, '')}`.trim();
  if (entry.fromCycle || entry.toCycle) return entry.toCycle ? `moved to ${cycle(entry.toCycle)}` : `removed from ${cycle(entry.fromCycle)}`;
  if (entry.fromEstimate !== entry.toEstimate && (entry.fromEstimate !== null || entry.toEstimate !== null)) return entry.toEstimate !== null ? `set the estimate to ${entry.toEstimate}` : 'removed the estimate';
  if (entry.updatedDescription) return 'updated the description';
  return null;
};

/** Comments oldest first, each reply right after the comment it answers. */
export const commentThreads = (comments: readonly LinearComment[]): { comment: LinearComment; reply: boolean }[] => {
  const byTime = [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const byId = new Map(byTime.map((comment) => [comment.id, comment]));
  // A reply to a reply belongs to the same thread; a parent not loaded starts its own.
  const rootOf = (comment: LinearComment): string => {
    const seen = new Set<string>();
    let current = comment;
    while (current.parent && byId.has(current.parent.id) && !seen.has(current.id)) {
      seen.add(current.id);
      current = byId.get(current.parent.id)!;
    }
    return current.id;
  };
  const roots = byTime.filter((comment) => rootOf(comment) === comment.id);
  return roots.flatMap((root) => [
    { comment: root, reply: false },
    ...byTime.filter((comment) => comment.id !== root.id && rootOf(comment) === root.id).map((comment) => ({ comment, reply: true })),
  ]);
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
