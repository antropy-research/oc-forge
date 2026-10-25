import { describe, expect, test } from 'bun:test';
import { assistantContext, describeOp, readAssistantAnswer, whenToPlacement } from '../src/domain/assistant.ts';
import { foldEvents } from '../src/domain/reducer.ts';
import type { EventBody, PlannerEvent } from '../src/domain/events.ts';

let clock = Date.parse('2026-10-24T16:00:00Z');
const ev = (body: EventBody): PlannerEvent => ({ v: 1, id: `e${(clock += 1000)}`, at: new Date(clock).toISOString(), ...body }) as PlannerEvent;
const state = foldEvents([
  ev({ type: 'channel.created', channel: { id: 'work', name: 'work', color: '#e8590c', context: 'work' } }),
  ev({ type: 'task.created', task: { id: 'gym1', title: 'Gym', placement: { kind: 'day', date: '2026-10-24' }, position: 1, plannedMinutes: 60 } }),
  ev({ type: 'task.created', task: { id: 'rep1', title: 'Weekly report', placement: { kind: 'backlog', bucket: 'next-weeks' }, position: 1, channelId: 'work' } }),
]);
const today = '2026-10-24';

describe('Ask Planner', () => {
  test('the context lists tasks with ids by day and bucket', () => {
    const context = assistantContext(state, today);
    expect(context).toContain('Today (2026-10-24):\n- [gym1] Gym (1:00)');
    expect(context).toContain('Tomorrow (2026-10-25):\n(nothing planned)');
    expect(context).toContain('(next-weeks):\n- [rep1] Weekly report (#work)');
  });
  test('only known operations on known tasks survive', () => {
    const answer = `Sure! {"reply":"Moved the gym.","ops":[
      {"op":"move","taskId":"gym1","when":"tomorrow"},
      {"op":"move","taskId":"ghost","when":"tomorrow"},
      {"op":"delete","taskId":"rep1"},
      {"op":"create","title":"Stretch","when":"today","minutes":10,"channel":"WORK"},
      {"op":"estimate","taskId":"rep1","minutes":45},
      {"op":"channel","taskId":"gym1","channel":"nope"},
      {"op":"move","taskId":"rep1","when":"someday"}
    ]}`;
    const parsed = readAssistantAnswer(answer, state, today)!;
    expect(parsed.reply).toBe('Moved the gym.');
    expect(parsed.ops).toEqual([
      { op: 'move', taskId: 'gym1', when: 'tomorrow' },
      { op: 'create', title: 'Stretch', when: 'today', minutes: 10, channel: 'work' },
      { op: 'estimate', taskId: 'rep1', minutes: 45 },
      { op: 'move', taskId: 'rep1', when: 'someday' },
    ]);
    expect(parsed.ops.map((op) => describeOp(state, op, today))).toEqual([
      'Move "Gym" to tomorrow',
      'Add "Stretch" for today (0:10) in #work',
      'Plan 0:45 for "Weekly report"',
      'Move "Weekly report" to someday',
    ]);
    expect(readAssistantAnswer('no json', state, today)).toBeNull();
    expect(readAssistantAnswer('{"reply":"Nothing to do."}', state, today)).toEqual({ reply: 'Nothing to do.', ops: [] });
  });
  test('when words', () => {
    expect(whenToPlacement('2026-10-30', today)).toEqual({ kind: 'day', date: '2026-10-30' });
    expect(whenToPlacement('next-month', today)).toEqual({ kind: 'backlog', bucket: 'next-month' });
    expect(whenToPlacement('later', today)).toBeNull();
  });
});
