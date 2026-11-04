// The day's GitHub work for Daily Highlights' "Other activities" (src/domain/githubActivity.ts), read through gh for
// the user it is signed in as. How each is read, and why:
// - Pull requests opened and merged: GitHub's issue search with the day as a range (`created:`, `merged:`), paged by
//   its cursor. Merged are the user's own pull requests merged that day and ones the user merged; GitHub's search has
//   no merged-by, so pull requests merged that day which the user reviewed or took part in (`reviewed-by:`,
//   `involves:`) are read and kept where `mergedBy` is the user.
// - Reviews: the user's contributions of the day (`contributionsCollection(from:, to:)`), each review once, at the
//   time it was submitted, which GitHub's search can't bound (it dates a pull request, not a review).
// - Comments on issues and pull requests: the user's own comments (`viewer.issueComments`), last updated first, read
//   until one was last updated before the day; the ones written that day are kept.
// - Discussions started: the user's discussions, newest first (`repositoryDiscussions`), until one is older.
// - Discussion comments: the user's own (`repositoryDiscussionComments`), whose order GitHub does not document: read
//   from the end, as for a list oldest first; a page that turns out newest first turns the reading around.
// The first page of each comes in one gh call (`ACTIVITY_QUERY`); a source with more is read on (`readActivityPage`),
// and the panel says where GitHub has the rest if it stops (src/domain/githubActivity.ts `activityMoreUrl`).
import { activitySearches, type ActivityPage, type ActivitySource, type GitHubActivity } from '../src/domain/githubActivity.ts';

/** Runs `gh api graphql` with these arguments, answering what gh printed. */
export type GraphQL = (args: string[]) => Promise<string>;

/** Items of one source a page: GitHub's search gives up to 100, 50 keeps one gh call short. */
export const ACTIVITY_PAGE_SIZE = 50;

const PAGE_INFO = 'pageInfo { hasNextPage endCursor }';
const BOTH_WAYS = 'pageInfo { hasNextPage endCursor hasPreviousPage startCursor }';
const PR = '... on PullRequest { id number title url createdAt mergedAt mergedBy { login } author { login } repository { nameWithOwner } }';
const REVIEW = 'occurredAt pullRequestReview { id url state } pullRequest { id number title url repository { nameWithOwner } }';
const COMMENT = 'id url createdAt updatedAt issue { id number title url repository { nameWithOwner } } pullRequest { id number title url repository { nameWithOwner } }';
const DISCUSSION = 'id number title url createdAt repository { nameWithOwner }';
const DISCUSSION_COMMENT = 'id url createdAt discussion { id number title url repository { nameWithOwner } }';
const N = ACTIVITY_PAGE_SIZE;
const search = (alias: string, variable: string) => `${alias}: search(query: $${variable}, type: ISSUE, first: ${N}) { issueCount ${PAGE_INFO} nodes { ${PR} } }`;

export const ACTIVITY_QUERY = `query PlannerGitHubActivity($opened: String!, $merged: String!, $mergedReviewed: String!, $mergedInvolved: String!, $from: DateTime!, $to: DateTime!) {
  viewer {
    login
    contributionsCollection(from: $from, to: $to) { pullRequestReviewContributions(first: ${N}) { ${PAGE_INFO} nodes { ${REVIEW} } } }
    issueComments(first: ${N}, orderBy: { field: UPDATED_AT, direction: DESC }) { ${PAGE_INFO} nodes { ${COMMENT} } }
    repositoryDiscussions(first: ${N}, orderBy: { field: CREATED_AT, direction: DESC }) { ${PAGE_INFO} nodes { ${DISCUSSION} } }
    repositoryDiscussionComments(last: ${N}) { ${BOTH_WAYS} nodes { ${DISCUSSION_COMMENT} } }
  }
  ${search('opened', 'opened')}
  ${search('merged', 'merged')}
  ${search('mergedReviewed', 'mergedReviewed')}
  ${search('mergedInvolved', 'mergedInvolved')}
}`;

export const ACTIVITY_SEARCH_QUERY = `query PlannerGitHubActivitySearch($q: String!, $after: String) { viewer { login } search(query: $q, type: ISSUE, first: ${N}, after: $after) { issueCount ${PAGE_INFO} nodes { ${PR} } } }`;
export const ACTIVITY_REVIEWS_QUERY = `query PlannerGitHubActivityReviews($from: DateTime!, $to: DateTime!, $after: String) { viewer { login contributionsCollection(from: $from, to: $to) { pullRequestReviewContributions(first: ${N}, after: $after) { ${PAGE_INFO} nodes { ${REVIEW} } } } } }`;
export const ACTIVITY_COMMENTS_QUERY = `query PlannerGitHubActivityComments($after: String) { viewer { login issueComments(first: ${N}, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) { ${PAGE_INFO} nodes { ${COMMENT} } } } }`;
export const ACTIVITY_DISCUSSIONS_QUERY = `query PlannerGitHubActivityDiscussions($after: String) { viewer { login repositoryDiscussions(first: ${N}, after: $after, orderBy: { field: CREATED_AT, direction: DESC }) { ${PAGE_INFO} nodes { ${DISCUSSION} } } } }`;
/** Discussion comments read from the end (`back:`), or from the start once they turn out newest first (`on:`). */
export const ACTIVITY_DISCUSSION_COMMENTS_BACK_QUERY = `query PlannerGitHubActivityDiscussionCommentsBack($cursor: String) { viewer { login repositoryDiscussionComments(last: ${N}, before: $cursor) { ${BOTH_WAYS} nodes { ${DISCUSSION_COMMENT} } } } }`;
export const ACTIVITY_DISCUSSION_COMMENTS_ON_QUERY = `query PlannerGitHubActivityDiscussionCommentsOn($cursor: String) { viewer { login repositoryDiscussionComments(first: ${N}, after: $cursor) { ${BOTH_WAYS} nodes { ${DISCUSSION_COMMENT} } } } }`;

interface RawTarget {
  id?: string;
  number?: number;
  title?: string;
  url?: string;
  repository?: { nameWithOwner?: string } | null;
}
interface RawPull extends RawTarget {
  createdAt?: string;
  mergedAt?: string | null;
  mergedBy?: { login?: string } | null;
  author?: { login?: string } | null;
}
interface RawReview {
  occurredAt?: string;
  pullRequestReview?: { id?: string; url?: string; state?: string } | null;
  pullRequest?: RawTarget | null;
}
interface RawComment {
  id?: string;
  url?: string;
  createdAt?: string;
  updatedAt?: string;
  issue?: RawTarget | null;
  pullRequest?: RawTarget | null;
}
interface RawDiscussion extends RawTarget {
  createdAt?: string;
}
interface RawDiscussionComment {
  id?: string;
  url?: string;
  createdAt?: string;
  discussion?: RawTarget | null;
}
interface Connection<T> {
  nodes?: (T | null)[];
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null; hasPreviousPage?: boolean; startCursor?: string | null };
  issueCount?: number;
}
interface Viewer {
  login?: string;
  contributionsCollection?: { pullRequestReviewContributions?: Connection<RawReview> } | null;
  issueComments?: Connection<RawComment>;
  repositoryDiscussions?: Connection<RawDiscussion>;
  repositoryDiscussionComments?: Connection<RawDiscussionComment>;
}
type ActivityData = { viewer?: Viewer | null; search?: Connection<RawPull> } & Partial<Record<'opened' | 'merged' | 'mergedReviewed' | 'mergedInvolved', Connection<RawPull>>>;

/** GitHub's answer; one with errors and no data is an error (gh exits 1 on errors beside data, which still count). */
const dataOf = (out: string): ActivityData => {
  const parsed = JSON.parse(out) as { data?: ActivityData | null; errors?: { message?: string }[] };
  if (!parsed.data && parsed.errors?.length) throw new Error(parsed.errors[0]?.message ?? 'GitHub returned an error');
  return parsed.data ?? {};
};

const nodesOf = <T>(page: Connection<T> | null | undefined): T[] => (page?.nodes ?? []).filter((node): node is T => Boolean(node));

const targetOf = (node: RawTarget | null | undefined, type: GitHubActivity['target']['type']): GitHubActivity['target'] | null =>
  node?.id && Number.isInteger(node.number) && typeof node.title === 'string' && typeof node.url === 'string' && node.repository?.nameWithOwner
    ? { id: node.id, repo: node.repository.nameWithOwner, number: node.number!, title: node.title, url: node.url, type }
    : null;

const same = (a: string | null | undefined, b: string): boolean => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

/** The bounds of a day, and whether an instant falls in it ([from, to)). */
const dayOf = (from: string, to: string) => {
  const start = Date.parse(from);
  const end = Date.parse(to);
  return { start, inDay: (at: string | null | undefined): at is string => typeof at === 'string' && Date.parse(at) >= start && Date.parse(at) < end };
};

type Day = ReturnType<typeof dayOf>;

const pullItems = (source: ActivitySource, page: Connection<RawPull> | null | undefined, login: string, day: Day): GitHubActivity[] =>
  nodesOf(page).flatMap((node): GitHubActivity[] => {
    const target = targetOf(node, 'pull');
    if (!target) return [];
    if (source === 'opened') return day.inDay(node.createdAt) ? [{ id: `opened:${target.id}`, kind: 'opened', target, url: target.url, at: node.createdAt }] : [];
    if (!day.inDay(node.mergedAt)) return [];
    const mergedBy = node.mergedBy?.login ?? null;
    const mergedByMe = same(mergedBy, login);
    const mine = same(node.author?.login, login);
    // Someone else's pull request counts when the user merged it.
    if (!mine && !mergedByMe) return [];
    return [{ id: `merged:${target.id}`, kind: 'merged', target, url: target.url, at: node.mergedAt, mergedBy, mergedByMe, mine }];
  });

const reviewItems = (page: Connection<RawReview> | null | undefined, day: Day): GitHubActivity[] =>
  nodesOf(page).flatMap((node): GitHubActivity[] => {
    const target = targetOf(node.pullRequest, 'pull');
    const review = node.pullRequestReview;
    if (!target || !review?.id || !day.inDay(node.occurredAt)) return [];
    return [{ id: `reviewed:${review.id}`, kind: 'reviewed', target, url: review.url ?? target.url, at: node.occurredAt, ...(review.state ? { state: review.state } : {}) }];
  });

const commentItems = (page: Connection<RawComment> | null | undefined, day: Day): GitHubActivity[] =>
  nodesOf(page).flatMap((node): GitHubActivity[] => {
    // A comment on a pull request names it as its issue too: the pull request is what it is on.
    const target = targetOf(node.pullRequest, 'pull') ?? targetOf(node.issue, 'issue');
    if (!target || !node.id || !node.url || !day.inDay(node.createdAt)) return [];
    return [{ id: `commented:${node.id}`, kind: 'commented', target, url: node.url, at: node.createdAt }];
  });

const discussionItems = (page: Connection<RawDiscussion> | null | undefined, day: Day): GitHubActivity[] =>
  nodesOf(page).flatMap((node): GitHubActivity[] => {
    const target = targetOf(node, 'discussion');
    return target && day.inDay(node.createdAt) ? [{ id: `discussion:${target.id}`, kind: 'discussion', target, url: target.url, at: node.createdAt }] : [];
  });

const discussionCommentItems = (page: Connection<RawDiscussionComment> | null | undefined, day: Day): GitHubActivity[] =>
  nodesOf(page).flatMap((node): GitHubActivity[] => {
    const target = targetOf(node.discussion, 'discussion');
    if (!target || !node.id || !node.url || !day.inDay(node.createdAt)) return [];
    return [{ id: `discussionComment:${node.id}`, kind: 'discussionComment', target, url: node.url, at: node.createdAt }];
  });

/** The next page's cursor, when there is one. */
const nextOf = (page: Connection<unknown> | null | undefined): string | null => (page?.pageInfo?.hasNextPage && page.pageInfo.endCursor ? page.pageInfo.endCursor : null);

/** A list newest first (by `field`): read on while its last item is not older than the day. */
const nextWhileRecent = <T extends { createdAt?: string; updatedAt?: string }>(page: Connection<T> | null | undefined, field: 'createdAt' | 'updatedAt', day: Day): string | null => {
  const last = nodesOf(page).at(-1);
  return nextOf(page) && last && Date.parse(last[field] ?? '') >= day.start ? nextOf(page) : null;
};

/**
 * Discussion comments: read from the end (`back:` and the page's start cursor) while the page is oldest first and its
 * first one is not older than the day; a page newest first means the end was the oldest, so the reading starts over
 * from the start (`on:`), on while the page's last one is not older than the day.
 */
const nextDiscussionComments = (page: Connection<RawDiscussionComment> | null | undefined, read: 'back' | 'on', day: Day): string | null => {
  const nodes = nodesOf(page);
  const info = page?.pageInfo ?? {};
  const first = Date.parse(nodes[0]?.createdAt ?? '');
  const last = Date.parse(nodes.at(-1)?.createdAt ?? '');
  if (!nodes.length) return null;
  if (read === 'back') {
    if (nodes.length > 1 && first > last) return info.hasPreviousPage ? 'on:' : null;
    return info.hasPreviousPage && info.startCursor && first >= day.start ? `back:${info.startCursor}` : null;
  }
  return info.hasNextPage && info.endCursor && last >= day.start ? `on:${info.endCursor}` : null;
};

/** The last second of the day: GitHub's `to` includes it. */
const lastSecond = (to: string): string => new Date(Date.parse(to) - 1000).toISOString();

const page = (login: string, items: GitHubActivity[], more: Partial<Record<ActivitySource, string | null>>, totals: ActivityPage['totals'] = {}): ActivityPage => ({
  login,
  items,
  more: Object.fromEntries(Object.entries(more).filter(([, cursor]) => typeof cursor === 'string')) as ActivityPage['more'],
  totals,
});

/** The first page of each source for the day [from, to), in one gh call. */
export const readActivity = async (graphql: GraphQL, from: string, to: string): Promise<ActivityPage> => {
  const searches = activitySearches(from, to);
  const out = await graphql([
    '-f', `query=${ACTIVITY_QUERY}`,
    '-f', `opened=${searches.opened}`,
    '-f', `merged=${searches.merged}`,
    '-f', `mergedReviewed=${searches.mergedReviewed}`,
    '-f', `mergedInvolved=${searches.mergedInvolved}`,
    '-f', `from=${new Date(from).toISOString()}`,
    '-f', `to=${lastSecond(to)}`,
  ]);
  const data = dataOf(out);
  const login = data.viewer?.login ?? '';
  const day = dayOf(from, to);
  const viewer: Viewer = data.viewer ?? {};
  const reviews = viewer.contributionsCollection?.pullRequestReviewContributions;
  const items = [
    ...pullItems('opened', data.opened, login, day),
    ...pullItems('merged', data.merged, login, day),
    ...pullItems('mergedReviewed', data.mergedReviewed, login, day),
    ...pullItems('mergedInvolved', data.mergedInvolved, login, day),
    ...reviewItems(reviews, day),
    ...commentItems(viewer.issueComments, day),
    ...discussionItems(viewer.repositoryDiscussions, day),
    ...discussionCommentItems(viewer.repositoryDiscussionComments, day),
  ];
  const more: Record<ActivitySource, string | null> = {
    opened: nextOf(data.opened),
    merged: nextOf(data.merged),
    mergedReviewed: nextOf(data.mergedReviewed),
    mergedInvolved: nextOf(data.mergedInvolved),
    reviewed: nextOf(reviews),
    commented: nextWhileRecent(viewer.issueComments, 'updatedAt', day),
    discussions: nextWhileRecent(viewer.repositoryDiscussions, 'createdAt', day),
    discussionComments: nextDiscussionComments(viewer.repositoryDiscussionComments, 'back', day),
  };
  const totals: ActivityPage['totals'] = {};
  for (const source of ['opened', 'merged', 'mergedReviewed', 'mergedInvolved'] as const) {
    const count = data[source]?.issueCount;
    if (typeof count === 'number' && Number.isInteger(count)) totals[source] = count;
  }
  return page(login, items, more, totals);
};

/** The next page of one source, from `after` (what the previous page gave as its `more`). */
export const readActivityPage = async (graphql: GraphQL, source: ActivitySource, from: string, to: string, after: string): Promise<ActivityPage> => {
  const day = dayOf(from, to);
  const cursor = (value: string) => (value ? ['-f', `after=${value}`] : []);
  switch (source) {
    case 'opened':
    case 'merged':
    case 'mergedReviewed':
    case 'mergedInvolved': {
      const data = dataOf(await graphql(['-f', `query=${ACTIVITY_SEARCH_QUERY}`, '-f', `q=${activitySearches(from, to)[source]}`, ...cursor(after)]));
      const login = data.viewer?.login ?? '';
      const count = data.search?.issueCount;
      return page(login, pullItems(source, data.search, login, day), { [source]: nextOf(data.search) }, typeof count === 'number' ? { [source]: count } : {});
    }
    case 'reviewed': {
      const data = dataOf(await graphql(['-f', `query=${ACTIVITY_REVIEWS_QUERY}`, '-f', `from=${new Date(from).toISOString()}`, '-f', `to=${lastSecond(to)}`, ...cursor(after)]));
      const reviews = data.viewer?.contributionsCollection?.pullRequestReviewContributions;
      return page(data.viewer?.login ?? '', reviewItems(reviews, day), { reviewed: nextOf(reviews) });
    }
    case 'commented': {
      const data = dataOf(await graphql(['-f', `query=${ACTIVITY_COMMENTS_QUERY}`, ...cursor(after)]));
      return page(data.viewer?.login ?? '', commentItems(data.viewer?.issueComments, day), { commented: nextWhileRecent(data.viewer?.issueComments, 'updatedAt', day) });
    }
    case 'discussions': {
      const data = dataOf(await graphql(['-f', `query=${ACTIVITY_DISCUSSIONS_QUERY}`, ...cursor(after)]));
      return page(data.viewer?.login ?? '', discussionItems(data.viewer?.repositoryDiscussions, day), { discussions: nextWhileRecent(data.viewer?.repositoryDiscussions, 'createdAt', day) });
    }
    case 'discussionComments': {
      const split = after.indexOf(':');
      const read = after.slice(0, split) === 'on' ? 'on' : 'back';
      const at = split >= 0 ? after.slice(split + 1) : after;
      const query = read === 'on' ? ACTIVITY_DISCUSSION_COMMENTS_ON_QUERY : ACTIVITY_DISCUSSION_COMMENTS_BACK_QUERY;
      const data = dataOf(await graphql(['-f', `query=${query}`, ...(at ? ['-f', `cursor=${at}`] : [])]));
      const comments = data.viewer?.repositoryDiscussionComments;
      return page(data.viewer?.login ?? '', discussionCommentItems(comments, day), { discussionComments: nextDiscussionComments(comments, read, day) });
    }
  }
};
