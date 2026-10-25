import { describe, expect, test } from 'bun:test';
import { applyEvents, foldEvents } from '../src/domain/reducer.ts';
import { completedOnDay, highlightItems, objectiveByText, objectivesForWeek, planningDate, planningWeek, ritualRecord, tasksForObjective, timeByChannel } from '../src/domain/rituals.ts';
import { validateCommand, type EventBody, type PlannerEvent } from '../src/domain/events.ts';

let clock = Date.parse('2026-10-24T16:00:00Z');
const ev = (body: EventBody): PlannerEvent => {
  clock += 1000;
  return { v: 1, id: `e${clock}`, at: new Date(clock).toISOString(), ...body } as PlannerEvent;
};

const base = () =>
  foldEvents([
    ev({ type: 'channel.created', channel: { id: 'work', name: 'work', color: '#e8590c', context: 'work' } }),
    ev({ type: 'objective.created', objective: { id: 'o1', weekStart: '2026-10-19', title: 'Ship the planner', carriedFrom: null } }),
    ev({ type: 'objective.created', objective: { id: 'o2', weekStart: '2026-10-19', title: 'Read two papers', carriedFrom: null } }),
    ev({ type: 'task.created', task: { id: 't1', title: 'Rituals UI', placement: { kind: 'day', date: '2026-10-24' }, position: 1, plannedMinutes: 60, channelId: 'work', objectiveId: 'o1' } }),
    ev({ type: 'task.created', task: { id: 't2', title: 'Paper A', placement: { kind: 'day', date: '2026-10-24' }, position: 2, plannedMinutes: 45, objectiveId: 'o2' } }),
  ]);

describe('objectives', () => {
  test('week list, alignment and completion', () => {
    let state = base();
    expect(objectivesForWeek(state, '2026-10-19').map((objective) => objective.id)).toEqual(['o1', 'o2']);
    expect(tasksForObjective(state, 'o1').map((task) => task.id)).toEqual(['t1']);
    state = applyEvents(state, [ev({ type: 'objective.updated', objectiveId: 'o1', patch: { completed: true, title: ' Ship it ' } })]);
    expect(state.objectives.o1).toMatchObject({ title: 'Ship it' });
    expect(state.objectives.o1!.completedAt).not.toBeNull();
  });
  test('deleting an objective keeps its tasks', () => {
    const state = applyEvents(base(), [ev({ type: 'objective.deleted', objectiveId: 'o2' })]);
    expect(objectivesForWeek(state, '2026-10-19').map((objective) => objective.id)).toEqual(['o1']);
    expect(state.tasks.t2).toMatchObject({ objectiveId: null, deletedAt: null });
  });
  test('continuing into the next week links back', () => {
    const state = applyEvents(base(), [ev({ type: 'objective.created', objective: { id: 'o3', weekStart: '2026-10-26', title: 'Ship the planner', carriedFrom: 'o1' } })]);
    expect(objectivesForWeek(state, '2026-10-26')[0]).toMatchObject({ carriedFrom: 'o1' });
  });
  test('$text finds the week objective', () => {
    const state = base();
    expect(objectiveByText(state, '2026-10-19', 'ship')?.id).toBe('o1');
    expect(objectiveByText(state, '2026-10-19', 'two-papers')?.id).toBe('o2');
    expect(objectiveByText(state, '2026-10-19', 'nothing')).toBeNull();
    expect(objectiveByText(state, '2026-10-26', 'ship')).toBeNull();
  });
});

describe('ritual records', () => {
  test('saves merge field by field', () => {
    let state = applyEvents(base(), [ev({ type: 'ritual.saved', ritual: 'planning', date: '2026-10-24', fields: { obstacles: 'meetings' } })]);
    state = applyEvents(state, [ev({ type: 'ritual.saved', ritual: 'planning', date: '2026-10-24', fields: { completedAt: '2026-10-24T16:30:00.000Z' } })]);
    expect(ritualRecord(state, 'planning', '2026-10-24')).toEqual({ obstacles: 'meetings', completedAt: '2026-10-24T16:30:00.000Z' });
    expect(ritualRecord(state, 'shutdown', '2026-10-24')).toEqual({});
  });
  test('validation', () => {
    const state = base();
    expect(validateCommand({ cmd: 'a', type: 'ritual.saved', ritual: 'planning', date: '2026-10-24', fields: { reflection: 'x' } }, state)).toBe('planning has no field reflection');
    expect(validateCommand({ cmd: 'b', type: 'ritual.saved', ritual: 'party', date: '2026-10-24', fields: {} }, state)).toBe('unknown ritual');
    expect(validateCommand({ cmd: 'c', type: 'ritual.saved', ritual: 'highlights', date: '2026-10-24', fields: { items: [{ id: 'h1', text: 'Shipped', taskId: null, starred: true }] } }, state)).toBeNull();
    expect(validateCommand({ cmd: 'd', type: 'ritual.saved', ritual: 'highlights', date: '2026-10-24', fields: { items: [{ id: 'h1', text: '', taskId: null, starred: true }] } }, state)).toBe('a highlight is invalid');
    expect(validateCommand({ cmd: 'e', type: 'task.updated', taskId: 't1', patch: { objectiveId: 'zzz' } }, state)).toBe('unknown objective');
    expect(validateCommand({ cmd: 'f', type: 'objective.created', objective: { id: 'o9', weekStart: '2026-10-26', title: 'Next', carriedFrom: 'nope' } }, state)).toBe('unknown objective to continue');
  });
});

describe('review read models', () => {
  test('completed on a day and time by channel', () => {
    const state = applyEvents(base(), [
      ev({ type: 'task.completed', taskId: 't1', on: '2026-10-24' }),
      ev({ type: 'task.completed', taskId: 't2', on: '2026-10-24' }),
    ]);
    const done = completedOnDay(state, '2026-10-24');
    expect(done.map((task) => task.id)).toEqual(['t1', 't2']);
    expect(timeByChannel(state, done)).toEqual([{ channelId: 'work', minutes: 60 }, { channelId: null, minutes: 45 }]);
  });
  test('planning dates', () => {
    expect(planningDate('2026-10-24', 14 * 60 + 59)).toBe('2026-10-24');
    expect(planningDate('2026-10-24', 15 * 60)).toBe('2026-10-25');
    const state = base();
    expect(planningWeek(state, '2026-10-20')).toBe('2026-10-19');
    expect(planningWeek(state, '2026-10-24')).toBe('2026-10-26');
  });
});

describe('highlights merge', () => {
  test('saved items, newly completed tasks, deleted and hidden items', () => {
    let state = applyEvents(base(), [ev({ type: 'task.completed', taskId: 't1', on: '2026-10-24' })]);
    expect(highlightItems(state, '2026-10-24').map((item) => item.id)).toEqual(['t1']);
    state = applyEvents(state, [ev({ type: 'ritual.saved', ritual: 'highlights', date: '2026-10-24', fields: { items: [{ id: 't1', text: 'Rituals UI', taskId: 't1', starred: true }, { id: 'x', text: 'Mentoring', taskId: null, starred: false }] } })]);
    state = applyEvents(state, [ev({ type: 'task.completed', taskId: 't2', on: '2026-10-24' })]);
    expect(highlightItems(state, '2026-10-24').map((item) => item.id)).toEqual(['t1', 'x', 't2']);
    state = applyEvents(state, [ev({ type: 'ritual.saved', ritual: 'highlights', date: '2026-10-24', fields: { items: [...highlightItems(state, '2026-10-24').map((item) => (item.id === 't2' ? { ...item, hidden: true } : item))] } })]);
    expect(highlightItems(state, '2026-10-24').filter((item) => !item.hidden).map((item) => item.id)).toEqual(['t1', 'x']);
    state = applyEvents(state, [ev({ type: 'task.deleted', taskId: 't1' })]);
    expect(highlightItems(state, '2026-10-24').filter((item) => !item.hidden).map((item) => item.id)).toEqual(['x']);
  });
});
