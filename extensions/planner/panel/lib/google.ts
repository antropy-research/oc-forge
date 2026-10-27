// Panel-side Google: the accounts the local service signed in, the Google
// calendars to show beside the plan, Google Tasks and Gmail messages to plan as
// tasks, and writing completion and due dates back to Google Tasks the way the
// Linear integration writes back to Linear (ask, do, or not).
import type { HostClient } from '@openchamber/sdk';
import type { Command, EventBody } from '../../src/domain/events.ts';
import {
  gtaskSource,
  isGoogleTaskItem,
  isMailItem,
  linkedGoogleTasks,
  planGoogleTaskSync,
  taskForGoogleTask,
  taskForMail,
  taskFromGoogleTask,
  taskFromMail,
  type GoogleCalendarInfo,
  type GoogleTaskItem,
  type GoogleTaskList,
  type MailItem,
} from '../../src/domain/google.ts';
import { edgePosition } from '../../src/domain/selectors.ts';
import { newId } from '../../src/domain/ids.ts';
import { applyMove, positionBetween, type MoveTarget } from '../../src/domain/gtasks.ts';
import type { CalendarSubscription, DateKey, Placement, PlannerState, Task } from '../../src/domain/types.ts';
import type { Origin, PlannerClient } from './client.ts';
import { calendarUi } from './gcal.ts';

export type GoogleFeature = 'calendar' | 'tasks' | 'mail';

export interface GoogleAccountView {
  email: string;
  features: GoogleFeature[];
  addedAt: string;
}

export interface GoogleStatusView {
  client: { id: string } | null;
  accounts: GoogleAccountView[];
  /** Why the last working session could not be written to Google Calendar. */
  timeboxError?: string | null;
}

export type SignInResult = { status: 'pending' } | { status: 'connected'; email: string; features: GoogleFeature[] } | { status: 'failed'; message: string };

export interface SignInView {
  id: string;
  authUrl: string;
  redirectUri: string;
  result: SignInResult;
}

export const MAIL_SEARCHES = [
  { label: 'Inbox', query: 'in:inbox' },
  { label: 'Unread', query: 'in:inbox is:unread' },
  { label: 'Starred', query: 'is:starred' },
  { label: 'Important', query: 'is:important in:inbox' },
] as const;

export interface GoogleView {
  /** Null until the service has answered. */
  status: GoogleStatusView | null;
  error: string | null;
  signIn: SignInView | null;
  calendars: GoogleCalendarInfo[];
  calendarErrors: { account: string; message: string }[];
  lists: GoogleTaskList[];
  list: { account: string; id: string } | null;
  tasks: GoogleTaskItem[];
  tasksLoading: boolean;
  tasksError: string | null;
  mailAccount: string | null;
  mailQuery: string;
  mail: MailItem[];
  mailLoading: boolean;
  mailError: string | null;
  /** Where Gmail's next page of this search starts; null when there is none. */
  mailNext: string | null;
  /** Asking whether to complete the Google task too. */
  prompt: { taskId: string; title: string } | null;
  /** The Tasks view: each list's tasks, completed ones too, by `listKey`. */
  board: Record<string, TaskBoardList>;
}

export interface TaskBoardList {
  items: GoogleTaskItem[];
  loading: boolean;
  error: string | null;
  /** False when the list is longer than the service reads. */
  complete: boolean;
}

export const listKey = (account: string, listId: string): string => `${account}\n${listId}`;

/** What a Google task or message carries while it is dragged. */
export type GoogleDrag = { kind: 'gtask'; item: GoogleTaskItem } | { kind: 'mail'; item: MailItem };

const REFRESH_MS = 5 * 60_000;
/** Linked tasks are asked for in parts of at most this many lists and tasks, which the service answers in time. */
const SYNC_GROUPS = 10;
const SYNC_IDS = 50;
const SIGN_IN_POLL_MS = 1500;
const SIGN_IN_MAX_MS = 10 * 60_000;
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Where a Google calendar opens on the web; the Planner reads it through the account, not from here. */
export const calendarWebUrl = (calendarId: string): string => `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(calendarId)}`;

export class GoogleStore {
  private view: GoogleView = {
    status: null,
    error: null,
    signIn: null,
    calendars: [],
    calendarErrors: [],
    lists: [],
    list: null,
    tasks: [],
    tasksLoading: false,
    tasksError: null,
    mailAccount: null,
    mailQuery: MAIL_SEARCHES[0].query,
    mail: [],
    mailLoading: false,
    mailError: null,
    mailNext: null,
    prompt: null,
    board: {},
  };
  private readonly listeners = new Set<() => void>();
  private started = false;
  private signInTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly host: HostClient, private readonly client: PlannerClient, private readonly surface: string) {}

  getView = (): GoogleView => this.view;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async start(): Promise<void> {
    if (this.started || this.surface === 'status' || this.surface === 'background') return;
    this.started = true;
    this.client.onCommitted((commands, before, after, origin) => this.afterCommit(commands, before, after, origin));
    await this.checkStatus();
    setInterval(() => {
      if (document.hidden || !this.accountsWith('tasks').length) return;
      void this.sync();
      if (this.view.list) void this.refreshTasks();
    }, REFRESH_MS);
  }

  accountsWith(feature: GoogleFeature): GoogleAccountView[] {
    return (this.view.status?.accounts ?? []).filter((account) => account.features.includes(feature));
  }

  async checkStatus(): Promise<void> {
    try {
      const status = await this.client.call<GoogleStatusView>('GET', '/google/status');
      this.set({ status, error: null });
      const mailAccounts = status.accounts.filter((account) => account.features.includes('mail'));
      if (!mailAccounts.some((account) => account.email === this.view.mailAccount)) this.set({ mailAccount: mailAccounts[0]?.email ?? null, mail: [] });
      if (status.accounts.some((account) => account.features.includes('tasks'))) {
        await this.loadLists();
        void this.sync();
      } else this.set({ lists: [], list: null, tasks: [] });
    } catch (error) {
      this.set({ status: { client: null, accounts: [] }, error: messageOf(error) });
    }
  }

  async setClient(id: string, secret: string): Promise<void> {
    const status = await this.client.call<GoogleStatusView>('PUT', '/google/client', { id, secret });
    this.set({ status: { ...this.view.status, ...status } });
  }

  async clearClient(): Promise<void> {
    const status = await this.client.call<GoogleStatusView>('DELETE', '/google/client');
    this.set({ status, calendars: [], lists: [], list: null, tasks: [], mail: [], mailAccount: null });
    await this.forgetCalendars(() => true);
  }

  /** Start a sign-in: the service waits for Google's redirect; the browser goes to Google. */
  async connect(features: readonly GoogleFeature[]): Promise<void> {
    this.stopSignIn();
    const started = await this.client.call<{ id: string; authUrl: string; redirectUri: string }>('POST', '/google/connect', { features });
    this.set({ signIn: { ...started, result: { status: 'pending' } } });
    void this.host.openUrl(started.authUrl).catch(() => {
      // The address shows in Settings to open by hand.
    });
    const until = Date.now() + SIGN_IN_MAX_MS;
    const poll = async () => {
      const current = this.view.signIn;
      if (!current || current.id !== started.id) return;
      try {
        const result = await this.client.call<SignInResult>('GET', `/google/connect/${started.id}`);
        await this.settleSignIn(started.id, result);
        if (result.status !== 'pending') return;
      } catch {
        // A blip; ask again.
      }
      if (Date.now() < until) this.signInTimer = setTimeout(() => void poll(), SIGN_IN_POLL_MS);
    };
    this.signInTimer = setTimeout(() => void poll(), SIGN_IN_POLL_MS);
  }

  /** Finish the sign-in with the address the browser was sent to, when this machine's listener was out of its reach. */
  async finishSignIn(address: string): Promise<void> {
    const current = this.view.signIn;
    if (!current) return;
    const result = await this.client.call<SignInResult>('POST', `/google/connect/${current.id}/finish`, { url: address });
    await this.settleSignIn(current.id, result);
  }

  cancelSignIn(): void {
    this.stopSignIn();
    this.set({ signIn: null });
  }

  async removeAccount(email: string): Promise<void> {
    await this.client.call<{ removed: boolean }>('DELETE', `/google/accounts/${encodeURIComponent(email)}`);
    await this.forgetCalendars((account) => account === email);
    await this.checkStatus();
    this.set({ calendars: this.view.calendars.filter((calendar) => calendar.account !== email) });
  }

  async loadCalendars(): Promise<void> {
    try {
      const answer = await this.client.call<{ calendars: GoogleCalendarInfo[]; errors: { account: string; message: string }[] }>('GET', '/google/calendars');
      this.set({ calendars: answer.calendars, calendarErrors: answer.errors });
    } catch (error) {
      this.set({ calendarErrors: [{ account: '', message: messageOf(error) }] });
    }
  }

  /** Show a Google calendar beside the plan (a calendar subscription read through its account), or stop. */
  showCalendar(calendar: GoogleCalendarInfo, show: boolean): Promise<void> {
    const state = this.client.getView().state;
    const existing = Object.values(state.calendars).filter((item) => item.google?.account === calendar.account && item.google.calendarId === calendar.id);
    if (!show) return this.client.dispatch(existing.map((item) => ({ type: 'calendar.removed' as const, calendarId: item.id })));
    if (existing.length) return this.client.dispatch(existing.filter((item) => !item.visible).map((item) => ({ type: 'calendar.updated' as const, calendarId: item.id, patch: { visible: true } })));
    return this.client.dispatch([
      { type: 'calendar.added', calendar: { id: newId(), name: calendar.name.slice(0, 80) || 'Google Calendar', url: calendarWebUrl(calendar.id), color: calendar.color, google: { account: calendar.account, calendarId: calendar.id } } },
    ]);
  }

  /**
   * Google Calendar's checkbox beside a calendar: shown or hidden, keeping its
   * color; a Google calendar not shown before is added.
   */
  setVisible(calendar: GoogleCalendarInfo | CalendarSubscription, visible: boolean): Promise<void> {
    if ('visible' in calendar) return this.client.dispatch([{ type: 'calendar.updated', calendarId: calendar.id, patch: { visible } }]);
    const state = this.client.getView().state;
    const existing = Object.values(state.calendars).filter((item) => item.google?.account === calendar.account && item.google.calendarId === calendar.id);
    if (existing.length) return this.client.dispatch(existing.filter((item) => item.visible !== visible).map((item) => ({ type: 'calendar.updated' as const, calendarId: item.id, patch: { visible } })));
    return visible ? this.showCalendar(calendar, true) : Promise.resolve();
  }

  setTimeboxCalendar(target: { account: string; calendarId: string } | null): Promise<void> {
    return this.client.dispatch([{ type: 'settings.updated', patch: { googleTimebox: target } }]);
  }

  async loadLists(): Promise<void> {
    try {
      const answer = await this.client.call<{ lists: GoogleTaskList[]; errors: { account: string; message: string }[] }>('GET', '/google/tasklists');
      const current = this.view.list;
      const keep = current && answer.lists.some((list) => list.account === current.account && list.id === current.id);
      const first = answer.lists[0];
      this.set({ lists: answer.lists, list: keep ? current : first ? { account: first.account, id: first.id } : null, tasksError: answer.errors[0] ? `${answer.errors[0].account}: ${answer.errors[0].message}` : null });
      if (this.view.list) await this.refreshTasks();
    } catch (error) {
      this.set({ tasksError: messageOf(error) });
    }
  }

  selectList(account: string, id: string): void {
    this.set({ list: { account, id }, tasks: [] });
    void this.refreshTasks();
  }

  async refreshTasks(): Promise<void> {
    const list = this.view.list;
    if (!list) return;
    this.set({ tasksLoading: true, tasksError: null });
    try {
      const answer = await this.client.call<{ tasks: GoogleTaskItem[] }>('GET', `/google/tasks?account=${encodeURIComponent(list.account)}&list=${encodeURIComponent(list.id)}`);
      // Another list may have been chosen meanwhile.
      if (this.view.list === list) this.set({ tasks: answer.tasks, tasksLoading: false });
    } catch (error) {
      this.set({ tasksLoading: false, tasksError: messageOf(error) });
    }
  }

  /** Commands that plan a Google task at `placement`: move its open task there, or create one. */
  importTask(item: GoogleTaskItem, placement: Placement, position?: number): { bodies: EventBody[]; taskId: string } {
    const state = this.client.getView().state;
    const at = position ?? edgePosition(state, placement, 'bottom');
    const existing = taskForGoogleTask(state, item);
    if (existing && !existing.completedAt) return { bodies: [{ type: 'task.moved', taskId: existing.id, placement, position: at }], taskId: existing.id };
    const id = newId();
    return { bodies: [{ type: 'task.created', task: taskFromGoogleTask(item, id, placement, at) }], taskId: id };
  }

  planTask(item: GoogleTaskItem, placement: Placement): Promise<void> {
    return this.client.dispatch(this.importTask(item, placement).bodies, { undo: `Planned "${item.title}"` });
  }

  setMailAccount(account: string): void {
    this.set({ mailAccount: account, mail: [], mailNext: null });
    void this.searchMail();
  }

  /** A Gmail search's first page; `more` reads the next page of the current one and adds it. */
  async searchMail(query: string = this.view.mailQuery, more = false): Promise<void> {
    const account = this.view.mailAccount;
    this.set({ mailQuery: query });
    if (!account) return;
    const pageToken = more ? this.view.mailNext : null;
    if (more && !pageToken) return;
    this.set({ mailLoading: true, mailError: null });
    try {
      const answer = await this.client.call<{ messages: MailItem[]; nextPageToken?: string | null }>('GET', `/google/mail?account=${encodeURIComponent(account)}&q=${encodeURIComponent(query)}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`);
      if (this.view.mailAccount !== account || this.view.mailQuery !== query) return;
      const mail = more ? [...this.view.mail, ...answer.messages.filter((item) => !this.view.mail.some((known) => known.id === item.id))] : answer.messages;
      this.set({ mail, mailNext: answer.nextPageToken ?? null, mailLoading: false });
    } catch (error) {
      this.set({ mailLoading: false, mailError: messageOf(error) });
    }
  }

  /** Commands that plan a message at `placement`: move its open task there, or create one. */
  importMail(item: MailItem, placement: Placement, position?: number): { bodies: EventBody[]; taskId: string } {
    const state = this.client.getView().state;
    const at = position ?? edgePosition(state, placement, 'bottom');
    const existing = taskForMail(state, item);
    if (existing && !existing.completedAt) return { bodies: [{ type: 'task.moved', taskId: existing.id, placement, position: at }], taskId: existing.id };
    const id = newId();
    return { bodies: [{ type: 'task.created', task: taskFromMail(item, id, placement, at) }], taskId: id };
  }

  planMail(item: MailItem, placement: Placement): Promise<void> {
    return this.client.dispatch(this.importMail(item, placement).bodies, { undo: `Planned "${item.subject}"` });
  }

  /** A dropped Google task or message, as commands that plan it; null when the payload is not one. */
  importDropped(raw: string, placement: Placement, position?: number): { bodies: EventBody[]; taskId: string; label: string } | null {
    let drag: unknown = null;
    try {
      drag = JSON.parse(raw);
    } catch {
      return null;
    }
    const value = drag as { kind?: unknown; item?: unknown } | null;
    if (value?.kind === 'gtask' && isGoogleTaskItem(value.item)) return { ...this.importTask(value.item, placement, position), label: `Planned "${value.item.title}"` };
    if (value?.kind === 'mail' && isMailItem(value.item)) return { ...this.importMail(value.item, placement, position), label: `Planned "${value.item.subject}"` };
    return null;
  }

  /** Make a Google task from a Planner task, and link the two. */
  async createTask(task: Task, account: string, listId: string): Promise<void> {
    const due = task.placement.kind === 'day' ? task.placement.date : task.dueDate ?? null;
    const answer = await this.client.call<{ task: GoogleTaskItem | null }>('POST', '/google/tasks', { account, listId, title: task.title, ...(task.notes.trim() ? { notes: task.notes.slice(0, 8000) } : {}), ...(due ? { due } : {}) });
    if (!answer.task) throw new Error('Google did not return the task');
    await this.client.dispatch([{ type: 'task.updated', taskId: task.id, patch: { source: gtaskSource(answer.task) } }], { undo: 'Added to Google Tasks' });
    this.remember(answer.task, true);
    if (this.view.list?.account === account && this.view.list.id === listId) void this.refreshTasks();
  }

  /** Complete or reopen the Google task behind a linked task, or set its due date. */
  async writeTask(task: Task, patch: { completed?: boolean; due?: DateKey | null }, quiet = false): Promise<boolean> {
    const source = task.source;
    if (source?.kind !== 'gtask' || !source.account || !source.listId) return false;
    try {
      const answer = await this.client.call<{ task: GoogleTaskItem | null }>('PATCH', '/google/tasks', { account: source.account, listId: source.listId, id: source.id, ...patch });
      if (answer.task) await this.client.dispatch([{ type: 'task.sourceSynced', taskId: task.id, source: gtaskSource(answer.task) }], { origin: 'google' });
      if (answer.task) this.remember(answer.task);
      if (!quiet && patch.completed !== undefined) this.client.notify(patch.completed ? `Completed "${task.title}" in Google Tasks` : `Reopened "${task.title}" in Google Tasks`);
      if (this.view.list?.account === source.account && this.view.list.id === source.listId) void this.refreshTasks();
      calendarUi.refresh();
      return true;
    } catch (error) {
      this.client.notify(`Couldn't update "${task.title}" in Google Tasks: ${messageOf(error)}`);
      return false;
    }
  }

  answerPrompt(answer: 'yes' | 'no' | 'always'): void {
    const prompt = this.view.prompt;
    this.set({ prompt: null });
    if (!prompt || answer === 'no') return;
    if (answer === 'always') void this.client.dispatch([{ type: 'settings.updated', patch: { googleTasksOnComplete: 'complete' } }]);
    const task = this.client.getView().state.tasks[prompt.taskId];
    if (task) void this.writeTask(task, { completed: true });
  }

  /** Bring linked tasks up to date with their Google tasks, asked for in parts the service answers in time. */
  async sync(): Promise<void> {
    const parts = linkedGoogleTasks(this.client.getView().state).flatMap((group) => Array.from({ length: Math.ceil(group.ids.length / SYNC_IDS) }, (_, index) => ({ ...group, ids: group.ids.slice(index * SYNC_IDS, (index + 1) * SYNC_IDS) })));
    if (!parts.length) return;
    try {
      const tasks: GoogleTaskItem[] = [];
      for (let index = 0; index < parts.length; index += SYNC_GROUPS) {
        const answer = await this.client.call<{ tasks: GoogleTaskItem[] }>('POST', '/google/tasks/linked', { groups: parts.slice(index, index + SYNC_GROUPS) });
        tasks.push(...answer.tasks);
      }
      const { state, today } = this.client.getView();
      const bodies = planGoogleTaskSync(state, new Map(tasks.map((item) => [item.id, item])), { today, importCompletion: state.settings.googleTasksImportCompletion });
      if (bodies.length) await this.client.dispatch(bodies, { origin: 'google' });
    } catch (error) {
      console.warn(`[planner] Google Tasks sync skipped: ${messageOf(error)}`);
    }
  }

  // ── The Tasks view, as the Google Tasks app ──────────────────────────────

  /** Read a list with its completed tasks. */
  async loadBoard(account: string, listId: string): Promise<void> {
    const key = listKey(account, listId);
    const current = this.view.board[key];
    this.setBoard(key, { items: current?.items ?? [], loading: true, error: null, complete: current?.complete ?? true });
    try {
      const answer = await this.client.call<{ tasks: GoogleTaskItem[]; complete: boolean }>('GET', `/google/tasks/all?account=${encodeURIComponent(account)}&list=${encodeURIComponent(listId)}`);
      this.setBoard(key, { items: answer.tasks, loading: false, error: null, complete: answer.complete });
    } catch (error) {
      this.setBoard(key, { items: current?.items ?? [], loading: false, error: messageOf(error), complete: true });
    }
  }

  async createList(account: string, title: string): Promise<GoogleTaskList> {
    const answer = await this.client.call<{ list: GoogleTaskList }>('POST', '/google/tasklists', { account, title });
    this.set({ lists: [...this.view.lists, answer.list] });
    this.setBoard(listKey(account, answer.list.id), { items: [], loading: false, error: null, complete: true });
    return answer.list;
  }

  async renameList(list: GoogleTaskList, title: string): Promise<void> {
    const rename = (to: string) => this.set({ lists: this.view.lists.map((item) => (item.account === list.account && item.id === list.id ? { ...item, title: to } : item)) });
    rename(title);
    try {
      await this.client.call('PATCH', '/google/tasklists', { account: list.account, listId: list.id, title });
    } catch (error) {
      rename(list.title);
      throw error;
    }
  }

  async deleteList(list: GoogleTaskList): Promise<void> {
    await this.client.call('DELETE', `/google/tasklists?account=${encodeURIComponent(list.account)}&list=${encodeURIComponent(list.id)}`);
    const lists = this.view.lists.filter((item) => !(item.account === list.account && item.id === list.id));
    const { [listKey(list.account, list.id)]: _gone, ...board } = this.view.board;
    const selected = this.view.list?.account === list.account && this.view.list.id === list.id;
    this.set({ lists, board, ...(selected ? { list: lists[0] ? { account: lists[0].account, id: lists[0].id } : null, tasks: [] } : {}) });
    if (selected) void this.refreshTasks();
    calendarUi.refresh();
  }

  /** A new task: at the top of the list, or under `parent` after `previous`. Shown at once. */
  async addListTask(account: string, listId: string, fields: { title: string; notes?: string; due?: DateKey | null; parent?: string | null; previous?: string | null }): Promise<GoogleTaskItem> {
    const key = listKey(account, listId);
    const temp: GoogleTaskItem = { account, listId, id: `new-${newId()}`, title: fields.title, notes: fields.notes ?? '', due: fields.due ?? null, completed: false, parent: fields.parent ?? null, position: '', url: 'https://tasks.google.com/', updated: new Date().toISOString() };
    const items = this.view.board[key]?.items ?? [];
    this.patchBoard(key, applyMove([...items, temp], temp.id, { parent: temp.parent, previous: fields.previous ?? null }));
    try {
      const answer = await this.client.call<{ task: GoogleTaskItem | null }>('POST', '/google/tasks', { account, listId, ...fields, ...(fields.notes ? {} : { notes: undefined }) });
      if (!answer.task) throw new Error('Google did not return the task');
      this.patchBoard(key, (this.view.board[key]?.items ?? []).map((item) => (item.id === temp.id ? answer.task! : item)));
      this.afterTaskWrite(account, listId, Boolean(fields.due));
      // Google may renumber the other tasks' places: read the list as Google has it now.
      if (this.view.board[key]) void this.loadBoard(account, listId);
      return answer.task;
    } catch (error) {
      this.patchBoard(key, (this.view.board[key]?.items ?? []).filter((item) => item.id !== temp.id));
      throw error;
    }
  }

  /** Rename a task, change its details or due date (Google Tasks keeps no time). */
  async editListTask(item: GoogleTaskItem, patch: { title?: string; notes?: string; due?: DateKey | null }): Promise<void> {
    await this.writeListTask([item], () => patch, patch.due !== undefined || patch.title !== undefined);
  }

  /**
   * Complete or reopen a task. As in Google Tasks, completing a task completes
   * its subtasks, and reopening a subtask reopens the task it is under.
   */
  async completeListTask(item: GoogleTaskItem, completed: boolean): Promise<void> {
    const items = this.view.board[listKey(item.account, item.listId)]?.items ?? [item];
    const related = completed ? items.filter((other) => other.parent === item.id && !other.completed) : items.filter((other) => other.id === item.parent && other.completed);
    await this.writeListTask([item, ...related], () => ({ completed }), true);
    void this.sync();
  }

  /** Delete a task and its subtasks. */
  async deleteListTask(item: GoogleTaskItem): Promise<void> {
    const key = listKey(item.account, item.listId);
    const before = this.view.board[key]?.items ?? [];
    this.patchBoard(key, before.filter((other) => other.id !== item.id && other.parent !== item.id));
    try {
      await this.client.call('DELETE', `/google/tasks?account=${encodeURIComponent(item.account)}&list=${encodeURIComponent(item.listId)}&id=${encodeURIComponent(item.id)}`);
      this.afterTaskWrite(item.account, item.listId, true);
    } catch (error) {
      this.patchBoard(key, before);
      throw error;
    }
  }

  /** Google Tasks' "Delete all completed tasks": each completed task of a list, gone at once. */
  async clearCompleted(account: string, listId: string): Promise<number> {
    const key = listKey(account, listId);
    const before = this.view.board[key]?.items ?? [];
    // Subtasks first: deleting a task deletes its subtasks, which would then not be found.
    const done = before.filter((item) => item.completed).sort((a, b) => Number(Boolean(b.parent)) - Number(Boolean(a.parent)));
    this.patchBoard(key, before.filter((item) => !item.completed));
    try {
      for (const item of done) await this.client.call('DELETE', `/google/tasks?account=${encodeURIComponent(account)}&list=${encodeURIComponent(listId)}&id=${encodeURIComponent(item.id)}`);
      this.afterTaskWrite(account, listId, true);
      return done.length;
    } catch (error) {
      void this.loadBoard(account, listId);
      throw error;
    }
  }

  /** Put a task under `parent` after `previous`, in its list or another of the same account. Shown at once. */
  async moveListTask(item: GoogleTaskItem, target: MoveTarget, destinationListId: string = item.listId): Promise<void> {
    const from = listKey(item.account, item.listId);
    const to = listKey(item.account, destinationListId);
    const before = { from: this.view.board[from]?.items ?? [], to: this.view.board[to]?.items ?? [] };
    if (from === to) this.patchBoard(from, applyMove(before.from, item.id, target));
    else {
      const moving = before.from.filter((other) => other.id === item.id || other.parent === item.id).map((other) => ({ ...other, listId: destinationListId }));
      this.patchBoard(from, before.from.filter((other) => other.id !== item.id && other.parent !== item.id));
      this.patchBoard(to, applyMove([...before.to, ...moving], item.id, target));
    }
    try {
      await this.client.call<{ task: GoogleTaskItem | null }>('POST', '/google/tasks/move', { account: item.account, listId: item.listId, id: item.id, parent: target.parent, previous: target.previous, ...(to !== from ? { destinationListId } : {}) });
      this.afterTaskWrite(item.account, item.listId, to !== from);
      // A move can renumber the places of the tasks around it: read the lists as Google has them now.
      if (this.view.board[from]) void this.loadBoard(item.account, item.listId);
      if (to !== from && this.view.board[to]) void this.loadBoard(item.account, destinationListId);
    } catch (error) {
      this.patchBoard(from, before.from);
      if (to !== from) this.patchBoard(to, before.to);
      throw error;
    }
  }

  /** A Google task shown on the calendar, due another day (from a drag in the calendar). */
  async setTaskDue(item: GoogleTaskItem, due: DateKey): Promise<void> {
    await this.writeListTask([item], () => ({ due }), true);
  }

  /** Several tasks patched alike: shown at once, put back when Google refuses. */
  private async writeListTask(items: readonly GoogleTaskItem[], patchOf: (item: GoogleTaskItem) => { title?: string; notes?: string; due?: DateKey | null; completed?: boolean }, calendar: boolean): Promise<void> {
    const first = items[0];
    if (!first) return;
    const key = listKey(first.account, first.listId);
    const before = this.view.board[key]?.items ?? null;
    const now = new Date().toISOString();
    const shown = (item: GoogleTaskItem): GoogleTaskItem => {
      const patch = patchOf(item);
      return { ...item, ...patch, ...(patch.completed !== undefined ? { completedAt: patch.completed ? now : null } : {}) } as GoogleTaskItem;
    };
    if (before) this.patchBoard(key, before.map((item) => (items.some((target) => target.id === item.id) ? shown(item) : item)));
    try {
      for (const item of items) {
        const answer = await this.client.call<{ task: GoogleTaskItem | null }>('PATCH', '/google/tasks', { account: item.account, listId: item.listId, id: item.id, ...patchOf(item) });
        if (answer.task) this.remember(answer.task);
      }
      this.afterTaskWrite(first.account, first.listId, calendar);
    } catch (error) {
      if (before) this.patchBoard(key, before);
      throw error;
    }
  }

  /** Google's answer for a task, where the Tasks view shows its list; a new one joins it. */
  private remember(item: GoogleTaskItem, add = false): void {
    const key = listKey(item.account, item.listId);
    const list = this.view.board[key];
    if (!list) return;
    const known = list.items.some((other) => other.id === item.id);
    if (!known && !add) return;
    this.patchBoard(key, known ? list.items.map((other) => (other.id === item.id ? item : other)) : [...list.items, item]);
  }

  private afterTaskWrite(account: string, listId: string, calendar: boolean): void {
    if (this.view.list?.account === account && this.view.list.id === listId) void this.refreshTasks();
    if (calendar) calendarUi.refresh();
  }

  private setBoard(key: string, list: TaskBoardList): void {
    this.set({ board: { ...this.view.board, [key]: list } });
  }

  /** New items for a list the Tasks view has read; lists it has not read stay unread. */
  private patchBoard(key: string, items: GoogleTaskItem[]): void {
    const current = this.view.board[key];
    if (current) this.setBoard(key, { ...current, items });
  }

  private async settleSignIn(id: string, result: SignInResult): Promise<void> {
    const current = this.view.signIn;
    if (!current || current.id !== id) return;
    this.set({ signIn: { ...current, result } });
    if (result.status === 'pending') return;
    this.stopSignIn();
    if (result.status === 'connected') {
      this.client.notify(`Connected ${result.email} to the Planner`);
      this.set({ signIn: null });
      await this.checkStatus();
      if (result.features.includes('calendar')) void this.loadCalendars();
    }
  }

  private stopSignIn(): void {
    if (this.signInTimer) clearTimeout(this.signInTimer);
    this.signInTimer = null;
  }

  /** Drop the calendars (and the session calendar) of accounts that are gone. */
  private async forgetCalendars(gone: (account: string) => boolean): Promise<void> {
    const state = this.client.getView().state;
    const bodies: EventBody[] = Object.values(state.calendars)
      .filter((calendar) => calendar.google && gone(calendar.google.account))
      .map((calendar) => ({ type: 'calendar.removed', calendarId: calendar.id }));
    if (state.settings.googleTimebox && gone(state.settings.googleTimebox.account)) bodies.push({ type: 'settings.updated', patch: { googleTimebox: null } });
    if (bodies.length) await this.client.dispatch(bodies);
  }

  private afterCommit(commands: readonly Command[], before: PlannerState, after: PlannerState, origin: Origin): void {
    // Only the user's own changes reach Google, from the surface they were made in.
    if (origin !== 'user' || !this.accountsWith('tasks').length) return;
    const settings = after.settings;
    for (const command of commands) {
      if (command.type === 'task.completed' || command.type === 'task.reopened') {
        const task = after.tasks[command.taskId];
        if (task?.source?.kind !== 'gtask') continue;
        const doneThere = task.source.status?.type === 'completed';
        if (command.type === 'task.completed' && !doneThere) {
          if (settings.googleTasksOnComplete === 'complete') void this.writeTask(task, { completed: true });
          // Only surfaces with room for the question ask it.
          else if (settings.googleTasksOnComplete === 'ask' && this.surface !== 'status') this.set({ prompt: { taskId: task.id, title: task.title } });
        } else if (command.type === 'task.reopened' && doneThere && settings.googleTasksOnComplete === 'complete') void this.writeTask(task, { completed: false });
        continue;
      }
      // Planned on a day: Google Calendar shows the task that day too.
      const plannedId = command.type === 'task.created' ? command.task.id : command.type === 'task.moved' ? command.taskId : null;
      if (!plannedId || !settings.googleTasksDueFromPlan) continue;
      const task = after.tasks[plannedId];
      const previous = before.tasks[plannedId];
      if (task?.source?.kind !== 'gtask' || task.placement.kind !== 'day' || task.completedAt) continue;
      if (previous?.placement.kind === 'day' && previous.placement.date === task.placement.date) continue;
      // Planned on the day it is due in Google already.
      if (command.type === 'task.created' && command.task.dueDate === task.placement.date) continue;
      void this.writeTask(task, { due: task.placement.date }, true);
    }
  }

  private set(patch: Partial<GoogleView>): void {
    this.view = { ...this.view, ...patch };
    for (const listener of this.listeners) listener();
  }
}
