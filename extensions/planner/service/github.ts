// GitHub issues and pull requests through the GitHub CLI of the machine running
// OpenChamber. Read-only, like Sunsama's GitHub integration. A list is read a
// page at a time (each page's cursor reaches the next, so none is left out),
// an item can be found by its URL (pasted into a new task, as in Sunsama),
// linked items are read back in GitHub's batches of 100, and the day's work
// (pull requests, reviews, comments, discussions) is read for Daily Highlights
// (githubActivity.ts).
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { isAbsolute } from 'node:path';
import { parseGitHubUrl, type GitHubItem } from '../src/domain/github.ts';
import type { ActivityPage, ActivitySource } from '../src/domain/githubActivity.ts';
import { readActivity, readActivityPage } from './githubActivity.ts';
import type { SeenPullRequest } from '../src/domain/events.ts';

/** Runs gh; `cwd` picks the repository for commands that infer it from a checkout. */
export type Runner = (args: string[], options?: { cwd?: string; timeoutMs?: number }) => Promise<string>;

/**
 * The host gives up on a service request after 20 seconds and then restarts
 * the service, so one gh call must finish well before that.
 */
const GH_TIMEOUT_MS = 15_000;

/**
 * Runs `gh` with the service's environment (PATH and HOME come from the host). A failure keeps what gh printed: `gh
 * api graphql` exits 1 when GitHub's answer has errors, and still prints the answer, data and all.
 */
export const ghRunner: Runner = (args, options) =>
  new Promise((resolve, reject) => {
    execFile('gh', args, { timeout: options?.timeoutMs ?? GH_TIMEOUT_MS, maxBuffer: 8_000_000, ...(options?.cwd ? { cwd: options.cwd } : {}) }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(new Error(`${error.message}\n${stderr}`), { code: (error as NodeJS.ErrnoException).code, stderr: String(stderr), stdout: String(stdout) }));
      else resolve(stdout);
    });
  });

const ITEM_FIELDS = `__typename
  ... on Issue { id number title url state updatedAt repository { nameWithOwner } }
  ... on PullRequest { id number title url state isDraft updatedAt repository { nameWithOwner } }`;

/** Items a list page has; GitHub's search gives up to 100 a page, 50 keeps one gh call short. */
export const PAGE_SIZE = 50;
/** GitHub's search returns at most this many results of one search, however many match: words narrow it. */
export const SEARCH_MAX = 1000;
/** Node ids GitHub reads in one `nodes(ids:)` call. */
export const NODES_MAX = 100;

/**
 * The repositories the viewer contributes to (their own, and others they committed, opened issues or pull requests,
 * or reviewed in), the most recently pushed first: Sunsama surfaces "the most relevant repositories" this way.
 */
export const REPOS_QUERY = `query PlannerGitHubRepos { viewer { repositoriesContributedTo(first: 25, includeUserRepositories: true, orderBy: { field: PUSHED_AT, direction: DESC }, contributionTypes: [COMMIT, ISSUE, PULL_REQUEST, PULL_REQUEST_REVIEW, REPOSITORY]) { nodes { nameWithOwner } } } }`;

export const LIST_QUERY = `query PlannerGitHubList($q: String!, $after: String) { search(query: $q, type: ISSUE, first: ${PAGE_SIZE}, after: $after) { issueCount pageInfo { hasNextPage endCursor } nodes { ${ITEM_FIELDS} } } }`;
export const NODES_QUERY = `query PlannerGitHubNodes($ids: [ID!]!) { nodes(ids: $ids) { ${ITEM_FIELDS} } }`;
/** An issue or a pull request by its address on github.com. */
export const RESOURCE_QUERY = `query PlannerGitHubResource($url: URI!) { resource(url: $url) { ${ITEM_FIELDS} } }`;

export const LISTS = {
  assigned: 'is:open is:issue assignee:@me archived:false sort:updated-desc',
  review: 'is:open is:pr review-requested:@me archived:false sort:updated-desc',
  mine: 'is:open is:pr author:@me archived:false sort:updated-desc',
} as const;

export type ListKind = keyof typeof LISTS;

/** A list's search: its own qualifiers, then the words that narrow it (GitHub's search syntax: text, repo:owner/name, label:…). */
export const listQuery = (kind: ListKind, text = ''): string => {
  const words = text.replace(/\s+/g, ' ').trim();
  return words ? `${LISTS[kind]} ${words}` : LISTS[kind];
};

/** One page of a list: its items, how many match in all, and the cursor of the next page (null after the last). */
export interface GitHubPage {
  items: GitHubItem[];
  total: number;
  next: string | null;
}

/** GraphQL's answer, or its first error as an error (an answer with errors and no data is not an empty list). */
const graphqlData = <T>(out: string): T => {
  const parsed = JSON.parse(out) as { data?: T | null; errors?: { message?: string }[] };
  if (!parsed.data && parsed.errors?.length) throw new Error(parsed.errors[0]?.message ?? 'GitHub returned an error');
  return (parsed.data ?? {}) as T;
};

interface RawNode {
  __typename?: string;
  id?: string;
  number?: number;
  title?: string;
  url?: string;
  state?: string;
  isDraft?: boolean;
  updatedAt?: string;
  repository?: { nameWithOwner?: string };
}

export const parseNodes = (nodes: readonly (RawNode | null)[]): GitHubItem[] =>
  nodes.flatMap((node): GitHubItem[] => {
    if (!node?.id || !node.number || !node.title || !node.url || !node.repository?.nameWithOwner) return [];
    const kind = node.__typename === 'PullRequest' ? 'pull' : 'issue';
    return [{
      id: node.id,
      kind,
      repo: node.repository.nameWithOwner,
      number: node.number,
      key: `${node.repository.nameWithOwner}#${node.number}`,
      title: node.title,
      url: node.url,
      state: node.state ?? 'OPEN',
      draft: Boolean(node.isDraft),
      updatedAt: node.updatedAt ?? '',
    }];
  });

export interface GitHubStatus {
  available: boolean;
  login: string | null;
  message: string | null;
  /** Why GitHub is out of reach: gh is not installed, or not signed in; null when it works or failed otherwise. */
  reason?: 'missing' | 'signed-out' | null;
  /** Where to sign gh in from: inside the container OpenChamber runs in (its id, as `docker exec` takes it), or null for this machine. */
  container?: string | null;
}

interface RawPull {
  number?: number;
  url?: string;
  state?: string;
  isDraft?: boolean;
  title?: string;
  updatedAt?: string;
}

const PULL_FIELDS = 'number,url,state,isDraft,title,updatedAt';
const PULL_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100})\/pull\/\d{1,9}$/;
/** A git branch name as git allows it, without anything gh could read as an option. */
const BRANCH = /^(?![-/.])(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,200}(?<![/.])$/;

/** The pull request to show for a branch: an open one, else a merged one, else the latest. */
export const pickPull = (pulls: readonly RawPull[]): SeenPullRequest | null => {
  const rank = { open: 0, merged: 1, closed: 2 } as const;
  const parsed = pulls.flatMap((pull) => {
    const match = PULL_URL.exec(pull.url ?? '');
    const state = pull.state?.toLowerCase();
    if (!match || !pull.number || !pull.title || !(state === 'open' || state === 'merged' || state === 'closed')) return [];
    return [{ pr: { number: pull.number, url: pull.url!, state, draft: Boolean(pull.isDraft), title: pull.title.slice(0, 500), repo: match[1]! } as SeenPullRequest, updatedAt: pull.updatedAt ?? '' }];
  });
  return parsed.sort((a, b) => rank[a.pr.state] - rank[b.pr.state] || b.updatedAt.localeCompare(a.updatedAt))[0]?.pr ?? null;
};

/** gh's failure, in words the user can act on, and whether it is a missing or signed-out gh. */
export const diagnose = (error: unknown): { reason: 'missing' | 'signed-out' | null; message: string } => {
  const failure = error as { code?: string; stderr?: string; message?: string };
  if (failure.code === 'ENOENT') return { reason: 'missing', message: 'The GitHub CLI (gh) is not installed where OpenChamber runs. Install it there, then sign in with `gh auth login`.' };
  const text = `${failure.stderr ?? ''} ${failure.message ?? ''}`;
  if (/auth login|not logged|authentication|GH_TOKEN|bad credentials|HTTP 401/i.test(text)) {
    return { reason: 'signed-out', message: 'The GitHub CLI (gh) is not signed in. Run `gh auth login` once where OpenChamber runs; a GH_TOKEN set for OpenChamber does not reach the Planner.' };
  }
  return { reason: null, message: text.trim().split('\n')[0]?.slice(0, 300) || 'gh failed' };
};

const explain = (error: unknown): string => diagnose(error).message;

/** The container this service runs in, by the id `docker exec` takes (its hostname), or null on a plain machine. */
export const containerId = (): string | null => {
  if (!existsSync('/.dockerenv') && !existsSync('/run/.containerenv')) return null;
  const name = hostname();
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name) ? name : null;
};

export class GitHubSource {
  constructor(private readonly run: Runner = ghRunner, private readonly container: () => string | null = containerId) {}

  /**
   * `gh api graphql`: GitHub's answer. gh exits 1 when the answer has errors beside its data (a linked issue deleted
   * since, which `nodes(ids:)` answers with null and an error): the data is still the answer then.
   */
  private async graphql(args: string[]): Promise<string> {
    try {
      return await this.run(['api', 'graphql', ...args]);
    } catch (error) {
      const printed = (error as { stdout?: string }).stdout;
      if (printed && /^\s*\{[\s\S]*"data"\s*:\s*\{/.test(printed)) return printed;
      throw new Error(explain(error));
    }
  }

  async status(): Promise<GitHubStatus> {
    try {
      const login = (await this.run(['api', 'user', '--jq', '.login'])).trim();
      return { available: true, login: login || null, message: null, reason: null, container: null };
    } catch (error) {
      const { reason, message } = diagnose(error);
      return { available: false, login: null, message, reason, container: reason ? this.container() : null };
    }
  }

  /** The repositories most relevant to the viewer (REPOS_QUERY), read again after ten minutes. */
  async repositories(): Promise<string[]> {
    if (this.repos && Date.now() - this.repos.at < 10 * 60_000) return this.repos.names;
    const out = await this.graphql(['-f', `query=${REPOS_QUERY}`]);
    const nodes = graphqlData<{ viewer?: { repositoriesContributedTo?: { nodes?: ({ nameWithOwner?: string } | null)[] } } }>(out).viewer?.repositoriesContributedTo?.nodes ?? [];
    const names = nodes.flatMap((node) => (node?.nameWithOwner && /^[\w.-]+\/[\w.-]+$/.test(node.nameWithOwner) ? [node.nameWithOwner] : []));
    this.repos = { at: Date.now(), names };
    return names;
  }

  private repos: { at: number; names: string[] } | null = null;

  /** A page of a list, from `after` (the previous page's cursor), narrowed by `text`. */
  async list(kind: ListKind, options: { after?: string | null; text?: string } = {}): Promise<GitHubPage> {
    const out = await this.graphql(['-f', `query=${LIST_QUERY}`, '-f', `q=${listQuery(kind, options.text)}`, ...(options.after ? ['-f', `after=${options.after}`] : [])]);
    type Search = { issueCount?: number; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; nodes?: RawNode[] };
    const search = graphqlData<{ search?: Search }>(out).search;
    const items = parseNodes(search?.nodes ?? []);
    // A next page without a cursor to reach it would be asked for again forever.
    const next = search?.pageInfo?.hasNextPage && search.pageInfo.endCursor ? search.pageInfo.endCursor : null;
    return { items, total: Math.max(search?.issueCount ?? 0, items.length), next };
  }

  /** An issue or a pull request by its URL (pasted into a new task), as GitHub has it now; null when GitHub has none there. */
  async byUrl(url: string): Promise<GitHubItem | null> {
    const parsed = parseGitHubUrl(url);
    if (!parsed) throw new Error('not a GitHub issue or pull request URL');
    const out = await this.graphql(['-f', `query=${RESOURCE_QUERY}`, '-f', `url=${parsed.url}`]);
    const parsedAnswer = JSON.parse(out) as { data?: { resource?: RawNode | null } | null; errors?: { type?: string; message?: string }[] };
    if (!parsedAnswer.data?.resource && parsedAnswer.errors?.length && !parsedAnswer.errors.every((error) => error.type === 'NOT_FOUND')) throw new Error(parsedAnswer.errors[0]?.message ?? 'GitHub returned an error');
    return parseNodes([parsedAnswer.data?.resource ?? null])[0] ?? null;
  }

  /**
   * The pull request opened from `branch`, asked in the first of `directories`
   * that is still there (gh finds the repository from that checkout); null when
   * the branch has none, or no directory is left to ask in.
   */
  async pullRequestFor(branch: string, directories: readonly string[]): Promise<SeenPullRequest | null> {
    if (!BRANCH.test(branch)) throw new Error('branch name is invalid');
    let failure: unknown = null;
    for (const directory of directories) {
      if (!isAbsolute(directory) || !existsSync(directory)) continue;
      try {
        // Several lookups share one service request; each stays short.
        const out = await this.run(['pr', 'list', '--head', branch, '--state', 'all', '--limit', '10', '--json', PULL_FIELDS], { cwd: directory, timeoutMs: 8_000 });
        return pickPull(JSON.parse(out) as RawPull[]);
      } catch (error) {
        failure = error;
      }
    }
    if (failure) throw new Error(explain(failure));
    return null;
  }

  /** A pull request by its URL (one linked to the run's chat, or seen before); gh needs no checkout for it. */
  async pullRequestAt(url: string): Promise<SeenPullRequest | null> {
    if (!PULL_URL.test(url)) throw new Error('pull request URL is invalid');
    const out = await this.run(['pr', 'view', url, '--json', PULL_FIELDS], { timeoutMs: 8_000 }).catch((error) => {
      throw new Error(explain(error));
    });
    return pickPull([JSON.parse(out) as RawPull]);
  }

  /** Current state of the items behind linked tasks, all of them, in GitHub's batches of 100. */
  async items(ids: readonly string[]): Promise<GitHubItem[]> {
    const found: GitHubItem[] = [];
    for (let index = 0; index < ids.length; index += NODES_MAX) {
      const out = await this.graphql(['-f', `query=${NODES_QUERY}`, ...ids.slice(index, index + NODES_MAX).flatMap((id) => ['-f', `ids[]=${id}`])]);
      found.push(...parseNodes(graphqlData<{ nodes?: (RawNode | null)[] }>(out).nodes ?? []));
    }
    return found;
  }

  /** The day's GitHub work [from, to), for Daily Highlights: the first page of each source, in one gh call. */
  activity(from: string, to: string): Promise<ActivityPage> {
    return readActivity((args) => this.graphql(args), from, to);
  }

  /** The next page of one source of the day's GitHub work, from `after`. */
  activityPage(source: ActivitySource, from: string, to: string, after: string): Promise<ActivityPage> {
    return readActivityPage((args) => this.graphql(args), source, from, to, after);
  }
}
