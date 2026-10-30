// Round 12's review found GitHub's Load more stuck when the search changed before it answered (P1-2). Its audit of every
// other read that a newer one can overtake: an older answer, or its error, never shows over the newer one's, and nothing
// is left loading. GitHub's own list is in github.test.ts, Linear's lists and views in linearStore.test.ts.
import { describe, expect, test } from 'bun:test';
import type { HostClient } from '@openchamber/sdk';
import { GoogleStore } from '../panel/lib/google.ts';
import { GmailStore } from '../panel/lib/gmail.ts';
import { AgentStore } from '../panel/lib/agents.ts';
import { keptRead, readAndKeep } from '../panel/lib/githubActivity.ts';
import type { PlannerClient } from '../panel/lib/client.ts';
import type { GoogleTaskItem } from '../src/domain/google.ts';
import { emptyState } from '../src/domain/types.ts';

const ME = 'harness@example.com';
const OTHER = 'other@example.com';
const host = { storage: { get: async () => undefined, set: async () => {}, delete: async () => {}, keys: async () => [] } } as unknown as HostClient;

/** A Planner client whose calls wait until the test answers or fails each of them. */
const heldClient = () => {
  const calls: { method: string; path: string; answer: (value: unknown) => void; fail: (error: Error) => void }[] = [];
  const client = {
    getView: () => ({ state: emptyState(), today: '2026-10-30' }),
    call: (method: string, path: string) => new Promise((answer, fail) => calls.push({ method, path, answer, fail })),
    dispatch: async () => {},
    onCommitted: () => () => {},
    notify: () => {},
  } as unknown as PlannerClient;
  return { client, calls };
};
const settle = () => new Promise((resolve) => setImmediate(resolve));
const mail = (id: string) => ({ id, threadId: id, account: ME, from: 'a@example.com', subject: id, snippet: '', date: '2026-10-30T08:00:00.000Z', labelIds: ['INBOX'], unread: false });
const gtask = (id: string, listId = 'L1'): GoogleTaskItem => ({ account: ME, listId, id, title: id, notes: '', due: null, completed: false, parent: null, position: id, url: '', updated: '2026-10-30T08:00:00.000Z' });

describe('Gmail: the newest search is the list', () => {
  test('Refresh while Load more is on its way: the old page never joins the list read again', async () => {
    const { client, calls } = heldClient();
    const google = new GoogleStore(host, client, 'page');
    google.setMailAccount(ME);
    calls[0]!.answer({ messages: [mail('m1'), mail('m2')], nextPageToken: 't2' });
    await settle();
    void google.searchMail(google.getView().mailQuery, true);
    void google.searchMail();
    expect(calls.map((call) => call.path.includes('pageToken=t2'))).toEqual([false, true, false]);
    calls[2]!.answer({ messages: [mail('m0'), mail('m1')], nextPageToken: 't2b' });
    await settle();
    calls[1]!.answer({ messages: [mail('m3')], nextPageToken: 't3' });
    await settle();
    expect([google.getView().mail.map((item) => item.id), google.getView().mailNext, google.getView().mailLoading]).toEqual([['m0', 'm1'], 't2b', false]);
  });

  test('a search left behind that fails says nothing over the newer one', async () => {
    const { client, calls } = heldClient();
    const google = new GoogleStore(host, client, 'page');
    google.setMailAccount(ME);
    void google.searchMail('is:starred');
    calls[1]!.answer({ messages: [mail('s1')], nextPageToken: null });
    await settle();
    calls[0]!.fail(new Error('Gmail answered HTTP 500'));
    await settle();
    expect([google.getView().mail.map((item) => item.id), google.getView().mailError, google.getView().mailLoading]).toEqual([['s1'], null, false]);
  });

  test('another account while a search is on its way: nothing is left loading, so the panel searches the new one', async () => {
    const { client, calls } = heldClient();
    const google = new GoogleStore(host, client, 'page');
    google.setMailAccount(ME);
    // What a status read does when the account went away: another one, with nothing searched yet.
    (google as unknown as { set: (patch: object) => void }).set({ mailAccount: OTHER, mail: [], mailNext: null });
    calls[0]!.answer({ messages: [mail('m1')], nextPageToken: 't2' });
    await settle();
    expect([google.getView().mail, google.getView().mailLoading, google.getView().mailNext]).toEqual([[], false, null]);
  });
});

describe('Google Tasks: the newest read of a list shows', () => {
  test('the list read twice at once: the older answer, or its error, never shows over the newer one', async () => {
    const { client, calls } = heldClient();
    const google = new GoogleStore(host, client, 'page');
    google.selectList(ME, 'L1');
    void google.refreshTasks();
    calls[1]!.answer({ tasks: [gtask('new')] });
    await settle();
    calls[0]!.answer({ tasks: [gtask('old')] });
    await settle();
    expect([google.getView().tasks.map((item) => item.id), google.getView().tasksLoading]).toEqual([['new'], false]);
    void google.refreshTasks();
    google.selectList(ME, 'L2');
    calls[3]!.answer({ tasks: [gtask('two', 'L2')] });
    await settle();
    calls[2]!.fail(new Error('Google answered HTTP 503'));
    await settle();
    expect([google.getView().tasks.map((item) => item.id), google.getView().tasksError, google.getView().tasksLoading]).toEqual([['two'], null, false]);
  });

  test("the Tasks view's list read twice at once (after a change made there): the newer read shows", async () => {
    const { client, calls } = heldClient();
    const google = new GoogleStore(host, client, 'page');
    void google.loadBoard(ME, 'L1');
    void google.loadBoard(ME, 'L1');
    calls[1]!.answer({ tasks: [gtask('a'), gtask('b')], complete: true });
    await settle();
    calls[0]!.answer({ tasks: [gtask('a')], complete: true });
    await settle();
    expect(google.getView().board[`${ME}\nL1`]).toMatchObject({ items: [{ id: 'a' }, { id: 'b' }], loading: false, error: null });
    void google.loadBoard(ME, 'L1');
    void google.loadBoard(ME, 'L1');
    const [, , older, newer] = calls.filter((call) => call.path.startsWith('/google/tasks/all'));
    newer!.answer({ tasks: [gtask('a'), gtask('b'), gtask('c')], complete: true });
    await settle();
    older!.fail(new Error('Google answered HTTP 503'));
    await settle();
    expect(google.getView().board[`${ME}\nL1`]).toMatchObject({ items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], loading: false, error: null });
  });
});

describe("Gmail: an email task's thread", () => {
  test('read twice at once (after an action on it): the older answer, or its error, never shows over the newer one', async () => {
    const { client, calls } = heldClient();
    const gmail = new GmailStore(client, new GoogleStore(host, client, 'page'), 'page');
    const thread = (labelIds: string[]) => ({ id: 'th1', account: ME, messages: [], labelIds });
    void gmail.loadThread(ME, 'th1');
    void gmail.loadThread(ME, 'th1');
    calls[1]!.answer({ thread: thread([]) });
    await settle();
    calls[0]!.answer({ thread: thread(['INBOX']) });
    await settle();
    const shown = () => Object.values(gmail.getView().threads)[0];
    expect(shown()).toEqual({ loading: false, thread: thread([]), error: null });
    void gmail.loadThread(ME, 'th1');
    void gmail.loadThread(ME, 'th1');
    calls[3]!.answer({ thread: thread(['STARRED']) });
    await settle();
    calls[2]!.fail(new Error('Gmail answered HTTP 500'));
    await settle();
    expect(shown()).toEqual({ loading: false, thread: thread(['STARRED']), error: null });
  });
});

describe("the agents and models to assign to", () => {
  const catalog = (name: string, modelsPending = false) => ({ agents: [{ name, mode: 'primary' }], defaultAgent: name, models: [], modelsError: null, modelsPending, configDir: '/cfg' });

  test("Look again while the folder's catalog is on its way: the newer answer stands", async () => {
    const { client, calls } = heldClient();
    const agents = new AgentStore(host, client, 'page');
    void agents.loadCatalog('/a');
    void agents.loadCatalog('/a', true);
    calls[1]!.answer(catalog('fresh'));
    await settle();
    calls[0]!.answer(catalog('stale'));
    await settle();
    expect([agents.getView().catalog?.defaultAgent, agents.getView().catalogLoading]).toEqual(['fresh', false]);
  });

  test("another folder before the models came: the first folder's models are not read again over it", async () => {
    const { client, calls } = heldClient();
    const agents = new AgentStore(host, client, 'page');
    const timers: (() => void)[] = [];
    const realTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void) => timers.push(fn)) as unknown as typeof setTimeout;
    try {
      void agents.loadCatalog('/a');
      calls[0]!.answer(catalog('a', true));
      await settle();
      void agents.loadCatalog('/b');
      calls[1]!.answer(catalog('b'));
      await settle();
      for (const timer of timers) timer();
      await settle();
      expect([calls.length, agents.getView().catalog?.defaultAgent]).toEqual([2, 'b']);
    } finally {
      globalThis.setTimeout = realTimeout;
    }
  });
});

describe("Daily Highlights' GitHub activity, kept for going back to a day", () => {
  test('read twice at once (a Refresh): what is kept is the read asked for last, whichever answers last', async () => {
    const { client, calls } = heldClient();
    const page = (id: string) => ({ login: 'me', items: [{ id, kind: 'opened', target: { id: 'I_1', repo: 'acme/app', number: 1, title: 'One', url: 'https://github.com/acme/app/issues/1', type: 'issue' }, url: 'https://github.com/acme/app/issues/1', at: '2026-10-29T08:00:00.000Z' }], more: {}, totals: {} });
    const key = '2026-10-29|America/Los_Angeles';
    const first = readAndKeep(client, key, '2026-10-29T07:00:00.000Z', '2026-10-30T07:00:00.000Z');
    const again = readAndKeep(client, key, '2026-10-29T07:00:00.000Z', '2026-10-30T07:00:00.000Z');
    calls[1]!.answer(page('newer'));
    await again;
    calls[0]!.answer(page('older'));
    await first;
    expect(keptRead(key)?.items.map((item) => item.id)).toEqual(['newer']);
  });
});
