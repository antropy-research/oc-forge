// Gmail as Sunsama's Gmail integration has it (help.sunsama.com/docs/integrations/gmail), end to end: the Planner's
// service signed in to the fake Google (tests/e2e/fakeGoogle.mjs) as two accounts, one that allowed Gmail actions and
// one that did not, and Planner windows made of the panel's own stores. An email task's actions and the import and
// completion automations are label changes in the fake Gmail. The browser journey tests/e2e/sunsama.mjs shows the same
// Gmail panel, its filters and its prompts on screen. A pasted Gmail address is in tests/github.test.ts ("a URL pasted
// as a new task").
import { beforeAll, describe, expect, test } from 'bun:test';
import type { EventBody } from '../src/domain/core/events.ts';
import { gmailUrl } from '../src/domain/google/google.ts';
import type { MailItem } from '../src/domain/google/google.ts';
import type { TaskSourceRef } from '../src/domain/core/types.ts';
import { firstOf, notesOf, slowRelay } from './support/github.ts';
import { ME, OTHER, THREADS, addSecondAccount, labelsOf, mailWorld, threadActs } from './support/gmail.ts';
import { until, usePlanner, type PlannerWindow } from './support/planner.ts';

const ZONE = 'America/Los_Angeles';
const planner = usePlanner({ zone: ZONE, google: mailWorld(ZONE) });
beforeAll(() => addSecondAccount(planner));

/** A window with its Google accounts read, as the panel has them once open. */
const open = async (surface: 'panel' | 'status' = 'panel'): Promise<PlannerWindow> => {
  const window = await planner.window({ surface });
  await window.google.checkStatus();
  return window;
};
const today = (window: PlannerWindow) => window.client.getView().today;
const email = (account: string, thread: string, title: string): TaskSourceRef => ({ kind: 'email', id: `m-${thread}`, key: 'Gmail', url: gmailUrl(account, thread), title, account });
const created = (window: PlannerWindow, id: string, source: TaskSourceRef | null, title = source?.title ?? 'Task'): EventBody => ({ type: 'task.created', task: { id, title, placement: { kind: 'day', date: today(window) }, position: 1024, ...(source ? { source } : {}) } });

describe("an email task's actions", () => {
  test('Archive, a label by name, Mark as unread and Move to trash happen in Gmail, to the whole thread; the task\'s thread and the Inbox follow; a label Gmail lacks is refused before anything changes; an account without Gmail actions is told how', async () => {
    const window = await open();
    const notes = notesOf(window);
    expect(window.google.getView().mailAccount).toBe(ME);
    await window.google.searchMail(window.gmail.query());
    const inbox = () => window.google.getView().mail.map((item) => item.subject);
    expect(inbox()).toEqual(expect.arrayContaining(['Quarterly numbers', 'Re: Quarterly numbers', 'Lunch?']));
    expect((await window.gmail.labels(ME)).map((label) => label.name)).toEqual(['Inbox', 'Starred', 'Important', 'Unread', 'Sent', 'Drafts', 'Spam', 'Trash', 'In progress']);

    const latest = window.google.getView().mail.find((item) => item.subject === 'Re: Quarterly numbers')!;
    await window.google.planMail(latest, { kind: 'day', date: today(window) });
    const task = Object.values(window.client.getView().state.tasks).find((item) => item.source?.kind === 'email')!;
    expect(task).toMatchObject({ title: 'Re: Quarterly numbers', source: { kind: 'email', account: ME } });
    await window.gmail.loadThread(ME, THREADS.numbers);
    const thread = () => window.gmail.getView().threads[`${ME}|${THREADS.numbers}`]!.thread!;
    expect(thread().messages.map((message) => [message.from, message.text, message.unread])).toEqual([['Ann Lee <ann@example.com>', 'Hi,\nthe first draft.', false], ['Bo <bo@example.com>', 'Looks good', true]]);

    expect(await window.gmail.act(ME, THREADS.numbers, [{ kind: 'markRead' }, { kind: 'addLabel', label: 'In progress' }, { kind: 'archive' }])).toBe(true);
    expect([labelsOf(planner, '18b2f3c4d5e6f701'), labelsOf(planner, '18b2f3c4d5e6f702')]).toEqual([['Label_7'], ['Label_7']]);
    await until(() => thread().labelIds.join() === 'Label_7' && !inbox().includes('Quarterly numbers'));
    expect(inbox()).toEqual(expect.arrayContaining(['Lunch?']));
    expect(await window.gmail.act(ME, THREADS.numbers, [{ kind: 'markUnread' }, { kind: 'removeLabel', label: 'In progress' }])).toBe(true);
    expect(labelsOf(planner, '18b2f3c4d5e6f701')).toEqual(['UNREAD']);
    expect(await window.gmail.act(ME, THREADS.numbers, [{ kind: 'trash' }])).toBe(true);
    expect(labelsOf(planner, '18b2f3c4d5e6f702')).toEqual(['TRASH', 'UNREAD']);

    const before = threadActs(planner, THREADS.lunch);
    expect(await window.gmail.act(ME, THREADS.lunch, [{ kind: 'archive' }, { kind: 'addLabel', label: 'Waiting' }])).toBe(false);
    expect(notes.at(-1)).toBe(`Gmail did not take it: Gmail has no label "Waiting" in ${ME}: make it in Gmail first`);
    expect(await window.gmail.act(OTHER, THREADS.lunch, [{ kind: 'archive' }])).toBe(false);
    expect(notes.at(-1)).toBe(`Gmail did not take it: Gmail actions are not allowed for ${OTHER}: allow them in Settings → Google`);
    expect([labelsOf(planner, THREADS.lunch), threadActs(planner, THREADS.lunch)]).toEqual([['INBOX', 'UNREAD'], before]);
  });
});

describe("Gmail's automations, from Settings → Gmail", () => {
  test('importing an email does what the import automations say, completing its task what the completion ones say, in the window that did it and only there; reopening does nothing; a setting Gmail cannot do is refused; an account without Gmail actions is told how', async () => {
    const window = await open();
    const other = await open();
    const notes = notesOf(window);
    await window.client.dispatch([{ type: 'settings.updated', patch: { gmailOnImport: [{ kind: 'markRead' }, { kind: 'addLabel', label: 'In progress' }], gmailOnComplete: [{ kind: 'archive' }, { kind: 'removeLabel', label: 'In progress' }] } }]);
    await window.client.dispatch([{ type: 'settings.updated', patch: { gmailOnImport: [{ kind: 'delete' }] as never } }]);
    expect(notes.at(-1)).toContain('gmailOnImport must be');
    expect((await planner.state()).settings.gmailOnImport).toEqual([{ kind: 'markRead' }, { kind: 'addLabel', label: 'In progress' }]);
    await other.client.refresh();

    await window.google.searchMail('in:inbox');
    const lunch = window.google.getView().mail.find((item) => item.subject === 'Lunch?') as MailItem;
    await window.google.planMail(lunch, { kind: 'day', date: today(window) });
    await until(() => labelsOf(planner, THREADS.lunch).join() === 'INBOX,Label_7');
    const taskId = Object.values(window.client.getView().state.tasks).find((task) => task.source?.kind === 'email' && task.title === 'Lunch?')!.id;
    await window.client.dispatch([{ type: 'task.completed', taskId, on: today(window) }]);
    await until(() => labelsOf(planner, THREADS.lunch).length === 0);
    await window.client.dispatch([{ type: 'task.reopened', taskId }]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect([labelsOf(planner, THREADS.lunch), threadActs(planner, THREADS.lunch)]).toEqual([[], 2]);

    // An email of the account that did not allow Gmail actions: nothing is done, and the Planner says how to allow them.
    await window.client.dispatch([created(window, 'other-mail', email(OTHER, THREADS.trip, 'Trip'))]);
    expect(notes.at(-1)).toBe(`Gmail's import automations need Gmail actions for ${OTHER}: allow them in Settings → Google`);
    expect(threadActs(planner, THREADS.trip)).toBe(0);
  });

  test("an email merged into a task is imported, and completed when checked off there or when the task is (the ones still open, once each); asked instead when Show prompt is on; Convert to task does nothing in Gmail again; the Work Status frame never acts", async () => {
    const window = await open();
    await window.client.dispatch([{ type: 'settings.updated', patch: { gmailOnImport: [{ kind: 'markRead' }], gmailOnComplete: [{ kind: 'star' }], gmailCompletePrompt: false } }]);
    const merged = (taskId: string, id: string, thread: string, title: string): EventBody => ({ type: 'subtask.added', taskId, subtask: { id, title, done: false, source: email(ME, thread, title) } });
    await window.client.dispatch([created(window, 'triage', email(ME, THREADS.triage, 'Inbox triage')), merged('triage', 's-budget', THREADS.budget, 'Budget'), merged('triage', 's-numbers', THREADS.numbers, 'Quarterly numbers')]);
    await until(() => !labelsOf(planner, '18c0000000000a01').includes('UNREAD') && !labelsOf(planner, '18c0000000000b01').includes('UNREAD'));
    await window.client.dispatch([{ type: 'subtask.updated', taskId: 'triage', subtaskId: 's-budget', patch: { done: true }, seen: { done: false } }]);
    await until(() => labelsOf(planner, '18c0000000000b01').includes('STARRED'));
    await window.client.dispatch([{ type: 'task.completed', taskId: 'triage', on: today(window) }]);
    await until(() => labelsOf(planner, '18c0000000000a01').includes('STARRED') && labelsOf(planner, '18b2f3c4d5e6f702').includes('STARRED'));
    // Budget: imported, then starred once, when checked off; not again with the task.
    expect(threadActs(planner, THREADS.budget)).toBe(2);

    // Show prompt: completing asks once, about the task's email and the ones merged into it, the configured actions ticked.
    await window.client.dispatch([{ type: 'settings.updated', patch: { gmailCompletePrompt: true, gmailOnComplete: [{ kind: 'archive' }] } }, { type: 'task.reopened', taskId: 'triage' }, { type: 'subtask.updated', taskId: 'triage', subtaskId: 's-budget', patch: { done: false }, seen: { done: true } }]);
    await window.client.dispatch([{ type: 'task.completed', taskId: 'triage', on: today(window) }]);
    expect(window.gmail.getView().prompt).toMatchObject({ when: 'complete', taskId: 'triage', subject: 'Inbox triage and 2 more', actions: [{ kind: 'archive' }] });
    window.gmail.answerPrompt([{ kind: 'trash' }]);
    await until(() => [THREADS.triage, THREADS.budget, THREADS.numbers].every((thread) => planner.google!.world.mail!.filter((item) => item.threadId === thread).every((item) => item.labels?.includes('TRASH'))));

    // Convert to task gives a merged email back as a task: it was imported when merged, so nothing happens in Gmail.
    const acts = threadActs(planner, THREADS.budget);
    await window.client.dispatch([{ type: 'subtask.deleted', taskId: 'triage', subtaskId: 's-budget', seen: { title: 'Budget' } }, created(window, 'budget-back', email(ME, THREADS.budget, 'Budget'))]);
    // The Work Status frame shows tasks but never acts in Gmail.
    const status = await open('status');
    await status.client.dispatch([created(status, 'status-mail', email(ME, THREADS.trip, 'Trip'))]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect([threadActs(planner, THREADS.budget), threadActs(planner, THREADS.trip)]).toEqual([acts, 0]);
  });
});

// Round 12's audit after its Load more finding (P1-2): a read a newer one overtakes never shows over it, its error
// neither, and nothing is left loading.
describe("Google's lists in the panel show the newest read", () => {
  test("a Gmail search left behind that fails says nothing; Refresh while Load more is on its way: the old page never joins the list read again; a Google Tasks list and the Tasks view read twice show the newer read; an email task's thread too; another account while a search is on its way leaves nothing loading", async () => {
    const window = await open();
    const relay = slowRelay(window);
    relay.hold(firstOf((request) => request.path.startsWith('/google/mail?')));
    void window.google.searchMail('in:inbox');
    await until(() => relay.held.length === 1);
    await window.google.searchMail('is:starred');
    relay.held[0]!.fail(500, 'Gmail answered HTTP 500');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect([window.google.getView().mailQuery, window.google.getView().mailError, window.google.getView().mailLoading]).toEqual(['is:starred', null, false]);

    // Gmail in pages of two. Refresh while Load more is on its way, a message come in meanwhile: the list is the new
    // first page, whenever the old page answers.
    const world = planner.google!.world;
    world.pageSize = { ...world.pageSize, mail: 2 };
    const listed = () => window.google.getView().mail.map((item) => item.id);
    await window.google.searchMail('in:anywhere');
    expect([listed().length, window.google.getView().mailNext]).toEqual([2, '2']);
    relay.held.length = 0;
    relay.hold(firstOf((request) => request.path.startsWith('/google/mail?') && request.path.includes('pageToken=')));
    const more = window.google.searchMail(window.google.getView().mailQuery, true);
    await until(() => relay.held.length === 1);
    await relay.held[0]!.answered;
    world.mail!.unshift({ id: '18d0000000000001', threadId: '18d0000000000001', subject: 'Just in', from: 'Gus <gus@example.com>', date: '2026-10-30T09:00:00.000Z', snippet: 'Hello', unread: true });
    await window.google.searchMail();
    const refreshed = listed();
    relay.held[0]!.release();
    await more;
    expect([refreshed[0], listed(), window.google.getView().mailNext, window.google.getView().mailLoading]).toEqual(['18d0000000000001', refreshed, '2', false]);
    delete world.pageSize.mail;

    const tasks = planner.google!.tasks.get('L1')!;
    const reads = async (read: () => Promise<void>, path: string, shownTitles: () => string[]) => {
      relay.hold(firstOf((request) => request.path.startsWith(path)));
      const older = read();
      await until(() => relay.held.length > 0);
      const held = relay.held.at(-1)!;
      await held.answered;
      tasks[0]!.title = `${tasks[0]!.title} again`;
      await read();
      held.release();
      await older;
      expect(shownTitles()).toContain(tasks[0]!.title);
    };
    relay.held.length = 0;
    window.google.selectList(ME, 'L1');
    await until(() => !window.google.getView().tasksLoading);
    await reads(() => window.google.refreshTasks(), '/google/tasks?', () => window.google.getView().tasks.map((item) => item.title));
    relay.held.length = 0;
    await reads(() => window.google.loadBoard(ME, 'L1'), '/google/tasks/all?', () => window.google.getView().board[`${ME}\nL1`]!.items.map((item) => item.title));
    // A list's read failing after another list was chosen says nothing over it.
    relay.held.length = 0;
    relay.hold(firstOf((request) => request.path.startsWith('/google/tasks?')));
    void window.google.refreshTasks();
    await until(() => relay.held.length === 1);
    window.google.selectList(ME, 'L2');
    await until(() => !window.google.getView().tasksLoading);
    relay.held[0]!.fail(503, 'Google answered HTTP 503');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect([window.google.getView().tasks.map((item) => item.title), window.google.getView().tasksError]).toEqual([['Buy stamps'], null]);

    // An email task's thread read twice (after an action on it): the newer read shows.
    relay.held.length = 0;
    relay.hold(firstOf((request) => request.path.startsWith('/google/mail/thread')));
    const older = window.gmail.loadThread(ME, THREADS.trip);
    await until(() => relay.held.length === 1);
    await relay.held[0]!.answered;
    await planner.call('POST', '/google/mail/act', { account: ME, thread: THREADS.trip, actions: [{ kind: 'star' }] });
    await window.gmail.loadThread(ME, THREADS.trip);
    relay.held[0]!.release();
    await older;
    expect(window.gmail.getView().threads[`${ME}|${THREADS.trip}`]).toMatchObject({ loading: false, error: null, thread: { labelIds: expect.arrayContaining(['STARRED']) } });

    // The account searched goes away while its search is on its way: the panel moves to the other one, with nothing
    // loading, so it searches that one.
    relay.held.length = 0;
    relay.hold(firstOf((request) => request.path.startsWith('/google/mail?')));
    void window.google.searchMail('in:inbox');
    await until(() => relay.held.length === 1);
    await planner.call('DELETE', `/google/accounts/${encodeURIComponent(ME)}`);
    await window.google.checkStatus();
    relay.held[0]!.release();
    await until(() => !window.google.getView().mailLoading);
    expect([window.google.getView().mailAccount, window.google.getView().mail, window.google.getView().mailLoading]).toEqual([OTHER, [], false]);
  });
});
