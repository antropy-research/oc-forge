// Linear's filters: rules such as "Status is either of Todo, In Progress" or
// "Labels include all of Bug, UI", their operators and chips, the choices each
// property offers (from the workspaces' teams, states, people, labels, projects
// and cycles, not from the issues loaded), and the IssueFilter they compile to,
// so Linear answers with every matching issue.
import { addDays, startOfWeek } from './dates.ts';
import type { DateKey } from './types.ts';
import { allOf, PRIORITY_NAMES, type GraphFilter } from './linearDisplay.ts';
import type { LinearIssue, LinearLabel, LinearState } from './linear.ts';

export const LINEAR_FILTER_FIELDS = ['status', 'assignee', 'creator', 'priority', 'label', 'project', 'team', 'cycle', 'due', 'workspace'] as const;
export type LinearFilterField = (typeof LINEAR_FILTER_FIELDS)[number];

export const FILTER_FIELD_LABELS: Record<LinearFilterField, string> = {
  status: 'Status',
  assignee: 'Assignee',
  creator: 'Creator',
  priority: 'Priority',
  label: 'Labels',
  project: 'Project',
  team: 'Team',
  cycle: 'Cycle',
  due: 'Due date',
  workspace: 'Workspace',
};

/** is / is not; include any / all / none for labels; before / after a date. */
export type FilterOp = 'is' | 'isNot' | 'includesAny' | 'includesAll' | 'excludes' | 'before' | 'after';

export interface FilterValue {
  value: string;
  label: string;
  color?: string;
}

/** One filter, as in Linear. A rule without values does nothing and is not kept. */
export interface LinearFilterRule {
  field: LinearFilterField;
  op: FilterOp;
  values: FilterValue[];
}

/** The operators a property offers, as Linear names them for one value or several. */
export const operatorsFor = (field: LinearFilterField): FilterOp[] => {
  if (field === 'label') return ['includesAny', 'includesAll', 'excludes'];
  if (field === 'due') return ['is', 'before', 'after'];
  return ['is', 'isNot'];
};

export const defaultOperator = (field: LinearFilterField): FilterOp => operatorsFor(field)[0]!;

export const operatorLabel = (op: FilterOp, count: number): string => {
  switch (op) {
    case 'is':
      return count > 1 ? 'is either of' : 'is';
    case 'isNot':
      return 'is not';
    case 'includesAny':
      return count > 1 ? 'include any of' : 'include';
    case 'includesAll':
      return count > 1 ? 'include all of' : 'include';
    case 'excludes':
      return count > 1 ? 'include neither of' : 'do not include';
    case 'before':
      return 'before';
    case 'after':
      return 'after';
  }
};

/** A rule as its chip reads, such as "Status is either of Todo, In Progress". */
export const describeRule = (rule: LinearFilterRule): string =>
  `${FILTER_FIELD_LABELS[rule.field]} ${operatorLabel(rule.op, rule.values.length)} ${rule.values.map((item) => item.label).join(', ')}`;

/** The relative due dates Linear's due date filter offers. */
export const DUE_CHOICES: FilterValue[] = [
  { value: 'overdue', label: 'Overdue' },
  { value: 'today', label: 'Due today' },
  { value: 'thisWeek', label: 'Due this week' },
  { value: 'nextWeek', label: 'Due next week' },
  { value: 'none', label: 'No due date' },
];

/** A changed operator keeps the values that still make sense: a date for before/after, a choice for is. */
export const withOperator = (rule: LinearFilterRule, op: FilterOp): LinearFilterRule => {
  if (rule.field !== 'due') return { ...rule, op };
  const dated = (item: FilterValue) => /^\d{4}-\d{2}-\d{2}$/.test(item.value);
  const values = op === 'is' ? rule.values.filter((item) => !dated(item)) : rule.values.filter(dated).slice(0, 1);
  return { ...rule, op, values };
};

// ── Compiling to Linear's IssueFilter ──────────────────────────────────────

export interface FilterContext {
  today: DateKey;
  weekStartsOn: 0 | 1;
}

const OPEN: GraphFilter = { state: { type: { nin: ['completed', 'canceled'] } } };

/** A nullable relation (assignee, creator, project, cycle): any of the ids, "none" (''), or with isNot neither. */
const relation = (key: string, rule: LinearFilterRule): GraphFilter | null => {
  const ids = rule.values.map((item) => item.value).filter((value) => value !== '' && !value.startsWith('@'));
  const none = rule.values.some((item) => item.value === '');
  if (rule.op === 'isNot') {
    // Issues with nobody (or nothing) set are "not" any of the ids, unless "none" is excluded too.
    const parts: GraphFilter[] = [];
    if (none) parts.push({ [key]: { null: false } });
    if (ids.length) parts.push(none ? { [key]: { id: { nin: ids } } } : { or: [{ [key]: { null: true } }, { [key]: { id: { nin: ids } } }] });
    return allOf(...parts);
  }
  const options: GraphFilter[] = [];
  if (ids.length) options.push({ [key]: { id: { in: ids } } });
  if (none) options.push({ [key]: { null: true } });
  return options.length === 0 ? null : options.length === 1 ? options[0]! : { or: options };
};

const dueChoice = (choice: string, context: FilterContext): GraphFilter | null => {
  const weekStart = startOfWeek(context.today, context.weekStartsOn);
  switch (choice) {
    case 'overdue':
      return { and: [{ dueDate: { lt: context.today } }, OPEN] };
    case 'today':
      return { dueDate: { eq: context.today } };
    case 'thisWeek':
      return { dueDate: { gte: weekStart, lte: addDays(weekStart, 6) } };
    case 'nextWeek':
      return { dueDate: { gte: addDays(weekStart, 7), lte: addDays(weekStart, 13) } };
    case 'none':
      return { dueDate: { null: true } };
    default:
      return null;
  }
};

/** One rule as an IssueFilter; null for rules Linear does not filter on (the workspace) or without values. */
export const compileRule = (rule: LinearFilterRule, context: FilterContext): GraphFilter | null => {
  const values = rule.values.map((item) => item.value);
  if (values.length === 0) return null;
  switch (rule.field) {
    case 'status':
      return { state: { name: { [rule.op === 'isNot' ? 'nin' : 'in']: values } } };
    case 'priority':
      return { priority: { [rule.op === 'isNot' ? 'nin' : 'in']: values.map(Number) } };
    case 'team':
      return { team: { id: { [rule.op === 'isNot' ? 'nin' : 'in']: values } } };
    case 'assignee':
    case 'creator':
    case 'project':
      return relation(rule.field, rule);
    case 'cycle': {
      const base = relation('cycle', rule);
      const active = values.includes('@active');
      const next = values.includes('@next');
      if (!active && !next) return base;
      const specials: GraphFilter[] = [...(active ? [{ cycle: { isActive: { eq: rule.op !== 'isNot' } } }] : []), ...(next ? [{ cycle: { isNext: { eq: rule.op !== 'isNot' } } }] : [])];
      if (rule.op === 'isNot') return allOf(base, ...specials.map((item) => ({ or: [{ cycle: { null: true } }, item] })));
      return { or: [...(base ? [base] : []), ...specials] };
    }
    case 'label': {
      if (rule.op === 'includesAll') return allOf(...values.map((name) => ({ labels: { some: { name: { eq: name } } } })));
      if (rule.op === 'excludes') return { labels: { every: { name: { nin: values } } } };
      return { labels: { some: { name: { in: values } } } };
    }
    case 'due': {
      if (rule.op === 'before') return { dueDate: { lt: values[0] } };
      if (rule.op === 'after') return { dueDate: { gt: values[0] } };
      const choices = values.map((value) => dueChoice(value, context)).filter((item): item is GraphFilter => Boolean(item));
      return choices.length === 0 ? null : choices.length === 1 ? choices[0]! : { or: choices };
    }
    case 'workspace':
      return null;
  }
};

/** All rules as one IssueFilter (they all apply); null when none narrows anything. */
export const compileFilter = (rules: readonly LinearFilterRule[], context: FilterContext): GraphFilter | null => allOf(...rules.map((rule) => compileRule(rule, context)));

/** The workspaces a workspace rule keeps, or all of them. */
export const workspacesFor = (rules: readonly LinearFilterRule[], all: readonly string[]): string[] => {
  const rule = rules.find((item) => item.field === 'workspace' && item.values.length > 0);
  if (!rule) return [...all];
  const named = new Set(rule.values.map((item) => item.value));
  return all.filter((id) => (rule.op === 'isNot' ? !named.has(id) : named.has(id)));
};

// ── The same rules on one issue (to keep a list right after an edit) ───────

const dueMatches = (choice: string, dueDate: string | null, closed: boolean, context: FilterContext): boolean => {
  const weekStart = startOfWeek(context.today, context.weekStartsOn);
  switch (choice) {
    case 'overdue':
      return Boolean(dueDate && dueDate < context.today && !closed);
    case 'today':
      return dueDate === context.today;
    case 'thisWeek':
      return Boolean(dueDate && dueDate >= weekStart && dueDate <= addDays(weekStart, 6));
    case 'nextWeek':
      return Boolean(dueDate && dueDate >= addDays(weekStart, 7) && dueDate <= addDays(weekStart, 13));
    case 'none':
      return !dueDate;
    default:
      return false;
  }
};

/** Whether `issue` passes every rule, the way Linear evaluates the compiled filter. */
export const matchesRules = (issue: LinearIssue, rules: readonly LinearFilterRule[], context: FilterContext): boolean =>
  rules.every((rule) => {
    const values = rule.values.map((item) => item.value);
    if (values.length === 0) return true;
    const negate = rule.op === 'isNot';
    const pick = (id: string | null | undefined) => (negate ? !values.includes(id ?? '') : values.includes(id ?? ''));
    switch (rule.field) {
      case 'status':
        return negate !== values.includes(issue.state.name);
      case 'priority':
        return negate !== values.includes(String(issue.priority));
      case 'team':
        return negate !== values.includes(issue.team.id);
      case 'assignee':
        return pick(issue.assignee?.id);
      case 'creator':
        return pick(issue.creator?.id);
      case 'project':
        return pick(issue.project?.id);
      case 'cycle': {
        const hit = values.includes(issue.cycle?.id ?? '') || (values.includes('@active') && Boolean(issue.cycle?.isActive)) || (values.includes('@next') && Boolean(issue.cycle?.isNext));
        return negate ? !hit : hit;
      }
      case 'label': {
        const names = new Set((issue.labels?.nodes ?? []).map((label) => label.name));
        if (rule.op === 'includesAll') return values.every((name) => names.has(name));
        if (rule.op === 'excludes') return values.every((name) => !names.has(name));
        return values.some((name) => names.has(name));
      }
      case 'due': {
        if (rule.op === 'before') return Boolean(issue.dueDate && issue.dueDate < values[0]!);
        if (rule.op === 'after') return Boolean(issue.dueDate && issue.dueDate > values[0]!);
        const closed = issue.state.type === 'completed' || issue.state.type === 'canceled';
        return values.some((choice) => dueMatches(choice, issue.dueDate, closed, context));
      }
      case 'workspace':
        return negate !== values.includes(issue.workspaceId ?? '');
    }
  });

// ── Choices, from the workspaces ────────────────────────────────────────────

/** What the Planner knows of one workspace for filtering and for the issue view. */
export interface FilterCatalog {
  workspaceId: string;
  teams: { id: string; key: string; name: string; states: LinearState[] }[];
  users: { id: string; name: string; displayName: string; active: boolean; isMe?: boolean }[];
  labels: (LinearLabel & { isGroup?: boolean; parent?: { id: string; name: string } | null; team?: { id: string; key?: string } | null })[];
  projects: { id: string; name: string; color: string; icon?: string | null; status?: { type: string } | null }[];
  cycles: { id: string; number: number; name: string | null; isActive?: boolean; isNext?: boolean; startsAt?: string; endsAt?: string; team: { id: string; key: string } }[];
}

export interface FilterOption extends FilterValue {
  /** A second line or a short note, such as the teams a state belongs to. */
  hint?: string;
  /** How its icon is drawn. */
  kind?: 'state' | 'priority' | 'person' | 'label' | 'project' | 'cycle' | 'team' | 'due' | 'workspace';
  /** A state's type, for its icon. */
  type?: string;
  /** A priority's number, for its icon. */
  priority?: number;
}

export interface OptionScope {
  /** The teams the list is about (a team's view, a project's teams); empty for the whole workspace. */
  teamIds?: readonly string[];
  workspaceNames?: ReadonlyMap<string, string>;
}

const STATE_TYPES = ['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled'];

/** The choices of a property, from the catalogs of the workspaces shown. */
export const filterChoices = (field: LinearFilterField, catalogs: readonly FilterCatalog[], scope: OptionScope = {}): FilterOption[] => {
  const inScope = (teamId: string | null | undefined) => !scope.teamIds?.length || !teamId || scope.teamIds.includes(teamId);
  const teams = catalogs.flatMap((catalog) => catalog.teams).filter((team) => inScope(team.id));
  switch (field) {
    case 'status': {
      // One choice per state name, as Linear merges same-named states of several teams.
      const merged = new Map<string, FilterOption & { rank: number; position: number; teamKeys: string[] }>();
      for (const team of teams) {
        for (const state of team.states) {
          const found = merged.get(state.name);
          if (found) {
            if (!found.teamKeys.includes(team.key)) found.teamKeys.push(team.key);
            continue;
          }
          const rank = STATE_TYPES.includes(state.type) ? STATE_TYPES.indexOf(state.type) : STATE_TYPES.length;
          merged.set(state.name, { value: state.name, label: state.name, color: state.color, kind: 'state', type: state.type, rank, position: state.position ?? 0, teamKeys: [team.key] });
        }
      }
      return [...merged.values()]
        .sort((a, b) => a.rank - b.rank || a.position - b.position || a.label.localeCompare(b.label))
        .map(({ rank: _rank, position: _position, teamKeys, ...option }) => (teams.length > 1 && teamKeys.length < teams.length ? { ...option, hint: teamKeys.join(', ') } : option));
    }
    case 'assignee':
    case 'creator': {
      const people = new Map<string, FilterOption & { me: boolean }>();
      for (const user of catalogs.flatMap((catalog) => catalog.users)) {
        if (!user.active || people.has(user.id)) continue;
        people.set(user.id, { value: user.id, label: user.name, kind: 'person', me: Boolean(user.isMe), ...(user.displayName && user.displayName !== user.name ? { hint: user.displayName } : {}) });
      }
      const sorted = [...people.values()].sort((a, b) => Number(b.me) - Number(a.me) || a.label.localeCompare(b.label)).map(({ me, ...option }) => (me ? { ...option, hint: 'You' } : option));
      return field === 'assignee' ? [{ value: '', label: 'No assignee', kind: 'person' }, ...sorted] : sorted;
    }
    case 'priority':
      return [0, 1, 2, 3, 4].map((priority) => ({ value: String(priority), label: PRIORITY_NAMES[priority]!, kind: 'priority', priority }));
    case 'label': {
      const byName = new Map<string, FilterOption>();
      for (const label of catalogs.flatMap((catalog) => catalog.labels)) {
        if (label.isGroup || !inScope(label.team?.id) || byName.has(label.name)) continue;
        byName.set(label.name, { value: label.name, label: label.name, color: label.color, kind: 'label', ...(label.parent ? { hint: label.parent.name } : {}) });
      }
      return [...byName.values()].sort((a, b) => a.label.localeCompare(b.label));
    }
    case 'project': {
      const projects = catalogs.flatMap((catalog) => catalog.projects);
      const unique = [...new Map(projects.map((project) => [project.id, project])).values()].sort((a, b) => a.name.localeCompare(b.name));
      return [{ value: '', label: 'No project', kind: 'project' }, ...unique.map((project) => ({ value: project.id, label: project.name, color: project.color, kind: 'project' as const }))];
    }
    case 'team':
      return teams.map((team) => ({ value: team.id, label: team.name, hint: team.key, kind: 'team' as const })).sort((a, b) => a.hint.localeCompare(b.hint));
    case 'cycle': {
      const cycles = catalogs.flatMap((catalog) => catalog.cycles).filter((cycle) => inScope(cycle.team.id));
      const several = new Set(cycles.map((cycle) => cycle.team.id)).size > 1;
      const listed = [...cycles]
        .sort((a, b) => a.team.key.localeCompare(b.team.key) || a.number - b.number)
        .map((cycle) => ({ value: cycle.id, label: `${several ? `${cycle.team.key} · ` : ''}${cycle.name || `Cycle ${cycle.number}`}`, kind: 'cycle' as const, ...(cycle.isActive ? { hint: 'Current' } : cycle.isNext ? { hint: 'Next' } : {}) }));
      return [{ value: '', label: 'No cycle', kind: 'cycle' }, { value: '@active', label: 'Current cycle', kind: 'cycle' }, { value: '@next', label: 'Next cycle', kind: 'cycle' }, ...listed];
    }
    case 'due':
      return DUE_CHOICES.map((choice) => ({ ...choice, kind: 'due' as const }));
    case 'workspace':
      return [...(scope.workspaceNames ?? new Map<string, string>())].map(([value, label]) => ({ value, label, kind: 'workspace' as const }));
  }
};

/** Choices matching a typed search, by label, hint or a word's start (Linear's quick filters). */
export const searchChoices = <T extends { label: string; hint?: string }>(options: readonly T[], term: string): T[] => {
  const query = term.trim().toLowerCase();
  if (!query) return [...options];
  const starts = options.filter((option) => option.label.toLowerCase().startsWith(query));
  const contains = options.filter((option) => !starts.includes(option) && (option.label.toLowerCase().includes(query) || option.hint?.toLowerCase().includes(query)));
  return [...starts, ...contains];
};

/** Rules after ticking or unticking `option` of `field`: a rule with no value left goes away. */
export const toggleValue = (rules: readonly LinearFilterRule[], field: LinearFilterField, option: FilterValue): LinearFilterRule[] => {
  const index = rules.findIndex((rule) => rule.field === field);
  const value = { value: option.value, label: option.label, ...(option.color ? { color: option.color } : {}) };
  if (index < 0) return [...rules, { field, op: defaultOperator(field), values: [value] }];
  const rule = rules[index]!;
  const on = rule.values.some((item) => item.value === option.value);
  // A date for before/after replaces the one there; a due choice cannot mix with a date.
  const values = on ? rule.values.filter((item) => item.value !== option.value) : rule.op === 'before' || rule.op === 'after' ? [value] : [...rule.values, value];
  const next = { ...rule, values };
  return values.length ? rules.map((item, at) => (at === index ? next : item)) : rules.filter((_, at) => at !== index);
};
