// Linear's Display options for issue and project lists: layout, grouping and
// sub-grouping, ordering, completed issues, sub-issues, empty groups and row
// properties; what a saved view sets of them, the part of the GraphQL filter
// they imply, and the groups they make. Grouped by status, groups are the
// teams' exact workflow states (one per name across teams, as Linear merges
// them), and a card dropped on one moves to that very state.
import {
  LINEAR_COMPLETED,
  LINEAR_GROUPS,
  LINEAR_ORDERS,
  LINEAR_PROPERTIES,
  type LinearCompletedWindow,
  type LinearDisplayPrefs,
  type LinearGroupBy,
  type LinearOrderBy,
  type LinearProperty,
  type Settings,
} from './types.ts';
import type { IssueInput, LinearIssue, LinearProject, LinearState } from './linear.ts';

/** A GraphQL input object (IssueFilter, ProjectFilter), as JSON. */
export type GraphFilter = { [key: string]: unknown };

/** Everything Linear's Display menu sets for an issue list. */
/** Whether a display shows empty groups (a list) or empty columns (a board). */
export const showsEmpty = (display: Pick<IssueDisplay, 'layout' | 'showEmptyGroups' | 'showEmptyColumns'>): boolean => (display.layout === 'board' ? display.showEmptyColumns : display.showEmptyGroups);

export interface IssueDisplay extends LinearDisplayPrefs {
  layout: 'list' | 'board';
  groupBy: LinearGroupBy;
  orderBy: LinearOrderBy;
  /** Issues in Triage; Linear hides them in some views. */
  showTriage: boolean;
}

export const DEFAULT_DISPLAY_PREFS: LinearDisplayPrefs = {
  subGroupBy: 'none',
  orderReverse: false,
  showCompleted: 'none',
  showSubIssues: true,
  showEmptyGroups: false,
  showEmptyColumns: true,
  properties: ['id', 'status', 'priority', 'labels', 'project', 'due', 'assignee', 'created'],
};

export const GROUP_LABELS: Record<LinearGroupBy, string> = {
  status: 'Status',
  assignee: 'Assignee',
  project: 'Project',
  priority: 'Priority',
  cycle: 'Cycle',
  label: 'Label',
  team: 'Team',
  workspace: 'Workspace',
  none: 'No grouping',
};

export const ORDER_LABELS: Record<LinearOrderBy, string> = {
  manual: 'Manual',
  status: 'Status',
  priority: 'Priority',
  updated: 'Last updated',
  created: 'Last created',
  due: 'Due date',
  identifier: 'Issue number',
};

export const COMPLETED_LABELS: Record<LinearCompletedWindow, string> = {
  all: 'All',
  day: 'Past day',
  '5days': 'Past 5 days',
  week: 'Past week',
  month: 'Past month',
  '3months': 'Past 3 months',
  '6months': 'Past 6 months',
  year: 'Past year',
  none: 'None',
};

export const PROPERTY_LABELS: Record<LinearProperty, string> = {
  id: 'ID',
  status: 'Status',
  priority: 'Priority',
  assignee: 'Assignee',
  labels: 'Labels',
  project: 'Project',
  cycle: 'Cycle',
  estimate: 'Estimate',
  due: 'Due date',
  created: 'Created',
  updated: 'Updated',
};

export const PRIORITY_NAMES: Record<number, string> = { 0: 'No priority', 1: 'Urgent', 2: 'High', 3: 'Medium', 4: 'Low' };
/** No priority sorts after Low, as in Linear. */
export const priorityRank = (priority: number): number => (priority >= 1 && priority <= 4 ? priority : 5);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === 'string' && (list as readonly string[]).includes(value);

/** Why a stored `linearDisplay` setting is not valid, or null. */
export const linearDisplayProblem = (value: unknown): string | null => {
  if (!isRecord(value)) return 'linearDisplay must be an object';
  if (!oneOf(LINEAR_GROUPS, value.subGroupBy)) return `linearDisplay.subGroupBy must be one of ${LINEAR_GROUPS.join(', ')}`;
  if (!oneOf(LINEAR_COMPLETED, value.showCompleted)) return `linearDisplay.showCompleted must be one of ${LINEAR_COMPLETED.join(', ')}`;
  for (const flag of ['orderReverse', 'showSubIssues', 'showEmptyGroups', 'showEmptyColumns'] as const) if (typeof value[flag] !== 'boolean') return `linearDisplay.${flag} must be true or false`;
  if (!Array.isArray(value.properties) || value.properties.length > LINEAR_PROPERTIES.length || !value.properties.every((item) => oneOf(LINEAR_PROPERTIES, item))) return 'linearDisplay.properties must list issue properties';
  const known = new Set(['subGroupBy', 'orderReverse', 'showCompleted', 'showSubIssues', 'showEmptyGroups', 'showEmptyColumns', 'properties']);
  const extra = Object.keys(value).find((key) => !known.has(key));
  return extra ? `unknown linearDisplay.${extra}` : null;
};

/** The display of the Planner's own lists (My issues, a project's issues, a search), from the settings. */
export const settingsDisplay = (settings: Pick<Settings, 'linearLayout' | 'linearGroupBy' | 'linearOrderBy'> & { linearDisplay?: Partial<LinearDisplayPrefs> }): IssueDisplay => ({
  ...DEFAULT_DISPLAY_PREFS,
  ...settings.linearDisplay,
  layout: settings.linearLayout,
  groupBy: settings.linearGroupBy,
  orderBy: settings.linearOrderBy,
  showTriage: true,
});

// ── A saved view's display ──────────────────────────────────────────────────

/** The view preference values the Planner reads (Linear's ViewPreferencesValues). */
export interface ViewPrefs {
  layout?: string | null;
  issueGrouping?: string | null;
  issueSubGrouping?: string | null;
  viewOrdering?: string | null;
  viewOrderingDirection?: string | null;
  showCompletedIssues?: string | null;
  showSubIssues?: boolean | null;
  showTriageIssues?: boolean | null;
  showEmptyGroups?: boolean | null;
  showEmptyGroupsBoard?: boolean | null;
  showEmptyGroupsList?: boolean | null;
  fieldId?: boolean | null;
  fieldStatus?: boolean | null;
  fieldPriority?: boolean | null;
  fieldAssignee?: boolean | null;
  fieldLabels?: boolean | null;
  fieldProject?: boolean | null;
  fieldCycle?: boolean | null;
  fieldEstimate?: boolean | null;
  fieldDueDate?: boolean | null;
  fieldDateCreated?: boolean | null;
  fieldDateUpdated?: boolean | null;
  projectLayout?: string | null;
  projectGrouping?: string | null;
  projectViewOrdering?: string | null;
  showCompletedProjects?: string | null;
}

/** The fields of ViewPreferencesValues a saved view is read with. */
export const VIEW_PREF_FIELDS = `layout issueGrouping issueSubGrouping viewOrdering viewOrderingDirection showCompletedIssues showSubIssues showTriageIssues
      showEmptyGroups showEmptyGroupsBoard showEmptyGroupsList
      fieldId fieldStatus fieldPriority fieldAssignee fieldLabels fieldProject fieldCycle fieldEstimate fieldDueDate fieldDateCreated fieldDateUpdated
      projectLayout projectGrouping projectViewOrdering showCompletedProjects`;

const squash = (value: string | null | undefined): string => (value ?? '').replace(/[^a-z0-9]/gi, '').toLowerCase();

const GROUPINGS: Record<string, LinearGroupBy> = {
  workflowstate: 'status',
  status: 'status',
  state: 'status',
  assignee: 'assignee',
  project: 'project',
  priority: 'priority',
  cycle: 'cycle',
  label: 'label',
  labels: 'label',
  team: 'team',
  nogrouping: 'none',
  none: 'none',
};
const ORDERINGS: Record<string, LinearOrderBy> = {
  manual: 'manual',
  workflowstate: 'status',
  status: 'status',
  priority: 'priority',
  updatedat: 'updated',
  updated: 'updated',
  createdat: 'created',
  created: 'created',
  duedate: 'due',
  due: 'due',
  number: 'identifier',
  identifier: 'identifier',
};
const FIELD_PROPERTIES: [keyof ViewPrefs, LinearProperty][] = [
  ['fieldId', 'id'],
  ['fieldStatus', 'status'],
  ['fieldPriority', 'priority'],
  ['fieldAssignee', 'assignee'],
  ['fieldLabels', 'labels'],
  ['fieldProject', 'project'],
  ['fieldCycle', 'cycle'],
  ['fieldEstimate', 'estimate'],
  ['fieldDueDate', 'due'],
  ['fieldDateCreated', 'created'],
  ['fieldDateUpdated', 'updated'],
];

/** Linear's completed-issues choice ("all", "week", "3months", "none"…); null when it is not one. */
export const completedWindow = (value: string | null | undefined): LinearCompletedWindow | null => {
  const key = squash(value);
  if (!key) return null;
  if ((LINEAR_COMPLETED as readonly string[]).includes(key)) return key as LinearCompletedWindow;
  if (key === 'hide' || key === 'false') return 'none';
  if (key === 'show' || key === 'true') return 'all';
  const match = /^(?:past|last)?(\d+|one|three|six)?(day|week|month|year)s?$/.exec(key);
  if (!match) return null;
  const count = ({ one: '1', three: '3', six: '6' } as Record<string, string>)[match[1] ?? ''] ?? match[1] ?? '1';
  const unit = match[2]!;
  if (unit === 'month' && (count === '3' || count === '6')) return `${count}months` as LinearCompletedWindow;
  return count === '1' ? (unit as LinearCompletedWindow) : null;
};

/** Ordering directions that differ from Linear's natural one (newest first, soonest due first). */
const reversed = (orderBy: LinearOrderBy, direction: string | null | undefined): boolean => {
  const key = squash(direction);
  const asc = key === 'asc' || key === 'ascending';
  const desc = key === 'desc' || key === 'descending';
  if (orderBy === 'updated' || orderBy === 'created') return asc;
  if (orderBy === 'due' || orderBy === 'identifier') return desc;
  return false;
};

/**
 * A saved view's display: its layout, grouping, sub-grouping, ordering,
 * completed issues, sub-issues, triage, empty groups and properties. What the
 * Planner cannot show the same way keeps `fallback` and is named in `unsupported`.
 */
export const viewDisplay = (prefs: ViewPrefs | null | undefined, fallback: IssueDisplay): { display: IssueDisplay; unsupported: string[] } => {
  const unsupported: string[] = [];
  const display: IssueDisplay = { ...fallback, properties: [...fallback.properties] };
  if (!prefs) return { display, unsupported };
  const layout = squash(prefs.layout);
  if (layout === 'list' || layout === 'board') display.layout = layout;
  else if (layout) unsupported.push(`the ${prefs.layout} layout`);
  const group = (value: string | null | undefined, what: string): LinearGroupBy | null => {
    const key = squash(value);
    if (!key) return null;
    const known = GROUPINGS[key];
    if (!known) unsupported.push(`${what} by ${value}`);
    return known ?? null;
  };
  display.groupBy = group(prefs.issueGrouping, 'grouping') ?? display.groupBy;
  display.subGroupBy = group(prefs.issueSubGrouping, 'sub-grouping') ?? (prefs.issueSubGrouping === undefined ? display.subGroupBy : 'none');
  const order = squash(prefs.viewOrdering);
  if (order) {
    const known = ORDERINGS[order];
    if (known) display.orderBy = known;
    else unsupported.push(`ordering by ${prefs.viewOrdering}`);
  }
  display.orderReverse = reversed(display.orderBy, prefs.viewOrderingDirection);
  // A choice the Planner does not know leaves the view's own filter alone.
  display.showCompleted = completedWindow(prefs.showCompletedIssues) ?? 'all';
  if (prefs.showCompletedIssues && !completedWindow(prefs.showCompletedIssues)) unsupported.push(`completed issues "${prefs.showCompletedIssues}"`);
  display.showSubIssues = prefs.showSubIssues ?? true;
  display.showTriage = prefs.showTriageIssues ?? true;
  display.showEmptyGroups = prefs.showEmptyGroupsList ?? prefs.showEmptyGroups ?? false;
  display.showEmptyColumns = prefs.showEmptyGroupsBoard ?? prefs.showEmptyGroups ?? true;
  if (FIELD_PROPERTIES.some(([field]) => typeof prefs[field] === 'boolean')) display.properties = FIELD_PROPERTIES.filter(([field]) => prefs[field] === true).map(([, property]) => property);
  return { display, unsupported };
};

// ── The filter a display implies ────────────────────────────────────────────

const WINDOW_DURATIONS: Record<string, string> = { day: 'P1D', '5days': 'P5D', week: 'P1W', month: 'P1M', '3months': 'P3M', '6months': 'P6M', year: 'P1Y' };
const OPEN_STATES: GraphFilter = { state: { type: { nin: ['completed', 'canceled'] } } };

/** Several filters that must all hold; null when there are none. */
export const allOf = (...filters: (GraphFilter | null | undefined)[]): GraphFilter | null => {
  const present = filters.filter((filter): filter is GraphFilter => Boolean(filter && Object.keys(filter).length));
  return present.length === 0 ? null : present.length === 1 ? present[0]! : { and: present };
};

/**
 * What the display's completed issues, sub-issues and triage choices keep, as
 * an IssueFilter: open issues plus those closed within the window. Nothing
 * else is narrowed, so a view keeps exactly its own filter.
 */
export const displayFilter = (display: Pick<IssueDisplay, 'showCompleted' | 'showSubIssues' | 'showTriage'>): GraphFilter | null => {
  const parts: GraphFilter[] = [];
  if (display.showCompleted === 'none') parts.push(OPEN_STATES);
  else if (display.showCompleted !== 'all') {
    const since = `-${WINDOW_DURATIONS[display.showCompleted]}`;
    parts.push({ or: [OPEN_STATES, { completedAt: { gte: since } }, { canceledAt: { gte: since } }] });
  }
  if (!display.showSubIssues) parts.push({ parent: { null: true } });
  if (!display.showTriage) parts.push({ state: { type: { neq: 'triage' } } });
  return allOf(...parts);
};

// ── Groups ──────────────────────────────────────────────────────────────────

/** What dropping a card on a group (column or row) changes on the issue. */
export type GroupTarget =
  | { kind: 'state'; name: string; type: string }
  | { kind: 'priority'; priority: number }
  | { kind: 'assignee'; id: string | null }
  | { kind: 'project'; id: string | null }
  | { kind: 'cycle'; id: string | null; teamId: string | null };

export interface IssueGroup {
  key: string;
  label: string;
  color?: string;
  /** A status group's state type, for its icon. */
  stateType?: string;
  /** What a card dropped here takes; absent where Linear's grouping has no single value to set. */
  target?: GroupTarget;
  issues: LinearIssue[];
}

/** A status column or group: one workflow state, or same-named states of several teams. */
export interface StateGroup {
  key: string;
  name: string;
  type: string;
  color: string;
  position: number;
  /** The ids of the states it stands for, one per team. */
  stateIds: string[];
}

const BOARD_TYPE_ORDER = ['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled'];
/** Lists put the work closest to done first, then completed and canceled, as Linear does. */
const LIST_TYPE_ORDER = ['started', 'unstarted', 'backlog', 'triage', 'completed', 'canceled'];
const typeRank = (order: readonly string[], type: string): number => (order.includes(type) ? order.indexOf(type) : order.length);
const stateKey = (state: Pick<LinearState, 'name' | 'type'>): string => `${state.type}:${state.name.trim().toLowerCase()}`;

/**
 * The status groups of the given states, merged by name and type across teams:
 * a board in workflow order, a list closest to done first.
 */
export const stateGroups = (states: readonly LinearState[], layout: 'list' | 'board'): StateGroup[] => {
  const groups = new Map<string, StateGroup>();
  for (const state of states) {
    const key = stateKey(state);
    const group = groups.get(key);
    if (group) {
      if (!group.stateIds.includes(state.id)) group.stateIds.push(state.id);
      group.position = Math.min(group.position, state.position ?? 0);
    } else groups.set(key, { key, name: state.name, type: state.type, color: state.color, position: state.position ?? 0, stateIds: [state.id] });
  }
  const order = layout === 'board' ? BOARD_TYPE_ORDER : LIST_TYPE_ORDER;
  // Within a type, a list shows the state closest to done (the highest position) first.
  const within = (a: StateGroup, b: StateGroup) => (layout === 'list' && (a.type === 'started' || a.type === 'unstarted') ? b.position - a.position : a.position - b.position);
  return [...groups.values()].sort((a, b) => typeRank(order, a.type) - typeRank(order, b.type) || within(a, b) || a.name.localeCompare(b.name));
};

export interface GroupContext {
  layout: 'list' | 'board';
  /** Workflow states of the teams shown, for status groups with no issue in them yet. */
  states?: readonly LinearState[];
  showEmpty?: boolean;
  /** Names of the workspaces, in order, for workspace groups. */
  workspaceNames?: ReadonlyMap<string, string>;
}

const byLabel = (a: IssueGroup, b: IssueGroup): number => a.label.localeCompare(b.label);

/** Collect issues under keys (an issue may fall under several); named groups by label, the empty one last. */
const collect = (issues: readonly LinearIssue[], keysOf: (issue: LinearIssue) => Omit<IssueGroup, 'issues'>[], none: string): IssueGroup[] => {
  const groups = new Map<string, IssueGroup>();
  for (const issue of issues) {
    for (const item of keysOf(issue)) {
      const group = groups.get(item.key) ?? { ...item, issues: [] };
      group.issues.push(issue);
      groups.set(item.key, group);
    }
  }
  const all = [...groups.values()];
  return [...all.filter((group) => group.key !== none).sort(byLabel), ...all.filter((group) => group.key === none)];
};

/**
 * Issues in groups, in display order (each group keeps the order given). Status
 * groups are exact workflow states; with `showEmpty` every state of the teams
 * shown has one, so a board has a column for each.
 */
export const groupIssues = (issues: readonly LinearIssue[], by: LinearGroupBy, context: GroupContext): IssueGroup[] => {
  switch (by) {
    case 'status': {
      const known = [...(context.showEmpty ? context.states ?? [] : []), ...issues.map((issue) => issue.state)];
      return stateGroups(known, context.layout)
        .map((group) => ({
          key: `state:${group.key}`,
          label: group.name,
          color: group.color,
          stateType: group.type,
          target: { kind: 'state' as const, name: group.name, type: group.type },
          issues: issues.filter((issue) => stateKey(issue.state) === group.key),
        }))
        .filter((group) => context.showEmpty || group.issues.length > 0);
    }
    case 'priority':
      return [1, 2, 3, 4, 0]
        .map((priority) => ({ key: `priority:${priority}`, label: PRIORITY_NAMES[priority]!, target: { kind: 'priority' as const, priority }, issues: issues.filter((issue) => (priorityRank(issue.priority) === 5 ? 0 : issue.priority) === priority) }))
        .filter((group) => context.showEmpty || group.issues.length > 0);
    case 'assignee':
      return collect(issues, (issue) => [issue.assignee ? { key: issue.assignee.id, label: issue.assignee.name, target: { kind: 'assignee', id: issue.assignee.id } } : { key: '', label: 'No assignee', target: { kind: 'assignee', id: null } }], '');
    case 'project':
      return collect(issues, (issue) => [issue.project ? { key: issue.project.id, label: issue.project.name, ...(issue.project.color ? { color: issue.project.color } : {}), target: { kind: 'project', id: issue.project.id } } : { key: '', label: 'No project', target: { kind: 'project', id: null } }], '');
    case 'cycle': {
      const teams = new Set(issues.map((issue) => issue.team.id));
      const groups = collect(
        issues,
        (issue) => [
          issue.cycle
            ? { key: issue.cycle.id, label: `${teams.size > 1 ? `${issue.team.key} · ` : ''}${issue.cycle.name || `Cycle ${issue.cycle.number}`}`, target: { kind: 'cycle', id: issue.cycle.id, teamId: issue.team.id } }
            : { key: '', label: 'No cycle', target: { kind: 'cycle', id: null, teamId: null } },
        ],
        '',
      );
      // By team, then by cycle number.
      const first = (group: IssueGroup) => group.issues[0]!;
      const named = groups.filter((group) => group.key).sort((a, b) => first(a).team.key.localeCompare(first(b).team.key) || (first(a).cycle?.number ?? 0) - (first(b).cycle?.number ?? 0));
      return [...named, ...groups.filter((group) => !group.key)];
    }
    case 'label':
      return collect(issues, (issue) => {
        const labels = issue.labels?.nodes ?? [];
        return labels.length ? labels.map((label) => ({ key: `label:${label.name.toLowerCase()}`, label: label.name, color: label.color })) : [{ key: '', label: 'No labels' }];
      }, '');
    case 'team':
      return collect(issues, (issue) => [{ key: issue.team.id, label: `${issue.team.key} · ${issue.team.name}` }], '\0');
    case 'workspace': {
      const names = context.workspaceNames ?? new Map<string, string>();
      const order = [...names.keys()];
      const groups = collect(issues, (issue) => [{ key: issue.workspaceId ?? '', label: names.get(issue.workspaceId ?? '') ?? 'Linear' }], '\0');
      const rank = (key: string) => (order.includes(key) ? order.indexOf(key) : order.length);
      return groups.sort((a, b) => rank(a.key) - rank(b.key) || byLabel(a, b));
    }
    default:
      return issues.length ? [{ key: 'all', label: 'Issues', issues: [...issues] }] : [];
  }
};

// ── Ordering ─────────────────────────────────────────────────────────────────

const issueNumber = (identifier: string): number => Number(/-(\d+)$/.exec(identifier)?.[1] ?? 0);
const newest = (a: string | undefined, b: string | undefined): number => (b ?? '').localeCompare(a ?? '');

/** Issues in the chosen order (reversed if asked, issues without a value still last); ties go to the most recently updated. */
export const sortIssues = (issues: readonly LinearIssue[], by: LinearOrderBy, reverse = false): LinearIssue[] => {
  const flip = reverse ? -1 : 1;
  const tie = (a: LinearIssue, b: LinearIssue) => newest(a.updatedAt, b.updatedAt);
  const compare = (a: LinearIssue, b: LinearIssue): number => {
    switch (by) {
      case 'priority': {
        const missing = Number(priorityRank(a.priority) === 5) - Number(priorityRank(b.priority) === 5);
        return missing || flip * (priorityRank(a.priority) - priorityRank(b.priority)) || (a.prioritySortOrder ?? 0) - (b.prioritySortOrder ?? 0) || tie(a, b);
      }
      case 'due': {
        const missing = Number(!a.dueDate) - Number(!b.dueDate);
        return missing || flip * (a.dueDate ?? '').localeCompare(b.dueDate ?? '') || priorityRank(a.priority) - priorityRank(b.priority) || tie(a, b);
      }
      case 'status': {
        const rank = (issue: LinearIssue) => typeRank(LIST_TYPE_ORDER, issue.state.type);
        const position = (issue: LinearIssue) => (issue.state.type === 'started' || issue.state.type === 'unstarted' ? -(issue.state.position ?? 0) : issue.state.position ?? 0);
        return flip * (rank(a) - rank(b) || position(a) - position(b)) || priorityRank(a.priority) - priorityRank(b.priority) || tie(a, b);
      }
      case 'manual':
        return (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || tie(a, b);
      case 'created':
        return flip * newest(a.createdAt ?? a.updatedAt, b.createdAt ?? b.updatedAt) || tie(a, b);
      case 'identifier':
        return flip * (a.team.key.localeCompare(b.team.key) || issueNumber(a.identifier) - issueNumber(b.identifier));
      default:
        return flip * tie(a, b);
    }
  };
  return [...issues].sort(compare);
};

// ── Moving an issue to a group ──────────────────────────────────────────────

/**
 * The change a drop on `target` makes to `issue`: its own team's state of that
 * exact name and type, or the group's priority, assignee, project or cycle.
 * Null when it is there already; an error when its team cannot take it.
 */
export const dropInput = (issue: LinearIssue, target: GroupTarget, teamStates: readonly LinearState[]): { input: IssueInput } | { error: string } | null => {
  switch (target.kind) {
    case 'state': {
      if (stateKey(issue.state) === stateKey(target)) return null;
      const wanted = target.name.trim().toLowerCase();
      const state = teamStates.find((item) => item.type === target.type && item.name.trim().toLowerCase() === wanted) ?? teamStates.find((item) => item.name.trim().toLowerCase() === wanted);
      if (!state) return { error: `${issue.team.key} has no ${target.name} status` };
      return state.id === issue.state.id ? null : { input: { stateId: state.id } };
    }
    case 'priority':
      return (issue.priority || 0) === target.priority ? null : { input: { priority: target.priority } };
    case 'assignee':
      return (issue.assignee?.id ?? null) === target.id ? null : { input: { assigneeId: target.id } };
    case 'project':
      return (issue.project?.id ?? null) === target.id ? null : { input: { projectId: target.id } };
    case 'cycle':
      if ((issue.cycle?.id ?? null) === target.id) return null;
      if (target.teamId && target.teamId !== issue.team.id) return { error: `that cycle belongs to another team than ${issue.identifier}` };
      return { input: { cycleId: target.id } };
  }
};

// ── Project lists (projects, and saved views of projects) ───────────────────

export type ProjectGroupBy = 'status' | 'lead' | 'health' | 'priority' | 'none';
export type ProjectOrderBy = 'manual' | 'priority' | 'status' | 'updated' | 'created' | 'target' | 'start' | 'name';

export interface ProjectDisplay {
  groupBy: ProjectGroupBy;
  orderBy: ProjectOrderBy;
  showCompleted: LinearCompletedWindow;
}

export const DEFAULT_PROJECT_DISPLAY: ProjectDisplay = { groupBy: 'status', orderBy: 'priority', showCompleted: 'none' };

const PROJECT_GROUPINGS: Record<string, ProjectGroupBy> = { status: 'status', lead: 'lead', health: 'health', priority: 'priority', nogrouping: 'none', none: 'none' };
const PROJECT_ORDERINGS: Record<string, ProjectOrderBy> = {
  manual: 'manual',
  priority: 'priority',
  status: 'status',
  updatedat: 'updated',
  createdat: 'created',
  targetdate: 'target',
  startdate: 'start',
  name: 'name',
  title: 'name',
};

/** A saved view of projects: its grouping, ordering and completed projects. */
export const projectViewDisplay = (prefs: ViewPrefs | null | undefined): { display: ProjectDisplay; unsupported: string[] } => {
  const display: ProjectDisplay = { ...DEFAULT_PROJECT_DISPLAY, showCompleted: 'all' };
  const unsupported: string[] = [];
  if (!prefs) return { display, unsupported };
  const layout = squash(prefs.projectLayout);
  if (layout && layout !== 'list') unsupported.push(`the ${prefs.projectLayout} layout`);
  const group = squash(prefs.projectGrouping);
  if (group) {
    if (PROJECT_GROUPINGS[group]) display.groupBy = PROJECT_GROUPINGS[group]!;
    else unsupported.push(`grouping by ${prefs.projectGrouping}`);
  }
  const order = squash(prefs.projectViewOrdering);
  if (order) {
    if (PROJECT_ORDERINGS[order]) display.orderBy = PROJECT_ORDERINGS[order]!;
    else unsupported.push(`ordering by ${prefs.projectViewOrdering}`);
  }
  display.showCompleted = completedWindow(prefs.showCompletedProjects) ?? 'all';
  return { display, unsupported };
};

/** The ProjectFilter that keeps open projects and those closed within the window. */
export const projectDisplayFilter = (display: Pick<ProjectDisplay, 'showCompleted'>): GraphFilter | null => {
  const open: GraphFilter = { status: { type: { nin: ['completed', 'canceled'] } } };
  if (display.showCompleted === 'all') return null;
  if (display.showCompleted === 'none') return open;
  const since = `-${WINDOW_DURATIONS[display.showCompleted]}`;
  return { or: [open, { completedAt: { gte: since } }, { canceledAt: { gte: since } }] };
};

/** Project status groups, the active ones first. */
export const PROJECT_STATUSES = [
  { type: 'started', label: 'In progress' },
  { type: 'planned', label: 'Planned' },
  { type: 'paused', label: 'Paused' },
  { type: 'backlog', label: 'Backlog' },
  { type: 'completed', label: 'Completed' },
  { type: 'canceled', label: 'Canceled' },
];

export const HEALTH_LABELS: Record<string, string> = { onTrack: 'On track', atRisk: 'At risk', offTrack: 'Off track' };

export const sortProjects = (projects: readonly LinearProject[], by: ProjectOrderBy): LinearProject[] => {
  const statusRank = (project: LinearProject) => {
    const index = PROJECT_STATUSES.findIndex((status) => status.type === project.status.type);
    return index < 0 ? PROJECT_STATUSES.length : index;
  };
  const target = (a: LinearProject, b: LinearProject) => (a.targetDate ?? '9999-12-31').localeCompare(b.targetDate ?? '9999-12-31');
  return [...projects].sort((a, b) => {
    switch (by) {
      case 'manual':
        return (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name);
      case 'status':
        return statusRank(a) - statusRank(b) || priorityRank(a.priority) - priorityRank(b.priority) || a.name.localeCompare(b.name);
      case 'updated':
        return newest(a.updatedAt, b.updatedAt);
      case 'created':
        return newest(a.createdAt ?? a.updatedAt, b.createdAt ?? b.updatedAt);
      case 'target':
        return target(a, b) || a.name.localeCompare(b.name);
      case 'start':
        return (a.startDate ?? '9999-12-31').localeCompare(b.startDate ?? '9999-12-31') || a.name.localeCompare(b.name);
      case 'name':
        return a.name.localeCompare(b.name);
      default:
        return priorityRank(a.priority) - priorityRank(b.priority) || target(a, b) || a.name.localeCompare(b.name);
    }
  });
};

export interface ProjectGroup {
  key: string;
  label: string;
  projects: LinearProject[];
}

/** Projects in groups, in the chosen order within each. */
export const groupProjects = (projects: readonly LinearProject[], display: Pick<ProjectDisplay, 'groupBy' | 'orderBy'> = DEFAULT_PROJECT_DISPLAY): ProjectGroup[] => {
  const sorted = sortProjects(projects, display.orderBy);
  const groups = (keyOf: (project: LinearProject) => { key: string; label: string }, order?: string[]): ProjectGroup[] => {
    const map = new Map<string, ProjectGroup>();
    for (const project of sorted) {
      const { key, label } = keyOf(project);
      const group = map.get(key) ?? { key, label, projects: [] };
      group.projects.push(project);
      map.set(key, group);
    }
    const all = [...map.values()];
    if (order) return all.sort((a, b) => (order.includes(a.key) ? order.indexOf(a.key) : order.length) - (order.includes(b.key) ? order.indexOf(b.key) : order.length));
    return [...all.filter((group) => group.key).sort((a, b) => a.label.localeCompare(b.label)), ...all.filter((group) => !group.key)];
  };
  switch (display.groupBy) {
    case 'status':
      return groups((project) => ({ key: project.status.type, label: PROJECT_STATUSES.find((status) => status.type === project.status.type)?.label ?? project.status.name }), PROJECT_STATUSES.map((status) => status.type));
    case 'lead':
      return groups((project) => (project.lead ? { key: project.lead.id, label: project.lead.name } : { key: '', label: 'No lead' }));
    case 'health':
      return groups((project) => (project.health ? { key: project.health, label: HEALTH_LABELS[project.health] ?? project.health } : { key: 'none', label: 'No update' }), ['onTrack', 'atRisk', 'offTrack', 'none']);
    case 'priority':
      return groups((project) => ({ key: `p${priorityRank(project.priority) === 5 ? 0 : project.priority}`, label: PRIORITY_NAMES[priorityRank(project.priority) === 5 ? 0 : project.priority]! }), ['p1', 'p2', 'p3', 'p4', 'p0']);
    default:
      return sorted.length ? [{ key: 'all', label: 'Projects', projects: sorted }] : [];
  }
};

// ── Pages ────────────────────────────────────────────────────────────────────

export interface Page<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

/**
 * Read pages from `after` on, following Linear's `pageInfo`, until the last
 * page or `maxPages`; what is left is said by `hasMore` and its cursor.
 */
export const readPages = async <T>(fetchPage: (after: string | null) => Promise<Page<T>>, options: { after?: string | null; maxPages: number }): Promise<{ nodes: T[]; endCursor: string | null; hasMore: boolean }> => {
  const nodes: T[] = [];
  let after = options.after ?? null;
  for (let page = 0; page < options.maxPages; page++) {
    const answer = await fetchPage(after);
    nodes.push(...answer.nodes);
    // A next page without a cursor to reach it would be read again forever; an answer without pageInfo is its last page.
    if (!answer.pageInfo?.hasNextPage || !answer.pageInfo.endCursor) return { nodes, endCursor: null, hasMore: false };
    after = answer.pageInfo.endCursor;
  }
  return { nodes, endCursor: after, hasMore: true };
};
