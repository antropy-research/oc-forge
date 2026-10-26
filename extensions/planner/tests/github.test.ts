import { describe, expect, test } from 'bun:test';
import { GitHubSource, LISTS, NODES_QUERY, parseNodes, type Runner } from '../service/github.ts';
import { githubSource, githubStatus, isGitHubItem, planGitHubSync, shortKey, taskFromGitHub, type GitHubItem } from '../src/domain/github.ts';
import { applyEvents, foldEvents } from '../src/domain/reducer.ts';
import type { EventBody, PlannerEvent } from '../src/domain/events.ts';

const node = (patch: Record<string, unknown> = {}) => ({
  __typename: 'Issue', id: 'I_1', number: 42, title: 'Crash on start', url: 'https://github.com/acme/app/issues/42', state: 'OPEN', updatedAt: '2026-10-24T10:00:00Z', repository: { nameWithOwner: 'acme/app' }, ...patch,
});
const item = (patch: Partial<GitHubItem> = {}): GitHubItem => ({ ...parseNodes([node()])[0]!, ...patch });

describe('gh', () => {
  test('missing CLI and logged-out CLI are explained', async () => {
    const missing: Runner = async () => { throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }); };
    expect(await new GitHubSource(missing).status()).toEqual({ available: false, login: null, message: 'The GitHub CLI (gh) is not installed on the machine running OpenChamber.' });
    const loggedOut: Runner = async () => { throw Object.assign(new Error('exit 4'), { code: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login' }); };
    expect((await new GitHubSource(loggedOut).status()).message).toContain('gh auth login');
  });
  test('lists and node reads pass the right arguments', async () => {
    const calls: string[][] = [];
    const runner: Runner = async (args) => {
      calls.push(args);
      if (args[1] === 'user') return 'qihang-zhang\n';
      return JSON.stringify(args.some((arg) => arg.startsWith('ids[]')) ? { data: { nodes: [node({ state: 'CLOSED' }), null] } } : { data: { search: { nodes: [node(), node({ __typename: 'PullRequest', id: 'PR_1', number: 7, isDraft: true, url: 'https://github.com/acme/app/pull/7' })] } } });
    };
    const source = new GitHubSource(runner);
    expect(await source.status()).toEqual({ available: true, login: 'qihang-zhang', message: null });
    const review = await source.list('review');
    expect(calls[1]).toContain(`q=${LISTS.review}`);
    expect(review.map((entry) => [entry.kind, entry.key, entry.draft])).toEqual([['issue', 'acme/app#42', false], ['pull', 'acme/app#7', true]]);
    const linked = await source.items(['I_1', 'PR_1']);
    expect(calls[2]).toEqual(['api', 'graphql', '-f', `query=${NODES_QUERY}`, '-f', 'ids[]=I_1', '-f', 'ids[]=PR_1']);
    expect(linked.map((entry) => entry.state)).toEqual(['CLOSED']);
    expect(await source.items([])).toEqual([]);
  });
});

describe('mapping and sync', () => {
  test('state looks and keys', () => {
    expect(githubStatus(item())).toMatchObject({ name: 'Open', type: 'open' });
    expect(githubStatus(item({ draft: true }))).toMatchObject({ name: 'Draft', type: 'open' });
    expect(githubStatus(item({ state: 'MERGED' }))).toMatchObject({ name: 'Merged', type: 'completed' });
    expect(githubStatus(item({ state: 'CLOSED' }))).toMatchObject({ name: 'Closed', type: 'completed' });
    expect(shortKey('acme/app#42')).toBe('app#42');
    expect(isGitHubItem(item())).toBe(true);
    expect(isGitHubItem({ ...item(), url: 'javascript:alert(1)' })).toBe(false);
  });
  test('a merged PR updates its task; a renamed task keeps its title', () => {
    let clock = Date.parse('2026-10-24T16:00:00Z');
    const ev = (body: EventBody): PlannerEvent => ({ v: 1, id: `e${(clock += 1000)}`, at: new Date(clock).toISOString(), ...body }) as PlannerEvent;
    const pr = item({ id: 'PR_1', kind: 'pull', key: 'acme/app#7', title: 'Add retries', url: 'https://github.com/acme/app/pull/7' });
    let state = foldEvents([ev({ type: 'task.created', task: taskFromGitHub(pr, 't', { kind: 'day', date: '2026-10-24' }, 1) })]);
    expect(state.tasks.t!.source).toEqual(githubSource(pr));
    const merged = { ...pr, state: 'MERGED', title: 'Add retries to sync' };
    const bodies = planGitHubSync(state, new Map([['PR_1', merged]]));
    expect(bodies).toEqual([{ type: 'task.sourceSynced', taskId: 't', source: githubSource(merged), title: 'Add retries to sync' }]);
    state = applyEvents(state, [ev({ type: 'task.updated', taskId: 't', patch: { title: 'Review retries PR' } })]);
    expect(planGitHubSync(state, new Map([['PR_1', merged]]))).toEqual([{ type: 'task.sourceSynced', taskId: 't', source: githubSource(merged) }]);
  });
});
