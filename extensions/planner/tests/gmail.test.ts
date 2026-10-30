// Round 12, Gmail as Sunsama's integration has it (help.sunsama.com/docs/integrations/gmail): the actions on an email
// task (Archive, Move to trash, Mark as unread, labels) as Gmail label changes; the panel's labels (one, Cmd/Ctrl adds)
// and filters (archived, spam and trash) as one Gmail search; the custom email client; a message's text; the import
// and completion automations (or their prompt) after the user's own changes; and the service's routes against the
// fake Google: labels, a thread with its text, the actions (only with Gmail actions allowed), Google Contacts.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MAIL_FILTER, emailUrl, gmailChanges, mailQuery, messageText, pickLabel, sourceUrl, threadIdOf } from '../src/domain/gmail.ts';
import { GmailStore } from '../panel/lib/gmail.ts';
import type { GoogleStore } from '../panel/lib/google.ts';
import type { PlannerClient, CommitListener } from '../panel/lib/client.ts';
import { applyEvents } from '../src/domain/reducer.ts';
import type { Command, EventBody, PlannerEvent } from '../src/domain/events.ts';
import { emptyState, type PlannerState, type TaskSourceRef } from '../src/domain/types.ts';
import { todayIn } from '../src/domain/dates.ts';
import { CONTACTS_SCOPES, DEFAULT_SCOPES, GMAIL_MODIFY_SCOPE, defaultFakeWorld, startFakeGoogle, type FakeGoogle } from './e2e/fakeGoogle.mjs';

const ME = 'harness@example.com';
const OTHER = 'other@example.com';
const labels = [{ id: 'Label_7', name: 'In progress', type: 'user' as const }];
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64url');

describe("Gmail's actions and the panel's view, as Gmail takes them", () => {
  test('actions are label changes on the thread (the last word wins), the trash last; a label the account lacks is named', () => {
    expect(gmailChanges([{ kind: 'markRead' }, { kind: 'removeLabel', label: 'Inbox' }, { kind: 'addLabel', label: 'in progress' }], labels)).toEqual({ add: ['Label_7'], remove: ['UNREAD', 'INBOX'], trash: false, missing: [] });
    expect(gmailChanges([{ kind: 'archive' }, { kind: 'markUnread' }, { kind: 'star' }], labels)).toEqual({ add: ['UNREAD', 'STARRED'], remove: ['INBOX'], trash: false, missing: [] });
    expect(gmailChanges([{ kind: 'markUnread' }, { kind: 'markRead' }], labels)).toEqual({ add: [], remove: ['UNREAD'], trash: false, missing: [] });
    expect(gmailChanges([{ kind: 'trash' }, { kind: 'addLabel', label: 'Waiting' }], labels)).toEqual({ add: [], remove: [], trash: true, missing: ['Waiting'] });
  });

  test("labels and filters make one search: the Inbox at first; a label alone, or several (all must match); archived, spam and trash only when shown", () => {
    expect(mailQuery(DEFAULT_MAIL_FILTER)).toBe('in:inbox');
    expect(mailQuery({ ...DEFAULT_MAIL_FILTER, labels: ['In progress'] })).toBe('label:in-progress in:inbox');
    expect(mailQuery({ ...DEFAULT_MAIL_FILTER, labels: ['In progress', 'Starred'], archived: true })).toBe('label:in-progress is:starred');
    expect(mailQuery({ ...DEFAULT_MAIL_FILTER, labels: ['Inbox'], archived: true, spamTrash: true, words: ' from:ann  budget ' })).toBe('in:inbox in:anywhere from:ann budget');
    // A click shows that label alone; Cmd/Ctrl adds it, or takes it off (the Inbox when none are left).
    expect(pickLabel(['Inbox'], 'Starred', false)).toEqual(['Starred']);
    expect(pickLabel(['Inbox'], 'Starred', true)).toEqual(['Inbox', 'Starred']);
    expect(pickLabel(['Starred'], 'starred', true)).toEqual(['Inbox']);
  });

  test('an email opens in Gmail, or in Superhuman when that is the email client; other links open as they are', () => {
    const source: TaskSourceRef = { kind: 'email', id: 'm1', key: 'Gmail', url: `https://mail.google.com/mail/u/${encodeURIComponent(ME)}/#all/18b2f3c4d5e6f700`, account: ME };
    expect(threadIdOf(source)).toBe('18b2f3c4d5e6f700');
    expect(emailUrl(source, 'gmail')).toBe(source.url);
    expect(emailUrl(source, 'superhuman')).toBe(`https://mail.superhuman.com/${encodeURIComponent(ME)}/thread/18b2f3c4d5e6f700`);
    expect(sourceUrl({ kind: 'github', id: 'I_1', key: 'acme/app#1', url: 'https://github.com/acme/app/issues/1' }, { emailClient: 'superhuman' })).toBe('https://github.com/acme/app/issues/1');
  });

  test("a message's text: its plain part first, else its HTML without tags; UTF-8 kept", () => {
    expect(messageText({ mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/html', body: { data: b64('<p>Hi</p>') } }, { mimeType: 'text/plain', body: { data: b64('Hi Ann,\r\nsee you — Bo') } }] })).toBe('Hi Ann,\nsee you — Bo');
    expect(messageText({ mimeType: 'text/html', body: { data: b64('<div>Line 1<br>Line&nbsp;2 &amp; more</div><style>p{}</style>') } })).toBe('Line 1\nLine 2 & more');
    expect(messageText(undefined)).toBe('');
  });
});

describe('the import and completion automations', () => {
  let clock = Date.parse('2026-10-29T15:00:00Z');
  const ev = (body: EventBody): PlannerEvent => ({ v: 1, id: `e${(clock += 1000)}`, at: new Date(clock).toISOString(), ...body }) as PlannerEvent;
  const email = (thread: string, subject: string): TaskSourceRef => ({ kind: 'email', id: `m-${thread}`, key: 'Gmail', url: `https://mail.google.com/mail/u/${encodeURIComponent(ME)}/#all/${thread}`, title: subject, account: ME });
  const setup = (settings: Partial<PlannerState['settings']>, options: { allowed?: boolean; surface?: string } = {}) => {
    let state: PlannerState = applyEvents(emptyState(), [ev({ type: 'settings.updated', patch: settings })]);
    let listener: CommitListener | null = null;
    const calls: { path: string; body: any }[] = [];
    const notes: string[] = [];
    const client = {
      getView: () => ({ state }),
      onCommitted: (fn: CommitListener) => {
        listener = fn;
        return () => {};
      },
      call: async (_method: string, path: string, body?: unknown) => {
        calls.push({ path, body });
        return { labelIds: [] };
      },
      notify: (message: string) => notes.push(message),
    } as unknown as PlannerClient;
    const google = { allows: (_account: string, feature: string) => feature === 'mailActions' && (options.allowed ?? true), searchMail: async () => {} } as unknown as GoogleStore;
    const gmail = new GmailStore(client, google, options.surface ?? 'page');
    /** The user's change, as the client reports it once committed. */
    const commit = (bodies: EventBody[], origin: 'user' | 'sync' = 'user') => {
      const before = state;
      state = applyEvents(state, bodies.map(ev));
      listener!(bodies.map((body, index) => ({ cmd: `c${index}`, ...body }) as Command), before, state, origin as never);
    };
    return { gmail, calls, notes, commit, state: () => state };
  };
  const created = (id: string, source: TaskSourceRef): EventBody => ({ type: 'task.created', task: { id, title: source.title ?? 'x', placement: { kind: 'day', date: '2026-10-29' }, position: 1024, source } });

  test('importing an email does what the import automations say, in Gmail; completing its task, the completion ones', async () => {
    const fake = setup({ gmailOnImport: [{ kind: 'markRead' }, { kind: 'removeLabel', label: 'Inbox' }], gmailOnComplete: [{ kind: 'archive' }] });
    fake.commit([created('t1', email('th1', 'Budget'))]);
    fake.commit([{ type: 'task.completed', taskId: 't1', on: '2026-10-29' }]);
    // Another window's change, or the Planner's own sync, does nothing here.
    fake.commit([created('t2', email('th2', 'Other'))], 'sync');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.calls.filter((call) => call.path === '/google/mail/act').map((call) => call.body)).toEqual([
      { account: ME, thread: 'th1', actions: [{ kind: 'markRead' }, { kind: 'removeLabel', label: 'Inbox' }] },
      { account: ME, thread: 'th1', actions: [{ kind: 'archive' }] },
    ]);
  });

  test('"Show prompt" asks with the configured actions ticked, and does the ones picked; without Gmail actions allowed, it says how', async () => {
    const asking = setup({ gmailOnComplete: [{ kind: 'archive' }], gmailCompletePrompt: true });
    asking.commit([created('t1', email('th1', 'Budget'))]);
    expect(asking.gmail.getView().prompt).toBeNull();
    asking.commit([{ type: 'task.completed', taskId: 't1', on: '2026-10-29' }]);
    expect(asking.gmail.getView().prompt).toEqual({ when: 'complete', taskId: 't1', mails: [{ account: ME, thread: 'th1', subject: 'Budget' }], subject: 'Budget', actions: [{ kind: 'archive' }] });
    asking.gmail.answerPrompt([{ kind: 'trash' }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(asking.calls.filter((call) => call.path === '/google/mail/act').map((call) => call.body.actions)).toEqual([[{ kind: 'trash' }]]);
    const notAllowed = setup({ gmailOnImport: [{ kind: 'archive' }] }, { allowed: false });
    notAllowed.commit([created('t1', email('th1', 'Budget'))]);
    expect(notAllowed.calls).toEqual([]);
    expect(notAllowed.notes).toEqual([`Gmail's import automations need Gmail actions for ${ME}: allow them in Settings → Google`]);
  });

  test('an email merged straight into a task is imported; checked off there, it is completed (Sunsama keeps merged items integrated)', async () => {
    const fake = setup({ gmailOnImport: [{ kind: 'markRead' }], gmailOnComplete: [{ kind: 'archive' }] });
    fake.commit([{ type: 'task.created', task: { id: 'triage', title: 'Inbox triage', placement: { kind: 'day', date: '2026-10-29' }, position: 1024 } }]);
    fake.commit([{ type: 'task.updated', taskId: 'triage', patch: { subtasks: [{ id: 's1', title: 'Budget', done: false, source: email('th9', 'Budget') }] } }]);
    fake.commit([{ type: 'task.updated', taskId: 'triage', patch: { subtasks: [{ id: 's1', title: 'Budget', done: true, source: email('th9', 'Budget') }] } }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.calls.filter((call) => call.path === '/google/mail/act').map((call) => [call.body.thread, call.body.actions])).toEqual([['th9', [{ kind: 'markRead' }]], ['th9', [{ kind: 'archive' }]]]);
  });

  test("completing a task completes its email and the emails merged into it, as checking each off would (not one checked off on its own: that ran then); asked, once for all; reopening does nothing in Gmail", async () => {
    const merged = (lunchDone: boolean) => [{ id: 's1', title: 'Budget', done: false, source: email('th1', 'Budget') }, { id: 's2', title: 'Lunch', done: lunchDone, source: email('th2', 'Lunch') }];
    const acts = (calls: { path: string; body: any }[]) => calls.filter((call) => call.path === '/google/mail/act').map((call) => [call.body.thread, call.body.actions]);
    const doing = setup({ gmailOnComplete: [{ kind: 'archive' }] });
    doing.commit([created('triage', email('th0', 'Inbox triage')), { type: 'task.updated', taskId: 'triage', patch: { subtasks: merged(false) } }]);
    doing.commit([{ type: 'task.updated', taskId: 'triage', patch: { subtasks: merged(true) } }]);
    doing.commit([{ type: 'task.completed', taskId: 'triage', on: '2026-10-29' }]);
    doing.commit([{ type: 'task.reopened', taskId: 'triage' }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(acts(doing.calls)).toEqual([['th2', [{ kind: 'archive' }]], ['th0', [{ kind: 'archive' }]], ['th1', [{ kind: 'archive' }]]]);

    const asking = setup({ gmailOnComplete: [{ kind: 'archive' }], gmailCompletePrompt: true });
    asking.commit([created('triage', email('th0', 'Inbox triage')), { type: 'task.updated', taskId: 'triage', patch: { subtasks: merged(false) } }]);
    asking.commit([{ type: 'task.completed', taskId: 'triage', on: '2026-10-29' }]);
    expect(asking.gmail.getView().prompt).toEqual({
      when: 'complete',
      taskId: 'triage',
      mails: [{ account: ME, thread: 'th0', subject: 'Inbox triage' }, { account: ME, thread: 'th1', subject: 'Budget' }, { account: ME, thread: 'th2', subject: 'Lunch' }],
      subject: 'Inbox triage and 2 more',
      actions: [{ kind: 'archive' }],
    });
    asking.gmail.answerPrompt([{ kind: 'star' }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(acts(asking.calls)).toEqual([['th0', [{ kind: 'star' }]], ['th1', [{ kind: 'star' }]], ['th2', [{ kind: 'star' }]]]);
    asking.commit([{ type: 'task.reopened', taskId: 'triage' }]);
    expect(asking.gmail.getView().prompt).toBeNull();
  });

  test('Convert to task gives back a merged email as a task: not an import, nothing done in Gmail again', async () => {
    const fake = setup({ gmailOnImport: [{ kind: 'markRead' }] });
    fake.commit([{ type: 'task.created', task: { id: 'triage', title: 'Inbox triage', placement: { kind: 'day', date: '2026-10-29' }, position: 1024 } }, { type: 'task.updated', taskId: 'triage', patch: { subtasks: [{ id: 's1', title: 'Budget', done: false, source: email('th9', 'Budget') }] } }]);
    fake.commit([{ type: 'task.updated', taskId: 'triage', patch: { subtasks: [] } }, created('back', email('th9', 'Budget'))]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.calls.filter((call) => call.path === '/google/mail/act').map((call) => call.body.actions)).toEqual([[{ kind: 'markRead' }]]);
  });

  test('the Work Status frame and the background never act', () => {
    for (const surface of ['status', 'background']) {
      const fake = setup({ gmailOnImport: [{ kind: 'archive' }] }, { surface });
      fake.commit([created('t1', email('th1', 'Budget'))]);
      expect(fake.calls).toEqual([]);
    }
  });
});

describe('the service, against the fake Google', () => {
  const token = 'gmail-routes-test-token';
  let child: ChildProcess;
  let fake: FakeGoogle;
  let base = '';
  let root = '';
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  const labelsOf = (id: string) => fake.world.mail!.find((message) => message.id === id)!.labels ?? null;

  beforeAll(async () => {
    const world = defaultFakeWorld({ account: ME, today: todayIn('America/Los_Angeles'), zone: 'America/Los_Angeles' });
    world.granted = [...DEFAULT_SCOPES, GMAIL_MODIFY_SCOPE, ...CONTACTS_SCOPES];
    world.mailLabels = [{ id: 'Label_7', name: 'In progress' }];
    world.mail = [
      { id: 'a1', threadId: 'ta', subject: 'Quarterly numbers', from: 'Ann Lee <ann@example.com>', date: '2026-10-28T09:00:00.000Z', snippet: 'First draft', body: 'Hi,\nthe first draft.' },
      { id: 'a2', threadId: 'ta', subject: 'Re: Quarterly numbers', from: 'Bo <bo@example.com>', date: '2026-10-29T10:00:00.000Z', snippet: 'Looks good', unread: true },
      { id: 'b1', threadId: 'tb', subject: 'Lunch?', from: 'Cy <cy@example.com>', date: '2026-10-29T11:00:00.000Z', snippet: 'Tacos', unread: true },
    ];
    world.contacts = [{ name: 'Ann Lee', email: 'ann@example.com' }, { name: 'Andy Roe', email: 'andy@example.com' }];
    world.otherContacts = [{ name: '', email: 'ann@example.com' }, { name: 'Annika', email: 'annika@example.org' }];
    fake = await startFakeGoogle(world);
    root = mkdtempSync(join(tmpdir(), 'planner-gmail-routes-'));
    // Two accounts: one allowed Gmail actions and Contacts, one not.
    const file = JSON.parse(fake.accountsFile());
    file.accounts = [{ ...file.accounts[0], scopes: world.granted }, { ...file.accounts[0], email: OTHER, scopes: DEFAULT_SCOPES }];
    writeFileSync(join(root, 'google-accounts.json'), JSON.stringify(file), { mode: 0o600 });
    const port = await new Promise<number>((resolve) => {
      const server = createServer();
      server.listen(0, '127.0.0.1', () => {
        const { port: free } = server.address() as AddressInfo;
        server.close(() => resolve(free));
      });
    });
    child = spawn(process.execPath, [join(import.meta.dir, '../service/main.ts')], {
      env: { ...process.env, OPENCHAMBER_SERVICE_PORT: String(port), OPENCHAMBER_SERVICE_TOKEN: token, PLANNER_DATA_DIR: join(root, 'data'), PLANNER_GOOGLE_API_BASE: fake.base },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    base = `http://127.0.0.1:${port}`;
    for (let attempt = 0; attempt < 150; attempt++) {
      try {
        if ((await fetch(`${base}/health`, { headers: { Authorization: `Bearer ${token}` } })).ok) break;
      } catch {
        // Not listening yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });

  afterAll(async () => {
    child?.kill();
    await fake?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("an account's labels: Gmail's own the panel lists (Inbox first), then the user's; categories and chats left out", async () => {
    const { status, body } = await call('GET', `/google/mail/labels?account=${encodeURIComponent(ME)}`);
    expect(status).toBe(200);
    expect(body.labels.map((label: { name: string }) => label.name)).toEqual(['Inbox', 'Starred', 'Important', 'Unread', 'Sent', 'Drafts', 'Spam', 'Trash', 'In progress']);
  });

  test("a thread: its messages oldest first, with their text, and the labels it has; one Gmail doesn't have is 404", async () => {
    const { status, body } = await call('GET', `/google/mail/thread?account=${encodeURIComponent(ME)}&thread=ta`);
    expect(status).toBe(200);
    expect(body.thread.messages.map((message: { from: string; text: string; unread: boolean }) => [message.from, message.text, message.unread])).toEqual([['Ann Lee <ann@example.com>', 'Hi,\nthe first draft.', false], ['Bo <bo@example.com>', 'Looks good', true]]);
    expect(body.thread.labelIds.sort()).toEqual(['INBOX', 'UNREAD']);
    expect((await call('GET', `/google/mail/thread?account=${encodeURIComponent(ME)}&thread=nothing`)).status).toBe(404);
    expect((await call('GET', `/google/mail/thread?account=${encodeURIComponent(ME)}&thread=bad%20id`)).status).toBe(400);
  });

  test('the actions happen in Gmail: archive, a label by name, read and unread, the trash; the list follows', async () => {
    const act = (thread: string, actions: unknown[], account = ME) => call('POST', '/google/mail/act', { account, thread, actions });
    expect((await act('ta', [{ kind: 'markRead' }, { kind: 'addLabel', label: 'In progress' }, { kind: 'archive' }])).status).toBe(200);
    expect(labelsOf('a2')!.sort()).toEqual(['Label_7']);
    const inbox = await call('GET', `/google/mail?account=${encodeURIComponent(ME)}&q=${encodeURIComponent('in:inbox')}`);
    expect(inbox.body.messages.map((message: { subject: string }) => message.subject)).toEqual(['Lunch?']);
    const labelled = await call('GET', `/google/mail?account=${encodeURIComponent(ME)}&q=${encodeURIComponent('label:in-progress')}`);
    expect(labelled.body.messages.length).toBe(2);
    expect((await act('ta', [{ kind: 'markUnread' }, { kind: 'removeLabel', label: 'In progress' }])).status).toBe(200);
    expect(labelsOf('a1')!.sort()).toEqual(['UNREAD']);
    expect((await act('tb', [{ kind: 'trash' }])).status).toBe(200);
    expect(labelsOf('b1')).toEqual(['UNREAD', 'TRASH']);
    expect((await call('GET', `/google/mail?account=${encodeURIComponent(ME)}&q=${encodeURIComponent('in:inbox')}`)).body.messages).toEqual([]);
    expect((await call('GET', `/google/mail?account=${encodeURIComponent(ME)}&q=${encodeURIComponent('Lunch in:anywhere')}`)).body.messages.length).toBe(1);
    // A label Gmail doesn't have is refused before anything changes; so are malformed actions.
    const missing = await act('ta', [{ kind: 'archive' }, { kind: 'addLabel', label: 'Waiting' }]);
    expect([missing.status, missing.body.error]).toEqual([400, `Gmail has no label "Waiting" in ${ME}: make it in Gmail first`]);
    expect((await act('ta', [{ kind: 'delete' }])).status).toBe(400);
    expect((await act('ta', [])).status).toBe(400);
  });

  test('an account that has not allowed Gmail actions is told how (403), and nothing changes', async () => {
    const before = JSON.stringify(fake.world.mail);
    const refused = await call('POST', '/google/mail/act', { account: OTHER, thread: 'ta', actions: [{ kind: 'archive' }] });
    expect([refused.status, refused.body.reason]).toEqual([403, 'not-allowed']);
    expect(JSON.stringify(fake.world.mail)).toBe(before);
  });

  test('Google Contacts: people of the contacts and those emailed, once each, by name or address; an account without Contacts is told how', async () => {
    const found = await call('GET', `/google/contacts?account=${encodeURIComponent(ME)}&q=ann`);
    expect(found.status).toBe(200);
    expect(found.body.contacts).toEqual([{ name: 'Ann Lee', email: 'ann@example.com' }, { name: 'Annika', email: 'annika@example.org' }]);
    // Google's cache is warmed with an empty search first, once per account.
    expect(fake.requests.filter((request) => request.path === '/v1/people:searchContacts').map((request) => request.query.query)).toEqual(['', 'ann']);
    const refused = await call('GET', `/google/contacts?account=${encodeURIComponent(OTHER)}&q=ann`);
    expect([refused.status, refused.body.reason]).toEqual([403, 'not-allowed']);
    expect((await call('GET', `/google/contacts?account=${encodeURIComponent(ME)}&q=`)).status).toBe(400);
  });

  test("access Google took back: the list says to connect the account again (the panel's Re-add Gmail account)", async () => {
    fake.world.revoked = true;
    try {
      const refused = await call('GET', `/google/mail?account=${encodeURIComponent(OTHER)}&q=in%3Ainbox`);
      expect([refused.status, refused.body.error]).toEqual([401, `Google no longer accepts the Planner's access to ${OTHER}; connect it again`]);
    } finally {
      fake.world.revoked = false;
    }
  });

  test('POST /meetings/sync runs the meeting import at once (nothing to do while it is set to Show prompt)', async () => {
    const { status, body } = await call('POST', '/meetings/sync');
    expect([status, body]).toEqual([200, { added: 0, moved: 0, removed: 0, completed: 0, errors: [] }]);
  });
});
