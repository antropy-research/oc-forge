import { describe, expect, test } from 'bun:test';
import { applyEvents, foldEvents } from '../src/domain/reducer.ts';
import { assignPrompt, isActive, needsYou, planAdoptions, planPullRequests, planRunOutcomes, pullRequestLookups, runStatus, taskChipId, taskPrompt, taskPullRequest, taskRunStatus, taskUrl, type LiveSession } from '../src/domain/runs.ts';
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

describe('assigned to an agent, with a pull request', () => {
  const pr = { number: 12, url: 'https://github.com/acme/app/pull/12', state: 'open' as const, draft: true, title: 'Write tests', repo: 'acme/app' };
  const assigned = () =>
    applyEvents(base(), [ev({ type: 'run.started', run: { id: 'r2', taskId: 't1', sessionId: 'ses_2', projectId: 'p1', directory: '/repo', worktree: { directory: '/repo-wt/write-tests', branch: 'planner/write-tests' }, title: 'Write tests', wantsPr: true } })]);
  test('the assignment prompt asks for a pull request that links the issue', () => {
    const plain = assignPrompt(assigned(), 't1', 'planner/write-tests');
    expect(plain.startsWith(taskPrompt(assigned(), 't1'))).toBe(true);
    expect(plain).toContain('branch `planner/write-tests`');
    expect(plain).toContain('gh pr create');
    expect(plain).not.toContain('Closes');
    const linear = applyEvents(assigned(), [ev({ type: 'task.updated', taskId: 't1', patch: { source: { kind: 'linear', id: 'iss', key: 'NEX-7', url: 'https://linear.app/a/issue/NEX-7' } } })]);
    expect(assignPrompt(linear, 't1', 'nex-7')).toContain('Mention NEX-7 in the description');
    const issue = applyEvents(assigned(), [ev({ type: 'task.updated', taskId: 't1', patch: { source: { kind: 'github', id: 'I_1', key: 'acme/app#3', url: 'https://github.com/acme/app/issues/3' } } })]);
    expect(assignPrompt(issue, 't1', 'b')).toContain('"Closes acme/app#3"');
    const review = applyEvents(assigned(), [ev({ type: 'task.updated', taskId: 't1', patch: { source: { kind: 'github', id: 'PR_1', key: 'acme/app#4', url: 'https://github.com/acme/app/pull/4' } } })]);
    expect(assignPrompt(review, 't1', 'b')).not.toContain('Closes');
  });
  test('runs with a worktree branch are looked up until their pull request is merged or closed', () => {
    let state = assigned();
    const now = Date.parse(state.runs.r2!.startedAt) + 60_000;
    expect(pullRequestLookups(state, now)).toEqual([{ runId: 'r2', branch: 'planner/write-tests', directories: ['/repo-wt/write-tests', '/repo'] }]);
    const found = planPullRequests(state, new Map([['r2', pr]]));
    expect(found).toEqual([{ type: 'run.pullRequest', runId: 'r2', taskId: 't1', pullRequest: pr }]);
    state = applyEvents(state, found.map(ev));
    expect(state.runs.r2!.pullRequest).toMatchObject({ ...pr, seenAt: expect.any(String) });
    expect(taskPullRequest(state, 't1')?.number).toBe(12);
    // Seen and unchanged: nothing to record; still open, so still looked up.
    expect(planPullRequests(state, new Map([['r2', pr]]))).toEqual([]);
    expect(pullRequestLookups(state, now)).toHaveLength(1);
    state = applyEvents(state, planPullRequests(state, new Map([['r2', { ...pr, state: 'merged', draft: false }]])).map(ev));
    expect(state.runs.r2!.pullRequest?.state).toBe('merged');
    expect(pullRequestLookups(state, now)).toEqual([]);
    expect(pullRequestLookups(assigned(), now + 31 * 86_400_000)).toEqual([]);
  });
  test('an assignment adopted from the session list before its start was written stays an assignment', () => {
    const session = live({ id: 'ses_9', worktree: { directory: '/repo-wt/x', branch: 'planner/x' }, items: [{ id: 'PLN-0001', data: { taskId: 't1', runId: 'r9', wantsPr: true } }] });
    const [adopted] = planAdoptions(base(), [session]);
    expect(adopted).toMatchObject({ type: 'run.started', run: { id: 'r9', taskId: 't1', wantsPr: true, worktree: { branch: 'planner/x' } } });
    const plain = planAdoptions(base(), [live({ id: 'ses_8', items: [{ id: 'PLN-0001', data: { taskId: 't1', runId: 'r8' } }] })])[0] as { run: Record<string, unknown> };
    expect('wantsPr' in plain.run).toBe(false);
  });
  test('the log only takes a well-formed pull request, for that run and its task', () => {
    const state = assigned();
    expect(validateCommand({ cmd: 'p1', type: 'run.pullRequest', runId: 'r2', taskId: 't1', pullRequest: pr }, state)).toBeNull();
    expect(validateCommand({ cmd: 'p2', type: 'run.pullRequest', runId: 'r2', taskId: 't9', pullRequest: pr }, state)).toContain('taskId');
    expect(validateCommand({ cmd: 'p3', type: 'run.pullRequest', runId: 'r2', taskId: 't1', pullRequest: { ...pr, url: 'https://evil.example/acme/app/pull/12' } }, state)).toBe('pullRequest is invalid');
    expect(validateCommand({ cmd: 'p4', type: 'run.pullRequest', runId: 'r2', taskId: 't1', pullRequest: { ...pr, state: 'draft' } }, state)).toBe('pullRequest is invalid');
    expect(validateCommand({ cmd: 'p5', type: 'run.pullRequest', runId: 'nope', taskId: 't1', pullRequest: pr }, state)).toBe('unknown run');
    expect(validateCommand({ cmd: 'p6', type: 'run.started', run: { id: 'r3', taskId: 't1', sessionId: 's', projectId: null, directory: null, worktree: null, title: 'x', wantsPr: 'yes' } }, state)).toBe('wantsPr must be true or false');
    expect(state.runs.r2!.wantsPr).toBe(true);
  });
});
