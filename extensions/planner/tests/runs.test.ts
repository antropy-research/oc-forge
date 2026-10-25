import { describe, expect, test } from 'bun:test';
import { applyEvents, foldEvents } from '../src/domain/reducer.ts';
import { isActive, needsYou, planAdoptions, planRunOutcomes, runStatus, taskChipId, taskPrompt, taskRunStatus, taskUrl, type LiveSession } from '../src/domain/runs.ts';
import { validateCommand, type EventBody, type PlannerEvent } from '../src/domain/events.ts';
import { branchFor } from '../panel/lib/agents.ts';
import { titleFromMessage } from '../panel/lib/background.ts';

let clock = Date.parse('2026-10-24T16:00:00Z');
const ev = (body: EventBody): PlannerEvent => {
  clock += 1000;
  return { v: 1, id: `e${clock}`, at: new Date(clock).toISOString(), ...body } as PlannerEvent;
};
const live = (patch: Partial<LiveSession> = {}): LiveSession => ({
  id: 'ses_1', title: 'Write tests', projectId: 'p1', directory: '/repo', activity: 'idle', outcome: null,
  updatedAt: Date.parse('2026-10-24T17:00:00Z'), archivedAt: null, worktree: null, items: [], ...patch,
});
const base = () =>
  foldEvents([
    ev({ type: 'task.created', task: { id: 't1', title: 'Write tests', notes: 'Cover the parser', placement: { kind: 'day', date: '2026-10-24' }, position: 1, subtasks: [{ id: 's1', title: 'Unit', done: false }, { id: 's2', title: 'Done one', done: true }] } }),
    ev({ type: 'run.started', run: { id: 'r1', taskId: 't1', sessionId: 'ses_1', projectId: 'p1', directory: '/repo', worktree: null, title: 'Write tests' } }),
  ]);

describe('run status', () => {
  const run = base().runs.r1!;
  test('live activity first, then what is left for the user', () => {
    expect(runStatus(run, live({ activity: 'running' }))).toBe('running');
    expect(runStatus(run, live({ activity: 'waiting-question' }))).toBe('question');
    expect(runStatus(run, live({ activity: 'waiting-permission' }))).toBe('permission');
    expect(runStatus(run, live({ outcome: 'completed' }))).toBe('review');
    expect(runStatus(run, live({ outcome: 'failed' }))).toBe('failed');
    expect(runStatus(run, live())).toBe('idle');
    expect(runStatus(run)).toBe('idle');
  });
  test('a finished turn is something to review, never done by itself', () => {
    expect(needsYou(runStatus(run, live({ outcome: 'completed' })))).toBe(true);
    expect(isActive('running')).toBe(true);
    expect(isActive('review')).toBe(false);
  });
  test('review verdicts and a stored outcome', () => {
    let state = applyEvents(base(), [ev({ type: 'run.outcome', runId: 'r1', outcome: 'completed' })]);
    expect(runStatus(state.runs.r1!)).toBe('review');
    state = applyEvents(state, [ev({ type: 'run.reviewed', runId: 'r1', verdict: 'changes' })]);
    expect(runStatus(state.runs.r1!)).toBe('changes');
    state = applyEvents(state, [ev({ type: 'run.outcome', runId: 'r1', outcome: 'completed' })]);
    expect(state.runs.r1!.review).toBeNull();
    state = applyEvents(state, [ev({ type: 'run.reviewed', runId: 'r1', verdict: 'accepted' })]);
    expect(runStatus(state.runs.r1!, live({ outcome: 'completed' }))).toBe('accepted');
    expect(runStatus(state.runs.r1!, live({ activity: 'running' }))).toBe('running');
  });
  test('a task shows its most urgent run', () => {
    const state = applyEvents(base(), [ev({ type: 'run.started', run: { id: 'r2', taskId: 't1', sessionId: 'ses_2', projectId: 'p1', directory: '/repo', worktree: null, title: 'Write tests' } })]);
    const sessions = new Map([['ses_1', live({ activity: 'running' })], ['ses_2', live({ id: 'ses_2', activity: 'waiting-question' })]]);
    expect(taskRunStatus(state, 't1', sessions)).toBe('question');
    expect(taskRunStatus(state, 'nope', sessions)).toBeNull();
  });
});

describe('recording', () => {
  test('settled outcomes are recorded once', () => {
    const state = base();
    expect(planRunOutcomes(state, new Map([['ses_1', live({ activity: 'running', outcome: 'completed' })]]))).toEqual([]);
    const bodies = planRunOutcomes(state, new Map([['ses_1', live({ outcome: 'completed' })]]));
    expect(bodies).toEqual([{ type: 'run.outcome', runId: 'r1', outcome: 'completed' }]);
    const after = applyEvents(state, bodies.map(ev));
    expect(planRunOutcomes(after, new Map([['ses_1', live({ outcome: 'completed' })]]))).toEqual([]);
  });
  test('a new result after changes were asked for is recorded again', () => {
    let state = applyEvents(base(), [ev({ type: 'run.outcome', runId: 'r1', outcome: 'completed' })]);
    state = applyEvents(state, [{ v: 1, id: 'rv', at: '2026-10-24T17:30:00.000Z', type: 'run.reviewed', runId: 'r1', verdict: 'changes' } as PlannerEvent]);
    expect(planRunOutcomes(state, new Map([['ses_1', live({ outcome: 'completed', updatedAt: Date.parse('2026-10-24T17:20:00Z') })]]))).toEqual([]);
    expect(planRunOutcomes(state, new Map([['ses_1', live({ outcome: 'completed', updatedAt: Date.parse('2026-10-24T17:45:00Z') })]]))).toHaveLength(1);
  });
  test('sessions carrying a task are adopted as runs', () => {
    const state = base();
    const sessions = [
      live({ id: 'ses_1', items: [{ id: 't1', data: { taskId: 't1', runId: 'r1' } }] }),
      live({ id: 'ses_9', projectId: 'p2', directory: '/other', items: [{ id: 't1', data: { taskId: 't1', runId: 'r9' } }], worktree: { directory: '/wt', branch: 'planner/x' } }),
      live({ id: 'ses_8', items: [{ id: 'today-2026-10-24', data: { kind: 'today' } }] }),
      live({ id: 'ses_7', items: [{ id: 't1' }] }),
    ];
    const bodies = planAdoptions(state, sessions);
    expect(bodies).toEqual([
      { type: 'run.started', run: { id: 'r9', taskId: 't1', sessionId: 'ses_9', projectId: 'p2', directory: '/other', worktree: { directory: '/wt', branch: 'planner/x' }, title: 'Write tests' } },
      { type: 'run.started', run: { id: 'adopt-ses_7', taskId: 't1', sessionId: 'ses_7', projectId: 'p1', directory: '/repo', worktree: null, title: 'Write tests' } },
    ]);
  });
});

describe('validation and helpers', () => {
  const state = base();
  test('run commands', () => {
    expect(validateCommand({ cmd: 'a', type: 'run.started', run: { id: 'r1', taskId: 't1', sessionId: 's', projectId: null, directory: null, worktree: null, title: 'x' } }, state)).toBe('run id already exists');
    expect(validateCommand({ cmd: 'b', type: 'run.started', run: { id: 'r5', taskId: 'zz', sessionId: 's', projectId: null, directory: null, worktree: null, title: 'x' } }, state)).toBe('unknown task');
    expect(validateCommand({ cmd: 'c', type: 'run.outcome', runId: 'r1', outcome: 'done' }, state)).toBe('outcome must be completed or failed');
    expect(validateCommand({ cmd: 'd', type: 'run.reviewed', runId: 'r1', verdict: 'accepted', note: 'Looks good' }, state)).toBeNull();
    expect(validateCommand({ cmd: 'e', type: 'task.created', task: { id: 't9', title: 'From chat', placement: { kind: 'day', date: '2026-10-24' }, position: 1, sessionRef: { sessionId: 'ses_1', title: 'Chat', directory: null } } }, state)).toBeNull();
  });
  test('prompt, url, branch and message titles', () => {
    expect(taskPrompt(state, 't1')).toBe('Write tests\n\nCover the parser\n\nChecklist:\n- [ ] Unit');
    expect(taskUrl(state, 't1')).toBe('https://planner.invalid/tasks/t1');
    expect(taskChipId(state, 'abcdef1234')).toBe('PLN-1234');
    expect(branchFor('Fix the flaky login test!', 'abc123def')).toBe('planner/fix-the-flaky-login-test');
    expect(branchFor('预约 hk 诊所', 'abc123def')).toBe('planner/task-123def');
    expect(titleFromMessage('\n## Next steps\n- [ ] Add retries to the **sync** job\n')).toBe('Next steps');
    expect(titleFromMessage('- Add retries')).toBe('Add retries');
    expect(titleFromMessage('x'.repeat(200)).length).toBe(120);
  });
});
