// Helpers for Area E's scenarios (tests/github.test.ts, gmail.test.ts, agents.test.ts): OpenChamber's relay between a
// window and the service when it is slow, what a window's error line said, and GitHub worlds for the fake GitHub
// behind the real gh (tests/e2e/fakeGithub.mjs).
import type { GitHubItem } from '../../src/domain/github/github.ts';
import { fakeIssue, type FakeGithubWorld, type FakeIssue } from '../e2e/fakeGithub.mjs';
import type { PlannerWindow } from './planner.ts';

type Request = { method: string; path: string; body?: string };
type Answer = { status: number; body: string };

/**
 * An answer held on its way from the service back to the window, until the test lets it through or fails it;
 * `answered` settles once the service has answered (what it read is then fixed).
 */
export type HeldAnswer = { method: string; path: string; answered: Promise<unknown>; release(): void; fail(status: number, error: string): void };

/**
 * A window's relay to the service, made slow: the requests `hold` picks reach the service at once (it reads GitHub,
 * Gmail or OpenCode then), but their answers wait in `held` until the test releases them, in the order it likes, or
 * fails them as a relay can. `asked` lists every request the window sent, held or not.
 */
export const slowRelay = (window: PlannerWindow) => {
  const host = window.host as unknown as { serviceRequest(request: Request): Promise<Answer> };
  const send = host.serviceRequest.bind(host);
  const held: HeldAnswer[] = [];
  const asked: string[] = [];
  let pick: (request: Request) => boolean = () => false;
  host.serviceRequest = (request) => {
    asked.push(`${request.method} ${request.path}`);
    if (!pick(request)) return send(request);
    const answer = send(request);
    const answered = answer.catch(() => {});
    return new Promise((resolve) => held.push({ method: request.method, path: request.path, answered, release: () => resolve(answer), fail: (status, error) => resolve({ status, body: JSON.stringify({ error }) }) }));
  };
  return { held, asked, hold: (next: (request: Request) => boolean) => void (pick = next) };
};

/** Picks the first `count` requests `test` matches from now on, then none. */
export const firstOf = (test: (request: Request) => boolean, count = 1) => {
  let left = count;
  return (request: Request) => test(request) && left-- > 0;
};

/**
 * A store's `start()`, with the timers it sets kept back: each comes back as a function that runs it as the browser
 * would after its minutes in a visible page.
 */
export const startKeepingTimers = async (start: () => Promise<void>): Promise<(() => void)[]> => {
  const kept: (() => void)[] = [];
  const real = globalThis.setInterval;
  globalThis.setInterval = ((fn: () => void) => (kept.push(fn), 0)) as unknown as typeof setInterval;
  try {
    await start();
  } finally {
    globalThis.setInterval = real;
  }
  const page = globalThis as { document?: unknown };
  return kept.map((fn) => () => {
    const had = 'document' in page;
    const before = page.document;
    page.document = { hidden: false };
    try {
      fn();
    } finally {
      if (had) page.document = before;
      else delete page.document;
    }
  });
};

/** Everything a window's error line says from now on (`client.notify`, a refused change), each message as it shows. */
export const notesOf = (window: PlannerWindow): string[] => {
  const notes: string[] = [];
  let last = window.client.getView().error;
  window.client.subscribe(() => {
    const error = window.client.getView().error;
    if (error && error !== last) notes.push(error);
    last = error;
  });
  return notes;
};

/** The fake GitHub's viewer, whom gh is signed in as. */
export const VIEWER = 'harness-bot';

/** `count` issues of `repo` titled "<word> N", assigned to the viewer; #1 updated last, so a list reads them in order. */
export const assignedIssues = (repo: string, word: string, count: number): FakeIssue[] =>
  Array.from({ length: count }, (_, n) => fakeIssue(repo, n + 1, { title: `${word} ${n + 1}`, assignees: [VIEWER], updatedAt: new Date(Date.UTC(2026, 9, 28) - (n + 1) * 60_000).toISOString() }));

/** `count` open pull requests of `repo` titled "<word> N" that ask the viewer's review; #1 updated last. */
export const reviewRequests = (repo: string, word: string, count: number): FakeGithubWorld['pulls'] =>
  Array.from({ length: count }, (_, n) => {
    const number = n + 1;
    const at = new Date(Date.UTC(2026, 9, 28) - number * 60_000).toISOString();
    return { id: `PR_${repo.replace(/\W/g, '_')}_${number}`, number, repo, url: `https://github.com/${repo}/pull/${number}`, title: `${word} ${number}`, body: '', headRefName: `${word}-${number}`, baseRefName: 'main', headOid: `oid-${number}`, isDraft: false, state: 'OPEN', createdAt: at, updatedAt: at, reviewRequested: [VIEWER] };
  });

/** A fake issue as the Planner's GitHub source reads it, to plan it with (the domain's task source). */
export const itemOf = (issue: FakeIssue): GitHubItem => ({ id: issue.id, kind: 'issue', repo: issue.repo, number: issue.number, key: `${issue.repo}#${issue.number}`, title: issue.title, url: issue.url, state: issue.state, draft: false, updatedAt: issue.updatedAt });
