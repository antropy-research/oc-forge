// GitHub issues and pull requests through the GitHub CLI of the machine running
// OpenChamber. Read-only, like Sunsama's GitHub integration.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
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

const explain = (error: unknown): string => {
  const failure = error as { code?: string; stderr?: string; message?: string };
  if (failure.code === 'ENOENT') return 'The GitHub CLI (gh) is not installed on the machine running OpenChamber.';
  const text = `${failure.stderr ?? ''} ${failure.message ?? ''}`;
  if (/auth login|not logged|authentication/i.test(text)) return 'Log in once with `gh auth login` on the machine running OpenChamber.';
  return text.trim().split('\n')[0]?.slice(0, 300) || 'gh failed';
};

export class GitHubSource {
  constructor(private readonly run: Runner = ghRunner) {}

  async status(): Promise<GitHubStatus> {
    try {
      const login = (await this.run(['api', 'user', '--jq', '.login'])).trim();
      return { available: true, login: login || null, message: null };
    } catch (error) {
      return { available: false, login: null, message: explain(error) };
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

  /** Current state of the items behind linked tasks. */
  async items(ids: readonly string[]): Promise<GitHubItem[]> {
    if (ids.length === 0) return [];
    const out = await this.run(['api', 'graphql', '-f', `query=${NODES_QUERY}`, ...ids.slice(0, 100).flatMap((id) => ['-f', `ids[]=${id}`])]).catch((error) => {
      throw new Error(explain(error));
    });
    return parseNodes((JSON.parse(out) as { data?: { nodes?: (RawNode | null)[] } }).data?.nodes ?? []);
  }
}
