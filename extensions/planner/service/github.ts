// GitHub issues and pull requests through the GitHub CLI of the machine running
// OpenChamber. Read-only, like Sunsama's GitHub integration.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { isAbsolute } from 'node:path';
import type { GitHubItem } from '../src/domain/github.ts';
import type { SeenPullRequest } from '../src/domain/events.ts';

/** Runs gh; `cwd` picks the repository for commands that infer it from a checkout. */
export type Runner = (args: string[], options?: { cwd?: string; timeoutMs?: number }) => Promise<string>;

/**
 * The host gives up on a service request after 20 seconds and then restarts
 * the service, so one gh call must finish well before that.
 */
const GH_TIMEOUT_MS = 15_000;

/** Runs `gh` with the service's environment (PATH and HOME come from the host). */
export const ghRunner: Runner = (args, options) =>
  new Promise((resolve, reject) => {
    execFile('gh', args, { timeout: options?.timeoutMs ?? GH_TIMEOUT_MS, maxBuffer: 8_000_000, ...(options?.cwd ? { cwd: options.cwd } : {}) }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(new Error(`${error.message}\n${stderr}`), { code: (error as NodeJS.ErrnoException).code, stderr: String(stderr) }));
      else resolve(stdout);
    });
  });

const ITEM_FIELDS = `__typename
  ... on Issue { id number title url state updatedAt repository { nameWithOwner } }
  ... on PullRequest { id number title url state isDraft updatedAt repository { nameWithOwner } }`;

export const LIST_QUERY = `query PlannerGitHubList($q: String!) { search(query: $q, type: ISSUE, first: 50) { nodes { ${ITEM_FIELDS} } } }`;
export const NODES_QUERY = `query PlannerGitHubNodes($ids: [ID!]!) { nodes(ids: $ids) { ${ITEM_FIELDS} } }`;

export const LISTS = {
  assigned: 'is:open is:issue assignee:@me archived:false sort:updated-desc',
  review: 'is:open is:pr review-requested:@me archived:false sort:updated-desc',
  mine: 'is:open is:pr author:@me archived:false sort:updated-desc',
} as const;

export type ListKind = keyof typeof LISTS;

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

  async status(): Promise<GitHubStatus> {
    try {
      const login = (await this.run(['api', 'user', '--jq', '.login'])).trim();
      return { available: true, login: login || null, message: null, reason: null, container: null };
    } catch (error) {
      const { reason, message } = diagnose(error);
      return { available: false, login: null, message, reason, container: reason ? this.container() : null };
    }
  }

  async list(kind: ListKind): Promise<GitHubItem[]> {
    const out = await this.run(['api', 'graphql', '-f', `query=${LIST_QUERY}`, '-f', `q=${LISTS[kind]}`]).catch((error) => {
      throw new Error(explain(error));
    });
    return parseNodes((JSON.parse(out) as { data?: { search?: { nodes?: RawNode[] } } }).data?.search?.nodes ?? []);
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

  /** Current state of the items behind linked tasks. */
  async items(ids: readonly string[]): Promise<GitHubItem[]> {
    if (ids.length === 0) return [];
    const out = await this.run(['api', 'graphql', '-f', `query=${NODES_QUERY}`, ...ids.slice(0, 100).flatMap((id) => ['-f', `ids[]=${id}`])]).catch((error) => {
      throw new Error(explain(error));
    });
    return parseNodes((JSON.parse(out) as { data?: { nodes?: (RawNode | null)[] } }).data?.nodes ?? []);
  }
}
