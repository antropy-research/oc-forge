import { describe, expect, test } from 'bun:test';
import {
  appendIn,
  beyondSaved,
  compileFilter,
  compileRule,
  describeNode,
  describeRule,
  filterChoices,
  groupTitle,
  isRawFilter,
  joinIn,
  matchesRules,
  nodeIn,
  operatorsFor,
  pruneFilters,
  readFilter,
  replaceIn,
  searchChoices,
  toggleRuleValue,
  toggleValue,
  withOperator,
  workspacesFor,
  type FilterCatalog,
  type LinearFilterGroup,
  type LinearFilterNode,
  type LinearFilterRule,
} from '../src/domain/linearFilter.ts';
import type { LinearIssue } from '../src/domain/linear.ts';

// Monday 2026-10-26; weeks start on Monday.
const context = { today: '2026-10-26', weekStartsOn: 1 as const };
const rule = (field: LinearFilterRule['field'], op: LinearFilterRule['op'], ...values: [string, string?][]): LinearFilterRule => ({ field, op, values: values.map(([value, label]) => ({ value, label: label ?? value })) });

describe('filters compile to IssueFilter, so Linear answers with every match', () => {
  test('status by name across teams; is not', () => {
    expect(compileRule(rule('status', 'is', ['Todo'], ['In Progress']), context)).toEqual({ state: { name: { in: ['Todo', 'In Progress'] } } });
    expect(compileRule(rule('status', 'isNot', ['Done']), context)).toEqual({ state: { name: { nin: ['Done'] } } });
  });
  test('people: any of, nobody, and "is not" keeps the unassigned', () => {
    expect(compileRule(rule('assignee', 'is', ['u1'], ['u2']), context)).toEqual({ assignee: { id: { in: ['u1', 'u2'] } } });
    expect(compileRule(rule('assignee', 'is', ['u1'], ['', 'No assignee']), context)).toEqual({ or: [{ assignee: { id: { in: ['u1'] } } }, { assignee: { null: true } }] });
    expect(compileRule(rule('assignee', 'is', ['', 'No assignee']), context)).toEqual({ assignee: { null: true } });
    expect(compileRule(rule('assignee', 'isNot', ['u1']), context)).toEqual({ or: [{ assignee: { null: true } }, { assignee: { id: { nin: ['u1'] } } }] });
    expect(compileRule(rule('assignee', 'isNot', ['u1'], ['', 'No assignee']), context)).toEqual({ and: [{ assignee: { null: false } }, { assignee: { id: { nin: ['u1'] } } }] });
    expect(compileRule(rule('creator', 'is', ['u3']), context)).toEqual({ creator: { id: { in: ['u3'] } } });
  });
  test('priority, team, project', () => {
    expect(compileRule(rule('priority', 'is', ['1'], ['0']), context)).toEqual({ priority: { in: [1, 0] } });
    expect(compileRule(rule('priority', 'isNot', ['4']), context)).toEqual({ priority: { nin: [4] } });
    expect(compileRule(rule('team', 'is', ['t1']), context)).toEqual({ team: { id: { in: ['t1'] } } });
    expect(compileRule(rule('project', 'is', ['p1'], ['', 'No project']), context)).toEqual({ or: [{ project: { id: { in: ['p1'] } } }, { project: { null: true } }] });
  });
  test('labels: include any, all, or none', () => {
    expect(compileRule(rule('label', 'includesAny', ['Bug'], ['UI']), context)).toEqual({ labels: { some: { name: { in: ['Bug', 'UI'] } } } });
    expect(compileRule(rule('label', 'includesAll', ['Bug'], ['UI']), context)).toEqual({ and: [{ labels: { some: { name: { eq: 'Bug' } } } }, { labels: { some: { name: { eq: 'UI' } } } }] });
    expect(compileRule(rule('label', 'excludes', ['Bug']), context)).toEqual({ labels: { every: { name: { nin: ['Bug'] } } } });
  });
  test('cycles: a cycle, none, the current one', () => {
    expect(compileRule(rule('cycle', 'is', ['c1']), context)).toEqual({ cycle: { id: { in: ['c1'] } } });
    // One part alone, not a one-element "or": a one-element "or" or "and" is a filter group.
    expect(compileRule(rule('cycle', 'is', ['@active', 'Current cycle']), context)).toEqual({ cycle: { isActive: { eq: true } } });
    expect(compileRule(rule('cycle', 'is', ['', 'No cycle'], ['@next', 'Next cycle']), context)).toEqual({ or: [{ cycle: { null: true } }, { cycle: { isNext: { eq: true } } }] });
    expect(compileRule(rule('cycle', 'isNot', ['@active', 'Current cycle']), context)).toEqual({ or: [{ cycle: { null: true } }, { cycle: { isActive: { eq: false } } }] });
  });
  test("due dates: Linear's choices, before and after a date", () => {
    expect(compileRule(rule('due', 'is', ['overdue']), context)).toEqual({ and: [{ dueDate: { lt: '2026-10-26' } }, { state: { type: { nin: ['completed', 'canceled'] } } }] });
    expect(compileRule(rule('due', 'is', ['today']), context)).toEqual({ dueDate: { eq: '2026-10-26' } });
    expect(compileRule(rule('due', 'is', ['thisWeek']), context)).toEqual({ dueDate: { gte: '2026-10-26', lte: '2026-11-01' } });
    expect(compileRule(rule('due', 'is', ['nextWeek']), context)).toEqual({ dueDate: { gte: '2026-11-02', lte: '2026-11-08' } });
    expect(compileRule(rule('due', 'is', ['nextWeek']), { today: '2026-10-28', weekStartsOn: 0 })).toEqual({ dueDate: { gte: '2026-11-01', lte: '2026-11-07' } });
    expect(compileRule(rule('due', 'is', ['none'], ['today']), context)).toEqual({ or: [{ dueDate: { null: true } }, { dueDate: { eq: '2026-10-26' } }] });
    expect(compileRule(rule('due', 'before', ['2026-11-02']), context)).toEqual({ dueDate: { lt: '2026-11-02' } });
    expect(compileRule(rule('due', 'after', ['2026-11-02']), context)).toEqual({ dueDate: { gt: '2026-11-02' } });
  });
  test('rules all apply; a workspace rule picks the workspaces to ask instead', () => {
    const rules = [rule('status', 'is', ['Todo']), rule('label', 'includesAny', ['Bug']), rule('workspace', 'is', ['org-b', 'Side'])];
    expect(compileFilter(rules, context)).toEqual({ and: [{ state: { name: { in: ['Todo'] } } }, { labels: { some: { name: { in: ['Bug'] } } } }] });
    expect(compileFilter([], context)).toBeNull();
    expect(compileFilter([rule('workspace', 'is', ['org-b'])], context)).toBeNull();
    expect(workspacesFor(rules, ['org-a', 'org-b'])).toEqual(['org-b']);
    expect(workspacesFor([rule('workspace', 'isNot', ['org-b'])], ['org-a', 'org-b'])).toEqual(['org-a']);
    expect(workspacesFor([], ['org-a', 'org-b'])).toEqual(['org-a', 'org-b']);
  });
});

describe('chips and operators read like Linear', () => {
  test('one value, several values, negation', () => {
    expect(describeRule(rule('status', 'is', ['Todo']))).toBe('Status is Todo');
    expect(describeRule(rule('status', 'is', ['Todo'], ['In Progress']))).toBe('Status is either of Todo, In Progress');
    expect(describeRule(rule('assignee', 'isNot', ['u1', 'Al']))).toBe('Assignee is not Al');
    expect(describeRule(rule('label', 'includesAll', ['Bug'], ['UI']))).toBe('Labels include all of Bug, UI');
    expect(describeRule(rule('label', 'excludes', ['Bug']))).toBe('Labels do not include Bug');
    expect(describeRule(rule('due', 'before', ['2026-11-02', 'Nov 2']))).toBe('Due date before Nov 2');
  });
  test('each property offers the operators Linear has for it', () => {
    expect(operatorsFor('status')).toEqual(['is', 'isNot']);
    expect(operatorsFor('label')).toEqual(['includesAny', 'includesAll', 'excludes']);
    expect(operatorsFor('due')).toEqual(['is', 'before', 'after']);
  });
  test('ticking values adds, keeps and removes rules', () => {
    let rules = toggleValue([], 'status', { value: 'Todo', label: 'Todo' });
    expect(rules).toEqual([{ field: 'status', op: 'is', values: [{ value: 'Todo', label: 'Todo' }] }]);
    rules = toggleValue(rules, 'status', { value: 'In Progress', label: 'In Progress', color: '#f2c94c' });
    expect(rules[0]!.values.map((item) => item.value)).toEqual(['Todo', 'In Progress']);
    rules = toggleValue(rules, 'label', { value: 'Bug', label: 'Bug' });
    expect(rules.map((item) => `${item.field}:${item.op}`)).toEqual(['status:is', 'label:includesAny']);
    rules = toggleValue(toggleValue(rules, 'status', { value: 'Todo', label: 'Todo' }), 'status', { value: 'In Progress', label: 'In Progress' });
    expect(rules.map((item) => item.field)).toEqual(['label']);
  });
  test('a due rule switching to before/after keeps only a date, and back', () => {
    const relative = rule('due', 'is', ['today', 'Due today']);
    expect(withOperator(relative, 'before').values).toEqual([]);
    const dated = toggleValue([{ field: 'due', op: 'after', values: [] }], 'due', { value: '2026-11-02', label: 'Nov 2' });
    expect(dated[0]).toEqual({ field: 'due', op: 'after', values: [{ value: '2026-11-02', label: 'Nov 2' }] });
    expect(toggleValue(dated, 'due', { value: '2026-11-09', label: 'Nov 9' })[0]!.values).toEqual([{ value: '2026-11-09', label: 'Nov 9' }]);
    expect(withOperator(dated[0]!, 'is').values).toEqual([]);
    expect(withOperator(rule('status', 'is', ['Todo']), 'isNot')).toEqual(rule('status', 'isNot', ['Todo']));
  });
});

describe('choices come from the workspaces, not from the loaded issues', () => {
  const catalog: FilterCatalog = {
    workspaceId: 'org-a',
    teams: [
      { id: 'team-har', key: 'HAR', name: 'Harness', states: [{ id: 'h1', name: 'Todo', type: 'unstarted', color: '#e2e2e2', position: 1 }, { id: 'h2', name: 'In Review', type: 'started', color: '#0f783c', position: 3 }, { id: 'h3', name: 'Done', type: 'completed', color: '#5e6ad2', position: 4 }, { id: 'h0', name: 'Backlog', type: 'backlog', color: '#bbb', position: 0 }] },
      { id: 'team-ops', key: 'OPS', name: 'Ops', states: [{ id: 'o1', name: 'Todo', type: 'unstarted', color: '#e2e2e2', position: 0 }, { id: 'o2', name: 'Doing', type: 'started', color: '#f2c94c', position: 1 }, { id: 'o3', name: 'Done', type: 'completed', color: '#5e6ad2', position: 2 }] },
    ],
    users: [
      { id: 'u2', name: 'Bo', displayName: 'bo', active: true },
      { id: 'u1', name: 'Me Myself', displayName: 'me', active: true, isMe: true },
      { id: 'u3', name: 'Gone', displayName: 'gone', active: false },
    ],
    labels: [
      { id: 'l1', name: 'Bug', color: '#f00', team: { id: 'team-har' } },
      { id: 'l2', name: 'Bug', color: '#f00', team: { id: 'team-ops' } },
      { id: 'g1', name: 'Type', color: '#000', isGroup: true },
      { id: 'l3', name: 'Feature', color: '#0f0', parent: { id: 'g1', name: 'Type' }, team: null },
      { id: 'l4', name: 'Ops only', color: '#00f', team: { id: 'team-ops' } },
    ],
    projects: [{ id: 'p2', name: 'Zeta', color: '#111' }, { id: 'p1', name: 'Alpha', color: '#222' }],
    cycles: [{ id: 'c2', number: 2, name: null, isActive: true, team: { id: 'team-har', key: 'HAR' } }, { id: 'c1', number: 1, name: 'Kickoff', team: { id: 'team-har', key: 'HAR' } }],
  };
  test('statuses: every state of every team, merged by name, in workflow order, with the teams that have them', () => {
    expect(filterChoices('status', [catalog]).map((option) => `${option.label}${option.hint ? ` (${option.hint})` : ''}`)).toEqual(['Backlog (HAR)', 'Todo', 'Doing (OPS)', 'In Review (HAR)', 'Done']);
    expect(filterChoices('status', [catalog], { teamIds: ['team-ops'] }).map((option) => option.label)).toEqual(['Todo', 'Doing', 'Done']);
  });
  test('people: active members, me first (as "Me", whoever reads, in each workspace); nobody first for assignees', () => {
    expect(filterChoices('assignee', [catalog]).map((option) => `${option.label}${option.hint ? ` (${option.hint})` : ''}`)).toEqual(['No assignee', 'Me (Me Myself)', 'Bo (bo)']);
    expect(filterChoices('creator', [catalog]).map((option) => option.value)).toEqual(['@me', 'u2']);
    expect(filterChoices('subscriber', [catalog]).map((option) => option.value)).toEqual(['@me', 'u2']);
    expect(searchChoices(filterChoices('subscriber', [catalog]), 'me my').map((option) => option.value)).toEqual(['@me']);
  });
  test('labels by name (no groups), projects, cycles, priorities, due dates', () => {
    expect(filterChoices('label', [catalog]).map((option) => `${option.label}${option.hint ? ` (${option.hint})` : ''}`)).toEqual(['Bug', 'Feature (Type)', 'Ops only']);
    expect(filterChoices('label', [catalog], { teamIds: ['team-har'] }).map((option) => option.label)).toEqual(['Bug', 'Feature']);
    expect(filterChoices('project', [catalog]).map((option) => option.label)).toEqual(['No project', 'Alpha', 'Zeta']);
    expect(filterChoices('cycle', [catalog]).map((option) => `${option.label}${option.hint ? ` (${option.hint})` : ''}`)).toEqual(['No cycle', 'Current cycle', 'Next cycle', 'Kickoff', 'Cycle 2 (Current)']);
    expect(filterChoices('priority', []).map((option) => option.label)).toEqual(['No priority', 'Urgent', 'High', 'Medium', 'Low']);
    expect(filterChoices('due', []).map((option) => option.label)).toEqual(['Overdue', 'Due today', 'Due this week', 'Due next week', 'No due date']);
  });
  test('typing finds choices by their start first, then anywhere', () => {
    const states = filterChoices('status', [catalog]);
    expect(searchChoices(states, 'do').map((option) => option.label)).toEqual(['Doing', 'Done', 'Todo']);
    expect(searchChoices(states, '').length).toBe(states.length);
  });
});

describe('the same rules on one issue', () => {
  const issue: LinearIssue = {
    id: 'i1', identifier: 'HAR-1', title: 't', url: 'https://linear.app/x/issue/HAR-1', priority: 2, dueDate: '2026-10-20', updatedAt: '2026-10-25T00:00:00.000Z',
    state: { id: 'h1', name: 'Todo', type: 'unstarted', color: '#e2e2e2' }, team: { id: 'team-har', key: 'HAR', name: 'Harness' },
    assignee: null, project: { id: 'p1', name: 'Alpha' }, cycle: { id: 'c2', number: 2, isActive: true }, labels: { nodes: [{ id: 'l1', name: 'Bug', color: '#f00' }] }, workspaceId: 'org-a',
  };
  test('agrees with what the compiled filter asks Linear for', () => {
    expect(matchesRules(issue, [rule('status', 'is', ['Todo'])], context)).toBe(true);
    expect(matchesRules(issue, [rule('status', 'isNot', ['Todo'])], context)).toBe(false);
    expect(matchesRules(issue, [rule('assignee', 'is', ['', 'No assignee'])], context)).toBe(true);
    expect(matchesRules(issue, [rule('assignee', 'isNot', ['u1'])], context)).toBe(true);
    expect(matchesRules(issue, [rule('label', 'includesAll', ['Bug'], ['UI'])], context)).toBe(false);
    expect(matchesRules(issue, [rule('label', 'excludes', ['UI'])], context)).toBe(true);
    expect(matchesRules(issue, [rule('cycle', 'is', ['@active'])], context)).toBe(true);
    expect(matchesRules(issue, [rule('due', 'is', ['overdue'])], context)).toBe(true);
    expect(matchesRules({ ...issue, state: { ...issue.state, type: 'completed', name: 'Done' } }, [rule('due', 'is', ['overdue'])], context)).toBe(false);
    expect(matchesRules(issue, [rule('due', 'after', ['2026-10-21'])], context)).toBe(false);
    expect(matchesRules(issue, [rule('priority', 'is', ['2'])], context)).toBe(true);
    expect(matchesRules(issue, [rule('workspace', 'isNot', ['org-a'])], context)).toBe(false);
  });
});

// ── Linear's advanced filters: all / any, nested groups, and the further properties ──

const group = (join: 'and' | 'or', ...items: LinearFilterNode[]): LinearFilterGroup => ({ join, items });

describe('match all / any and filter groups compile to and / or', () => {
  const urgent = rule('priority', 'is', ['1', 'Urgent']);
  const mine = rule('assignee', 'is', ['@me', 'Me']);
  const bug = rule('label', 'includesAny', ['Bug']);
  test('(priority is Urgent or assignee is me) and labels include Bug', () => {
    expect(compileFilter([group('or', urgent, mine), bug], context)).toEqual({
      and: [{ or: [{ priority: { in: [1] } }, { assignee: { isMe: { eq: true } } }] }, { labels: { some: { name: { in: ['Bug'] } } } }],
    });
  });
  test('the top level matches any', () => {
    expect(compileFilter([urgent, bug], context, 'or')).toEqual({ or: [{ priority: { in: [1] } }, { labels: { some: { name: { in: ['Bug'] } } } }] });
    expect(compileFilter([urgent], context, 'or')).toEqual({ priority: { in: [1] } });
  });
  test('groups nest, each with its own and / or; a group of one keeps its wrapper; empty ones vanish', () => {
    const nested = group('or', urgent, group('and', mine, bug));
    expect(compileFilter([nested], context)).toEqual({ or: [{ priority: { in: [1] } }, { and: [{ assignee: { isMe: { eq: true } } }, { labels: { some: { name: { in: ['Bug'] } } } }] }] });
    expect(compileFilter([group('and', urgent)], context)).toEqual({ and: [{ priority: { in: [1] } }] });
    expect(compileFilter([group('or'), urgent], context)).toEqual({ priority: { in: [1] } });
  });
  test('a part of a saved view kept as it is goes to Linear unchanged', () => {
    const raw = { raw: { slaStatus: { eq: 'Breached' } }, label: 'SLA status is Breached' };
    expect(compileFilter([raw, urgent], context)).toEqual({ and: [{ slaStatus: { eq: 'Breached' } }, { priority: { in: [1] } }] });
  });
  test('describes groups as Linear’s chips do', () => {
    expect(groupTitle(group('or', urgent, mine))).toBe('Any of 2 filters');
    expect(groupTitle(group('and', urgent))).toBe('All of 1 filter');
    expect(describeNode(group('or', urgent, group('and', mine, bug)))).toBe('Any of 2 filters: Priority is Urgent or (Assignee is Me and Labels include Bug)');
  });
  test('an issue is judged the same way, all or any, through groups', () => {
    const issue = {
      id: 'i1', identifier: 'HAR-1', title: 'Fix the login page', url: 'https://linear.app/x/issue/HAR-1', priority: 2, dueDate: null, updatedAt: '2026-10-25T00:00:00.000Z', createdAt: '2026-10-20T00:00:00.000Z',
      state: { id: 'h1', name: 'Todo', type: 'unstarted', color: '#e2e2e2' }, team: { id: 'team-har', key: 'HAR', name: 'Harness' }, assignee: { id: 'u1', name: 'Me Myself' }, creator: { id: 'u2', name: 'Bo' },
      project: null, cycle: null, parent: null, estimate: 3, labels: { nodes: [{ id: 'l1', name: 'Bug', color: '#f00' }] }, workspaceId: 'org-a',
    } as LinearIssue;
    const me = { ...context, viewerIds: new Map([['org-a', 'u1']]), now: Date.parse('2026-10-26T12:00:00Z') };
    expect(matchesRules(issue, [group('or', urgent, mine), bug], me)).toBe(true);
    expect(matchesRules(issue, [group('and', urgent, mine), bug], me)).toBe(false);
    expect(matchesRules(issue, [urgent, bug], me, 'or')).toBe(true);
    expect(matchesRules(issue, [urgent, rule('label', 'includesAny', ['UI'])], me, 'or')).toBe(false);
    expect(matchesRules(issue, [rule('content', 'contains', ['LOGIN'])], me)).toBe(true);
    expect(matchesRules(issue, [rule('content', 'notContains', ['login'])], me)).toBe(false);
    // The description is not in a list's issues: Linear judged it, so the issue stays.
    expect(matchesRules(issue, [rule('content', 'contains', ['missing'])], me)).toBe(true);
    expect(matchesRules({ ...issue, description: 'nothing' } as LinearIssue, [rule('content', 'contains', ['missing'])], me)).toBe(false);
    expect(matchesRules(issue, [rule('estimate', 'atLeast', ['3'])], me)).toBe(true);
    expect(matchesRules(issue, [rule('estimate', 'isNot', ['3'])], me)).toBe(false);
    expect(matchesRules(issue, [rule('created', 'after', ['-P1W'])], me)).toBe(true);
    expect(matchesRules(issue, [rule('created', 'before', ['2026-10-01'])], me)).toBe(false);
    expect(matchesRules(issue, [rule('creator', 'is', ['@me'])], me)).toBe(false);
    expect(matchesRules(issue, [rule('relation', 'includesAny', ['parent'])], me)).toBe(false);
    expect(matchesRules(issue, [rule('relation', 'includesAny', ['parent'], ['blocked'])], me)).toBe(true);
    expect(matchesRules(issue, [rule('subscriber', 'includesAny', ['@me'])], me)).toBe(true);
    expect(matchesRules(issue, [{ raw: { slaStatus: { eq: 'Breached' } }, label: 'SLA' }], me)).toBe(true);
  });
});

describe('the further properties compile as Linear filters them', () => {
  test('content: the title or the description contains the text, or neither does', () => {
    expect(compileRule(rule('content', 'contains', ['login']), context)).toEqual({ or: [{ title: { containsIgnoreCase: 'login' } }, { description: { containsIgnoreCase: 'login' } }] });
    expect(compileRule(rule('content', 'notContains', ['login']), context)).toEqual({
      and: [{ title: { notContainsIgnoreCase: 'login' } }, { or: [{ description: { null: true } }, { description: { notContainsIgnoreCase: 'login' } }] }],
    });
    expect(describeRule(rule('content', 'contains', ['login']))).toBe('Content contains “login”');
  });
  test('subscribers, me included', () => {
    expect(compileRule(rule('subscriber', 'includesAny', ['@me', 'Me']), context)).toEqual({ subscribers: { some: { isMe: { eq: true } } } });
    expect(compileRule(rule('subscriber', 'includesAny', ['u2'], ['@me']), context)).toEqual({ subscribers: { some: { or: [{ id: { in: ['u2'] } }, { isMe: { eq: true } }] } } });
    expect(compileRule(rule('subscriber', 'includesAll', ['u2'], ['@me']), context)).toEqual({ and: [{ subscribers: { some: { id: { eq: 'u2' } } } }, { subscribers: { some: { isMe: { eq: true } } } }] });
    expect(compileRule(rule('subscriber', 'excludes', ['u2'], ['@me']), context)).toEqual({ subscribers: { every: { id: { nin: ['u2'] }, isMe: { eq: false } } } });
  });
  test('relations: blocked by, blocking, related, duplicate, a parent, sub-issues', () => {
    expect(compileRule(rule('relation', 'includesAny', ['blocked'], ['blocking'], ['related'], ['duplicate']), context)).toEqual({
      or: [{ hasBlockedByRelations: { eq: true } }, { hasBlockingRelations: { eq: true } }, { hasRelatedRelations: { eq: true } }, { hasDuplicateRelations: { eq: true } }],
    });
    expect(compileRule(rule('relation', 'includesAll', ['parent'], ['children']), context)).toEqual({ and: [{ parent: { null: false } }, { children: { length: { gt: 0 } } }] });
    expect(compileRule(rule('relation', 'excludes', ['parent'], ['children']), context)).toEqual({ and: [{ parent: { null: true } }, { children: { length: { eq: 0 } } }] });
    expect(compileRule(rule('relation', 'excludes', ['blocked']), context)).toEqual({ hasBlockedByRelations: { eq: false } });
  });
  test('dates: created, updated and completed after or before a time ago or a date', () => {
    expect(compileRule(rule('created', 'after', ['-P1W', '1 week ago']), context)).toEqual({ createdAt: { gt: '-P1W' } });
    expect(compileRule(rule('updated', 'before', ['-P1M']), context)).toEqual({ updatedAt: { lt: '-P1M' } });
    expect(compileRule(rule('completed', 'after', ['2026-10-01']), context)).toEqual({ completedAt: { gt: '2026-10-01' } });
    expect(operatorsFor('created')).toEqual(['after', 'before']);
    expect(filterChoices('updated', []).map((option) => option.label)).toEqual(['1 day ago', '1 week ago', '2 weeks ago', '1 month ago', '3 months ago', '6 months ago', '1 year ago']);
  });
  test('estimate: is, is not (keeping those without one), at least, at most', () => {
    expect(compileRule(rule('estimate', 'is', ['3'], ['', 'No estimate']), context)).toEqual({ or: [{ estimate: { in: [3] } }, { estimate: { null: true } }] });
    expect(compileRule(rule('estimate', 'isNot', ['3']), context)).toEqual({ or: [{ estimate: { null: true } }, { estimate: { nin: [3] } }] });
    expect(compileRule(rule('estimate', 'atLeast', ['5']), context)).toEqual({ estimate: { gte: 5 } });
    expect(compileRule(rule('estimate', 'atMost', ['2']), context)).toEqual({ estimate: { lte: 2 } });
    expect(withOperator(rule('estimate', 'is', ['', 'No estimate'], ['3']), 'atLeast').values.map((item) => item.value)).toEqual(['3']);
  });
  test('milestone, creator me, cycle: relations like the assignee', () => {
    expect(compileRule(rule('milestone', 'is', ['m1'], ['', 'No milestone']), context)).toEqual({ or: [{ projectMilestone: { id: { in: ['m1'] } } }, { projectMilestone: { null: true } }] });
    expect(compileRule(rule('milestone', 'isNot', ['m1']), context)).toEqual({ or: [{ projectMilestone: { null: true } }, { projectMilestone: { id: { nin: ['m1'] } } }] });
    expect(compileRule(rule('creator', 'is', ['@me']), context)).toEqual({ creator: { isMe: { eq: true } } });
    expect(compileRule(rule('assignee', 'isNot', ['@me']), context)).toEqual({ or: [{ assignee: { null: true } }, { assignee: { isMe: { eq: false } } }] });
  });
  test('the choices of the further properties come from the workspaces', () => {
    const catalog: FilterCatalog = {
      workspaceId: 'org-a',
      teams: [{ id: 't1', key: 'HAR', name: 'Harness', states: [], estimation: { type: 'tShirt', allowZero: false, extended: false } }, { id: 't2', key: 'OPS', name: 'Ops', states: [], estimation: { type: 'notUsed', allowZero: false, extended: false } }],
      users: [],
      labels: [],
      projects: [],
      cycles: [],
      milestones: [{ id: 'm2', name: 'GA', project: { id: 'p1', name: 'Planner' } }, { id: 'm1', name: 'Beta', project: { id: 'p1', name: 'Planner' } }],
    };
    expect(filterChoices('estimate', [catalog]).map((option) => option.label)).toEqual(['No estimate', 'XS', 'S', 'M', 'L', 'XL']);
    expect(filterChoices('milestone', [catalog]).map((option) => `${option.label}${option.hint ? ` (${option.hint})` : ''}`)).toEqual(['No milestone', 'Beta (Planner)', 'GA (Planner)']);
    expect(filterChoices('relation', []).map((option) => option.label)).toEqual(['Blocked by', 'Blocking', 'Related', 'Duplicate', 'Parent issue', 'Sub-issues']);
    expect(operatorsFor('subscriber')).toEqual(['includesAny', 'includesAll', 'excludes']);
    expect(operatorsFor('content')).toEqual(['contains', 'notContains']);
  });
  test('one-value operators replace their value; a rule left without values goes', () => {
    const since = rule('created', 'after', ['-P1W', '1 week ago']);
    expect(toggleRuleValue(since, { value: '-P1M', label: '1 month ago' })!.values).toEqual([{ value: '-P1M', label: '1 month ago' }]);
    expect(toggleRuleValue(since, { value: '-P1W', label: '1 week ago' })).toBeNull();
    expect(toggleRuleValue(rule('label', 'includesAny', ['Bug']), { value: 'UI', label: 'UI' })!.values.map((item) => item.value)).toEqual(['Bug', 'UI']);
  });
});

describe('editing a tree of filters', () => {
  const a = rule('status', 'is', ['Todo']);
  const b = rule('priority', 'is', ['1', 'Urgent']);
  const c = rule('label', 'includesAny', ['Bug']);
  const tree = group('and', a, group('or', b, c));
  test('finds, replaces and removes by path; a group left empty goes too', () => {
    expect(nodeIn(tree, [1, 0])).toEqual(b);
    expect(nodeIn(tree, [2])).toBeNull();
    expect(replaceIn(tree, [1, 1], rule('label', 'excludes', ['Bug'])).items[1]).toEqual(group('or', b, rule('label', 'excludes', ['Bug'])));
    expect(replaceIn(tree, [1, 0], null)).toEqual(group('and', a, group('or', c)));
    expect(replaceIn(replaceIn(tree, [1, 0], null), [1, 0], null)).toEqual(group('and', a));
  });
  test('adds at the end of a group and says where; switches a group or the top between all and any', () => {
    const added = appendIn(tree, [1], a);
    expect(added.path).toEqual([1, 2]);
    expect(nodeIn(added.group, [1, 2])).toEqual(a);
    expect(appendIn(tree, [], c).path).toEqual([2]);
    expect((nodeIn(joinIn(tree, [1], 'and'), [1]) as LinearFilterGroup).join).toBe('and');
    expect(joinIn(tree, [], 'or').join).toBe('or');
  });
  test('rules without values and empty groups are pruned', () => {
    expect(pruneFilters([a, rule('label', 'includesAny'), group('or', rule('status', 'is')), group('and', b)])).toEqual([a, group('and', b)]);
  });
});

describe("a saved view's filterData, read back", () => {
  const catalog: FilterCatalog = {
    workspaceId: 'org-a',
    teams: [{ id: 'team-har', key: 'HAR', name: 'Harness', states: [{ id: 'st-todo', name: 'Todo', type: 'unstarted', color: '#e2e2e2' }, { id: 'st-prog', name: 'In Progress', type: 'started', color: '#f2c94c' }] }],
    users: [{ id: 'u1', name: 'Me Myself', displayName: 'me', active: true, isMe: true }, { id: 'u2', name: 'Bo', displayName: 'bo', active: true }],
    labels: [{ id: 'lbl-bug', name: 'Bug', color: '#f00' }, { id: 'lbl-inc', name: 'Incident', color: '#fa0' }],
    projects: [{ id: 'p1', name: 'Planner', color: '#26b5ce' }],
    cycles: [{ id: 'c7', number: 7, name: null, team: { id: 'team-har', key: 'HAR' } }],
    milestones: [{ id: 'm1', name: 'Beta', project: { id: 'p1', name: 'Planner' } }],
  };
  const names = (nodes: LinearFilterNode[]) => nodes.map(describeNode);
  test('an "or" (as Linear saves it, by ids) is one group, its parts named from the workspace', () => {
    const filterData = { or: [{ priority: { eq: 1 } }, { and: [{ assignee: { isMe: { eq: true } } }, { labels: { some: { id: { in: ['lbl-bug'] } } } }] }] };
    const read = readFilter(filterData, [catalog], context);
    expect(names(read)).toEqual(['Any of 2 filters: Priority is Urgent or (Assignee is Me and Labels include Bug)']);
    expect(compileFilter(read, context)).toEqual({ or: [{ priority: { in: [1] } }, { and: [{ assignee: { isMe: { eq: true } } }, { labels: { some: { name: { in: ['Bug'] } } } }] }] });
  });
  test('an "and", and an object of several properties, open into top-level filters; ids become names', () => {
    expect(names(readFilter({ and: [{ team: { id: { eq: 'team-har' } } }, { state: { id: { in: ['st-todo', 'st-prog'] } } }] }, [catalog], context))).toEqual(['Team is Harness', 'Status is either of Todo, In Progress']);
    expect(names(readFilter({ project: { id: { in: ['p1'] } }, cycle: { isActive: { eq: true } } }, [catalog], context))).toEqual(['Project is Planner', 'Cycle is Current cycle']);
    expect(readFilter({}, [catalog], context)).toEqual([]);
    expect(readFilter(null, [catalog], context)).toEqual([]);
  });
  test('Linear’s other shapes: content, subscribers, relations, dates, estimates, milestones', () => {
    expect(names(readFilter({ and: [
      { searchableContent: { contains: 'login' } },
      { subscribers: { some: { isMe: { eq: true } } } },
      { hasBlockedByRelations: { eq: true } },
      { parent: { null: true } },
      { createdAt: { gt: '-P2W' } },
      { estimate: { gte: 3 } },
      { projectMilestone: { id: { in: ['m1'] } } },
      { creator: { id: { nin: ['u2'] } } },
    ] }, [catalog], context))).toEqual([
      'Content contains “login”',
      'Subscribers include Me',
      'Relations include Blocked by',
      'Relations do not include Parent issue',
      'Created date after 2 weeks ago',
      'Estimate is at least 3 points',
      'Milestone is Beta',
      'Creator is not Bo, No creator',
    ]);
  });
  test('what the Planner cannot edit is kept as it is, in words, and still sent', () => {
    const read = readFilter({ and: [{ state: { type: { nin: ['completed', 'canceled'] } } }, { slaStatus: { eq: 'Breached' } }, { state: { id: { in: ['st-unknown'] } } }] }, [catalog], context);
    expect(names(read)).toEqual(['Status type is not completed, canceled', 'SLA status is Breached', 'Status id is st-unknown']);
    expect(read.every(isRawFilter)).toBe(true);
    expect(compileFilter(read, context)).toEqual({ and: [{ state: { type: { nin: ['completed', 'canceled'] } } }, { slaStatus: { eq: 'Breached' } }, { state: { id: { in: ['st-unknown'] } } }] });
  });
  test('round trip: filters → IssueFilter → the same filters, for every property and nesting', () => {
    const value = (v: string, label = v) => ({ value: v, label });
    const cases: LinearFilterNode[][] = [
      [group('or', rule('priority', 'is', ['1', 'Urgent']), rule('assignee', 'is', ['@me', 'Me'])), rule('label', 'includesAny', ['Bug'])],
      [group('or', rule('status', 'is', ['Todo']), group('and', rule('assignee', 'isNot', ['u2', 'Bo']), rule('label', 'includesAll', ['Bug'], ['Incident'])))],
      [rule('assignee', 'is', ['u2', 'Bo'], ['@me', 'Me'], ['', 'No assignee']), rule('creator', 'isNot', ['u2', 'Bo'], ['', 'No creator'])],
      [rule('project', 'isNot', ['p1', 'Planner']), rule('cycle', 'isNot', ['c7', 'Cycle 7'], ['@active', 'Current cycle']), rule('cycle', 'is', ['c7', 'Cycle 7'], ['@next', 'Next cycle'])],
      [rule('milestone', 'is', ['m1', 'Beta'], ['', 'No milestone']), rule('team', 'isNot', ['team-har', 'Harness'])],
      [rule('content', 'contains', ['login']), rule('content', 'notContains', ['crash'])],
      [rule('subscriber', 'includesAny', ['u2', 'Bo'], ['@me', 'Me']), rule('subscriber', 'includesAll', ['u2', 'Bo'], ['@me', 'Me']), rule('subscriber', 'excludes', ['u2', 'Bo'])],
      [rule('relation', 'includesAny', ['blocked', 'Blocked by'], ['parent', 'Parent issue']), rule('relation', 'includesAll', ['blocking', 'Blocking'], ['children', 'Sub-issues']), rule('relation', 'excludes', ['related', 'Related'], ['duplicate', 'Duplicate'])],
      [rule('estimate', 'is', ['3', '3 points'], ['', 'No estimate']), rule('estimate', 'isNot', ['5', '5 points']), rule('estimate', 'atMost', ['8', '8 points'])],
      [rule('due', 'is', ['overdue', 'Overdue'], ['none', 'No due date']), rule('due', 'before', ['2026-11-02', 'November 2']), rule('created', 'after', ['-P1W', '1 week ago']), rule('completed', 'before', ['2026-10-01', 'October 1'])],
      [rule('label', 'excludes', ['Bug'], ['Incident']), rule('status', 'isNot', ['Todo'], ['In Progress'])],
    ];
    // Read back, values gain their workspace colors (labels, states, projects); the rest is the same.
    const uncolored = (nodes: LinearFilterNode[]) => JSON.parse(JSON.stringify(nodes, (key, item) => (key === 'color' ? undefined : item))) as LinearFilterNode[];
    for (const nodes of cases) {
      const filter = compileFilter(nodes, context);
      const back = readFilter(filter, [catalog], context);
      expect(uncolored(back)).toEqual(nodes);
      expect(compileFilter(back, context)).toEqual(filter);
    }
    expect(readFilter(compileFilter([rule('label', 'includesAny', ['Bug'])], context), [catalog], context)).toEqual([{ field: 'label', op: 'includesAny', values: [{ value: 'Bug', label: 'Bug', color: '#f00' }] }]);
    expect(value('x')).toEqual({ value: 'x', label: 'x' });
  });
  test('beyond a saved view: what was added while all of its own still hold', () => {
    const own = [rule('status', 'is', ['Todo']), group('or', rule('priority', 'is', ['1', 'Urgent']), rule('label', 'includesAny', ['Bug']))];
    const added = rule('assignee', 'is', ['@me', 'Me']);
    expect(beyondSaved([...own, added], 'and', own)).toEqual({ nodes: [added], match: 'and' });
    expect(beyondSaved(own, 'and', own)).toEqual({ nodes: [], match: 'and' });
    expect(beyondSaved([own[1]!, added], 'and', own)).toBeNull();
    expect(beyondSaved([...own, added], 'or', own)).toBeNull();
    expect(beyondSaved([added, own[0]!], 'or', [])).toEqual({ nodes: [added, own[0]], match: 'or' });
  });
});
