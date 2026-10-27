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

export interface FakeGithubWorld {
  viewer: string;
  repos: { id: string; owner: string; name: string; defaultBranch: string; bare: string | null }[];
  pulls: FakePull[];
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
  world: FakeGithubWorld;
  requests: FakeGithubRequest[];
  close(): Promise<void>;
}

export const FAKE_TOKEN: string;
export function defaultGithubWorld(options?: { owner?: string; repo?: string; viewer?: string; bare?: string | null; defaultBranch?: string }): FakeGithubWorld;
export function ghConfigFiles(socket: string, viewer?: string): Record<'config.yml' | 'hosts.yml', string>;
export function startFakeGithub(options?: { socket?: string | null; port?: number; world?: FakeGithubWorld; onChange?: () => void }): Promise<FakeGithub>;
