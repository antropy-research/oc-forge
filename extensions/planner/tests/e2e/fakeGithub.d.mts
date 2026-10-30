// Types for fakeGithub.mjs, so the TypeScript tests can use it.
export interface FakePull {
  id: string;
  number: number;
  repo: string;
  url: string;
  title: string;
  body: string;
  headRefName: string;
  baseRefName: string;
  headOid: string;
  isDraft: boolean;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  createdAt: string;
  updatedAt: string;
}

export interface FakeIssue {
  id: string;
  number: number;
  repo: string;
  url: string;
  title: string;
  state: 'OPEN' | 'CLOSED';
  assignees: string[];
  updatedAt: string;
}

/** A pull request's review, as the day's work reads it (contributionsCollection). */
export interface FakeReview {
  id: string;
  author: string;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED';
  submittedAt: string;
  url: string;
}

/** A comment on an issue or a pull request (`on` is its URL). */
export interface FakeIssueComment {
  id: string;
  author: string;
  on: string;
  url: string;
  createdAt: string;
  updatedAt: string;
}

export interface FakeDiscussion {
  id: string;
  number: number;
  repo: string;
  title: string;
  url: string;
  author: string;
  createdAt: string;
}

export interface FakeDiscussionComment {
  id: string;
  discussionId: string;
  author: string;
  url: string;
  createdAt: string;
}

export interface FakeGithubWorld {
  viewer: string;
  repos: { id: string; owner: string; name: string; defaultBranch: string; bare: string | null }[];
  pulls: (FakePull & { reviewRequested?: string[]; author?: string; mergedAt?: string | null; mergedBy?: string | null; reviews?: FakeReview[]; assignees?: string[] })[];
  issues?: FakeIssue[];
  issueComments?: FakeIssueComment[];
  discussions?: FakeDiscussion[];
  discussionComments?: FakeDiscussionComment[];
  next: number;
}

export interface FakeGithubRequest {
  method: string;
  path: string;
  operation?: string;
  variables?: Record<string, unknown>;
  query?: Record<string, string>;
  body?: unknown;
}

export interface FakeGithub {
  socket: string | null;
  port: number | null;
  /** The repositories' git server (smart HTTP), when started with `gitPort`. */
  gitPort: number | null;
  gitUrl(owner: string, name: string): string | null;
  world: FakeGithubWorld;
  requests: FakeGithubRequest[];
  close(): Promise<void>;
}

export const FAKE_TOKEN: string;
export function defaultGithubWorld(options?: { owner?: string; repo?: string; viewer?: string; bare?: string | null; defaultBranch?: string }): FakeGithubWorld;
export function ghConfigFiles(socket: string, viewer?: string): Record<'config.yml' | 'hosts.yml', string>;
export function fakeIssue(repo: string, number: number, options?: { title?: string; state?: 'OPEN' | 'CLOSED'; assignees?: string[]; updatedAt?: string }): FakeIssue;
export function startFakeGithub(options?: { socket?: string | null; port?: number; gitPort?: number | null; world?: FakeGithubWorld; onChange?: () => void }): Promise<FakeGithub>;
