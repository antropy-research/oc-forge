// Panel-side Google: the accounts the local service signed in, the Google
// calendars to show beside the plan, Google Tasks and Gmail messages to plan as
// tasks, and writing completion and due dates back to Google Tasks the way the
// Linear integration writes back to Linear (ask, do, or not).
import type { HostClient } from '@openchamber/sdk';
import { GOOGLE_NOTES_MAX, GTASK_EXCEPTIONS_MAX, type Command, type DeclineInput, type EventBody, type GoogleTaskKeptPatch } from '../../src/domain/events.ts';
import {
  findMovedTask,
  GONE_STATUS,
  gtaskSource,
  isGoogleTaskItem,
  isMailItem,
  linkedGoogleTasks,
  planGoogleTaskSync,
  plannerEditTimes,
  TASK_GONE,
  taskForGoogleTask,
  taskForMail,
  taskFromGoogleTask,
  taskFromMail,
  type GoogleCalendarInfo,
  type GoogleTaskItem,
  type GoogleTaskList,
  type GoogleTaskWrite,
  type MailItem,
  type SyncedField,
} from '../../src/domain/google.ts';
import {
  dueOccurrences,
  firstSightOfSeries,
  keptFor,
  nextOccurrence,
  scheduledOn,
  seriesCut,
  seriesTemplate,
  templateOf,
  upcomingValues,
  type MadeTask,
  type SeriesSide,
  type UpcomingTask,
} from '../../src/domain/gtaskKept.ts';
import { edgePosition } from '../../src/domain/selectors.ts';
import { newId } from '../../src/domain/ids.ts';
import { addDays } from '../../src/domain/dates.ts';
import { longDay } from '../../src/domain/gcalendar.ts';
import { applyMove, positionBetween, type MoveTarget } from '../../src/domain/gtasks.ts';
import type { CalendarSubscription, DateKey, GoogleTaskException, GoogleTaskKept, GoogleTaskTemplate, Placement, PlannerState, Task, TaskAttachment, TaskVisibility } from '../../src/domain/types.ts';
import type { DeclinedMeeting, DriveFile } from '../../src/domain/gtaskAdvanced.ts';
import type { Origin, PlannerClient, Snapshot } from './client.ts';
import { calendarUi } from './gcal.ts';

/**
 * What a Google task's form sets: Google's own fields, and what the Planner keeps for it; Busy, a visibility, Do not
 * disturb and declining meetings only with a time, declining only Busy (left out: as they are), a color (null: its
 * list's) and Drive attachments.
 */
export interface TaskFields {
  title: string;
  notes: string;
  due: DateKey | null;
  kept: Pick<GoogleTaskKept, 'time' | 'duration' | 'deadline'> & {
    rule: string | null;
    busy?: boolean;
    visibility?: TaskVisibility;
    color?: string | null;
    attachments?: TaskAttachment[];
    doNotDisturb?: boolean;
    decline?: DeclineInput | null;
  };
}

/** The advanced settings a form's fields give a task, from what is kept for it now where the form leaves one out. */
export const advancedOf = (fields: TaskFields['kept'], kept: GoogleTaskKept | null) => {
  const timed = fields.time !== null;
  const busy = timed && (fields.busy ?? Boolean(kept?.busy));
  const decline = busy ? (fields.decline !== undefined ? fields.decline : kept?.decline ?? null) : null;
  return {
    busy,
    visibility: timed ? fields.visibility ?? kept?.visibility ?? ('default' as TaskVisibility) : ('default' as TaskVisibility),
    doNotDisturb: timed && (fields.doNotDisturb ?? Boolean(kept?.doNotDisturb)),
    // Declining stays on since it was turned on; a new message or mode keeps that.
    decline: decline ? { mode: decline.mode, message: decline.message, ...(decline.since ?? kept?.decline?.since ? { since: decline.since ?? kept!.decline!.since } : {}) } : null,
    color: fields.color !== undefined ? fields.color : kept?.color ?? null,
  };
};

/** Whether the form changes a task's series-wide advanced settings (availability, visibility, color, Do not disturb, declining). */
export const advancedChanged = (fields: TaskFields['kept'], kept: GoogleTaskKept | null): boolean => {
  const next = advancedOf(fields, kept);
  return (
    next.busy !== Boolean(kept?.busy) ||
    next.visibility !== (kept?.visibility ?? 'default') ||
    next.doNotDisturb !== Boolean(kept?.doNotDisturb) ||
    next.color !== (kept?.color ?? null) ||
    (next.decline?.mode ?? null) !== (kept?.decline?.mode ?? null) ||
    (next.decline?.message ?? null) !== (kept?.decline?.message ?? null)
  );
};

/** Whether the form changes a task's attachments. */
export const attachmentsChanged = (fields: TaskFields['kept'], kept: GoogleTaskKept | null): boolean =>
  fields.attachments !== undefined && JSON.stringify(fields.attachments.map((file) => file.id)) !== JSON.stringify((kept?.attachments ?? []).map((file) => file.id));

/** Why a repeating task cannot go to another list: Google Tasks keeps it in its own. */
export const REPEATING_STAYS = 'A repeating task stays in its list, as in Google Tasks';
/** Why a repeating task takes no subtasks, and does not become one; and why a subtask, or a task with subtasks, does not repeat. */
export const REPEATING_NO_SUBTASKS = "A repeating task can't have subtasks, as in Google Tasks";
export const REPEATING_NOT_SUBTASK = "A repeating task can't be a subtask, as in Google Tasks";
export const SUBTASKS_NO_REPEAT = "A task with subtasks can't repeat, as in Google Tasks";
export const SUBTASK_NO_REPEAT = "A subtask can't repeat, as in Google Tasks";
/** A shared task (assigned from a Doc or a Chat space) neither repeats nor takes subtasks, as in Google Tasks. */
export const SHARED_NO_REPEAT = "A shared task can't repeat, as in Google Tasks";
export const SHARED_NO_SUBTASKS = "A shared task can't have subtasks, as in Google Tasks";
/** Why one upcoming task of a series keeps a date: deleting it is how it goes. */
export const OCCURRENCE_KEEPS_DATE = 'A task of a repeating series keeps a date: delete it to skip that day';

/** Which tasks of a repeating series a change is for, as Google Calendar asks: This task or All tasks. */
export type RepeatScope = 'this' | 'all';
/** Which tasks of a repeating series a deletion is for, as Google Calendar asks. */
export type DeleteScope = 'this' | 'following' | 'all';
/** Google Calendar's choices for deleting a repeating task, in its words. */
export const DELETE_CHOICES: { id: DeleteScope; label: string }[] = [
  { id: 'this', label: 'This task' },
  { id: 'following', label: 'This and following tasks' },
  { id: 'all', label: 'All tasks' },
];

export type GoogleFeature = 'calendar' | 'tasks' | 'mail' | 'drive';

export interface GoogleAccountView {
  email: string;
  features: GoogleFeature[];
  addedAt: string;
  /** A work or school account (Google Workspace). */
  workspace?: boolean;
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

/** What Google Tasks' Undo does, once: what to say then, and (`note`) anything that stayed as it is. */
type UndoEntry = () => Promise<{ done: string; note: string | null }>;

/**
 * Complete a task with Google Tasks' and Google Calendar's "Task completed · Undo" in the snackbar (and Ctrl/⌘+Z in
 * the Tasks view).
 */
export const completeWithUndo = async (google: Pick<GoogleStore, 'completeListTask' | 'undoLast'>, notify: (message: string) => void, item: GoogleTaskItem): Promise<void> => {
  await google.completeListTask(item, true);
  calendarUi.snack('Task completed', undoAction(google, notify));
};

/** The snackbar's "Undo" (after Delete, or after completing): the last of those taken back; what stayed, or a refusal, said. */
export const undoAction = (google: Pick<GoogleStore, 'undoLast'>, notify: (message: string) => void) => async (): Promise<void> => {
  try {
    const done = await google.undoLast();
    if (done?.note) notify(done.note);
  } catch (error) {
    notify(`Google Tasks did not undo it: ${messageOf(error)}`);
  }
};

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
  /** First sights of accounts' calendars, one after another (two loads at once must not show a calendar twice). */
  private introductions: Promise<void> = Promise.resolve();
  /** Repeating tasks whose next occurrence is being made, so it is made once. */
  private readonly making = new Set<string>();
  /** Open tasks of series a read no longer found, being looked for (`missingHeads`). */
  private readonly looking = new Set<string>();

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

  /** Whether an account allowed a feature. */
  allows(account: string, feature: GoogleFeature): boolean {
    return Boolean(this.view.status?.accounts.find((item) => item.email === account)?.features.includes(feature));
  }

  /** A work or school account (Google Workspace): Google Calendar gives its tasks Do not disturb and declining meetings. */
  isWorkspace(account: string): boolean {
    return Boolean(this.view.status?.accounts.find((item) => item.email === account)?.workspace);
  }

  /**
   * Ask Google for one more feature of an account (Drive, to attach files), the way the Planner asks for the others:
   * a sign-in for what it has plus that one, which Google adds to what was allowed before.
   */
  allow(account: string, feature: GoogleFeature): Promise<void> {
    const current = this.view.status?.accounts.find((item) => item.email === account)?.features ?? [];
    return this.connect([...new Set([...current, feature])]);
  }

  /** Drive files whose name has `text` (the latest when empty), to attach to a task. */
  async searchDrive(account: string, text: string): Promise<DriveFile[]> {
    const answer = await this.client.call<{ files: DriveFile[] }>('GET', `/google/drive/files?account=${encodeURIComponent(account)}&q=${encodeURIComponent(text)}`);
    return answer.files ?? [];
  }

  /** The meetings the Planner declined for a task. */
  async declinedFor(account: string, taskId: string): Promise<DeclinedMeeting[]> {
    const answer = await this.client.call<{ declined: DeclinedMeeting[] }>('GET', `/google/tasks/declined?account=${encodeURIComponent(account)}&task=${encodeURIComponent(taskId)}`);
    return answer.declined ?? [];
  }

  /** "Automatically decline meetings" now, after a task's change; says what it declined. */
  declineSoon(): void {
    void this.client
      .call<{ declined: DeclinedMeeting[]; errors: string[] }>('POST', '/google/tasks/decline')
      .then((answer) => {
        const declined = answer.declined ?? [];
        if (declined.length) {
          calendarUi.refresh();
          const names = declined.slice(0, 3).map((meeting) => `"${meeting.summary}"`).join(', ');
          this.client.notify(`Declined ${declined.length === 1 ? 'a meeting' : `${declined.length} meetings`} during "${declined[0]!.task}": ${names}${declined.length > 3 ? '…' : ''}`);
        }
        if (answer.errors?.length) this.client.notify(`Some meetings were not declined: ${answer.errors[0]}`);
      })
      .catch(() => {
        // The service declines them at its next pass.
      });
  }

  async checkStatus(): Promise<void> {
    try {
      const status = await this.client.call<GoogleStatusView>('GET', '/google/status');
      this.set({ status, error: null });
      // An account the Planner has not seen yet gets its own calendar shown (loadCalendars), wherever the user is.
      const seen = this.client.getView().state.settings.googleCalendarsIntroduced ?? [];
      if (status.accounts.some((account) => account.features.includes('calendar') && !seen.includes(account.email))) void this.loadCalendars();
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
      this.introductions = this.introductions.then(() => this.introduce(answer.calendars)).catch(() => {});
      await this.introductions;
    } catch (error) {
      this.set({ calendarErrors: [{ account: '', message: messageOf(error) }] });
    }
  }

  /**
   * Google Calendar shows your own calendar from the start: the first time the
   * Planner sees an account's calendars, its primary calendar is shown, unless
   * one of that account's calendars already is. Once per account, so a calendar
   * hidden or removed later stays as the user left it.
   */
  private async introduce(calendars: readonly GoogleCalendarInfo[]): Promise<void> {
    const state = this.client.getView().state;
    const seen = state.settings.googleCalendarsIntroduced ?? [];
    const accounts = [...new Set(calendars.map((calendar) => calendar.account))].filter((account) => !seen.includes(account));
    if (!accounts.length) return;
    for (const account of accounts) {
      const shown = Object.values(state.calendars).some((item) => item.google?.account === account);
      const primary = calendars.find((calendar) => calendar.account === account && calendar.primary);
      if (!shown && primary) await this.showCalendar(primary, true);
    }
    await this.client.dispatch([{ type: 'settings.updated', patch: { googleCalendarsIntroduced: [...seen, ...accounts].slice(-50) } }]);
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

  /**
   * Complete or reopen the Google task behind a linked task, set its due date,
   * or send it the task's title, details or date. Written to the list the link
   * names; the service looks a task its list no longer has up in the account's
   * other lists once and writes there, and the link follows. A write that
   * still fails says so, and the Planner does not keep claiming what Google
   * does not have: a completion or reopening Google refused is undone here, a
   * task Google no longer has shows as deleted there. Completed or reopened,
   * it takes its subtasks or the task it is under along first, as the Tasks
   * view does (`completeListTask`), however little of its list is loaded.
   */
  async writeTask(task: Task, patch: GoogleTaskWrite['patch'] & { completed?: boolean }, quiet = false): Promise<boolean> {
    const source = task.source;
    if (source?.kind !== 'gtask' || !source.account || !source.listId) return false;
    try {
      const completed = patch.completed;
      if (completed !== undefined) {
        const related = await this.relatives({ account: source.account, listId: source.listId, id: source.id }, completed);
        // Planner tasks planning those take the change too.
        if (related.length) await this.syncItems(await this.writeListTask(related, () => ({ completed }), true));
      }
      const answer = await this.client.call<{ task: GoogleTaskItem | null }>('PATCH', '/google/tasks', { account: source.account, listId: source.listId, id: source.id, ...patch });
      const item = answer.task;
      if (item) {
        const current = this.client.getView().state.tasks[task.id] ?? task;
        // What was written is what both sides now agree on; a date set from the plan becomes the task's date here too.
        const planner = patch.due !== undefined && current.dueDate !== item.due ? { dueDate: item.due } : {};
        await this.client.dispatch([{ type: 'task.sourceSynced', taskId: task.id, source: gtaskSource(item), ...planner }], { origin: 'google' });
        if (item.listId !== source.listId) await this.followMove({ account: source.account, listId: source.listId, id: source.id }, item);
        this.remember(item);
        if (patch.completed) await this.makeNextOccurrences([item]);
      }
      if (!quiet && patch.completed !== undefined) this.client.notify(patch.completed ? `Completed "${task.title}" in Google Tasks` : `Reopened "${task.title}" in Google Tasks`);
      if (this.view.list?.account === source.account && (this.view.list.id === source.listId || this.view.list.id === item?.listId)) void this.refreshTasks();
      calendarUi.refresh();
      return true;
    } catch (error) {
      const message = messageOf(error);
      const current = this.client.getView().state.tasks[task.id];
      if (message === TASK_GONE) {
        this.client.notify(`"${task.title}" is no longer in Google Tasks`);
        if (current?.source?.kind === 'gtask') await this.client.dispatch([{ type: 'task.sourceSynced', taskId: task.id, source: { ...current.source, status: GONE_STATUS } }], { origin: 'google' });
      } else if (patch.completed === true && current?.completedAt) {
        this.client.notify(`Google Tasks did not complete "${task.title}" (${message}), so it stays open here too`);
        await this.client.dispatch([{ type: 'task.reopened', taskId: task.id }], { origin: 'google' });
      } else if (patch.completed === false && current && !current.completedAt) {
        this.client.notify(`Google Tasks did not reopen "${task.title}" (${message}), so it stays completed here too`);
        await this.client.dispatch([{ type: 'task.completed', taskId: task.id, on: current.completedOn ?? this.client.getView().today }], { origin: 'google' });
      } else this.client.notify(`Couldn't update "${task.title}" in Google Tasks: ${message}`);
      return false;
    }
  }

  /**
   * A Google task moved to another list (and, when Google gave it a new id,
   * under that id): the Planner tasks linked to it and what the Planner keeps
   * for it follow.
   */
  private async followMove(from: { account: string; listId: string; id: string }, to: GoogleTaskItem): Promise<void> {
    const state = this.client.getView().state;
    const bodies: EventBody[] = [];
    for (const task of Object.values(state.tasks)) {
      const source = task.source;
      if (source?.kind !== 'gtask' || source.id !== from.id || (source.account && source.account !== from.account) || task.deletedAt) continue;
      if (source.listId === to.listId && source.id === to.id) continue;
      bodies.push({ type: 'task.sourceSynced', taskId: task.id, source: gtaskSource(to) });
    }
    const kept = keptFor(state, { account: from.account, id: from.id });
    if (kept && (kept.listId !== to.listId || from.id !== to.id)) bodies.push({ type: 'gtask.moved', account: from.account, taskId: from.id, listId: to.listId, ...(to.id !== from.id ? { newTaskId: to.id } : {}) });
    if (bodies.length) await this.client.dispatch(bodies, { origin: 'google' });
  }

  /** What the Planner keeps for a Google task (a time, a deadline, a repeat, a star): set at once, with no Google write (Google Tasks has none of them for other apps). */
  setKept(item: Pick<GoogleTaskItem, 'account' | 'listId' | 'id'>, patch: GoogleTaskKeptPatch): Promise<void> {
    return this.client.dispatch([{ type: 'gtask.kept', account: item.account, listId: item.listId, taskId: item.id, patch }]);
  }

  /** Google Tasks' star: on, or off. Kept in the Planner alone, so nothing goes to Google. */
  toggleStar(item: Pick<GoogleTaskItem, 'account' | 'listId' | 'id'>): Promise<void> {
    return this.setKept(item, { starred: !keptFor(this.client.getView().state, item)?.starredAt });
  }

  /**
   * A timed Google task dragged on the grid: a new day is Google's date,
   * written first; a new time is kept here once Google has the day, so a day
   * Google refuses leaves the time as it was (the task keeps its time).
   */
  async moveTimedTask(item: GoogleTaskItem, date: DateKey, time: number): Promise<void> {
    if (item.due !== date) await this.setTaskDue(item, date);
    if (keptFor(this.client.getView().state, item)?.time !== time) await this.setKept(item, { time });
  }

  /**
   * The next occurrence of each repeating task just completed (here, in
   * Google, or found so on a read), made by `makeSuccessor`. A series that
   * ends there stops repeating. One Google refuses is said, and the completed
   * occurrence keeps its series (template, schedule and exceptions) as it
   * was: the next read makes it (`dueOccurrences`).
   */
  async makeNextOccurrences(items: readonly GoogleTaskItem[]): Promise<Map<string, MadeTask | null>> {
    // For each task, the next one this call made (Undo after completing takes that one back).
    const out = new Map<string, MadeTask | null>();
    for (const next of dueOccurrences(this.client.getView().state, items)) {
      const { item, kept } = next;
      const key = `${item.account}\n${item.id}`;
      if (this.making.has(key) || !kept.repeat) continue;
      this.making.add(key);
      try {
        // The service also ends a series that ends here, by the series as it is now (another window may have changed its rule).
        const { task, made } = await this.makeSuccessor(item);
        out.set(item.id, made);
        // Google may renumber the other tasks' places: read the list as Google has it now.
        if (task && this.view.board[listKey(task.account, task.listId)]) void this.loadBoard(task.account, task.listId);
      } catch (error) {
        this.client.notify(`Google Tasks did not take the next "${item.title}": ${messageOf(error)}`);
      } finally {
        this.making.delete(key);
      }
    }
    return out;
  }

  /**
   * The occurrence a series has after `item`, made by the service, which
   * changes one series at a time for every window (`GoogleSeries.next`): a
   * new Google task in the same list, on the series' next date (past the
   * dates deleted on their own) from its template, or as that occurrence was
   * changed on its own, as Google Tasks makes it, kept with its link
   * (`repeat.next`) in the same step. Another window asking at the same time
   * gets the one this one made, and one made already (kept as this series'
   * later occurrence) is taken, never a second; a task that only shares the
   * title and the date is never taken for it. A refusal throws before
   * anything changed. The task made or taken (null when the series has none
   * after `item`), and (`made`) the one this call made, as it was made.
   */
  private async makeSuccessor(item: GoogleTaskItem): Promise<{ task: GoogleTaskItem | null; made: MadeTask | null }> {
    const answer = await this.client.call<Snapshot & { task: GoogleTaskItem | null; made?: boolean }>('POST', '/google/tasks/next', { account: item.account, listId: item.listId, id: item.id, completed: item.completed, due: item.due });
    await this.client.adopt(answer);
    const task = answer.task;
    if (task) this.remember(task, true);
    calendarUi.refresh();
    const kept = task && answer.made && answer.state ? keptFor(answer.state, task) : null;
    return { task, made: task && kept ? { listId: task.listId, id: task.id, title: task.title, notes: task.notes, due: task.due, updatedAt: kept.updatedAt } : null };
  }

  answerPrompt(answer: 'yes' | 'no' | 'always'): void {
    const prompt = this.view.prompt;
    this.set({ prompt: null });
    if (!prompt || answer === 'no') return;
    if (answer === 'always') void this.client.dispatch([{ type: 'settings.updated', patch: { googleTasksOnComplete: 'complete' } }]);
    const task = this.client.getView().state.tasks[prompt.taskId];
    if (task) void this.writeTask(task, { completed: true });
  }

  /**
   * Bring linked tasks and their Google tasks into step, asked for in parts
   * the service answers in time: links follow tasks moved to other lists,
   * changes on either side reach the other (`planGoogleTaskSync`), repeating
   * tasks completed in Google get their next occurrence, and links to tasks
   * Google no longer has say so.
   */
  async sync(): Promise<void> {
    const parts = linkedGoogleTasks(this.client.getView().state).flatMap((group) => Array.from({ length: Math.ceil(group.ids.length / SYNC_IDS) }, (_, index) => ({ ...group, ids: group.ids.slice(index * SYNC_IDS, (index + 1) * SYNC_IDS) })));
    if (!parts.length) return;
    try {
      const tasks: GoogleTaskItem[] = [];
      const missing: { account: string; listId: string; id: string }[] = [];
      for (let index = 0; index < parts.length; index += SYNC_GROUPS) {
        const answer = await this.client.call<{ tasks: GoogleTaskItem[]; missing?: { account: string; listId: string; id: string }[] }>('POST', '/google/tasks/linked', { groups: parts.slice(index, index + SYNC_GROUPS) });
        tasks.push(...answer.tasks);
        missing.push(...(answer.missing ?? []));
      }
      await this.syncItems(tasks);
      if (missing.length) await this.relink(missing);
    } catch (error) {
      console.warn(`[planner] Google Tasks sync skipped: ${messageOf(error)}`);
    }
  }

  /**
   * Linked tasks against these Google tasks, field by field: what changed in
   * Google comes in, what changed here goes out, and a field changed on both
   * sides takes the newer change (the Planner's from the task's activity).
   */
  async syncItems(items: readonly GoogleTaskItem[]): Promise<void> {
    if (!items.length) return;
    const { state, today } = this.client.getView();
    const byId = new Map(items.map((item) => [item.id, item]));
    const options = { today, importCompletion: state.settings.googleTasksImportCompletion };
    let plan = planGoogleTaskSync(state, byId, options);
    if (plan.conflicts.length) {
      const times = new Map<string, Partial<Record<SyncedField, string>>>();
      for (const { taskId } of plan.conflicts) times.set(taskId, plannerEditTimes(await this.client.activity(taskId).catch(() => [])));
      plan = planGoogleTaskSync(state, byId, { ...options, editedAt: (taskId, field) => times.get(taskId)?.[field] ?? null });
    }
    if (plan.bodies.length) await this.client.dispatch(plan.bodies, { origin: 'google' });
    for (const write of plan.writes) {
      const task = this.client.getView().state.tasks[write.taskId];
      if (task) await this.writeTask(task, write.patch, true);
    }
    await this.keepSeries(items);
    await this.makeNextOccurrences(items);
  }

  /** A series kept before templates gets its template from its open occurrence the first time it is seen (`firstSightOfSeries`). */
  private async keepSeries(items: readonly GoogleTaskItem[]): Promise<void> {
    const bodies = firstSightOfSeries(this.client.getView().state, items);
    if (bodies.length) await this.client.dispatch(bodies, { origin: 'google' });
  }

  /** A Google task as Google has it now: the Tasks view's copy of its list, else read (following a move to another list). */
  async findTask(account: string, listId: string, id: string): Promise<GoogleTaskItem | null> {
    const known = this.view.board[listKey(account, listId)]?.items.find((item) => item.id === id);
    if (known) return known;
    const answer = await this.client.call<{ tasks: GoogleTaskItem[] }>('POST', '/google/tasks/linked', { groups: [{ account, listId, ids: [id] }] });
    return answer.tasks.find((item) => item.id === id) ?? null;
  }

  /** A list's tasks, completed ones too: the Tasks view's copy of it, else read from Google. */
  private async listItems(account: string, listId: string): Promise<GoogleTaskItem[]> {
    const known = this.view.board[listKey(account, listId)]?.items;
    return known ?? (await this.client.call<{ tasks?: GoogleTaskItem[] }>('GET', `/google/tasks/all?account=${encodeURIComponent(account)}&list=${encodeURIComponent(listId)}`)).tasks ?? [];
  }

  /** Whether a task has subtasks (open or done) in Google. */
  private async hasSubtasks(item: GoogleTaskItem): Promise<boolean> {
    return (await this.listItems(item.account, item.listId)).some((other) => other.parent === item.id);
  }

  /**
   * What changes with a task completed or reopened, as in Google Tasks: its
   * open subtasks when it is completed, the completed task it is under when it
   * is reopened. Its list as the Tasks view has it, else read from Google, so
   * the result is the same however little the panel has loaded. A task whose
   * parent is known needs no read when it can have none: a subtask has no
   * subtasks, a task at the top is under none.
   */
  private async relatives(task: { account: string; listId: string; id: string; parent?: string | null }, completed: boolean): Promise<GoogleTaskItem[]> {
    if (task.parent !== undefined && (completed ? task.parent !== null : task.parent === null)) return [];
    let items = await this.listItems(task.account, task.listId);
    if (!items.some((other) => other.id === task.id)) {
      // Moved to another list in Google's own apps since the Planner last read it (the write finds it there too):
      // its relatives are in the list it is in now.
      const lists = this.view.lists.length ? this.view.lists : ((await this.client.call<{ lists?: GoogleTaskList[] }>('GET', '/google/tasklists').catch(() => null))?.lists ?? []);
      for (const list of lists.filter((other) => other.account === task.account && other.id !== task.listId)) {
        const there = await this.listItems(task.account, list.id);
        if (there.some((other) => other.id === task.id)) {
          items = there;
          break;
        }
      }
    }
    if (completed) return items.filter((other) => other.parent === task.id && !other.completed);
    const parent = task.parent ?? items.find((other) => other.id === task.id)?.parent ?? null;
    return parent ? items.filter((other) => other.id === parent && other.completed) : [];
  }

  /**
   * Linked tasks whose Google task is in none of the account's lists under its
   * id: one Google's own apps moved under a new id is found by what it last
   * said (`findMovedTask`); the rest show as deleted in Google.
   */
  private async relink(missing: readonly { account: string; listId: string; id: string }[]): Promise<void> {
    const candidates: GoogleTaskItem[] = [];
    for (const account of new Set(missing.map((item) => item.account))) {
      for (const list of this.view.lists.filter((item) => item.account === account)) {
        const answer = await this.client.call<{ tasks: GoogleTaskItem[] }>('GET', `/google/tasks/all?account=${encodeURIComponent(account)}&list=${encodeURIComponent(list.id)}`).catch(() => ({ tasks: [] }));
        candidates.push(...answer.tasks);
      }
    }
    const state = this.client.getView().state;
    const bodies: EventBody[] = [];
    for (const gone of missing) {
      const found = Object.values(state.tasks).find((task) => task.source?.kind === 'gtask' && task.source.id === gone.id && task.source.account === gone.account && !task.deletedAt);
      const moved = found?.source ? findMovedTask(found.source, candidates, state) : null;
      if (moved) {
        await this.followMove(gone, moved);
        continue;
      }
      for (const task of Object.values(state.tasks)) {
        if (task.source?.kind !== 'gtask' || task.source.id !== gone.id || task.source.account !== gone.account || task.deletedAt || task.source.status?.name === GONE_STATUS.name) continue;
        bodies.push({ type: 'task.sourceSynced', taskId: task.id, source: { ...task.source, status: GONE_STATUS } });
      }
      if (keptFor(state, gone)) bodies.push({ type: 'gtask.dropped', account: gone.account, taskId: gone.id });
    }
    if (bodies.length) await this.client.dispatch(bodies, { origin: 'google' });
  }

  // ── The Tasks view, as the Google Tasks app ──────────────────────────────

  /**
   * Read a list with its completed tasks. What the Planner keeps for a task
   * seen here follows it from another list, and a repeating task completed in
   * Google gets its next occurrence.
   */
  async loadBoard(account: string, listId: string): Promise<void> {
    const key = listKey(account, listId);
    const current = this.view.board[key];
    this.setBoard(key, { items: current?.items ?? [], loading: true, error: null, complete: current?.complete ?? true });
    try {
      const answer = await this.client.call<{ tasks: GoogleTaskItem[]; complete: boolean }>('GET', `/google/tasks/all?account=${encodeURIComponent(account)}&list=${encodeURIComponent(listId)}`);
      this.setBoard(key, { items: answer.tasks, loading: false, error: null, complete: answer.complete });
      const state = this.client.getView().state;
      const moved: EventBody[] = answer.tasks.flatMap((item) => {
        const kept = keptFor(state, item);
        return kept && kept.listId !== item.listId ? [{ type: 'gtask.moved' as const, account: item.account, taskId: item.id, listId: item.listId }] : [];
      });
      if (moved.length) await this.client.dispatch(moved, { origin: 'google' });
      await this.keepSeries(answer.tasks);
      await this.makeNextOccurrences(answer.tasks);
      if (answer.complete) this.missingHeads(account, listId, answer.tasks);
    } catch (error) {
      this.setBoard(key, { items: current?.items ?? [], loading: false, error: messageOf(error), complete: true });
    }
  }

  /**
   * The open tasks of series in a list that a complete read of it no longer
   * has: moved to another list or deleted in Google's own apps. The service
   * looks (`GoogleSeries.gone`): one moved is followed, one deleted is taken
   * as "This task" deleted there, so its series goes on from its next one
   * instead of showing upcoming tasks after a task Google no longer has.
   */
  private missingHeads(account: string, listId: string, tasks: readonly GoogleTaskItem[]): void {
    for (const kept of Object.values(this.client.getView().state.googleTasks ?? {})) {
      const key = `${account}\n${kept.taskId}`;
      if (kept.account !== account || kept.listId !== listId || !kept.repeat || kept.repeat.next || this.looking.has(key) || tasks.some((task) => task.id === kept.taskId)) continue;
      this.looking.add(key);
      void this.client
        .call<Snapshot>('POST', '/google/tasks/gone', { account, listId, id: kept.taskId })
        .then((answer) => this.client.adopt(answer))
        .then(() => calendarUi.refresh())
        .catch((error) => console.warn(`[planner] Google Tasks: where a series' task went is not known: ${messageOf(error)}`))
        .finally(() => this.looking.delete(key));
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
    // Its tasks went with it in Google: what the Planner kept for them (their repeats' upcoming occurrences on the
    // calendar too) goes now, not on the next read, and Planner tasks linked to them say they are gone.
    const state = this.client.getView().state;
    const bodies: EventBody[] = [
      ...Object.values(state.googleTasks ?? {})
        .filter((kept) => kept.account === list.account && kept.listId === list.id)
        .map((kept) => ({ type: 'gtask.dropped' as const, account: kept.account, taskId: kept.taskId })),
      ...Object.values(state.tasks)
        .filter((task) => task.source?.kind === 'gtask' && task.source.account === list.account && task.source.listId === list.id && !task.deletedAt && task.source.status?.name !== GONE_STATUS.name)
        .map((task) => ({ type: 'task.sourceSynced' as const, taskId: task.id, source: { ...task.source!, status: GONE_STATUS } })),
    ];
    if (bodies.length) await this.client.dispatch(bodies, { origin: 'google' });
    const lists = this.view.lists.filter((item) => !(item.account === list.account && item.id === list.id));
    const { [listKey(list.account, list.id)]: _gone, ...board } = this.view.board;
    const selected = this.view.list?.account === list.account && this.view.list.id === list.id;
    this.set({ lists, board, ...(selected ? { list: lists[0] ? { account: lists[0].account, id: lists[0].id } : null, tasks: [] } : {}) });
    if (selected) void this.refreshTasks();
    calendarUi.refresh();
  }

  /**
   * A new task: at the top of the list, or under `parent` after `previous`.
   * Shown at once. What Google Tasks' API cannot take (a time, a deadline, a
   * repeat with its series' template, a star) is kept in the Planner for it.
   * As in Google Tasks, a repeating task takes no subtask and a subtask does
   * not repeat: refused before anything changes.
   */
  async addListTask(account: string, listId: string, fields: { title: string; notes?: string; due?: DateKey | null; parent?: string | null; previous?: string | null }, kept: Omit<GoogleTaskKeptPatch, 'repeat'> & { rule?: string | null } = {}): Promise<GoogleTaskItem> {
    if (fields.parent && keptFor(this.client.getView().state, { account, id: fields.parent })?.repeat) throw new Error(REPEATING_NO_SUBTASKS);
    if (fields.parent && kept.rule) throw new Error(SUBTASK_NO_REPEAT);
    const key = listKey(account, listId);
    if (fields.parent && this.view.board[key]?.items.find((item) => item.id === fields.parent)?.assigned) throw new Error(SHARED_NO_SUBTASKS);
    const temp: GoogleTaskItem = { account, listId, id: `new-${newId()}`, title: fields.title, notes: fields.notes ?? '', due: fields.due ?? null, completed: false, parent: fields.parent ?? null, position: '', url: 'https://tasks.google.com/', updated: new Date().toISOString() };
    const items = this.view.board[key]?.items ?? [];
    this.patchBoard(key, applyMove([...items, temp], temp.id, { parent: temp.parent, previous: fields.previous ?? null }));
    try {
      const answer = await this.client.call<{ task: GoogleTaskItem | null }>('POST', '/google/tasks', { account, listId, ...fields, ...(fields.notes ? {} : { notes: undefined }) });
      if (!answer.task) throw new Error('Google did not return the task');
      const { rule, busy, visibility, color, attachments, doNotDisturb, decline, ...rest } = kept;
      // Availability, visibility, Do not disturb and declining come with a time (declining with Busy); Free, the
      // default visibility, its list's color and no attachments are kept as nothing.
      const timed = (rest.time ?? null) !== null;
      const advanced = {
        ...(timed && busy ? { busy: true } : {}),
        ...(timed && visibility && visibility !== 'default' ? { visibility } : {}),
        ...(timed && doNotDisturb ? { doNotDisturb: true } : {}),
        ...(timed && busy && decline ? { decline: { ...decline, since: decline.since ?? new Date().toISOString() } } : {}),
        ...(color ? { color } : {}),
        ...(attachments?.length ? { attachments } : {}),
      };
      const template = fields.due ? templateOf({ title: fields.title, notes: fields.notes ?? '' }, { time: rest.time ?? null, duration: rest.duration ?? null, deadline: rest.deadline ?? null, ...advanced }, fields.due) : null;
      const patch: GoogleTaskKeptPatch = { ...rest, ...advanced, ...(rule && fields.due && template ? { repeat: { rule, seriesId: newId(), index: 1, next: null, on: fields.due, template } } : {}) };
      if (Object.values(patch).some((value) => value !== null && value !== undefined && value !== false)) await this.setKept(answer.task, patch);
      if (advanced.decline) this.declineSoon();
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

  /**
   * A task's form saved, all or nothing: Google's fields (title, details,
   * date) and a move to another list are written first, and what the Planner
   * keeps (time, deadline, repeat with the series' template, star) changes
   * only once Google has taken them, so an edit Google refuses leaves the
   * task, what is kept for it and its series as they were, for the form to
   * try again. A change of what the Planner keeps alone needs no Google write.
   * For a repeating task, `scope` says whether the change is for this task or
   * all of the series, as Google Tasks asks (a new rule is for all); either
   * way it is all or nothing. "This task" changes this occurrence alone, in
   * Google and in what is kept for it; the series' template and schedule
   * stay. "All tasks" changes the template (and the series' other open
   * occurrences), then this occurrence to match; a new rule or a new date
   * starts the schedule there. Upcoming occurrences changed on their own
   * (`setOccurrence`) keep their changes, but for those a new rule or start
   * no longer has. A subtask, or a task with subtasks, does not
   * repeat, and a repeating task stays in its list, as in Google Tasks:
   * refused before anything changes.
   */
  async saveListTask(item: GoogleTaskItem, fields: TaskFields, scope: RepeatScope = 'this', extra: { starred?: boolean; listId?: string } = {}): Promise<void> {
    const kept = keptFor(this.client.getView().state, item);
    const repeat = kept?.repeat ?? null;
    const rule = fields.kept.rule && fields.due ? fields.kept.rule : null;
    const moveTo = extra.listId && extra.listId !== item.listId ? extra.listId : null;
    if (rule && !repeat && item.parent) throw new Error(SUBTASK_NO_REPEAT);
    if (rule && !repeat && item.assigned) throw new Error(SHARED_NO_REPEAT);
    if (moveTo && (repeat || rule)) throw new Error(REPEATING_STAYS);
    if (rule && !repeat && (await this.hasSubtasks(item))) throw new Error(SUBTASKS_NO_REPEAT);
    const state = this.client.getView().state;
    const google = { ...(fields.title !== item.title ? { title: fields.title } : {}), ...(fields.notes !== item.notes ? { notes: fields.notes } : {}), ...(fields.due !== item.due ? { due: fields.due } : {}) };
    const patch: GoogleTaskKeptPatch = {};
    if ((kept?.time ?? null) !== fields.kept.time) patch.time = fields.kept.time;
    if ((kept?.duration ?? null) !== fields.kept.duration) patch.duration = fields.kept.duration;
    if ((kept?.deadline ?? null) !== fields.kept.deadline) patch.deadline = fields.kept.deadline;
    // Availability, visibility, Do not disturb and declining come with a time (left out of the fields: as they are),
    // and they and its color are a series' own, as Google Calendar keeps one for a whole series: a change of them is
    // for all its tasks. Attachments are this task's, or (All tasks) the series'.
    const next = advancedOf(fields.kept, kept);
    const { busy, visibility, doNotDisturb, color } = next;
    const decline = next.decline && !next.decline.since ? { ...next.decline, since: new Date().toISOString() } : next.decline;
    const advanced = advancedChanged(fields.kept, kept);
    if (busy !== Boolean(kept?.busy)) patch.busy = busy;
    if (visibility !== (kept?.visibility ?? 'default')) patch.visibility = visibility;
    if (doNotDisturb !== Boolean(kept?.doNotDisturb)) patch.doNotDisturb = doNotDisturb;
    if ((decline?.mode ?? null) !== (kept?.decline?.mode ?? null) || (decline?.message ?? null) !== (kept?.decline?.message ?? null)) patch.decline = decline;
    if (color !== (kept?.color ?? null)) patch.color = color;
    if (attachmentsChanged(fields.kept, kept)) patch.attachments = fields.kept.attachments ?? [];
    const attachments = fields.kept.attachments ?? kept?.attachments ?? [];
    const timing = { ...fields.kept, busy, visibility, doNotDisturb, decline, color, attachments };
    const all = scope === 'all' || Boolean(repeat && rule && (rule !== repeat.rule || advanced));
    // An edit of all tasks of a series, or no repeat any more, is the service's, against the series as it is then
    // (`GoogleSeries.edit`): the series as this window shows it (`before`) and as the form leaves it (`after`).
    let series: { before: SeriesSide; after: SeriesSide } | null = null;
    if (!rule || !fields.due) {
      if (kept && repeat) {
        const template = seriesTemplate(kept, item) ?? templateOf(item, kept, scheduledOn(kept, item) ?? this.client.getView().today);
        series = { before: { rule: repeat.rule, template, due: item.due }, after: { rule: null, template, due: fields.due } };
      }
    } else if (!kept || !repeat) {
      patch.repeat = { rule, seriesId: newId(), index: 1, next: null, on: fields.due, template: templateOf(fields, timing, fields.due) };
    } else {
      const on = scheduledOn(kept, item) ?? fields.due;
      const template = seriesTemplate(kept, item) ?? templateOf(item, kept, on);
      if (all) {
        const moved = rule !== repeat.rule || (fields.due !== item.due && fields.due !== on);
        series = { before: { rule: repeat.rule, template, due: item.due }, after: { rule, template: templateOf(fields, timing, fields.due, moved ? fields.due : template.start), due: fields.due } };
      } else if (!repeat.on || !repeat.template) {
        // First sight of a series kept before templates: kept as this occurrence was, before this one-off change.
        patch.repeat = { ...repeat, on, template };
      }
    }
    // A star is the Planner's alone: no Google write.
    if (extra.starred !== undefined && extra.starred !== Boolean(kept?.starredAt)) patch.starred = extra.starred;
    // Google first. A refusal throws here, before anything kept in the Planner has changed.
    const answers = Object.keys(google).length ? await this.writeListTask([item], () => google, google.due !== undefined || google.title !== undefined) : [];
    let now: GoogleTaskItem | null = answers[0] ?? null;
    if (moveTo) {
      try {
        now = await this.moveListTask(now ?? item, { parent: null, previous: null }, moveTo);
      } catch (error) {
        // Google took the fields but not the move: they go back as they were, so nothing of the edit stays.
        const back = { ...(google.title !== undefined ? { title: item.title } : {}), ...(google.notes !== undefined ? { notes: item.notes } : {}), ...(google.due !== undefined ? { due: item.due } : {}) };
        if (answers[0] && Object.keys(back).length) await this.writeListTask([answers[0]], () => back, true).catch(() => {});
        throw error;
      }
    }
    // Google has it: now what the Planner keeps, for the task where it is now.
    const at = now ?? item;
    if (series && repeat) {
      const { repeat: _none, ...own } = patch;
      try {
        await this.client.adopt(await this.client.call<Snapshot>('POST', '/google/tasks/series/edit', { account: at.account, listId: at.listId, taskId: at.id, seriesId: repeat.seriesId, own, ...series }));
      } catch (error) {
        // Google took the fields but the series did not change: they go back as they were, so nothing of the edit stays.
        const back = { ...(google.title !== undefined ? { title: item.title } : {}), ...(google.notes !== undefined ? { notes: item.notes } : {}), ...(google.due !== undefined ? { due: item.due } : {}) };
        if (answers[0] && Object.keys(back).length) await this.writeListTask([answers[0]], () => back, true).catch(() => {});
        throw error;
      }
    } else if (Object.keys(patch).length) await this.client.dispatch([{ type: 'gtask.kept', account: at.account, listId: at.listId, taskId: at.id, patch }]);
    // Meetings it overlaps are declined now, not at the next pass.
    if (decline && (patch.decline !== undefined || patch.time !== undefined || patch.duration !== undefined || patch.busy !== undefined || google.due !== undefined)) this.declineSoon();
    // Linked Planner tasks take Google's change at once.
    if (now) await this.syncItems([now]);
    else calendarUi.refresh();
  }

  /**
   * Complete or reopen a task, wherever it is done (the Tasks view, the
   * calendar, Starred). As in Google Tasks, completing a task completes its
   * subtasks, and reopening a subtask reopens the task it is under, read from
   * Google when its list is not loaded (`relatives`). Those are written
   * first, so Google never has an open subtask under a completed task, even
   * when a write fails half way. A repeating task's next occurrence appears.
   * A completion can be undone, as Google Tasks and Google Calendar offer it
   * ("Task completed · Undo", and Ctrl/⌘+Z): `undoLast`.
   */
  async completeListTask(item: GoogleTaskItem, completed: boolean): Promise<void> {
    const related = await this.relatives(item, completed);
    // What Undo takes back: the tasks this completes, and what was kept for it before (a series that ends with it).
    const opened = [...related, item].filter((one) => !one.completed);
    const before = keptFor(this.client.getView().state, item);
    // A task opened again by hand is what an earlier Undo would have done: that Undo goes.
    this.lastUndo = null;
    const answers = await this.writeListTask([...related, item], () => ({ completed }), true);
    if (completed) {
      const made = await this.makeNextOccurrences(answers);
      this.lastUndo = this.completionUndo(item, opened, before, made.get(item.id) ?? null);
    }
    void this.sync();
  }

  /**
   * Undo after completing: the tasks it completed open again, the task before
   * its subtasks. A task of a series is the service's (`GoogleSeries.uncomplete`):
   * the next one its completion made goes again while it is still as it was
   * made; one changed or completed since stays, and Undo says so.
   */
  private completionUndo(item: GoogleTaskItem, opened: readonly GoogleTaskItem[], before: GoogleTaskKept | null, made: MadeTask | null): UndoEntry {
    return async () => {
      let note: string | null = null;
      if (before?.repeat) {
        const answer = await this.client.call<Snapshot & { nextKept: boolean }>('POST', '/google/tasks/uncomplete', { account: item.account, listId: item.listId, id: item.id, before, made });
        await this.client.adopt(answer);
        if (answer.nextKept) note = `"${item.title}" is open again; its next task${made?.due ? `, ${longDay(made.due)},` : ''} stays, as it was changed or completed since`;
      } else {
        // The task first: Google never has an open subtask under a completed task.
        await this.writeListTask([...opened].sort((a, b) => Number(Boolean(a.parent)) - Number(Boolean(b.parent))), () => ({ completed: false }), true);
      }
      this.afterTaskWrite(item.account, item.listId, true);
      if (this.view.board[listKey(item.account, item.listId)]) void this.loadBoard(item.account, item.listId);
      void this.sync();
      return { done: 'Completion undone', note };
    };
  }

  /**
   * Delete a task and its subtasks. A repeating task asks first, as Google
   * Calendar does: "This task" (the series goes on with the next one), "This
   * and following tasks" (the series ends before it) or "All tasks" (the
   * series goes, its completed tasks too); the last two are `deleteSeries`.
   * "This task", all or nothing: on an occurrence whose next one is not made
   * yet, the series makes it first, as when it is done (`makeSuccessor`), and
   * only then is this one deleted; when the next one can't be made, nothing is
   * deleted and the series stays as it was, to delete again. The series'
   * template, schedule and exceptions go on with the next one; deleting this
   * one never drops them while the series goes on.
   */
  async deleteListTask(item: GoogleTaskItem, scope: DeleteScope = 'this'): Promise<void> {
    const key = listKey(item.account, item.listId);
    const before = this.view.board[key]?.items ?? [];
    const kept = keptFor(this.client.getView().state, item);
    if (kept?.repeat && scope !== 'this') {
      const from = scope === 'following' ? scheduledOn(kept, item) : null;
      return this.deleteSeries({ account: item.account, seriesId: kept.repeat.seriesId, from, task: item.id });
    }
    // What Undo gives back: the task and its subtasks as Google had them, and what the Planner kept for them.
    const subtree = [item, ...before.filter((other) => other.parent === item.id)];
    const keptBefore = subtree.flatMap((one) => keptFor(this.client.getView().state, one) ?? []);
    this.lastUndo = null;
    const next = kept?.repeat && !kept.repeat.next ? nextOccurrence(item, kept) : null;
    this.patchBoard(key, before.filter((other) => other.id !== item.id && other.parent !== item.id));
    let made: GoogleTaskItem | null = null;
    let madeNow: MadeTask | null = null;
    try {
      if (next?.date && next.template) {
        try {
          ({ task: made, made: madeNow } = await this.makeSuccessor(item));
        } catch (error) {
          throw new Error(`the next "${item.title}" couldn't be made, so this one stays (${messageOf(error)})`);
        }
      }
      // A task of a series as kept now, linked to its next one: what the series' Undo gives back.
      const inSeries = keptFor(this.client.getView().state, item);
      try {
        await this.client.call('DELETE', `/google/tasks?account=${encodeURIComponent(item.account)}&list=${encodeURIComponent(item.listId)}&id=${encodeURIComponent(item.id)}`);
      } catch (error) {
        // The next one stays, linked: a DELETE that fails may still have reached Google (the service gives up after
        // 12 s), so deleting the next one too could leave the series with no task at all. Kept, the series goes on
        // from it whatever Google did, and deleting this one again makes no second one (its `repeat.next` is set).
        if (made) throw new Error(`${messageOf(error)}; its next task, ${longDay(made.due ?? next!.date!)}, is made, so deleting this one again finishes`);
        throw error;
      }
      if (keptFor(this.client.getView().state, item)) await this.client.dispatch([{ type: 'gtask.dropped', account: item.account, taskId: item.id }], { origin: 'google' });
      this.afterTaskWrite(item.account, item.listId, true);
      // Read once this one is gone (a read before it could bring it back): Google may renumber the places around them.
      if (made && this.view.board[key]) void this.loadBoard(item.account, item.listId);
      // Undo, as Google Tasks offers it: Google undeletes the task (and its subtasks) and what the Planner kept for it
      // comes back. A task of a series is the service's, one change of the series at a time (`GoogleSeries.undo`): the
      // next one this deletion made goes again while it is still as it was made.
      this.lastUndo = inSeries?.repeat
        ? this.seriesUndo({ account: item.account, seriesId: inSeries.repeat.seriesId, kind: 'one', task: inSeries, made: madeNow }, [item.listId, ...(made ? [made.listId] : [])])
        : async () => {
            await this.undelete(subtree);
            await this.restoreKept(keptBefore);
            this.afterTaskWrite(item.account, item.listId, true);
            if (this.view.board[key]) void this.loadBoard(item.account, item.listId);
            return { done: 'Deletion undone', note: null };
          };
    } catch (error) {
      this.patchBoard(key, before);
      if (made) this.remember(made, true);
      throw error;
    }
  }

  /**
   * "This and following tasks" of a series, from the date it puts an
   * occurrence on (`from`; `task`, when asked from a task Google has, goes
   * too), or "All tasks" (`from` null), as Google Calendar deletes them. The
   * service does it, one change of a series at a time for every window
   * (`GoogleSeries.remove`): the open tasks go in Google first, then the
   * series as kept here, its tasks before `from` ending the day before, so
   * those and their upcoming occurrences stay and nothing is made past it;
   * the completed tasks from `from` on (all of them for All tasks) go too.
   * Shown at once in the Tasks view, and back when Google refuses.
   */
  async deleteSeries(target: { account: string; seriesId: string; from: DateKey | null; task?: string }): Promise<void> {
    const { remove } = seriesCut(this.client.getView().state.googleTasks, target.account, target.seriesId, target.from, target.task ?? null);
    // What Undo gives back, as this window has it (the service answers with the series as it was just before).
    let keptBefore = Object.values(this.client.getView().state.googleTasks).filter((entry) => entry.account === target.account && entry.repeat?.seriesId === target.seriesId);
    this.lastUndo = null;
    const boards = Object.entries(this.view.board).filter(([key]) => key.startsWith(`${target.account}\n`));
    const without = (ids: Iterable<string>) => {
      const gone = new Set(ids);
      for (const [key] of boards) {
        const list = this.view.board[key];
        if (list) this.patchBoard(key, list.items.filter((other) => !gone.has(other.id) && !(other.parent && gone.has(other.parent))));
      }
    };
    without([...remove.map((kept) => kept.taskId), ...(target.task ? [target.task] : [])]);
    let deleted: string[];
    try {
      const query = new URLSearchParams({ account: target.account, series: target.seriesId, ...(target.from ? { from: target.from } : {}), ...(target.task ? { task: target.task } : {}) });
      const answer = await this.client.call<Snapshot & { deleted: string[]; before?: GoogleTaskKept[] }>('DELETE', `/google/tasks/series?${query}`);
      await this.client.adopt(answer);
      deleted = answer.deleted ?? [];
      keptBefore = answer.before ?? keptBefore;
    } catch (error) {
      for (const [key, list] of boards) this.patchBoard(key, list.items);
      throw error;
    }
    // What the service deleted, which another window may have added to since this one read the series.
    without(deleted);
    for (const listId of new Set(remove.map((kept) => kept.listId))) this.afterTaskWrite(target.account, listId, false);
    calendarUi.refresh();
    const listOf = (id: string) => keptBefore.find((entry) => entry.taskId === id)?.listId ?? remove.find((entry) => entry.taskId === id)?.listId ?? null;
    const gone = deleted.flatMap((id) => (listOf(id) ? [{ listId: listOf(id)!, id }] : []));
    this.lastUndo = this.seriesUndo({ account: target.account, seriesId: target.seriesId, kind: 'cut', from: target.from, deleted: gone, before: keptBefore }, keptBefore.map((entry) => entry.listId));
  }

  /**
   * Undo after deleting tasks of a series, which the service takes back, one
   * change of the series at a time and against the series as it is then
   * (`GoogleSeries.undo`); the lists it touches read again.
   */
  private seriesUndo(body: { account: string; seriesId: string } & Record<string, unknown>, lists: readonly string[]): UndoEntry {
    return async () => {
      const answer = await this.client.call<Snapshot & { nextKept: boolean; failed: number }>('POST', '/google/tasks/series/undo', body);
      await this.client.adopt(answer);
      for (const listId of new Set(lists)) {
        this.afterTaskWrite(body.account, listId, true);
        if (this.view.board[listKey(body.account, listId)]) void this.loadBoard(body.account, listId);
      }
      calendarUi.refresh();
      const note = answer.failed ? `Google Tasks did not give back ${answer.failed} of the tasks` : answer.nextKept ? 'Its next task stays, as it was changed or completed since' : null;
      return { done: 'Deletion undone', note };
    };
  }

  /** The last deletion or completion of tasks, until it is undone or another one comes. */
  private lastUndo: UndoEntry | null = null;

  /** Whether there is a deletion or a completion to undo. */
  canUndo(): boolean {
    return Boolean(this.lastUndo);
  }

  /**
   * Google Tasks' "Undo" after Delete or after completing (and Ctrl/⌘+Z):
   * the tasks come back as they were (Google undeletes them, or they are open
   * again) with what the Planner kept for them. Once; null when there is
   * nothing to undo. What to say once done, and (`note`) what stayed as it is.
   */
  async undoLast(): Promise<{ done: string; note: string | null } | null> {
    const last = this.lastUndo;
    this.lastUndo = null;
    return last ? last() : null;
  }

  /** Tasks Google deleted, undeleted (the task first, then its subtasks). */
  private async undelete(items: readonly { account: string; listId: string; id: string }[]): Promise<void> {
    for (const one of items) await this.client.call('PATCH', '/google/tasks', { account: one.account, listId: one.listId, id: one.id, deleted: false });
  }

  /** What the Planner kept for tasks, as it was (Undo). */
  private async restoreKept(entries: readonly GoogleTaskKept[]): Promise<void> {
    if (!entries.length) return;
    await this.client.dispatch(
      entries.map((entry) => ({
        type: 'gtask.kept' as const,
        account: entry.account,
        listId: entry.listId,
        taskId: entry.taskId,
        patch: {
          time: entry.time,
          duration: entry.duration,
          deadline: entry.deadline,
          repeat: entry.repeat,
          starred: Boolean(entry.starredAt),
          busy: Boolean(entry.busy),
          visibility: entry.visibility ?? 'default',
          color: entry.color ?? null,
          attachments: entry.attachments ?? [],
          doNotDisturb: Boolean(entry.doNotDisturb),
          decline: entry.decline ?? null,
        },
      })),
    );
  }

  /**
   * Gmail's "Add to Tasks": a task in the account's default list titled as the message, as Gmail adds one. Google's
   * link back to the email is Gmail's own (its API lets no other app set one), so the message's address goes in
   * the task's details.
   */
  async addMailToTasks(item: MailItem): Promise<GoogleTaskItem> {
    const lists = this.view.lists.filter((list) => list.account === item.account);
    const list = lists.find((one) => one.isDefault) ?? lists[0];
    if (!list) throw new Error(`${item.account} has no task list (connect it with Tasks in Settings → Google)`);
    return this.addListTask(item.account, list.id, { title: item.subject.slice(0, 1024), notes: `From Gmail: ${item.url}` });
  }

  /**
   * One upcoming occurrence of a series changed on its own, as Google Calendar
   * changes one ("This task" on the calendar): deleted (`{ skip: true }`: the
   * series passes over its date and goes on), or (Undo) put back as it was:
   * `change` is what it had, null as its series has it. The service keeps it
   * with the series as the series is then (`GoogleSeries.occurrence`), by the
   * date the series puts it on, applied when the series makes it; one the
   * series has made meanwhile is deleted as "This task" deletes one. The
   * series and its other occurrences stay as they are.
   */
  setOccurrence(upcoming: Pick<UpcomingTask, 'account' | 'listId' | 'seriesId' | 'on'>, change: GoogleTaskException | null): Promise<void> {
    return this.changeOccurrence(upcoming, change?.skip ? { skip: true } : { restore: change });
  }

  /**
   * One upcoming occurrence edited on its own ("This task"), from what the
   * editor showed to its form: the service puts what the edit changed over
   * the occurrence as it is then (a change made meanwhile in another window,
   * or of the series, stays), and a task the series has made for it
   * meanwhile is changed instead, in Google too.
   */
  editOccurrence(upcoming: UpcomingTask, fields: TaskFields): Promise<void> {
    if (!fields.due) return Promise.reject(new Error(OCCURRENCE_KEEPS_DATE));
    if (fields.title.length > 1024 || fields.notes.length > GOOGLE_NOTES_MAX) return Promise.reject(new Error(`Google Tasks takes a title of at most 1024 characters and details of at most ${GOOGLE_NOTES_MAX}`));
    // Its attachments too: This task attaches files to this occurrence alone, as Google Calendar does.
    const after = { title: fields.title, notes: fields.notes, due: fields.due, time: fields.kept.time, duration: fields.kept.duration, deadline: fields.kept.deadline, ...(fields.kept.attachments ? { attachments: fields.kept.attachments } : {}) };
    return this.changeOccurrence(upcoming, { before: upcomingValues(upcoming), after });
  }

  private async changeOccurrence(upcoming: Pick<UpcomingTask, 'account' | 'listId' | 'seriesId' | 'on'>, edit: Record<string, unknown>): Promise<void> {
    await this.client.adopt(await this.client.call<Snapshot>('POST', '/google/tasks/occurrence', { account: upcoming.account, seriesId: upcoming.seriesId, on: upcoming.on, ...edit }));
    // A task the series had made for it meanwhile changed in Google: its list as Google has it now.
    if (this.view.board[listKey(upcoming.account, upcoming.listId)]) void this.loadBoard(upcoming.account, upcoming.listId);
    calendarUi.refresh();
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

  /**
   * Put a task under `parent` after `previous`, in its list or another of the
   * same account. Shown at once. As in Google Tasks, a repeating task stays in
   * its list, takes no subtasks and is no subtask: such a move is refused
   * before anything moves. The task as Google has it after the move.
   */
  async moveListTask(item: GoogleTaskItem, target: MoveTarget, destinationListId: string = item.listId): Promise<GoogleTaskItem> {
    const state = this.client.getView().state;
    if (destinationListId !== item.listId && keptFor(state, item)?.repeat) throw new Error(REPEATING_STAYS);
    if (target.parent && keptFor(state, item)?.repeat) throw new Error(REPEATING_NOT_SUBTASK);
    if (target.parent && keptFor(state, { account: item.account, id: target.parent })?.repeat) throw new Error(REPEATING_NO_SUBTASKS);
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
      const answer = await this.client.call<{ task: GoogleTaskItem | null }>('POST', '/google/tasks/move', { account: item.account, listId: item.listId, id: item.id, parent: target.parent, previous: target.previous, ...(to !== from ? { destinationListId } : {}) });
      const movedTask = answer.task ?? { ...item, listId: destinationListId, parent: target.parent };
      if (to !== from) {
        // The Planner tasks planning it (and its subtasks), and what is kept for them, follow it to the other list.
        await this.followMove(item, movedTask);
        for (const kid of before.from.filter((other) => other.parent === item.id)) await this.followMove(kid, { ...kid, listId: destinationListId });
      }
      this.afterTaskWrite(item.account, item.listId, to !== from);
      // A move can renumber the places of the tasks around it: read the lists as Google has them now.
      if (this.view.board[from]) void this.loadBoard(item.account, item.listId);
      if (to !== from && this.view.board[to]) void this.loadBoard(item.account, destinationListId);
      return movedTask;
    } catch (error) {
      this.patchBoard(from, before.from);
      if (to !== from) this.patchBoard(to, before.to);
      throw error;
    }
  }

  /** A Google task shown on the calendar, due another day (from a drag in the calendar); a Planner task planning it takes the date. */
  async setTaskDue(item: GoogleTaskItem, due: DateKey): Promise<void> {
    await this.syncItems(await this.writeListTask([item], () => ({ due }), true));
  }

  /** Several tasks patched alike: shown at once, put back when Google refuses; Google's answers. */
  private async writeListTask(items: readonly GoogleTaskItem[], patchOf: (item: GoogleTaskItem) => { title?: string; notes?: string; due?: DateKey | null; completed?: boolean }, calendar: boolean): Promise<GoogleTaskItem[]> {
    const first = items[0];
    if (!first) return [];
    const answers: GoogleTaskItem[] = [];
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
        if (answer.task) {
          this.remember(answer.task);
          answers.push(answer.task);
        }
      }
      this.afterTaskWrite(first.account, first.listId, calendar);
      return answers;
    } catch (error) {
      if (before) this.patchBoard(key, before);
      // Refused half way: the list as Google has it now.
      if (before && answers.length) void this.loadBoard(first.account, first.listId);
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
      // Its title, details or date changed here: Google gets them too (a link just made is in step already).
      if (command.type === 'task.updated' && command.patch.source === undefined) {
        const task = after.tasks[command.taskId];
        const previous = before.tasks[command.taskId];
        if (task?.source?.kind !== 'gtask' || !previous || task.completedAt || task.source.status?.name === GONE_STATUS.name) continue;
        const patch: GoogleTaskWrite['patch'] = {
          ...(command.patch.title !== undefined && task.title !== previous.title ? { title: task.title } : {}),
          ...(command.patch.notes !== undefined && task.notes !== previous.notes ? { notes: task.notes.slice(0, GOOGLE_NOTES_MAX) } : {}),
          ...(command.patch.dueDate !== undefined && task.dueDate !== previous.dueDate ? { due: task.dueDate } : {}),
        };
        if (Object.keys(patch).length) void this.writeTask(task, patch, true);
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
