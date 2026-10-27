// Linear's filters: rules such as "Status is either of Todo, In Progress" or
// "Labels include all of Bug, UI", groups of rules that must all or any hold
// (Linear's advanced filter, nested), their operators and chips, the choices
// each property offers (from the workspaces' teams, states, people, labels,
// projects, milestones and cycles, not from the issues loaded), the IssueFilter
// they compile to, so Linear answers with every matching issue, and a saved
// view's filterData read back into rules and groups.
import { addDays, isDateKey, monthDay, startOfWeek } from './dates.ts';
import type { DateKey } from './types.ts';
import { allOf, PRIORITY_NAMES, type GraphFilter } from './linearDisplay.ts';
import { estimateChoices, type LinearIssue, type LinearLabel, type LinearState } from './linear.ts';

export const LINEAR_FILTER_FIELDS = [
  'status',
  'assignee',
  'creator',
  'priority',
  'label',
  'content',
  'project',
  'milestone',
  'team',
  'cycle',
  'estimate',
  'subscriber',
  'relation',
  'due',
  'created',
  'updated',
  'completed',
  'workspace',
] as const;
export type LinearFilterField = (typeof LINEAR_FILTER_FIELDS)[number];

export const FILTER_FIELD_LABELS: Record<LinearFilterField, string> = {
  status: 'Status',
  assignee: 'Assignee',
  creator: 'Creator',
  priority: 'Priority',
  label: 'Labels',
  content: 'Content',
  project: 'Project',
  milestone: 'Milestone',
  team: 'Team',
  cycle: 'Cycle',
  estimate: 'Estimate',
  subscriber: 'Subscribers',
  relation: 'Relations',
  due: 'Due date',
  created: 'Created date',
  updated: 'Updated date',
  completed: 'Completed date',
  workspace: 'Workspace',
};

/**
 * is / is not; include any / all / none for labels, subscribers and relations;
 * before / after a date; contains / does not contain for content; at least /
 * at most for estimates.
 */
export type FilterOp = 'is' | 'isNot' | 'includesAny' | 'includesAll' | 'excludes' | 'before' | 'after' | 'contains' | 'notContains' | 'atLeast' | 'atMost';

/** Operators that take one value: a date, a text, a number. */
const SINGLE_OPS: ReadonlySet<FilterOp> = new Set(['before', 'after', 'contains', 'notContains', 'atLeast', 'atMost']);
export const isSingleValued = (op: FilterOp): boolean => SINGLE_OPS.has(op);

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

/** Whether all (and) or any (or) of several filters must hold. */
export type FilterJoin = 'and' | 'or';

/** A filter group, as Linear's advanced filter has them: its filters and groups, all or any of which hold. */
export interface LinearFilterGroup {
  join: FilterJoin;
  items: LinearFilterNode[];
}

/** A part of a saved view's filter the Planner shows and keeps but cannot edit; it goes to Linear as it is. */
export interface LinearRawFilter {
  raw: GraphFilter;
  label: string;
}

export type LinearFilterNode = LinearFilterRule | LinearFilterGroup | LinearRawFilter;

export const isFilterGroup = (node: LinearFilterNode): node is LinearFilterGroup => 'items' in node;
export const isRawFilter = (node: LinearFilterNode): node is LinearRawFilter => 'raw' in node;
export const isFilterRule = (node: LinearFilterNode): node is LinearFilterRule => 'field' in node;

/** The operators a property offers, as Linear names them for one value or several. */
export const operatorsFor = (field: LinearFilterField): FilterOp[] => {
  switch (field) {
    case 'label':
    case 'subscriber':
    case 'relation':
      return ['includesAny', 'includesAll', 'excludes'];
    case 'due':
      return ['is', 'before', 'after'];
    case 'created':
    case 'updated':
    case 'completed':
      return ['after', 'before'];
    case 'content':
      return ['contains', 'notContains'];
    case 'estimate':
      return ['is', 'isNot', 'atLeast', 'atMost'];
    default:
      return ['is', 'isNot'];
  }
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
    case 'contains':
      return 'contains';
    case 'notContains':
      return 'does not contain';
    case 'atLeast':
      return 'is at least';
    case 'atMost':
      return 'is at most';
  }
};

/** A rule's values as its chip reads them; a text is quoted. */
export const valuesLabel = (rule: LinearFilterRule): string =>
  rule.field === 'content' ? rule.values.map((item) => `“${item.label}”`).join(', ') : rule.values.map((item) => item.label).join(', ');

/** A rule as its chip reads, such as "Status is either of Todo, In Progress". */
export const describeRule = (rule: LinearFilterRule): string => `${FILTER_FIELD_LABELS[rule.field]} ${operatorLabel(rule.op, rule.values.length)} ${valuesLabel(rule)}`;

/** A group's chip, as Linear's: "Any of 2 filters", "All of 3 filters". */
export const groupTitle = (group: LinearFilterGroup): string => `${group.join === 'or' ? 'Any' : 'All'} of ${group.items.length} filter${group.items.length === 1 ? '' : 's'}`;

/** A filter in words: a rule's chip, a group with its parts ("Any of 2 filters: Priority is Urgent or Assignee is Me"). */
export const describeNode = (node: LinearFilterNode): string => {
  if (isRawFilter(node)) return node.label;
  if (isFilterRule(node)) return describeRule(node);
  const inner = (item: LinearFilterNode): string => (isFilterGroup(item) ? `(${item.items.map(inner).join(` ${item.join} `)})` : describeNode(item));
  return `${groupTitle(node)}: ${node.items.map(inner).join(` ${node.join} `)}`;
};

/** The relative due dates Linear's due date filter offers. */
export const DUE_CHOICES: FilterValue[] = [
  { value: 'overdue', label: 'Overdue' },
  { value: 'today', label: 'Due today' },
  { value: 'thisWeek', label: 'Due this week' },
  { value: 'nextWeek', label: 'Due next week' },
  { value: 'none', label: 'No due date' },
];

/** The relative times the created, updated and completed dates offer; Linear takes them as ISO durations before now. */
export const SINCE_CHOICES: FilterValue[] = [
  { value: '-P1D', label: '1 day ago' },
  { value: '-P1W', label: '1 week ago' },
  { value: '-P2W', label: '2 weeks ago' },
  { value: '-P1M', label: '1 month ago' },
  { value: '-P3M', label: '3 months ago' },
  { value: '-P6M', label: '6 months ago' },
  { value: '-P1Y', label: '1 year ago' },
];

/** Linear's relation filters, as one property whose values an issue has or not. */
export const RELATION_CHOICES: FilterValue[] = [
  { value: 'blocked', label: 'Blocked by' },
  { value: 'blocking', label: 'Blocking' },
  { value: 'related', label: 'Related' },
  { value: 'duplicate', label: 'Duplicate' },
  { value: 'parent', label: 'Parent issue' },
  { value: 'children', label: 'Sub-issues' },
];

const DATED = /^\d{4}-\d{2}-\d{2}$/;
const isDateField = (field: LinearFilterField): field is 'created' | 'updated' | 'completed' => field === 'created' || field === 'updated' || field === 'completed';

/** A changed operator keeps the values that still make sense: a date for before/after, a choice for is, one number for at least/most. */
export const withOperator = (rule: LinearFilterRule, op: FilterOp): LinearFilterRule => {
  if (rule.field === 'due') {
    const dated = (item: FilterValue) => DATED.test(item.value);
    const values = op === 'is' ? rule.values.filter((item) => !dated(item)) : rule.values.filter(dated).slice(0, 1);
    return { ...rule, op, values };
  }
  if (rule.field === 'estimate' && isSingleValued(op)) return { ...rule, op, values: rule.values.filter((item) => item.value !== '').slice(0, 1) };
  return { ...rule, op };
};

// ── Compiling to Linear's IssueFilter ──────────────────────────────────────

export interface FilterContext {
  today: DateKey;
  weekStartsOn: 0 | 1;
  /** My user id in each workspace, for "Me" on one issue (Linear knows it for its own answers). */
  viewerIds?: ReadonlyMap<string, string>;
  /** Now, for "1 week ago" on one issue. */
  now?: number;
}

/** Several filters of which one must hold; null when there are none. */
export const anyOf = (...filters: (GraphFilter | null | undefined)[]): GraphFilter | null => {
  const present = filters.filter((filter): filter is GraphFilter => Boolean(filter && Object.keys(filter).length));
  return present.length === 0 ? null : present.length === 1 ? present[0]! : { or: present };
};

const OPEN: GraphFilter = { state: { type: { nin: ['completed', 'canceled'] } } };

/**
 * A nullable relation (assignee, creator, project, cycle, milestone): any of the
 * ids, me ("@me"), "none" (''), or with isNot neither. A relation that is not set
 * matches only `null: true` in Linear, so "is not" keeps those explicitly.
 */
const relation = (key: string, rule: LinearFilterRule): GraphFilter | null => {
  const values = rule.values.map((item) => item.value);
  const ids = values.filter((value) => value !== '' && !value.startsWith('@'));
  const me = values.includes('@me');
  const none = values.includes('');
  if (rule.op === 'isNot') {
    const not: GraphFilter = { ...(ids.length ? { id: { nin: ids } } : {}), ...(me ? { isMe: { eq: false } } : {}) };
    const parts: GraphFilter[] = [];
    if (none) parts.push({ [key]: { null: false } });
    if (Object.keys(not).length) parts.push(none ? { [key]: not } : { or: [{ [key]: { null: true } }, { [key]: not }] });
    return allOf(...parts);
  }
  return anyOf(ids.length ? { [key]: { id: { in: ids } } } : null, me ? { [key]: { isMe: { eq: true } } } : null, none ? { [key]: { null: true } } : null);
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

/** Each relation as Linear filters it: with it, and without it. */
const RELATION_FILTERS: Record<string, readonly [GraphFilter, GraphFilter]> = {
  blocked: [{ hasBlockedByRelations: { eq: true } }, { hasBlockedByRelations: { eq: false } }],
  blocking: [{ hasBlockingRelations: { eq: true } }, { hasBlockingRelations: { eq: false } }],
  related: [{ hasRelatedRelations: { eq: true } }, { hasRelatedRelations: { eq: false } }],
  duplicate: [{ hasDuplicateRelations: { eq: true } }, { hasDuplicateRelations: { eq: false } }],
  parent: [{ parent: { null: false } }, { parent: { null: true } }],
  children: [{ children: { length: { gt: 0 } } }, { children: { length: { eq: 0 } } }],
};

const DATE_KEYS = { created: 'createdAt', updated: 'updatedAt', completed: 'completedAt' } as const;

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
    case 'milestone':
      return relation('projectMilestone', rule);
    case 'cycle': {
      const base = relation('cycle', rule);
      const active = values.includes('@active');
      const next = values.includes('@next');
      if (!active && !next) return base;
      const specials: GraphFilter[] = [...(active ? [{ cycle: { isActive: { eq: rule.op !== 'isNot' } } }] : []), ...(next ? [{ cycle: { isNext: { eq: rule.op !== 'isNot' } } }] : [])];
      if (rule.op === 'isNot') return allOf(base, ...specials.map((item) => ({ or: [{ cycle: { null: true } }, item] })));
      return anyOf(base, ...specials);
    }
    case 'label': {
      if (rule.op === 'includesAll') return allOf(...values.map((name) => ({ labels: { some: { name: { eq: name } } } })));
      if (rule.op === 'excludes') return { labels: { every: { name: { nin: values } } } };
      return { labels: { some: { name: { in: values } } } };
    }
    case 'subscriber': {
      const ids = values.filter((value) => value !== '@me');
      const me = values.includes('@me');
      if (rule.op === 'includesAll') return allOf(...values.map((value) => ({ subscribers: { some: value === '@me' ? { isMe: { eq: true } } : { id: { eq: value } } } })));
      if (rule.op === 'excludes') return { subscribers: { every: { ...(ids.length ? { id: { nin: ids } } : {}), ...(me ? { isMe: { eq: false } } : {}) } } };
      const some = anyOf(ids.length ? { id: { in: ids } } : null, me ? { isMe: { eq: true } } : null);
      return some ? { subscribers: { some } } : null;
    }
    case 'relation': {
      const known = values.filter((value) => value in RELATION_FILTERS);
      if (rule.op === 'excludes') return allOf(...known.map((value) => RELATION_FILTERS[value]![1]));
      if (rule.op === 'includesAll') return allOf(...known.map((value) => RELATION_FILTERS[value]![0]));
      return anyOf(...known.map((value) => RELATION_FILTERS[value]![0]));
    }
    case 'content': {
      // Title and description, as Linear's content filter reads them; an issue without a description does not contain the text.
      const text = values[0]!.trim();
      if (!text) return null;
      if (rule.op === 'notContains') return { and: [{ title: { notContainsIgnoreCase: text } }, { or: [{ description: { null: true } }, { description: { notContainsIgnoreCase: text } }] }] };
      return { or: [{ title: { containsIgnoreCase: text } }, { description: { containsIgnoreCase: text } }] };
    }
    case 'estimate': {
      if (rule.op === 'atLeast' || rule.op === 'atMost') {
        const points = Number(values[0]);
        return values[0] !== '' && Number.isFinite(points) ? { estimate: { [rule.op === 'atLeast' ? 'gte' : 'lte']: points } } : null;
      }
      const points = values.filter((value) => value !== '').map(Number).filter(Number.isFinite);
      const none = values.includes('');
      if (rule.op === 'isNot') {
        const parts: GraphFilter[] = [];
        if (none) parts.push({ estimate: { null: false } });
        if (points.length) parts.push(none ? { estimate: { nin: points } } : { or: [{ estimate: { null: true } }, { estimate: { nin: points } }] });
        return allOf(...parts);
      }
      return anyOf(points.length ? { estimate: { in: points } } : null, none ? { estimate: { null: true } } : null);
    }
    case 'due': {
      if (rule.op === 'before') return { dueDate: { lt: values[0] } };
      if (rule.op === 'after') return { dueDate: { gt: values[0] } };
      return anyOf(...values.map((value) => dueChoice(value, context)));
    }
    case 'created':
    case 'updated':
    case 'completed':
      return { [DATE_KEYS[rule.field]]: { [rule.op === 'before' ? 'lt' : 'gt']: values[0] } };
    case 'workspace':
      return null;
  }
};

/** A rule or a group as an IssueFilter; a group keeps its and/or even around one filter, so it reads back as a group. */
export const compileNode = (node: LinearFilterNode, context: FilterContext): GraphFilter | null => {
  if (isRawFilter(node)) return node.raw;
  if (isFilterRule(node)) return compileRule(node, context);
  const parts = node.items.map((item) => compileNode(item, context)).filter((part): part is GraphFilter => Boolean(part));
  return parts.length ? { [node.join]: parts } : null;
};

/** The top-level filters as one IssueFilter, all (match "and") or any of them; null when none narrows anything. */
export const compileFilter = (nodes: readonly LinearFilterNode[], context: FilterContext, match: FilterJoin = 'and'): GraphFilter | null => {
  const parts = nodes.map((node) => compileNode(node, context));
  return match === 'or' ? anyOf(...parts) : allOf(...parts);
};

/** The workspaces a top-level workspace rule keeps, or all of them. */
export const workspacesFor = (nodes: readonly LinearFilterNode[], all: readonly string[]): string[] => {
  const rule = nodes.find((item): item is LinearFilterRule => isFilterRule(item) && item.field === 'workspace' && item.values.length > 0);
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

/** "-P1W" (before now) or a date, as a time; null for anything else. */
const pointInTime = (value: string, now: number): number | null => {
  const match = /^-P(\d+)([DWMY])$/.exec(value);
  if (match) {
    const date = new Date(now);
    const n = Number(match[1]);
    if (match[2] === 'D') date.setDate(date.getDate() - n);
    if (match[2] === 'W') date.setDate(date.getDate() - 7 * n);
    if (match[2] === 'M') date.setMonth(date.getMonth() - n);
    if (match[2] === 'Y') date.setFullYear(date.getFullYear() - n);
    return date.getTime();
  }
  return DATED.test(value) ? Date.parse(`${value}T00:00:00Z`) : null;
};

/** The issue's own fields the list query does not read: kept, as Linear judged them. */
type Unknown = 'unknown';

const ruleMatches = (issue: LinearIssue & { description?: string | null; projectMilestone?: { id: string } | null }, rule: LinearFilterRule, context: FilterContext): boolean | Unknown => {
  const values = rule.values.map((item) => item.value);
  const negate = rule.op === 'isNot';
  const me = context.viewerIds?.get(issue.workspaceId ?? '');
  /** One person or thing among the values: by id, "@me", or '' for none. */
  const pick = (id: string | null | undefined): boolean | Unknown => {
    if (values.includes('@me') && !me && !values.includes(id ?? '')) return 'unknown';
    const hit = values.includes(id ?? '') || (values.includes('@me') && Boolean(id) && id === me);
    return negate ? !hit : hit;
  };
  /** Of several values an issue may have: any, all or none of them (`has` says for one, or does not know). */
  const several = (has: (value: string) => boolean | Unknown): boolean | Unknown => {
    const answers = values.map(has);
    if (rule.op === 'includesAll') return answers.includes(false) ? false : answers.includes('unknown') ? 'unknown' : true;
    if (rule.op === 'excludes') return answers.includes(true) ? false : answers.includes('unknown') ? 'unknown' : true;
    return answers.includes(true) ? true : answers.includes('unknown') ? 'unknown' : false;
  };
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
      return issue.creator === undefined ? 'unknown' : pick(issue.creator?.id);
    case 'project':
      return pick(issue.project?.id);
    case 'milestone':
      return issue.projectMilestone === undefined ? 'unknown' : pick(issue.projectMilestone?.id);
    case 'cycle': {
      const hit = values.includes(issue.cycle?.id ?? '') || (values.includes('@active') && Boolean(issue.cycle?.isActive)) || (values.includes('@next') && Boolean(issue.cycle?.isNext));
      return negate ? !hit : hit;
    }
    case 'label': {
      const names = new Set((issue.labels?.nodes ?? []).map((label) => label.name));
      return several((name) => names.has(name));
    }
    case 'subscriber':
      return 'unknown';
    case 'relation':
      return several((value) => (value === 'parent' ? Boolean(issue.parent) : 'unknown'));
    case 'content': {
      const text = (values[0] ?? '').toLowerCase();
      const inTitle = issue.title.toLowerCase().includes(text);
      const inDescription = typeof issue.description === 'string' ? issue.description.toLowerCase().includes(text) : issue.description === null ? false : 'unknown';
      const found = inTitle || inDescription === true ? true : inDescription === 'unknown' ? 'unknown' : false;
      if (found === 'unknown') return 'unknown';
      return rule.op === 'notContains' ? !found : found;
    }
    case 'estimate': {
      const estimate = issue.estimate ?? null;
      if (rule.op === 'atLeast' || rule.op === 'atMost') return estimate !== null && (rule.op === 'atLeast' ? estimate >= Number(values[0]) : estimate <= Number(values[0]));
      const hit = values.includes(estimate === null ? '' : String(estimate));
      return negate ? !hit : hit;
    }
    case 'due': {
      if (rule.op === 'before') return Boolean(issue.dueDate && issue.dueDate < values[0]!);
      if (rule.op === 'after') return Boolean(issue.dueDate && issue.dueDate > values[0]!);
      const closed = issue.state.type === 'completed' || issue.state.type === 'canceled';
      return values.some((choice) => dueMatches(choice, issue.dueDate, closed, context));
    }
    case 'created':
    case 'updated':
    case 'completed': {
      const at = rule.field === 'created' ? issue.createdAt : rule.field === 'updated' ? issue.updatedAt : issue.completedAt;
      if (at === undefined) return 'unknown';
      const point = pointInTime(values[0] ?? '', context.now ?? Date.now());
      if (point === null) return 'unknown';
      if (!at) return false;
      return rule.op === 'before' ? Date.parse(at) < point : Date.parse(at) > point;
    }
    case 'workspace':
      return negate !== values.includes(issue.workspaceId ?? '');
  }
};

/** Filters that narrow something: rules with values, groups with such filters, and the parts Linear judges. */
const effective = (nodes: readonly LinearFilterNode[]): LinearFilterNode[] =>
  nodes.filter((node) => (isFilterRule(node) ? node.values.length > 0 : isFilterGroup(node) ? effective(node.items).length > 0 : true));

const nodeMatches = (issue: LinearIssue, node: LinearFilterNode, context: FilterContext): boolean | Unknown => {
  if (isRawFilter(node)) return 'unknown';
  if (isFilterRule(node)) return ruleMatches(issue, node, context);
  return joined(issue, effective(node.items), context, node.join);
};

const joined = (issue: LinearIssue, nodes: readonly LinearFilterNode[], context: FilterContext, join: FilterJoin): boolean | Unknown => {
  if (nodes.length === 0) return true;
  const answers = nodes.map((node) => nodeMatches(issue, node, context));
  if (join === 'or') return answers.includes(true) ? true : answers.includes('unknown') ? 'unknown' : false;
  return answers.includes(false) ? false : answers.includes('unknown') ? 'unknown' : true;
};

/**
 * Whether `issue` passes the filters, the way Linear evaluates the compiled
 * filter. What the list does not read about an issue (its subscribers, most
 * relations, a saved view's parts the Planner cannot edit) counts as passing:
 * Linear listed it, and the next read asks Linear again.
 */
export const matchesRules = (issue: LinearIssue, nodes: readonly LinearFilterNode[], context: FilterContext, match: FilterJoin = 'and'): boolean =>
  joined(issue, effective(nodes), context, match) !== false;

// ── Choices, from the workspaces ────────────────────────────────────────────

/** What the Planner knows of one workspace for filtering and for the issue view. */
export interface FilterCatalog {
  workspaceId: string;
  teams: {
    id: string;
    key: string;
    name: string;
    states: LinearState[];
    /** The team's estimate scale (Linear's issueEstimationType and its options). */
    estimation?: { type: string; allowZero: boolean; extended: boolean };
  }[];
  users: { id: string; name: string; displayName: string; active: boolean; isMe?: boolean }[];
  labels: (LinearLabel & { isGroup?: boolean; parent?: { id: string; name: string } | null; team?: { id: string; key?: string } | null })[];
  projects: { id: string; name: string; color: string; icon?: string | null; status?: { type: string } | null }[];
  cycles: { id: string; number: number; name: string | null; isActive?: boolean; isNext?: boolean; startsAt?: string; endsAt?: string; team: { id: string; key: string } }[];
  /** Project milestones, with their project. */
  milestones?: { id: string; name: string; targetDate?: string | null; project: { id: string; name: string } }[];
}

export interface FilterOption extends FilterValue {
  /** A second line or a short note, such as the teams a state belongs to. */
  hint?: string;
  /** How its icon is drawn. */
  kind?: 'state' | 'priority' | 'person' | 'label' | 'project' | 'cycle' | 'team' | 'due' | 'workspace' | 'milestone' | 'estimate' | 'relation' | 'date';
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
/** Estimates offered when no team in scope uses them, so the filter still reads. */
const FALLBACK_ESTIMATION = { type: 'fibonacci', allowZero: false, extended: false };

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
    case 'creator':
    case 'subscriber': {
      // "Me" is whoever reads, in each workspace (Linear's isMe); the others by name.
      const people = new Map<string, FilterOption>();
      let myName: string | null = null;
      for (const user of catalogs.flatMap((catalog) => catalog.users)) {
        if (!user.active) continue;
        if (user.isMe) {
          myName ??= user.name;
          continue;
        }
        if (people.has(user.id)) continue;
        people.set(user.id, { value: user.id, label: user.name, kind: 'person', ...(user.displayName && user.displayName !== user.name ? { hint: user.displayName } : {}) });
      }
      const me: FilterOption = { value: '@me', label: 'Me', kind: 'person', ...(myName ? { hint: myName } : {}) };
      const sorted = [...people.values()].sort((a, b) => a.label.localeCompare(b.label));
      return field === 'assignee' ? [{ value: '', label: 'No assignee', kind: 'person' }, me, ...sorted] : [me, ...sorted];
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
    case 'milestone': {
      const milestones = [...new Map(catalogs.flatMap((catalog) => catalog.milestones ?? []).map((milestone) => [milestone.id, milestone])).values()];
      const sorted = milestones.sort((a, b) => a.project.name.localeCompare(b.project.name) || a.name.localeCompare(b.name));
      return [{ value: '', label: 'No milestone', kind: 'milestone' }, ...sorted.map((milestone) => ({ value: milestone.id, label: milestone.name, hint: milestone.project.name, kind: 'milestone' as const }))];
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
    case 'estimate': {
      // The teams' own scales (points or T-shirt sizes), merged.
      const scales = teams.map((team) => team.estimation).filter((scale): scale is NonNullable<typeof scale> => Boolean(scale && scale.type !== 'notUsed'));
      const named = new Map<number, string>();
      for (const scale of scales.length ? scales : [FALLBACK_ESTIMATION]) for (const choice of estimateChoices(scale)) if (!named.has(choice.value)) named.set(choice.value, choice.label);
      return [{ value: '', label: 'No estimate', kind: 'estimate' }, ...[...named].sort((a, b) => a[0] - b[0]).map(([value, label]) => ({ value: String(value), label, kind: 'estimate' as const }))];
    }
    case 'relation':
      return RELATION_CHOICES.map((choice) => ({ ...choice, kind: 'relation' as const }));
    case 'content':
      return [];
    case 'due':
      return DUE_CHOICES.map((choice) => ({ ...choice, kind: 'due' as const }));
    case 'created':
    case 'updated':
    case 'completed':
      return SINCE_CHOICES.map((choice) => ({ ...choice, kind: 'date' as const }));
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

/** A rule after ticking or unticking `option`; null when no value is left. One-value operators replace their value. */
export const toggleRuleValue = (rule: LinearFilterRule, option: FilterValue): LinearFilterRule | null => {
  const value = { value: option.value, label: option.label, ...(option.color ? { color: option.color } : {}) };
  const on = rule.values.some((item) => item.value === option.value);
  const values = on ? rule.values.filter((item) => item.value !== option.value) : isSingleValued(rule.op) ? [value] : [...rule.values, value];
  return values.length ? { ...rule, values } : null;
};

/** Top-level filters after ticking or unticking `option` of `field`, in that property's rule (one per property, as Linear's bar keeps). */
export const toggleValue = <T extends LinearFilterNode>(rules: readonly T[], field: LinearFilterField, option: FilterValue): (T | LinearFilterRule)[] => {
  const index = rules.findIndex((rule) => isFilterRule(rule) && rule.field === field);
  if (index < 0) return [...rules, { field, op: defaultOperator(field), values: [{ value: option.value, label: option.label, ...(option.color ? { color: option.color } : {}) }] }];
  const next = toggleRuleValue(rules[index] as LinearFilterRule, option);
  return next ? rules.map((item, at) => (at === index ? next : item)) : rules.filter((_, at) => at !== index);
};

// ── Editing a tree of filters ──────────────────────────────────────────────

/** Where a filter sits: indexes from the top level down through groups. */
export type FilterPath = readonly number[];

export const nodeIn = (group: LinearFilterGroup, path: FilterPath): LinearFilterNode | null => {
  let node: LinearFilterNode = group;
  for (const index of path) {
    if (!isFilterGroup(node)) return null;
    const child: LinearFilterNode | undefined = node.items[index];
    if (!child) return null;
    node = child;
  }
  return node;
};

/** The tree with the filter at `path` replaced, or removed (null); a group left empty goes with it. */
export const replaceIn = (group: LinearFilterGroup, path: FilterPath, node: LinearFilterNode | null): LinearFilterGroup => {
  if (path.length === 0) return node && isFilterGroup(node) ? node : group;
  const [index, ...rest] = path as [number, ...number[]];
  const child = group.items[index];
  if (!child) return group;
  let next: LinearFilterNode | null = node;
  if (rest.length) {
    if (!isFilterGroup(child)) return group;
    const inner = replaceIn(child, rest, node);
    next = inner.items.length ? inner : null;
  }
  return { ...group, items: next ? group.items.map((item, at) => (at === index ? next! : item)) : group.items.filter((_, at) => at !== index) };
};

/** The tree with `node` added at the end of the group at `parent`, and where it went. */
export const appendIn = (group: LinearFilterGroup, parent: FilterPath, node: LinearFilterNode): { group: LinearFilterGroup; path: number[] } => {
  const target = nodeIn(group, parent);
  if (!target || !isFilterGroup(target)) return { group, path: [] };
  const grown: LinearFilterGroup = { ...target, items: [...target.items, node] };
  return { group: parent.length ? replaceIn(group, parent, grown) : grown, path: [...parent, target.items.length] };
};

/** The tree with the group at `path` (the top level for []) joined by `join`. */
export const joinIn = (group: LinearFilterGroup, path: FilterPath, join: FilterJoin): LinearFilterGroup => {
  const target = nodeIn(group, path);
  if (!target || !isFilterGroup(target)) return group;
  return path.length ? replaceIn(group, path, { ...target, join }) : { ...group, join };
};

/** Filters without rules that have no values, and without groups left empty. */
export const pruneFilters = (nodes: readonly LinearFilterNode[]): LinearFilterNode[] =>
  nodes.flatMap((node): LinearFilterNode[] => {
    if (isFilterRule(node)) return node.values.length ? [node] : [];
    if (isRawFilter(node)) return [node];
    const items = pruneFilters(node.items);
    return items.length ? [{ ...node, items }] : [];
  });

// ── A saved view's filter, read back ───────────────────────────────────────

const isObject = (value: unknown): value is GraphFilter => typeof value === 'object' && value !== null && !Array.isArray(value);
const onlyKey = (value: unknown): [string, unknown] | null => {
  if (!isObject(value)) return null;
  const keys = Object.keys(value);
  return keys.length === 1 ? [keys[0]!, value[keys[0]!]] : null;
};
const isText = (value: unknown): value is string => typeof value === 'string';

/** A comparator's values: in or eq (is), nin or neq (is not). */
const listOf = (comparator: unknown): { op: 'is' | 'isNot'; values: unknown[] } | null => {
  const entry = onlyKey(comparator);
  if (!entry) return null;
  const [op, value] = entry;
  if ((op === 'in' || op === 'nin') && Array.isArray(value)) return { op: op === 'in' ? 'is' : 'isNot', values: value };
  if ((op === 'eq' || op === 'neq') && (isText(value) || typeof value === 'number')) return { op: op === 'eq' ? 'is' : 'isNot', values: [value] };
  return null;
};

/** Names and colors of the ids a saved view's filter uses, from the catalogs. */
const lookups = (catalogs: readonly FilterCatalog[]) => {
  const index = <T extends { id: string }>(items: T[]) => new Map(items.map((item) => [item.id, item]));
  return {
    states: index(catalogs.flatMap((catalog) => catalog.teams.flatMap((team) => team.states))),
    users: index(catalogs.flatMap((catalog) => catalog.users)),
    labels: index(catalogs.flatMap((catalog) => catalog.labels)),
    projects: index(catalogs.flatMap((catalog) => catalog.projects)),
    cycles: index(catalogs.flatMap((catalog) => catalog.cycles)),
    teams: index(catalogs.flatMap((catalog) => catalog.teams)),
    milestones: index(catalogs.flatMap((catalog) => catalog.milestones ?? [])),
  };
};
type Lookups = ReturnType<typeof lookups>;

const rule = (field: LinearFilterField, op: FilterOp, values: FilterValue[]): LinearFilterRule => ({ field, op, values });
const valueOf = (value: string, label: string, color?: string | null): FilterValue => ({ value, label, ...(color ? { color } : {}) });

const RELATION_KEYS: Record<string, { field: LinearFilterField; noun: string }> = {
  assignee: { field: 'assignee', noun: 'No assignee' },
  creator: { field: 'creator', noun: 'No creator' },
  project: { field: 'project', noun: 'No project' },
  cycle: { field: 'cycle', noun: 'No cycle' },
  projectMilestone: { field: 'milestone', noun: 'No milestone' },
};

/** A relation's value by id, named from the catalogs. */
const relationValue = (key: string, id: string, names: Lookups): FilterValue => {
  switch (key) {
    case 'assignee':
    case 'creator':
      return valueOf(id, names.users.get(id)?.name ?? id);
    case 'project': {
      const project = names.projects.get(id);
      return valueOf(id, project?.name ?? id, project?.color);
    }
    case 'cycle': {
      const cycle = names.cycles.get(id);
      return valueOf(id, cycle ? cycle.name || `Cycle ${cycle.number}` : id);
    }
    default:
      return valueOf(id, names.milestones.get(id)?.name ?? id);
  }
};

const SPECIALS: Record<string, FilterValue> = { '@me': valueOf('@me', 'Me'), '@active': valueOf('@active', 'Current cycle'), '@next': valueOf('@next', 'Next cycle') };

/** `{ assignee: … }` and the like: who or what it is, or is not. */
const readRelation = (key: string, body: unknown, names: Lookups): LinearFilterRule | null => {
  const { field, noun } = RELATION_KEYS[key]!;
  if (!isObject(body)) return null;
  const none = valueOf('', noun);
  const entries = Object.entries(body);
  if (entries.length === 1 && entries[0]![0] === 'null' && typeof entries[0]![1] === 'boolean') return rule(field, entries[0]![1] ? 'is' : 'isNot', [none]);
  const flag = (name: string, on: boolean) => (value: unknown) => onlyKey(value)?.[0] === 'eq' && (value as GraphFilter).eq === on && name;
  // One positive part: these ids, me, the current or next cycle.
  if (entries.length === 1) {
    const [what, comparator] = entries[0]!;
    const list = what === 'id' ? listOf(comparator) : null;
    if (list?.op === 'is' && list.values.every(isText)) return rule(field, 'is', list.values.map((id) => relationValue(key, id, names)));
    const special = (what === 'isMe' && (key === 'assignee' || key === 'creator') && flag('@me', true)(comparator)) || (key === 'cycle' && what === 'isActive' && flag('@active', true)(comparator)) || (key === 'cycle' && what === 'isNext' && flag('@next', true)(comparator));
    if (special) return rule(field, 'is', [SPECIALS[special]!]);
  }
  // Negative parts only: not these ids, not me…; a relation that is not set never matches them.
  const values: FilterValue[] = [];
  for (const [what, comparator] of entries) {
    const list = what === 'id' ? listOf(comparator) : null;
    if (list?.op === 'isNot' && list.values.every(isText)) values.push(...list.values.map((id) => relationValue(key, id, names)));
    else if (what === 'isMe' && (key === 'assignee' || key === 'creator') && flag('@me', false)(comparator)) values.push(SPECIALS['@me']!);
    else if (key === 'cycle' && what === 'isActive' && flag('@active', false)(comparator)) values.push(SPECIALS['@active']!);
    else if (key === 'cycle' && what === 'isNext' && flag('@next', false)(comparator)) values.push(SPECIALS['@next']!);
    else return null;
  }
  return values.length ? rule(field, 'isNot', [...values, none]) : null;
};

const labelNamesOf = (names: Lookups, ids: string[]): string[] | null => {
  const found = ids.map((id) => names.labels.get(id)?.name);
  return found.every((name): name is string => Boolean(name)) ? [...new Set(found)] : null;
};

/** `{ labels: … }`: by name or (from Linear) by id; "some" includes, "every … nin" excludes. */
const readLabels = (body: unknown, names: Lookups): LinearFilterRule | null => {
  const entry = onlyKey(body);
  if (!entry) return null;
  const [how, inner] = entry;
  const part = onlyKey(inner);
  if (!part) return null;
  const [what, comparator] = part;
  const list = listOf(comparator);
  if (!list || !list.values.every(isText)) return null;
  const labelNames = what === 'name' ? (list.values as string[]) : what === 'id' ? labelNamesOf(names, list.values as string[]) : null;
  if (!labelNames) return null;
  const color = (name: string) => [...names.labels.values()].find((label) => label.name === name)?.color;
  const values = labelNames.map((name) => valueOf(name, name, color(name)));
  if (how === 'some' && list.op === 'is') return rule('label', onlyKey(comparator)?.[0] === 'eq' ? 'includesAll' : 'includesAny', values);
  if (how === 'every' && list.op === 'isNot') return rule('label', 'excludes', values);
  return null;
};

/** `{ subscribers: … }`: some subscriber is one of them (or me); every subscriber is none of them. */
const readSubscribers = (body: unknown, names: Lookups): LinearFilterRule | null => {
  const entry = onlyKey(body);
  if (!entry) return null;
  const [how, inner] = entry;
  const person = (id: string) => valueOf(id, names.users.get(id)?.name ?? id);
  const positive = (filter: unknown): { values: FilterValue[]; eq: boolean } | null => {
    const part = onlyKey(filter);
    if (!part) return null;
    const [what, comparator] = part;
    if (what === 'isMe') return onlyKey(comparator)?.[0] === 'eq' && (comparator as GraphFilter).eq === true ? { values: [SPECIALS['@me']!], eq: false } : null;
    if (what === 'or' && Array.isArray(comparator)) {
      const parts = comparator.map(positive);
      return parts.every((item): item is NonNullable<typeof item> => Boolean(item)) ? { values: parts.flatMap((item) => item.values), eq: false } : null;
    }
    const list = what === 'id' ? listOf(comparator) : null;
    return list?.op === 'is' && list.values.every(isText) ? { values: list.values.map(person), eq: onlyKey(comparator)?.[0] === 'eq' } : null;
  };
  if (how === 'some') {
    const found = positive(inner);
    return found ? rule('subscriber', found.eq ? 'includesAll' : 'includesAny', found.values) : null;
  }
  if (how === 'every' && isObject(inner)) {
    const values: FilterValue[] = [];
    for (const [what, comparator] of Object.entries(inner)) {
      const list = what === 'id' ? listOf(comparator) : null;
      if (list?.op === 'isNot' && list.values.every(isText)) values.push(...list.values.map(person));
      else if (what === 'isMe' && onlyKey(comparator)?.[0] === 'eq' && (comparator as GraphFilter).eq === false) values.push(SPECIALS['@me']!);
      else return null;
    }
    return values.length ? rule('subscriber', 'excludes', values) : null;
  }
  return null;
};

const relationChoice = (value: string): FilterValue => RELATION_CHOICES.find((choice) => choice.value === value)!;
const FLAG_RELATIONS: Record<string, string> = { hasBlockedByRelations: 'blocked', hasBlockingRelations: 'blocking', hasRelatedRelations: 'related', hasDuplicateRelations: 'duplicate' };

/** "1 week ago" for "-P1W", "October 2" for a date, else as it is. */
const sinceLabel = (value: string): string => SINCE_CHOICES.find((choice) => choice.value === value)?.label ?? (isDateKey(value) ? monthDay(value) : value);

/** One filter of a single property, as the Planner compiles it or Linear saves it; null when it is not one. */
const readRule = (filter: unknown, names: Lookups, context: FilterContext): LinearFilterRule | null => {
  const entry = onlyKey(filter);
  if (!entry) return null;
  const [key, body] = entry;
  if (key in RELATION_KEYS) return readRelation(key, body, names);
  if (key in FLAG_RELATIONS) {
    const flag = onlyKey(body);
    if (!flag || (flag[0] !== 'eq' && flag[0] !== 'neq') || typeof flag[1] !== 'boolean') return null;
    const has = flag[0] === 'eq' ? flag[1] : !flag[1];
    return rule('relation', has ? 'includesAny' : 'excludes', [relationChoice(FLAG_RELATIONS[key]!)]);
  }
  switch (key) {
    case 'state': {
      const part = onlyKey(body);
      const list = part && listOf(part[1]);
      if (!part || !list || !list.values.every(isText)) return null;
      const color = (name: string) => [...names.states.values()].find((state) => state.name === name)?.color;
      if (part[0] === 'name') return rule('status', list.op, (list.values as string[]).map((name) => valueOf(name, name, color(name))));
      if (part[0] !== 'id') return null;
      // Linear saves states by id; the Planner's status filter merges same-named states, as Linear's menu does.
      const states = (list.values as string[]).map((id) => names.states.get(id));
      if (!states.every((state): state is LinearState => Boolean(state))) return null;
      return rule('status', list.op, [...new Map(states.map((state) => [state.name, valueOf(state.name, state.name, state.color)])).values()]);
    }
    case 'priority': {
      const list = listOf(body);
      if (!list || !list.values.every((value): value is number => typeof value === 'number')) return null;
      return rule('priority', list.op, (list.values as number[]).map((priority) => valueOf(String(priority), PRIORITY_NAMES[priority] ?? String(priority))));
    }
    case 'team': {
      const part = onlyKey(body);
      const list = part?.[0] === 'id' ? listOf(part[1]) : null;
      if (!list || !list.values.every(isText)) return null;
      return rule('team', list.op, (list.values as string[]).map((id) => valueOf(id, names.teams.get(id)?.name ?? id)));
    }
    case 'labels':
      return readLabels(body, names);
    case 'subscribers':
      return readSubscribers(body, names);
    case 'parent': {
      const part = onlyKey(body);
      if (part?.[0] !== 'null' || typeof part[1] !== 'boolean') return null;
      return rule('relation', part[1] ? 'excludes' : 'includesAny', [relationChoice('parent')]);
    }
    case 'children': {
      const part = onlyKey(body);
      const length = part?.[0] === 'length' ? onlyKey(part[1]) : null;
      if (length?.[0] === 'gt' && length[1] === 0) return rule('relation', 'includesAny', [relationChoice('children')]);
      if (length?.[0] === 'eq' && length[1] === 0) return rule('relation', 'excludes', [relationChoice('children')]);
      return null;
    }
    case 'searchableContent': {
      const part = onlyKey(body);
      if (!part || !isText(part[1]) || (part[0] !== 'contains' && part[0] !== 'notContains')) return null;
      return rule('content', part[0], [valueOf(part[1], part[1])]);
    }
    case 'estimate': {
      const list = listOf(body);
      if (list && list.values.every((value): value is number => typeof value === 'number')) {
        // As for a relation, an issue without an estimate is never "not 3".
        const values = (list.values as number[]).map((points) => valueOf(String(points), `${points} point${points === 1 ? '' : 's'}`));
        return rule('estimate', list.op, list.op === 'isNot' ? [...values, valueOf('', 'No estimate')] : values);
      }
      const part = onlyKey(body);
      if (part?.[0] === 'null' && typeof part[1] === 'boolean') return rule('estimate', part[1] ? 'is' : 'isNot', [valueOf('', 'No estimate')]);
      if ((part?.[0] === 'gte' || part?.[0] === 'lte') && typeof part[1] === 'number') return rule('estimate', part[0] === 'gte' ? 'atLeast' : 'atMost', [valueOf(String(part[1]), `${part[1]} point${part[1] === 1 ? '' : 's'}`)]);
      return null;
    }
    case 'dueDate': {
      if (!isObject(body)) return null;
      const weekStart = startOfWeek(context.today, context.weekStartsOn);
      const choice = (value: string) => valueOf(value, DUE_CHOICES.find((item) => item.value === value)!.label);
      if (body.gte === weekStart && body.lte === addDays(weekStart, 6) && Object.keys(body).length === 2) return rule('due', 'is', [choice('thisWeek')]);
      if (body.gte === addDays(weekStart, 7) && body.lte === addDays(weekStart, 13) && Object.keys(body).length === 2) return rule('due', 'is', [choice('nextWeek')]);
      const part = onlyKey(body);
      if (!part) return null;
      if (part[0] === 'null' && part[1] === true) return rule('due', 'is', [choice('none')]);
      if (part[0] === 'eq' && part[1] === context.today) return rule('due', 'is', [choice('today')]);
      if ((part[0] === 'lt' || part[0] === 'gt') && isText(part[1]) && isDateKey(part[1])) return rule('due', part[0] === 'lt' ? 'before' : 'after', [valueOf(part[1], monthDay(part[1]))]);
      return null;
    }
    case 'createdAt':
    case 'updatedAt':
    case 'completedAt': {
      const part = onlyKey(body);
      if (!part || (part[0] !== 'gt' && part[0] !== 'lt') || !isText(part[1])) return null;
      const field = key === 'createdAt' ? 'created' : key === 'updatedAt' ? 'updated' : 'completed';
      return rule(field, part[0] === 'gt' ? 'after' : 'before', [valueOf(part[1], sinceLabel(part[1]))]);
    }
    default:
      return null;
  }
};

const MERGE_ANY: ReadonlySet<FilterOp> = new Set(['is', 'includesAny']);
/** Values once each, in order, "none" last (as the Planner compiles them). */
const unique = (values: FilterValue[]): FilterValue[] => {
  const byValue = new Map<string, FilterValue>();
  for (const item of values) if (!byValue.has(item.value)) byValue.set(item.value, item);
  const all = [...byValue.values()];
  return [...all.filter((item) => item.value !== ''), ...all.filter((item) => item.value === '')];
};
const isPlusNone = (field: LinearFilterField) => field in { assignee: 1, creator: 1, project: 1, cycle: 1, milestone: 1, estimate: 1 };

/**
 * Several parts that are one rule: what the Planner compiles one rule of
 * several values to ("is either of" as or, "is not" as and, "include all" as
 * and, overdue, content), and the same a saved view says in parts.
 */
const readJoined = (join: FilterJoin, parts: unknown[], names: Lookups, context: FilterContext): LinearFilterRule | null => {
  if (parts.length < 2) return null;
  // Content: the title or the description contains the text, or neither does.
  const text = (filter: unknown, field: string, op: string): string | null => {
    const entry = onlyKey(filter);
    const inner = entry?.[0] === field ? onlyKey(entry[1]) : null;
    return inner?.[0] === op && isText(inner[1]) ? inner[1] : null;
  };
  if (join === 'or' && parts.length === 2) {
    const inTitle = text(parts[0], 'title', 'containsIgnoreCase');
    if (inTitle !== null && text(parts[1], 'description', 'containsIgnoreCase') === inTitle) return rule('content', 'contains', [valueOf(inTitle, inTitle)]);
  }
  if (join === 'and' && parts.length === 2) {
    const notInTitle = text(parts[0], 'title', 'notContainsIgnoreCase');
    const rest = onlyKey(parts[1]);
    if (notInTitle !== null && rest?.[0] === 'or' && Array.isArray(rest[1]) && rest[1].length === 2 && JSON.stringify(rest[1][0]) === JSON.stringify({ description: { null: true } }) && text(rest[1][1], 'description', 'notContainsIgnoreCase') === notInTitle) {
      return rule('content', 'notContains', [valueOf(notInTitle, notInTitle)]);
    }
    // Overdue: due before today and still open.
    if (JSON.stringify(parts[0]) === JSON.stringify({ dueDate: { lt: context.today } }) && JSON.stringify(parts[1]) === JSON.stringify(OPEN)) return rule('due', 'is', [valueOf('overdue', 'Overdue')]);
  }
  const rules = parts.map((part) => readFilterRule(part, names, context));
  if (!rules.every((item): item is LinearFilterRule => Boolean(item))) return null;
  const field = rules[0]!.field;
  if (!rules.every((item) => item.field === field)) return null;
  if (join === 'or') {
    // "Is not these" keeps the issues without any: none, or set and not these.
    if (rules.length === 2 && isPlusNone(field)) {
      const [a, b] = rules as [LinearFilterRule, LinearFilterRule];
      const [none, not] = a.op === 'is' && a.values.length === 1 && a.values[0]!.value === '' ? [a, b] : [b, a];
      if (none.op === 'is' && none.values.length === 1 && none.values[0]!.value === '' && not.op === 'isNot' && not.values.some((item) => item.value === '')) {
        return rule(field, 'isNot', not.values.filter((item) => item.value !== ''));
      }
    }
    const op = rules[0]!.op;
    if (MERGE_ANY.has(op) && rules.every((item) => item.op === op)) return rule(field, op, unique(rules.flatMap((item) => item.values)));
    return null;
  }
  if (rules.every((item) => item.op === 'isNot' || (item.op === 'excludes' && field !== 'content'))) {
    const op = rules[0]!.op;
    if (rules.every((item) => item.op === op)) return rule(field, op, unique(rules.flatMap((item) => item.values)));
  }
  if ((field === 'label' || field === 'subscriber' || field === 'relation') && rules.every((item) => item.op === 'includesAll' || (item.op === 'includesAny' && item.values.length === 1))) {
    return rule(field, 'includesAll', unique(rules.flatMap((item) => item.values)));
  }
  return null;
};

/** One filter that is a single rule, alone or in parts; null when it is not one. */
const readFilterRule = (filter: unknown, names: Lookups, context: FilterContext): LinearFilterRule | null => {
  const entry = onlyKey(filter);
  if (entry && (entry[0] === 'and' || entry[0] === 'or') && Array.isArray(entry[1])) return readJoined(entry[0], entry[1], names, context);
  return readRule(filter, names, context);
};

const RAW_WORDS: Record<string, string> = {
  state: 'Status',
  type: 'type',
  name: 'name',
  priority: 'Priority',
  labels: 'Labels',
  team: 'Team',
  key: 'key',
  slaStatus: 'SLA status',
  dueDate: 'Due date',
  title: 'Title',
  description: 'Description',
};
const RAW_OPS: Record<string, string> = {
  eq: 'is',
  neq: 'is not',
  in: 'is',
  nin: 'is not',
  lt: 'before',
  lte: 'on or before',
  gt: 'after',
  gte: 'on or after',
  contains: 'contains',
  containsIgnoreCase: 'contains',
  notContains: 'does not contain',
  notContainsIgnoreCase: 'does not contain',
  startsWith: 'starts with',
};
const words = (key: string): string => RAW_WORDS[key] ?? key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
const phrase = (path: readonly string[], rest: string): string => `${path.map(words).join(' ')} ${rest}`.trim().replace(/^./, (letter) => letter.toUpperCase());

/** A filter the Planner cannot edit, in words where it can tell ("Status type is not completed, canceled"). */
export const describeRaw = (filter: unknown): string => {
  const path: string[] = [];
  let node: unknown = filter;
  for (;;) {
    const entry = onlyKey(node);
    if (!entry) break;
    const [key, value] = entry;
    if (key === 'null') return phrase(path, value ? 'is not set' : 'is set');
    if (key in RAW_OPS) return phrase(path, `${RAW_OPS[key]} ${Array.isArray(value) ? value.join(', ') : String(value)}`);
    if (key === 'and' || key === 'or' || key === 'some' || key === 'every') break;
    path.push(key);
    node = value;
  }
  return path.length ? phrase(path, '(saved filter)') : 'Saved filter';
};

/** One part of a filter: a rule, a group of them (an object of several fields is a group of all of them), or a part kept as it is. */
const readNode = (filter: unknown, names: Lookups, context: FilterContext): LinearFilterNode => {
  if (!isObject(filter)) return { raw: {}, label: 'Saved filter' };
  const keys = Object.keys(filter);
  if (keys.length > 1) return { join: 'and', items: keys.map((key) => readNode({ [key]: filter[key] }, names, context)) };
  const single = readFilterRule(filter, names, context);
  if (single) return single;
  const [key, value] = [keys[0], keys[0] ? filter[keys[0]] : undefined];
  if ((key === 'and' || key === 'or') && Array.isArray(value)) return { join: key, items: value.map((part) => readNode(part, names, context)) };
  return { raw: filter, label: describeRaw(filter) };
};

/**
 * A filter as Linear keeps it (a saved view's filterData, an IssueFilter) as
 * the top-level filters of a list, all of which hold: an "and" opens into its
 * parts; an "or" stays one group, shown as "Any of N filters". Names come
 * from the catalogs; parts the Planner cannot edit are kept as they are.
 */
export const readFilter = (filter: unknown, catalogs: readonly FilterCatalog[], context: FilterContext): LinearFilterNode[] => {
  if (!isObject(filter) || Object.keys(filter).length === 0) return [];
  const node = readNode(filter, lookups(catalogs), context);
  return isFilterGroup(node) && node.join === 'and' ? node.items : [node];
};

/**
 * What a list's filters ask beyond a saved view's own, while all of the view's
 * still hold as saved: then Linear applies the view's filter itself. Null once
 * one of them was changed or removed, or the top level matches any.
 */
export const beyondSaved = (nodes: readonly LinearFilterNode[], match: FilterJoin, saved: readonly LinearFilterNode[]): { nodes: LinearFilterNode[]; match: FilterJoin } | null => {
  if (saved.length === 0) return { nodes: [...nodes], match };
  if (match !== 'and') return null;
  const rest = [...nodes];
  for (const item of saved) {
    const at = rest.findIndex((node) => JSON.stringify(node) === JSON.stringify(item));
    if (at < 0) return null;
    rest.splice(at, 1);
  }
  return { nodes: rest, match: 'and' };
};
