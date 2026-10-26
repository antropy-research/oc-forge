// The Sunsama panel's day targets, the plan actions' words, and where popovers go.
import { describe, expect, test } from 'bun:test';
import { boardTargets, planningTargets, quickDays, todayTargets } from '../panel/lib/dayTargets.ts';
import { dayPhrase, shortDay } from '../panel/components/PlanActions.tsx';
import { placeBeside } from '../panel/lib/popover.ts';
import { assignBranch } from '../panel/lib/agents.ts';
import { foldEvents } from '../src/domain/reducer.ts';
import type { PlannerEvent } from '../src/domain/events.ts';

const days = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'];

describe('day targets', () => {
  test('Home offers every visible column, today first, then the next one as a button', () => {
    const targets = boardTargets(days, '2026-10-26');
    expect(targets).toEqual({ days, primary: '2026-10-26' });
    expect(quickDays(targets)).toEqual(['2026-10-26', '2026-10-27']);
    // Scrolled past today: the first column on screen leads.
    const later = boardTargets(days.slice(2), '2026-10-26');
    expect(later.primary).toBe('2026-10-28');
    expect(quickDays(later)).toEqual(['2026-10-28', '2026-10-29']);
  });

  test('Today plans today, with tomorrow a click away', () => {
    expect(quickDays(todayTargets('2026-10-26'))).toEqual(['2026-10-26', '2026-10-27']);
  });

  test('daily planning adds every item to the day being planned, tomorrow after 3 PM', () => {
    expect(planningTargets('2026-10-27')).toEqual({ days: ['2026-10-27'], primary: '2026-10-27' });
    expect(quickDays(planningTargets('2026-10-27'))).toEqual(['2026-10-27']);
  });

  test('buttons say Today, Tmrw or the weekday; labels read the day out', () => {
    expect(['2026-10-26', '2026-10-27', '2026-10-28'].map((day) => shortDay(day, '2026-10-26'))).toEqual(['Today', 'Tmrw', 'Wed 28']);
    expect(dayPhrase('2026-10-27', '2026-10-26')).toBe('tomorrow');
    expect(dayPhrase('2026-10-28', '2026-10-26')).toBe('on Wednesday, October 28');
  });
});

describe('popover placement', () => {
  const view = { width: 1000, height: 850 };
  test('below its button when it fits, else above, never over the button', () => {
    expect(placeBeside({ top: 100, bottom: 120, left: 600, right: 660 }, 300, 400, view, 'right')).toEqual({ left: 360, top: 124, maxHeight: null });
    expect(placeBeside({ top: 700, bottom: 720, left: 100, right: 160 }, 300, 400, view, 'left')).toEqual({ left: 100, top: 296, maxHeight: null });
  });
  test('too tall for either side: the roomier side, capped to it', () => {
    const place = placeBeside({ top: 450, bottom: 475, left: 100, right: 160 }, 300, 460, view, 'left');
    expect(place).toEqual({ left: 100, top: 8, maxHeight: 438 });
    expect(place.top + place.maxHeight!).toBeLessThanOrEqual(450);
  });
  test('kept inside the window sideways', () => {
    expect(placeBeside({ top: 100, bottom: 120, left: 10, right: 40 }, 300, 200, view, 'right').left).toBe(8);
    expect(placeBeside({ top: 100, bottom: 120, left: 900, right: 950 }, 300, 200, view, 'left').left).toBe(692);
  });
});

describe('assignment branches', () => {
  test("Linear's branch name, else the title; a new one when an earlier run used it", () => {
    let clock = Date.parse('2026-10-26T16:00:00Z');
    const ev = (body: Record<string, unknown>) => ({ v: 1, id: `e${(clock += 1000)}`, at: new Date(clock).toISOString(), ...body }) as PlannerEvent;
    const state = foldEvents([
      ev({ type: 'task.created', task: { id: 't1', title: 'Fix the login', placement: { kind: 'day', date: '2026-10-26' }, position: 1 } }),
      ev({ type: 'task.created', task: { id: 't2', title: 'x', placement: { kind: 'day', date: '2026-10-26' }, position: 2, source: { kind: 'linear', id: 'i', key: 'NEX-7', url: 'https://linear.app/a/issue/NEX-7', branch: 'me/nex-7-fix' } } }),
    ]);
    expect(assignBranch(state, 't1')).toBe('planner/fix-the-login');
    expect(assignBranch(state, 't2')).toBe('me/nex-7-fix');
    const used = foldEvents([
      ...[ev({ type: 'task.created', task: { id: 't1', title: 'Fix the login', placement: { kind: 'day', date: '2026-10-26' }, position: 1 } })],
      ev({ type: 'run.started', run: { id: 'r1', taskId: 't1', sessionId: 's1', projectId: 'p', directory: '/p', worktree: { directory: '/w1', branch: 'planner/fix-the-login' }, title: 'Fix the login' } }),
      ev({ type: 'run.started', run: { id: 'r2', taskId: 't1', sessionId: 's2', projectId: 'p', directory: '/p', worktree: { directory: '/w2', branch: 'planner/fix-the-login-2' }, title: 'Fix the login' } }),
    ]);
    expect(assignBranch(used, 't1')).toBe('planner/fix-the-login-3');
  });
});
