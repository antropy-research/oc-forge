// Linear as a task source: GraphQL documents, issue → task mapping, and the
// rules for keeping a linked task in step with its issue.
import type { DateKey, Placement, PlannerState, Priority, Task, TaskSourceRef } from './types.ts';
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
  state: LinearState;
  team: { id: string; key: string; name: string };
  project: { id: string; name: string } | null;
  cycle: { id: string; number: number } | null;
}

const ISSUE_FIELDS = `id identifier title url priority dueDate updatedAt
    state { id name type color }
    team { id key name }
    project { id name }
    cycle { id number }`;

const OPEN_FILTER = `{ state: { type: { nin: ["completed", "canceled"] } } }`;

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
  SET_STATE_MUTATION,
  CREATE_ISSUE_MUTATION,
];

const FROM_LINEAR_PRIORITY: Record<number, Priority | null> = { 0: null, 1: 'urgent', 2: 'high', 3: 'medium', 4: 'low' };
const TO_LINEAR_PRIORITY: Record<Priority, number> = { urgent: 1, high: 2, medium: 3, low: 4 };

export const priorityFromLinear = (value: number): Priority | null => FROM_LINEAR_PRIORITY[value] ?? null;
export const priorityToLinear = (value: Priority | null): number => (value ? TO_LINEAR_PRIORITY[value] : 0);

export const isClosedType = (type: string | undefined): boolean => type === 'completed' || type === 'canceled';

/** The link a task keeps to its issue, with the title and state last seen there. */
export const issueSource = (issue: LinearIssue): TaskSourceRef => ({
  kind: 'linear',
  id: issue.id,
  key: issue.identifier,
  url: issue.url,
  title: issue.title,
  teamId: issue.team.id,
  status: { name: issue.state.name, type: issue.state.type, color: issue.state.color },
});

export const taskFromIssue = (issue: LinearIssue, id: string, placement: Placement, position: number): NewTask => ({
  id,
  title: issue.title,
  placement,
  position,
  priority: priorityFromLinear(issue.priority),
  dueDate: issue.dueDate && isDateKey(issue.dueDate) ? issue.dueDate : null,
  source: issueSource(issue),
});

/** The live task planning an issue, if any (an open one before a completed one). */
export const linkedTask = (state: PlannerState, issueId: string): Task | null => {
  const linked = Object.values(state.tasks).filter((task) => task.source?.kind === 'linear' && task.source.id === issueId && !task.deletedAt && !task.archivedAt);
  return linked.find((task) => !task.completedAt) ?? linked[0] ?? null;
};

/** Issues behind open linked tasks; completed tasks keep the state they last saw. */
export const linkedIssueIds = (state: PlannerState): string[] =>
  [...new Set(Object.values(state.tasks).filter((task) => task.source?.kind === 'linear' && !task.deletedAt && !task.archivedAt && !task.completedAt).map((task) => task.source!.id))];

/** The team's first state of `type` by its board order. */
export const stateOfType = (states: readonly LinearState[], type: 'completed' | 'started'): LinearState | null =>
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
    const next = issueSource(issue);
    const titleFollows = source.title !== undefined && task.title === source.title && issue.title !== source.title;
    const changed =
      source.title !== next.title ||
      source.key !== next.key ||
      source.url !== next.url ||
      source.teamId !== next.teamId ||
      source.status?.name !== next.status?.name ||
      source.status?.type !== next.status?.type ||
      source.status?.color !== next.status?.color;
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
    typeof team?.id === 'string'
  );
};

/** `NEX-110` from a Linear issue URL such as https://linear.app/acme/issue/NEX-110/some-title. */
export const parseLinearUrl = (text: string): string | null => {
  const match = /^https:\/\/linear\.app\/[^/\s]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:[/?#]\S*)?$/.exec(text.trim());
  return match ? match[1]!.toUpperCase() : null;
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
