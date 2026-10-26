import { describe, expect, test } from 'bun:test';
import {
  compileFilter,
  compileRule,
  describeRule,
  filterChoices,
  matchesRules,
  operatorsFor,
  searchChoices,
  toggleValue,
  withOperator,
  workspacesFor,
  type FilterCatalog,
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
    expect(compileRule(rule('cycle', 'is', ['@active', 'Current cycle']), context)).toEqual({ or: [{ cycle: { isActive: { eq: true } } }] });
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
  test('people: active members, me first; nobody first for assignees', () => {
    expect(filterChoices('assignee', [catalog]).map((option) => `${option.label}${option.hint ? ` (${option.hint})` : ''}`)).toEqual(['No assignee', 'Me Myself (You)', 'Bo (bo)']);
    expect(filterChoices('creator', [catalog]).map((option) => option.value)).toEqual(['u1', 'u2']);
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
