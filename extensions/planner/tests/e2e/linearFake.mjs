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

export const compare = (value, comparator) => Object.entries(comparator).every(([op, wanted]) => {
  switch (op) {
    case 'eq': return value === wanted;
    case 'neq': return value !== wanted;
    case 'in': return wanted.includes(value);
    case 'nin': return !wanted.includes(value);
    case 'lt': return value != null && value < since(wanted);
    case 'lte': return value != null && value <= since(wanted);
    case 'gt': return value != null && value > since(wanted);
    case 'gte': return value != null && value >= since(wanted);
    case 'null': return wanted ? value == null : value != null;
    default: throw new Error(`fake Linear: comparator ${op}`);
  }
});

const fail = (what) => { throw new Error(`fake Linear: ${what}`); };

/**
 * Filters over issues shaped like the Planner reads them (state, team, assignee, creator,
 * project, cycle, parent, labels.nodes), plus `subscribers` (user ids) where a journey has them.
 * `cycleFlags(id)` says whether a cycle is the current or the next one.
 */
export const makeFilters = ({ viewerId, cycleFlags = () => ({}) }) => {
  // A relation that is not set matches only `null: true`, as a join in Linear does.
  const relation = (value, filter, fields) => {
    if (value == null) return filter.null === true;
    return Object.entries(filter).every(([key, comparator]) => {
      if (key === 'null') return comparator === false;
      if (!(key in fields)) fail(`relation field ${key}`);
      return fields[key](value, comparator);
    });
  };
  const idField = { id: (value, c) => compare(value.id, c) };
  const userFields = { ...idField, isMe: (value, c) => compare(value.id === viewerId, c) };
  const cycleFields = { ...idField, isActive: (value, c) => compare(Boolean(cycleFlags(value.id).isActive), c), isNext: (value, c) => compare(Boolean(cycleFlags(value.id).isNext), c) };
  const labelMatch = (item, filter) => Object.entries(filter).every(([key, c]) => (key === 'name' ? compare(item.name, c) : key === 'id' ? compare(item.id, c) : fail(`label field ${key}`)));
  const matchIssue = (item, filter) => Object.entries(filter).every(([key, value]) => {
    switch (key) {
      case 'and': return value.every((part) => matchIssue(item, part));
      case 'or': return value.some((part) => matchIssue(item, part));
      case 'id': return compare(item.id, value);
      case 'state': return Object.entries(value).every(([field, c]) => compare(item.state[field], c));
      case 'team': return Object.entries(value).every(([field, c]) => compare(item.team[field], c));
      case 'assignee': case 'creator': return relation(item[key], value, userFields);
      case 'project': return relation(item.project, value, idField);
      case 'cycle': return relation(item.cycle, value, cycleFields);
      case 'priority': return compare(item.priority, value);
      case 'dueDate': return compare(item.dueDate, value);
      case 'completedAt': case 'canceledAt': return compare(item[key] ?? null, value);
      case 'parent': return relation(item.parent, value, idField);
      case 'labels': return Object.entries(value).every(([how, f]) => (how === 'some' ? (item.labels?.nodes ?? []).some((l) => labelMatch(l, f)) : how === 'every' ? (item.labels?.nodes ?? []).every((l) => labelMatch(l, f)) : fail(`labels.${how}`)));
      case 'subscribers': return value.some?.isMe?.eq === true ? (item.subscribers ?? []).includes(viewerId) : fail('subscribers filter');
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
