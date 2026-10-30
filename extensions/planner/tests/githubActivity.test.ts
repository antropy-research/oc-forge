// The day's GitHub work in Daily Highlights' Other activities, as Sunsama's GitHub integration surfaces "the work you
// did in GitHub (comments, PRs, discussions)" in the end-of-day review: what the service reads and how it pages each
// source, what the panel reads to the end (or says GitHub has more), how rows group and read, and highlights with links.
import { describe, expect, test } from 'bun:test';
import {
  ACTIVITY_QUERY,
  ACTIVITY_COMMENTS_QUERY,
  ACTIVITY_DISCUSSION_COMMENTS_BACK_QUERY,
  ACTIVITY_DISCUSSION_COMMENTS_ON_QUERY,
  ACTIVITY_SEARCH_QUERY,
  readActivity,
  readActivityPage,
  type GraphQL,
} from '../service/githubActivity.ts';
import { activityGroups, activityLabel, activityMoreUrl, activitySearches, activityText, searchRange, type ActivityPage, type GitHubActivity } from '../src/domain/githubActivity.ts';
import { MAX_ACTIVITY_PAGES, readGitHubActivity } from '../panel/lib/githubActivity.ts';
import { validateCommand } from '../src/domain/events.ts';
import { emptyState } from '../src/domain/types.ts';

// A day in Los Angeles: from its midnight to the next.
const FROM = '2026-10-29T07:00:00.000Z';
const TO = '2026-10-30T07:00:00.000Z';
const at = (hours: number) => new Date(Date.parse(FROM) + hours * 3_600_000).toISOString();
const pull = (n: number, extra: Record<string, unknown> = {}) => ({ id: `PR_${n}`, number: n, title: `Pull ${n}`, url: `https://github.com/acme/app/pull/${n}`, repository: { nameWithOwner: 'acme/app' }, ...extra });
const issue = (n: number) => ({ id: `I_${n}`, number: n, title: `Issue ${n}`, url: `https://github.com/acme/app/issues/${n}`, repository: { nameWithOwner: 'acme/app' } });
const discussion = (n: number, createdAt = at(1)) => ({ id: `D_${n}`, number: n, title: `Discussion ${n}`, url: `https://github.com/acme/app/discussions/${n}`, repository: { nameWithOwner: 'acme/app' }, createdAt });
const connection = (nodes: unknown[], info: Record<string, unknown> = {}) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null, ...info } });

/** gh's printed answer for one call; the arguments as gh got them. */
const recording = (answer: (args: string[]) => unknown) => {
  const calls: string[][] = [];
  const graphql: GraphQL = async (args) => {
    calls.push(args);
    return JSON.stringify({ data: answer(args) });
  };
  const variable = (args: string[], name: string) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
  return { calls, graphql, variable };
};

describe('what the service reads for a day', () => {
  test('one gh call for the first page of every source: the searches bounded to the day, the review contributions of the day', async () => {
    const { calls, graphql, variable } = recording(() => ({
      viewer: {
        login: 'me',
        contributionsCollection: {
          pullRequestReviewContributions: connection([
            { occurredAt: at(5), pullRequestReview: { id: 'R_2', url: 'https://github.com/acme/app/pull/6#pullrequestreview-2', state: 'APPROVED' }, pullRequest: pull(6) },
            { occurredAt: at(4), pullRequestReview: { id: 'R_1', url: 'https://github.com/acme/app/pull/6#pullrequestreview-1', state: 'COMMENTED' }, pullRequest: pull(6) },
          ]),
        },
        // Last updated first: a comment of yesterday updated today is left out, and nothing older is read.
        issueComments: connection([
          { id: 'C_2', url: 'https://github.com/acme/app/pull/8#issuecomment-2', createdAt: at(7), updatedAt: at(7), issue: issue(8), pullRequest: pull(8) },
          { id: 'C_1', url: 'https://github.com/acme/app/issues/7#issuecomment-1', createdAt: at(6), updatedAt: at(6), issue: issue(7), pullRequest: null },
          { id: 'C_0', url: 'https://github.com/acme/app/issues/7#issuecomment-0', createdAt: at(-30), updatedAt: at(2), issue: issue(7), pullRequest: null },
          { id: 'C_old', url: 'https://github.com/acme/app/issues/7#issuecomment-9', createdAt: at(-50), updatedAt: at(-49), issue: issue(7), pullRequest: null },
        ], { hasNextPage: true, endCursor: 'c-next' }),
        repositoryDiscussions: connection([discussion(9, at(8)), discussion(3, at(-20))], { hasNextPage: true, endCursor: 'd-next' }),
        // Oldest first, read from the end: one of today, and one of yesterday before it, so nothing earlier is needed.
        repositoryDiscussionComments: connection([
          { id: 'DC_0', url: 'https://github.com/acme/app/discussions/3#discussioncomment-0', createdAt: at(-10), discussion: discussion(3) },
          { id: 'DC_1', url: 'https://github.com/acme/app/discussions/3#discussioncomment-1', createdAt: at(9), discussion: discussion(3) },
        ], { hasPreviousPage: true, startCursor: 'dc-before' }),
      },
      opened: { issueCount: 1, ...connection([pull(1, { createdAt: at(2), author: { login: 'me' } })]) },
      // Mine, merged by Ann: it counts; Bo's merged by me counts; Bo's merged by Ann doesn't.
      merged: { issueCount: 1, ...connection([pull(3, { mergedAt: at(3), mergedBy: { login: 'ann' }, author: { login: 'me' } })]) },
      mergedReviewed: { issueCount: 2, ...connection([pull(4, { mergedAt: at(3.5), mergedBy: { login: 'ME' }, author: { login: 'bo' } }), pull(5, { mergedAt: at(3.6), mergedBy: { login: 'ann' }, author: { login: 'bo' } })]) },
      mergedInvolved: { issueCount: 1, ...connection([pull(4, { mergedAt: at(3.5), mergedBy: { login: 'me' }, author: { login: 'bo' } })]) },
    }));
    const page = await readActivity(graphql, FROM, TO);
    expect(calls).toHaveLength(1);
    expect(variable(calls[0]!, 'query')).toBe(ACTIVITY_QUERY);
    expect(variable(calls[0]!, 'opened')).toBe('is:pr author:@me created:2026-10-29T07:00:00+00:00..2026-10-30T06:59:59+00:00');
    expect(variable(calls[0]!, 'mergedReviewed')).toBe('is:pr is:merged -author:@me reviewed-by:@me merged:2026-10-29T07:00:00+00:00..2026-10-30T06:59:59+00:00');
    expect([variable(calls[0]!, 'from'), variable(calls[0]!, 'to')]).toEqual([FROM, '2026-10-30T06:59:59.000Z']);
    expect(page.items.map((item) => item.id)).toEqual(['opened:PR_1', 'merged:PR_3', 'merged:PR_4', 'merged:PR_4', 'reviewed:R_2', 'reviewed:R_1', 'commented:C_2', 'commented:C_1', 'discussion:D_9', 'discussionComment:DC_1']);
    expect(page.items.find((item) => item.id === 'merged:PR_3')).toMatchObject({ mine: true, mergedBy: 'ann', mergedByMe: false });
    expect(page.items.find((item) => item.id === 'commented:C_2')!.target).toMatchObject({ type: 'pull', number: 8, url: 'https://github.com/acme/app/pull/8' });
    // The comments' next page is older than the day; so is the discussions'; the discussion comments' earlier ones too.
    expect(page.more).toEqual({});
    expect(page.totals).toEqual({ opened: 1, merged: 1, mergedReviewed: 2, mergedInvolved: 1 });
    expect(page.login).toBe('me');
  });

  test('a source with more of the day has a cursor; its next page is read with its own query', async () => {
    const today = Array.from({ length: 3 }, (_, n) => ({ id: `C_${n}`, url: `https://github.com/acme/app/issues/7#issuecomment-${n}`, createdAt: at(10 - n), updatedAt: at(10 - n), issue: issue(7), pullRequest: null }));
    const { calls, graphql, variable } = recording((args) =>
      variable(args, 'query') === ACTIVITY_COMMENTS_QUERY
        ? { viewer: { login: 'me', issueComments: connection([{ ...today[2]!, id: 'C_9', createdAt: at(0.5), updatedAt: at(0.5) }, { ...today[2]!, id: 'C_x', createdAt: at(-3), updatedAt: at(-3) }], { hasNextPage: true, endCursor: 'c3' }) } }
        : variable(args, 'query') === ACTIVITY_SEARCH_QUERY
          ? { viewer: { login: 'me' }, search: { issueCount: 51, ...connection([pull(51, { createdAt: at(1) })], { hasNextPage: false }) } }
          : { viewer: { login: 'me', issueComments: connection(today, { hasNextPage: true, endCursor: 'c2' }) }, opened: { issueCount: 51, ...connection([pull(1, { createdAt: at(1) })], { hasNextPage: true, endCursor: 'o50' }) } },
    );
    const first = await readActivity(graphql, FROM, TO);
    expect(first.more).toEqual({ commented: 'c2', opened: 'o50' });
    const comments = await readActivityPage(graphql, 'commented', FROM, TO, 'c2');
    expect(variable(calls[1]!, 'after')).toBe('c2');
    expect([comments.items.map((item) => item.id), comments.more]).toEqual([['commented:C_9'], {}]);
    const opened = await readActivityPage(graphql, 'opened', FROM, TO, 'o50');
    expect([variable(calls[2]!, 'q'), variable(calls[2]!, 'after')]).toEqual([activitySearches(FROM, TO).opened, 'o50']);
    expect([opened.items.map((item) => item.id), opened.more, opened.totals]).toEqual([['opened:PR_51'], {}, { opened: 51 }]);
  });

  test("discussion comments, whose order GitHub doesn't document: read back from the end while oldest first, or from the start once newest first", async () => {
    const comment = (n: number, hours: number) => ({ id: `DC_${n}`, url: `https://github.com/acme/app/discussions/3#discussioncomment-${n}`, createdAt: at(hours), discussion: discussion(3) });
    // Oldest first: the end page is all of today, so the page before it is read, up to one older than the day.
    const oldestFirst = recording((args) => {
      const query = args.find((arg) => arg.startsWith('query='))!.slice(6);
      if (query === ACTIVITY_DISCUSSION_COMMENTS_BACK_QUERY) return { viewer: { login: 'me', repositoryDiscussionComments: connection([comment(1, -2), comment(2, 1)], { hasPreviousPage: true, startCursor: 's0' }) } };
      return { viewer: { login: 'me', repositoryDiscussionComments: connection([comment(3, 2), comment(4, 3)], { hasPreviousPage: true, startCursor: 's1' }) } };
    });
    const first = await readActivity(oldestFirst.graphql, FROM, TO);
    expect(first.more.discussionComments).toBe('back:s1');
    const back = await readActivityPage(oldestFirst.graphql, 'discussionComments', FROM, TO, 'back:s1');
    expect(oldestFirst.variable(oldestFirst.calls[1]!, 'cursor')).toBe('s1');
    expect([back.items.map((item) => item.id), back.more]).toEqual([['discussionComment:DC_2'], {}]);
    // Newest first after all: the end was the oldest; the reading starts over from the start and goes on.
    const newestFirst = recording((args) => {
      const query = args.find((arg) => arg.startsWith('query='))!.slice(6);
      const cursor = newestFirst.variable(args, 'cursor');
      if (query === ACTIVITY_DISCUSSION_COMMENTS_ON_QUERY && !cursor) return { viewer: { login: 'me', repositoryDiscussionComments: connection([comment(9, 5), comment(8, 4)], { hasNextPage: true, endCursor: 'e1' }) } };
      if (query === ACTIVITY_DISCUSSION_COMMENTS_ON_QUERY) return { viewer: { login: 'me', repositoryDiscussionComments: connection([comment(7, 3), comment(6, -1)], { hasNextPage: true, endCursor: 'e2' }) } };
      return { viewer: { login: 'me', repositoryDiscussionComments: connection([comment(1, -40), comment(0, -41)], { hasPreviousPage: true, startCursor: 'x' }) } };
    });
    const turned = await readActivity(newestFirst.graphql, FROM, TO);
    expect([turned.items.filter((item) => item.kind === 'discussionComment'), turned.more.discussionComments]).toEqual([[], 'on:']);
    const start = await readActivityPage(newestFirst.graphql, 'discussionComments', FROM, TO, 'on:');
    expect(newestFirst.variable(newestFirst.calls[1]!, 'cursor')).toBeUndefined();
    expect([start.items.map((item) => item.id), start.more]).toEqual([['discussionComment:DC_9', 'discussionComment:DC_8'], { discussionComments: 'on:e1' }]);
    const on = await readActivityPage(newestFirst.graphql, 'discussionComments', FROM, TO, 'on:e1');
    expect([on.items.map((item) => item.id), on.more]).toEqual([['discussionComment:DC_7'], {}]);
  });

  test('an answer with errors and no data is an error; one with data and errors (something gone since) is read', async () => {
    await expect(readActivity(async () => JSON.stringify({ data: null, errors: [{ message: 'API rate limit exceeded' }] }), FROM, TO)).rejects.toThrow('API rate limit exceeded');
    const partly = await readActivity(async () => JSON.stringify({ data: { viewer: { login: 'me' }, opened: { issueCount: 1, ...connection([pull(1, { createdAt: at(1) })]) } }, errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible' }] }), FROM, TO);
    expect(partly.items.map((item) => item.id)).toEqual(['opened:PR_1']);
  });
});

describe('what the panel reads and shows', () => {
  test('every source to its end, a page at a time; past its bound of pages, it is named as cut', async () => {
    const asked: string[] = [];
    const paths: string[] = [];
    const item = (id: string): GitHubActivity => ({ id, kind: 'commented', target: { id: 'I_7', repo: 'acme/app', number: 7, title: 'Issue 7', url: 'https://github.com/acme/app/issues/7', type: 'issue' }, url: `https://github.com/acme/app/issues/7#${id}`, at: at(1) });
    const client = {
      call: async <T,>(_method: string, path: string): Promise<T> => {
        paths.push(path);
        const query = new URL(path, 'http://x').searchParams;
        const source = query.get('source');
        asked.push(source ? `${source}:${query.get('after')}` : 'first');
        if (!source) return { login: 'me', items: [item('c0')], more: { commented: '1', opened: 'o1' }, totals: { opened: 2 } } as T;
        if (source === 'opened') return { login: 'me', items: [], more: {}, totals: { opened: 2 } } as T;
        const n = Number(query.get('after'));
        return { login: 'me', items: [item(`c${n}`)], more: { commented: String(n + 1) }, totals: {} } as ActivityPage as T;
      },
    };
    const read = await readGitHubActivity(client, FROM, TO);
    expect(asked.filter((call) => call.startsWith('opened'))).toEqual(['opened:o1']);
    expect(asked.filter((call) => call.startsWith('commented'))).toHaveLength(MAX_ACTIVITY_PAGES);
    expect([read.items.length, read.cut, read.totals]).toEqual([1 + MAX_ACTIVITY_PAGES, ['commented'], { opened: 2 }]);
    const firstPath = new URL(paths[0]!, 'http://x');
    expect([firstPath.pathname, firstPath.searchParams.get('from'), firstPath.searchParams.get('to'), firstPath.searchParams.get('source')]).toEqual(['/github/activity', FROM, TO, null]);
  });

  test('a pull request reviewed twice is one row with its last state; the same work read twice is one; each says what was done', () => {
    const base = { target: { id: 'PR_6', repo: 'acme/app', number: 6, title: 'Fix the crash', url: 'https://github.com/acme/app/pull/6', type: 'pull' as const } };
    const items: GitHubActivity[] = [
      { ...base, id: 'reviewed:R_2', kind: 'reviewed', url: 'https://github.com/acme/app/pull/6#pullrequestreview-2', at: at(5), state: 'APPROVED' },
      { ...base, id: 'reviewed:R_1', kind: 'reviewed', url: 'https://github.com/acme/app/pull/6#pullrequestreview-1', at: at(4), state: 'COMMENTED' },
      { ...base, id: 'merged:PR_6', kind: 'merged', url: base.target.url, at: at(6), mergedBy: 'me', mergedByMe: true, mine: false },
      { ...base, id: 'merged:PR_6', kind: 'merged', url: base.target.url, at: at(6), mergedBy: 'me', mergedByMe: true, mine: false },
      { ...base, id: 'opened:PR_6', kind: 'opened', url: base.target.url, at: at(1) },
    ];
    const groups = activityGroups(items);
    expect(groups.map((group) => [group.key, group.count, group.url.split('#')[1] ?? '', activityLabel(group)])).toEqual([
      ['opened:PR_6', 1, '', 'Opened'],
      ['reviewed:PR_6', 2, 'pullrequestreview-2', 'Reviewed · approved ×2'],
      ['merged:PR_6', 1, '', 'Merged'],
    ]);
    expect(groups.map(activityText)).toEqual([
      'Opened pull request acme/app#6: Fix the crash',
      'Reviewed pull request acme/app#6: Fix the crash (approved)',
      'Merged pull request acme/app#6: Fix the crash',
    ]);
    const someoneMerged = activityGroups([{ ...base, id: 'merged:PR_7', kind: 'merged', url: base.target.url, at: at(2), mergedBy: 'ann', mergedByMe: false, mine: true }])[0]!;
    expect([activityLabel(someoneMerged), activityText(someoneMerged)]).toEqual(['Merged by ann', 'Pull request acme/app#6: Fix the crash was merged']);
    const discussionTarget = { id: 'D_3', repo: 'acme/app', number: 3, title: 'Roadmap', url: 'https://github.com/acme/app/discussions/3', type: 'discussion' as const };
    expect(activityText(activityGroups([{ id: 'discussionComment:DC_1', kind: 'discussionComment', target: discussionTarget, url: `${discussionTarget.url}#discussioncomment-1`, at: at(1) }])[0]!)).toBe('Commented on discussion acme/app#3: Roadmap');
    expect(activityText(activityGroups([{ id: 'commented:C_1', kind: 'commented', target: { ...discussionTarget, id: 'I_3', type: 'issue', url: 'https://github.com/acme/app/issues/3' }, url: 'x', at: at(1) }])[0]!)).toBe('Commented on issue acme/app#3: Roadmap');
  });

  test("where GitHub has the rest of a cut source: its own search, with the user's login for @me", () => {
    expect(searchRange(FROM, TO)).toBe('2026-10-29T07:00:00+00:00..2026-10-30T06:59:59+00:00');
    expect(decodeURIComponent(activityMoreUrl('opened', 'octo', FROM, TO))).toBe('https://github.com/search?type=pullrequests&q=is:pr author:octo created:2026-10-29T07:00:00+00:00..2026-10-30T06:59:59+00:00');
    expect(decodeURIComponent(activityMoreUrl('commented', 'octo', FROM, TO))).toBe('https://github.com/search?type=issues&q=commenter:octo updated:>=2026-10-29T07:00:00+00:00');
    expect(activityMoreUrl('discussionComments', 'octo', FROM, TO)).toContain('type=discussions');
  });

  test('a highlight included from GitHub keeps its link and what it came from; only https links, short refs', () => {
    const state = emptyState();
    const save = (item: Record<string, unknown>) => validateCommand({ cmd: 'c1', type: 'ritual.saved', ritual: 'highlights', date: '2026-10-29', fields: { items: [{ id: 'h1', text: 'Merged pull request acme/app#6: Fix the crash', taskId: null, starred: true, ...item }] } }, state);
    expect(save({ url: 'https://github.com/acme/app/pull/6', ref: 'github:merged:PR_6' })).toBeNull();
    expect(save({ url: 'javascript:alert(1)' })).toBe('a highlight is invalid');
    expect(save({ url: 'http://github.com/acme/app/pull/6' })).toBe('a highlight is invalid');
    expect(save({ ref: 'x'.repeat(301) })).toBe('a highlight is invalid');
  });
});
