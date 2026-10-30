import { describe, expect, test } from 'bun:test';
import { GitHubStore } from '../panel/lib/github.ts';
import { GitHubSource, LISTS, LIST_QUERY, NODES_QUERY, RESOURCE_QUERY, diagnose, listQuery, parseNodes, pickPull, type Runner } from '../service/github.ts';
import { githubSource, githubStatus, isGitHubItem, parseGitHubUrl, planGitHubSync, repoOfSearch, shortKey, taskFromGitHub, withRepo, type GitHubItem } from '../src/domain/github.ts';
import { applyEvents, foldEvents } from '../src/domain/reducer.ts';
import type { EventBody, PlannerEvent } from '../src/domain/events.ts';

const node = (patch: Record<string, unknown> = {}) => ({
  __typename: 'Issue', id: 'I_1', number: 42, title: 'Crash on start', url: 'https://github.com/acme/app/issues/42', state: 'OPEN', updatedAt: '2026-10-24T10:00:00Z', repository: { nameWithOwner: 'acme/app' }, ...patch,
});
const item = (patch: Partial<GitHubItem> = {}): GitHubItem => ({ ...parseNodes([node()])[0]!, ...patch });

describe('gh', () => {
  test('missing CLI and logged-out CLI are told apart, with how to sign in and where', async () => {
    const missing: Runner = async () => { throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }); };
    expect(await new GitHubSource(missing, () => null).status()).toEqual({ available: false, login: null, message: 'The GitHub CLI (gh) is not installed where OpenChamber runs. Install it there, then sign in with `gh auth login`.', reason: 'missing', container: null });
    // gh 2.103.2 in the dev container, never signed in.
    const loggedOut: Runner = async () => { throw Object.assign(new Error('Command failed: gh api user --jq .login'), { code: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\n' }); };
    const signedOut = await new GitHubSource(loggedOut, () => '7fd513237c0c').status();
    expect(signedOut).toMatchObject({ available: false, reason: 'signed-out', container: '7fd513237c0c' });
    expect(signedOut.message).toContain('gh auth login');
    expect(diagnose(Object.assign(new Error('HTTP 401: Bad credentials (https://api.github.com/user)'), { code: 1 })).reason).toBe('signed-out');
    expect(diagnose(Object.assign(new Error('rate limited'), { code: 1, stderr: 'API rate limit exceeded' }))).toEqual({ reason: null, message: 'API rate limit exceeded rate limited' });
    expect(await new GitHubSource(async () => 'octo\n', () => 'abc').status()).toEqual({ available: true, login: 'octo', message: null, reason: null, container: null });
  });
  test('lists and node reads pass the right arguments', async () => {
    const calls: string[][] = [];
    const runner: Runner = async (args) => {
      calls.push(args);
      if (args[1] === 'user') return 'qihang-zhang\n';
      return JSON.stringify(args.some((arg) => arg.startsWith('ids[]')) ? { data: { nodes: [node({ state: 'CLOSED' }), null] } } : { data: { search: { nodes: [node(), node({ __typename: 'PullRequest', id: 'PR_1', number: 7, isDraft: true, url: 'https://github.com/acme/app/pull/7' })] } } });
    };
    const source = new GitHubSource(runner);
    expect(await source.status()).toEqual({ available: true, login: 'qihang-zhang', message: null, reason: null, container: null });
    const review = await source.list('review');
    expect(calls[1]).toContain(`q=${LISTS.review}`);
    expect(review.items.map((entry) => [entry.kind, entry.key, entry.draft])).toEqual([['issue', 'acme/app#42', false], ['pull', 'acme/app#7', true]]);
    // No pageInfo: one page, nothing after it.
    expect([review.total, review.next]).toEqual([2, null]);
    const linked = await source.items(['I_1', 'PR_1']);
    expect(calls[2]).toEqual(['api', 'graphql', '-f', `query=${NODES_QUERY}`, '-f', 'ids[]=I_1', '-f', 'ids[]=PR_1']);
    expect(linked.map((entry) => entry.state)).toEqual(['CLOSED']);
    expect(await source.items([])).toEqual([]);
  });
});

describe("the panel's Repository choice (round 12, Sunsama's most relevant repositories)", () => {
  test("a repository chosen is the search's repo: term, first; All repositories takes it off; typing one chooses it", () => {
    expect(repoOfSearch('crash repo:acme/app label:bug')).toBe('acme/app');
    expect(repoOfSearch('crash')).toBeNull();
    expect(repoOfSearch('repo:acme')).toBeNull();
    expect(withRepo('crash label:bug', 'acme/app')).toBe('repo:acme/app crash label:bug');
    expect(withRepo('repo:acme/old crash', 'acme/app')).toBe('repo:acme/app crash');
    expect(withRepo('repo:acme/app crash', null)).toBe('crash');
    expect(withRepo('', 'acme/app')).toBe('repo:acme/app');
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

describe('pull requests from agent branches', () => {
  const pull = (patch: Record<string, unknown> = {}) => ({ number: 12, url: 'https://github.com/acme/app/pull/12', state: 'OPEN', isDraft: false, title: 'Write tests', updatedAt: '2026-10-25T10:00:00Z', ...patch });
  test('an open pull request first, then a merged one, then the latest', () => {
    expect(pickPull([])).toBeNull();
    expect(pickPull([pull({ number: 3, url: 'https://github.com/acme/app/pull/3', state: 'CLOSED' }), pull({ number: 4, url: 'https://github.com/acme/app/pull/4', state: 'MERGED' })])).toMatchObject({ number: 4, state: 'merged', repo: 'acme/app' });
    expect(pickPull([pull({ state: 'MERGED' }), pull({ number: 13, url: 'https://github.com/acme/app/pull/13', isDraft: true })])).toEqual({ number: 13, url: 'https://github.com/acme/app/pull/13', state: 'open', draft: true, title: 'Write tests', repo: 'acme/app' });
    // Anything that is not a GitHub pull request URL is dropped.
    expect(pickPull([pull({ url: 'https://evil.example/acme/app/pull/12' })])).toBeNull();
  });
  test('asked with gh in the first checkout that exists, for that branch only', async () => {
    const calls: { args: string[]; cwd?: string; timeoutMs?: number }[] = [];
    const runner: Runner = async (args, options) => {
      calls.push({ args, cwd: options?.cwd, timeoutMs: options?.timeoutMs });
      return JSON.stringify([pull()]);
    };
    const source = new GitHubSource(runner);
    const found = await source.pullRequestFor('planner/write-tests', ['/no/such/worktree', process.cwd()]);
    expect(found).toMatchObject({ number: 12, state: 'open' });
    expect(calls).toEqual([{ args: ['pr', 'list', '--head', 'planner/write-tests', '--state', 'all', '--limit', '10', '--json', 'number,url,state,isDraft,title,updatedAt'], cwd: process.cwd(), timeoutMs: 8000 }]);
    expect(await source.pullRequestFor('planner/x', ['/no/such/worktree', 'relative/dir'])).toBeNull();
    for (const bad of ['--help', '-x', 'a..b', 'a//b', 'trailing/', 'sp ace', '']) await expect(source.pullRequestFor(bad, [process.cwd()])).rejects.toThrow('branch name is invalid');
    expect(calls).toHaveLength(1);
  });
  test('a known pull request is followed by its URL, without a checkout', async () => {
    const calls: { args: string[]; cwd?: string }[] = [];
    const source = new GitHubSource(async (args, options) => {
      calls.push({ args, cwd: options?.cwd });
      return JSON.stringify(pull({ state: 'MERGED' }));
    });
    expect(await source.pullRequestAt('https://github.com/acme/app/pull/12')).toMatchObject({ number: 12, state: 'merged', repo: 'acme/app' });
    expect(calls).toEqual([{ args: ['pr', 'view', 'https://github.com/acme/app/pull/12', '--json', 'number,url,state,isDraft,title,updatedAt'], cwd: undefined }]);
    for (const bad of ['https://evil.example/acme/app/pull/12', 'https://github.com/acme/app/pull/12 --web', '--web']) await expect(source.pullRequestAt(bad)).rejects.toThrow('pull request URL is invalid');
    expect(calls).toHaveLength(1);
  });
  test('gh failing everywhere is explained', async () => {
    const loggedOut: Runner = async () => { throw Object.assign(new Error('exit 4'), { code: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login' }); };
    await expect(new GitHubSource(loggedOut).pullRequestFor('planner/x', [process.cwd()])).rejects.toThrow('gh auth login');
  });
});

// Review 11 (P1-3): the list was one page of 50 with no cursor, so the 51st assigned issue could not be reached, and
// Refresh asked for the same first page again; a pasted issue URL made a task titled with the URL, linked to nothing.
describe('every item reachable: pages, words, linked items in batches, an item by its URL', () => {
  const page = (numbers: number[], next: string | null, total: number) => JSON.stringify({ data: { search: { issueCount: total, pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes: numbers.map((number) => node({ id: `I_${number}`, number, title: `Issue ${number}`, url: `https://github.com/acme/app/issues/${number}` })) } } });

  test('a page at a time: the first without a cursor, the next from the last one\'s; how many match in all', async () => {
    const calls: string[][] = [];
    const source = new GitHubSource(async (args) => {
      calls.push(args);
      return args.includes('after=Y3Vyc29yOjUw') ? page([51], null, 51) : page(Array.from({ length: 50 }, (_, n) => n + 1), 'Y3Vyc29yOjUw', 51);
    });
    const first = await source.list('assigned');
    expect([first.items.length, first.total, first.next]).toEqual([50, 51, 'Y3Vyc29yOjUw']);
    expect(calls[0]).toEqual(['api', 'graphql', '-f', `query=${LIST_QUERY}`, '-f', `q=${LISTS.assigned}`]);
    const second = await source.list('assigned', { after: first.next });
    expect(calls[1]).toEqual(['api', 'graphql', '-f', `query=${LIST_QUERY}`, '-f', `q=${LISTS.assigned}`, '-f', 'after=Y3Vyc29yOjUw']);
    expect([second.items.map((item) => item.key), second.next]).toEqual([['acme/app#51'], null]);
    expect(LIST_QUERY).toContain('pageInfo { hasNextPage endCursor }');
    expect(LIST_QUERY).toContain('after: $after');
  });

  test('words narrow a list, in GitHub\'s search syntax, after its own qualifiers', async () => {
    expect(listQuery('assigned', '  crash   repo:acme/app ')).toBe(`${LISTS.assigned} crash repo:acme/app`);
    expect(listQuery('mine', '')).toBe(LISTS.mine);
    const calls: string[][] = [];
    await new GitHubSource(async (args) => (calls.push(args), page([], null, 0))).list('review', { text: 'retries' });
    expect(calls[0]).toContain(`q=${LISTS.review} retries`);
  });

  test('a next page without a cursor is no next page; an answer with errors and no data is an error, not an empty list', async () => {
    const odd = JSON.stringify({ data: { search: { issueCount: 3, pageInfo: { hasNextPage: true, endCursor: null }, nodes: [node()] } } });
    expect((await new GitHubSource(async () => odd).list('assigned')).next).toBeNull();
    const failing = new GitHubSource(async () => JSON.stringify({ data: null, errors: [{ message: 'API rate limit exceeded' }] }));
    await expect(failing.list('assigned')).rejects.toThrow('API rate limit exceeded');
  });

  test('linked items are all read back, 100 a call (they used to stop at the first 100)', async () => {
    const asked: number[] = [];
    const source = new GitHubSource(async (args) => {
      const ids = args.filter((arg) => arg.startsWith('ids[]=')).map((arg) => arg.slice(6));
      asked.push(ids.length);
      return JSON.stringify({ data: { nodes: ids.map((id) => node({ id })) } });
    });
    const ids = Array.from({ length: 250 }, (_, n) => `I_${n}`);
    expect((await source.items(ids)).map((item) => item.id)).toEqual(ids);
    expect(asked).toEqual([100, 100, 50]);
  });

  test('an issue or a pull request by its URL, as pasted (a comment\'s address too); null where GitHub has none', async () => {
    expect(parseGitHubUrl('https://github.com/acme/app/issues/51#issuecomment-123')).toEqual({ repo: 'acme/app', number: 51, kind: 'issue', key: 'acme/app#51', url: 'https://github.com/acme/app/issues/51' });
    expect(parseGitHubUrl(' https://github.com/acme/app/pull/7/files ')).toMatchObject({ kind: 'pull', key: 'acme/app#7', url: 'https://github.com/acme/app/pull/7' });
    for (const other of ['https://github.com/acme/app', 'https://github.com/acme/app/issues', 'https://gitlab.com/acme/app/issues/1', 'http://github.com/acme/app/issues/1', 'see https://github.com/acme/app/issues/1']) expect(parseGitHubUrl(other)).toBeNull();
    const calls: string[][] = [];
    const source = new GitHubSource(async (args) => {
      calls.push(args);
      return args.includes('url=https://github.com/acme/app/issues/51') ? JSON.stringify({ data: { resource: node({ id: 'I_51', number: 51, title: 'Issue 51', url: 'https://github.com/acme/app/issues/51' }) } }) : JSON.stringify({ data: { resource: null } });
    });
    expect(await source.byUrl('https://github.com/acme/app/issues/51#issuecomment-1')).toMatchObject({ id: 'I_51', key: 'acme/app#51', title: 'Issue 51', url: 'https://github.com/acme/app/issues/51' });
    expect(calls[0]).toEqual(['api', 'graphql', '-f', `query=${RESOURCE_QUERY}`, '-f', 'url=https://github.com/acme/app/issues/51']);
    expect(await source.byUrl('https://github.com/acme/app/issues/52')).toBeNull();
    const notFound = new GitHubSource(async () => JSON.stringify({ data: { resource: null }, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve' }] }));
    expect(await notFound.byUrl('https://github.com/acme/app/pull/9')).toBeNull();
    await expect(new GitHubSource(async () => JSON.stringify({ data: null, errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration' }] })).byUrl('https://github.com/acme/app/pull/9')).rejects.toThrow('Resource not accessible');
    await expect(source.byUrl('https://example.com/x')).rejects.toThrow('not a GitHub issue');
  });
});

describe("the GitHub source's list: Load more, Refresh, words", () => {
  const issue = (number: number): GitHubItem => ({ ...parseNodes([node({ id: `I_${number}`, number, title: `Issue ${number}`, url: `https://github.com/acme/app/issues/${number}` })])[0]! });
  /** The service's /github/list over `count` issues, 50 a page, cursors as offsets; /github/items answers from the ids. */
  const panel = (count: number, linked: string[] = []) => {
    const all = Array.from({ length: count }, (_, n) => issue(n + 1));
    const asked: string[] = [];
    let state = foldEvents(linked.map((id, n) => ({ v: 1, id: `l${n}`, at: '2026-10-24T16:00:00.000Z', type: 'task.created', task: taskFromGitHub({ ...issue(1000 + n), id }, `t${n}`, { kind: 'day', date: '2026-10-24' }, n) }) as PlannerEvent));
    const client = {
      getView: () => ({ state }),
      call: async (method: string, path: string, body?: { ids?: string[] }) => {
        asked.push(`${method} ${path}${body?.ids ? ` ${body.ids.length}` : ''}`);
        if (path === '/github/items') return { items: (body?.ids ?? []).map((id) => ({ ...issue(1), id })) };
        const query = new URL(path, 'http://x').searchParams;
        const matching = all.filter((item) => !query.get('q') || item.title.includes(query.get('q')!));
        const from = Number(query.get('after') ?? 0);
        return { items: matching.slice(from, from + 50), total: matching.length, next: from + 50 < matching.length ? String(from + 50) : null };
      },
      dispatch: async (bodies: EventBody[]) => {
        state = applyEvents(state, bodies.map((body, n) => ({ v: 1, id: `d${asked.length}-${n}`, at: '2026-10-24T17:00:00.000Z', ...body }) as PlannerEvent));
      },
    } as unknown as ConstructorParameters<typeof GitHubStore>[0];
    const store = new GitHubStore(client, 'page');
    (store as unknown as { view: { status: unknown } }).view.status = { available: true, login: 'me', message: null };
    return { store, asked };
  };

  test('51 assigned issues: 50 shown and "Load more" reaches the 51st; Refresh then reads both pages again, not the first alone', async () => {
    const { store, asked } = panel(51);
    await store.refresh();
    expect([store.getView().items.length, store.getView().total, store.getView().next]).toEqual([50, 51, '50']);
    await store.loadMore();
    expect([store.getView().items.length, store.getView().items.at(-1)!.key, store.getView().next]).toEqual([51, 'acme/app#51', null]);
    asked.length = 0;
    await store.refresh();
    expect(asked.filter((call) => call.startsWith('GET'))).toEqual(['GET /github/list?kind=assigned', 'GET /github/list?kind=assigned&after=50']);
    expect([store.getView().items.length, store.getView().next]).toEqual([51, null]);
  });

  test('Refresh with more left keeps them a Load more away; words narrow the list from its first page', async () => {
    const { store } = panel(120);
    await store.refresh();
    await store.loadMore();
    await store.refresh();
    expect([store.getView().items.length, store.getView().next, store.getView().total]).toEqual([100, '100', 120]);
    await store.loadMore();
    expect([store.getView().items.length, store.getView().next]).toEqual([120, null]);
    store.setText('Issue 11');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await store.refresh();
    expect(store.getView().items.map((item) => item.number)).toEqual([11, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119]);
  });

  test('linked tasks are kept current in batches of 100, every one of them', async () => {
    const { store, asked } = panel(3, Array.from({ length: 230 }, (_, n) => `L_${n}`));
    await store.refresh();
    expect(asked.filter((call) => call.startsWith('POST'))).toEqual(['POST /github/items 100', 'POST /github/items 100', 'POST /github/items 30']);
  });
});
