import { describe, expect, test } from 'bun:test';
import { applyEvents, foldEvents } from '../src/domain/reducer.ts';
import { planRollover } from '../src/domain/rollover.ts';
import { suggestFor, titleTokens } from '../src/domain/suggest.ts';
import { parseBraindump, readBraindumpAnswer } from '../src/domain/braindump.ts';
import { validateCommand, type EventBody, type PlannerEvent } from '../src/domain/events.ts';

let clock = Date.parse('2026-10-20T16:00:00Z');
const ev = (body: EventBody): PlannerEvent => {
  clock += 1000;
  return { v: 1, id: `e${clock}`, at: new Date(clock).toISOString(), ...body } as PlannerEvent;
};
const day = (date: string) => ({ kind: 'day' as const, date });

describe('history suggestions', () => {
  const state = foldEvents([
    ev({ type: 'channel.created', channel: { id: 'work', name: 'work', color: '#e8590c', context: 'work' } }),
    ev({ type: 'channel.created', channel: { id: 'personal', name: 'personal', color: '#1c7ed6', context: 'personal' } }),
    ev({ type: 'task.created', task: { id: 'a', title: 'Write weekly report', placement: day('2026-10-13'), position: 1, plannedMinutes: 60, channelId: 'work' } }),
    ev({ type: 'time.logged', entry: { id: 'x', taskId: 'a', start: '2026-10-13T16:00:00.000Z', end: '2026-10-13T16:40:00.000Z' } }),
    ev({ type: 'task.completed', taskId: 'a', on: '2026-10-13' }),
    ev({ type: 'task.created', task: { id: 'b', title: 'Write the weekly report', placement: day('2026-10-20'), position: 2, plannedMinutes: 30, channelId: 'work' } }),
    ev({ type: 'task.created', task: { id: 'c', title: '预约 hk 诊所', placement: day('2026-10-20'), position: 3, plannedMinutes: 15, channelId: 'personal' } }),
  ]);
  test('tokens', () => {
    expect([...titleTokens('Write the weekly report!')]).toEqual(['write', 'weekly', 'report']);
    expect([...titleTokens('预约诊所')]).toEqual(['预约', '约诊', '诊所']);
  });
  test('tracked time of done tasks and planned time of open ones, the usual channel', () => {
    expect(suggestFor(state, 'write weekly report')).toEqual({ minutes: 35, channelId: 'work', basis: 2 });
    expect(suggestFor(state, '预约诊所 hk')).toMatchObject({ minutes: 15, channelId: 'personal' });
    expect(suggestFor(state, 'Plan the offsite')).toBeNull();
    expect(suggestFor(state, 'write weekly report', 'b')).toEqual({ minutes: 40, channelId: 'work', basis: 1 });
  });
});

describe('braindump', () => {
  const fallback = { kind: 'backlog' as const, bucket: 'next-weeks' as const };
  test('lines become tasks, syntax honored', () => {
    const items = parseBraindump('- call the bank ~15m @tomorrow\n\n2. renew passport #personal\n* [ ] fix CI !high', '2026-10-24', 1, fallback);
    expect(items).toEqual([
      { title: 'call the bank', plannedMinutes: 15, placement: day('2026-10-25'), channel: null, priority: null },
      { title: 'renew passport', plannedMinutes: null, placement: fallback, channel: 'personal', priority: null },
      { title: 'fix CI', plannedMinutes: null, placement: fallback, channel: null, priority: 'high' },
    ]);
  });
  test('a model answer is read strictly', () => {
    const answer = 'Here you go:\n[{"title":"Call the bank","minutes":15,"when":"tomorrow","channel":"Personal"},{"title":"","minutes":5},{"title":"Fix CI","minutes":9999,"when":"next-month","channel":"ops","priority":"high"}]';
    expect(readBraindumpAnswer(answer, '2026-10-24', fallback, ['work', 'personal'])).toEqual([
      { title: 'Call the bank', plannedMinutes: 15, placement: day('2026-10-25'), channel: 'personal', priority: null },
      { title: 'Fix CI', plannedMinutes: null, placement: { kind: 'backlog', bucket: 'next-month' }, channel: null, priority: 'high' },
    ]);
    expect(readBraindumpAnswer('no json here', '2026-10-24', fallback, [])).toBeNull();
    expect(readBraindumpAnswer('[1, 2]', '2026-10-24', fallback, [])).toBeNull();
  });
});

describe('folders', () => {
  test('create, assign, delete keeps the tasks', () => {
    let state = foldEvents([
      ev({ type: 'folder.created', folder: { id: 'f1', name: ' Reading ' } }),
      ev({ type: 'task.created', task: { id: 't', title: 'Paper', placement: { kind: 'backlog', bucket: 'someday' }, position: 1, folderId: 'f1' } }),
    ]);
    expect(state.folders.f1!.name).toBe('Reading');
    expect(state.tasks.t!.folderId).toBe('f1');
    expect(validateCommand({ cmd: 'a', type: 'task.updated', taskId: 't', patch: { folderId: 'nope' } }, state)).toBe('unknown folder');
    state = applyEvents(state, [ev({ type: 'folder.deleted', folderId: 'f1' })]);
    expect(state.tasks.t).toMatchObject({ folderId: null, deletedAt: null });
    expect(validateCommand({ cmd: 'b', type: 'task.updated', taskId: 't', patch: { folderId: 'f1' } }, state)).toBe('unknown folder');
  });
});

describe('rollover from two replicas', () => {
  test('the same day rolled over twice moves and counts once', () => {
    const state = foldEvents([
      ev({ type: 'settings.updated', patch: { archiveAfterRollovers: null } }),
      ev({ type: 'task.created', task: { id: 't', title: 'Carry', placement: day('2026-10-22'), position: 1 } }),
    ]);
    const body = planRollover(state, '2026-10-24')!;
    const twice = applyEvents(state, [ev(body), ev(body)]);
    expect(twice.tasks.t).toMatchObject({ placement: day('2026-10-24'), rolloverCount: 2 });
  });
});
