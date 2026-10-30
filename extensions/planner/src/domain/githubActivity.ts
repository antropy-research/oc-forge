// The day's GitHub work, for Daily Highlights' "Other activities": Sunsama's GitHub integration surfaces "the work
// you did in GitHub (comments, PRs, discussions) in your end of day review" (help.sunsama.com/docs/integrations/github),
// listed beside the day's tasks for the user to include in the highlights. Read for the user gh is signed in as
// (service/github.ts `activity`): pull requests opened, reviewed and merged, comments on issues and pull requests,
// discussions started and commented on.

export const ACTIVITY_KINDS = ['opened', 'reviewed', 'merged', 'commented', 'discussion', 'discussionComment'] as const;
export type GitHubActivityKind = (typeof ACTIVITY_KINDS)[number];

/** What the service reads, one GitHub read each (a page at a time): a search, or one of the user's own lists. */
export const ACTIVITY_SOURCES = ['opened', 'merged', 'mergedReviewed', 'mergedInvolved', 'reviewed', 'commented', 'discussions', 'discussionComments'] as const;
export type ActivitySource = (typeof ACTIVITY_SOURCES)[number];

export interface GitHubActivity {
  /** One per thing done: its kind and GitHub's id of it (the review, the comment, the pull request…). */
  id: string;
  kind: GitHubActivityKind;
  /** The pull request, issue or discussion it is about. */
  target: { id: string; repo: string; number: number; title: string; url: string; type: 'pull' | 'issue' | 'discussion' };
  /** Where it opens: the review, the comment, the pull request or the discussion. */
  url: string;
  /** When it happened. */
  at: string;
  /** A review's state (APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED). */
  state?: string;
  /** Who merged a merged pull request, and whether that is the user. */
  mergedBy?: string | null;
  mergedByMe?: boolean;
  /** A merged pull request of the user's own (else one the user merged). */
  mine?: boolean;
}

/** One page of the day's activity, as the service answers it. */
export interface ActivityPage {
  /** The GitHub user it is for. */
  login: string;
  items: GitHubActivity[];
  /** Where each source's next page starts; a source with none left in the day is absent. */
  more: Partial<Record<ActivitySource, string>>;
  /** How many a search found in all (GitHub's issueCount). */
  totals: Partial<Record<ActivitySource, number>>;
}

/** What Other activities lists: one row per pull request, issue or discussion and what was done there. */
export interface ActivityGroup {
  /** Stable while the day's activity is reread: the kind and the target's id; a highlight keeps it as its `ref`. */
  key: string;
  kind: GitHubActivityKind;
  target: GitHubActivity['target'];
  /** The latest of its activities: where the row opens, and when. */
  url: string;
  at: string;
  /** How many (reviews, comments) it stands for. */
  count: number;
  state?: string;
  mergedBy?: string | null;
  mergedByMe?: boolean;
  mine?: boolean;
}

export const ACTIVITY_SECTIONS: readonly { title: string; kinds: readonly GitHubActivityKind[] }[] = [
  { title: 'Pull requests', kinds: ['opened', 'reviewed', 'merged'] },
  { title: 'Comments', kinds: ['commented'] },
  { title: 'Discussions', kinds: ['discussion', 'discussionComment'] },
];

/** The same pull request reviewed or commented on twice is one row, as one piece of work; the rest one row each. */
export const activityGroups = (items: readonly GitHubActivity[]): ActivityGroup[] => {
  const groups = new Map<string, ActivityGroup>();
  const seen = new Set<string>();
  for (const item of [...items].sort((a, b) => a.at.localeCompare(b.at))) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const key = `${item.kind}:${item.target.id}`;
    const known = groups.get(key);
    if (known) {
      // The latest one is what the row opens and says (a review's last state).
      groups.set(key, { ...known, url: item.url, at: item.at, count: known.count + 1, ...(item.state ? { state: item.state } : {}) });
      continue;
    }
    groups.set(key, {
      key,
      kind: item.kind,
      target: item.target,
      url: item.url,
      at: item.at,
      count: 1,
      ...(item.state ? { state: item.state } : {}),
      ...(item.mergedBy !== undefined ? { mergedBy: item.mergedBy } : {}),
      ...(item.mergedByMe !== undefined ? { mergedByMe: item.mergedByMe } : {}),
      ...(item.mine !== undefined ? { mine: item.mine } : {}),
    });
  }
  return [...groups.values()];
};

const REVIEW_STATES: Record<string, string> = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes requested', COMMENTED: 'commented', DISMISSED: 'dismissed' };

const ref = (target: GitHubActivity['target']): string => `${target.repo}#${target.number}`;

/** The row's short label: what was done. */
export const activityLabel = (group: ActivityGroup): string => {
  const times = group.count > 1 ? ` ×${group.count}` : '';
  switch (group.kind) {
    case 'opened':
      return 'Opened';
    case 'reviewed':
      return `Reviewed${group.state && REVIEW_STATES[group.state] && group.state !== 'COMMENTED' ? ` · ${REVIEW_STATES[group.state]}` : ''}${times}`;
    case 'merged':
      return group.mine && group.mergedBy && !group.mergedByMe ? `Merged by ${group.mergedBy}` : 'Merged';
    case 'commented':
      return `Commented${times}`;
    case 'discussion':
      return 'Started';
    case 'discussionComment':
      return `Commented${times}`;
  }
};

/** The highlight an included row becomes: what was done, where, and its title. */
export const activityText = (group: ActivityGroup): string => {
  const where = `${ref(group.target)}: ${group.target.title}`;
  switch (group.kind) {
    case 'opened':
      return `Opened pull request ${where}`;
    case 'reviewed':
      return `Reviewed pull request ${where}${group.state && group.state !== 'COMMENTED' && REVIEW_STATES[group.state] ? ` (${REVIEW_STATES[group.state]})` : ''}`;
    case 'merged':
      return group.mine && group.mergedBy && !group.mergedByMe ? `Pull request ${where} was merged` : `Merged pull request ${where}`;
    case 'commented':
      return `Commented on ${group.target.type === 'pull' ? 'pull request' : 'issue'} ${where}`;
    case 'discussion':
      return `Started discussion ${where}`;
    case 'discussionComment':
      return `Commented on discussion ${where}`;
  }
};

/** An instant as GitHub's search takes one (`2026-10-29T07:00:00+00:00`), to the second. */
export const searchInstant = (iso: string): string => `${new Date(iso).toISOString().slice(0, 19)}+00:00`;

/** A day as a search range: from its start to the second before the next day starts (GitHub's `..` includes both ends). */
export const searchRange = (from: string, to: string): string => `${searchInstant(from)}..${searchInstant(new Date(Date.parse(to) - 1000).toISOString())}`;

/** The searches the service sends for the day, with the user as `@me` (GitHub's issue search takes it). */
export const activitySearches = (from: string, to: string): Record<'opened' | 'merged' | 'mergedReviewed' | 'mergedInvolved', string> => {
  const day = searchRange(from, to);
  return {
    opened: `is:pr author:@me created:${day}`,
    merged: `is:pr is:merged author:@me merged:${day}`,
    // GitHub's search has no merged-by: pull requests merged that day which the user reviewed or took part in, kept
    // when the user is the one who merged them.
    mergedReviewed: `is:pr is:merged -author:@me reviewed-by:@me merged:${day}`,
    mergedInvolved: `is:pr is:merged -author:@me involves:@me merged:${day}`,
  };
};

/** Where GitHub lists the rest of a source the Planner stopped reading (its bound of pages). */
export const activityMoreUrl = (source: ActivitySource, login: string, from: string, to: string): string => {
  const searches = activitySearches(from, to);
  const since = `>=${searchInstant(from)}`;
  const search = (type: string, q: string) => `https://github.com/search?type=${type}&q=${encodeURIComponent(q.replace(/@me/g, login))}`;
  switch (source) {
    case 'opened':
    case 'merged':
    case 'mergedReviewed':
    case 'mergedInvolved':
      return search('pullrequests', searches[source]);
    case 'reviewed':
      return search('pullrequests', `is:pr reviewed-by:${login} updated:${since}`);
    case 'commented':
      return search('issues', `commenter:${login} updated:${since}`);
    case 'discussions':
      return search('discussions', `author:${login} created:${searchRange(from, to)}`);
    case 'discussionComments':
      return search('discussions', `commenter:${login} updated:${since}`);
  }
};

/** What a cut source is called in "GitHub has more … than the Planner read". */
export const ACTIVITY_SOURCE_NOUNS: Record<ActivitySource, string> = {
  opened: 'pull requests opened',
  merged: 'pull requests merged',
  mergedReviewed: 'pull requests merged',
  mergedInvolved: 'pull requests merged',
  reviewed: 'reviews',
  commented: 'comments',
  discussions: 'discussions',
  discussionComments: 'discussion comments',
};
