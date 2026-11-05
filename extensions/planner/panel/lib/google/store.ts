// Panel-side Google: the accounts the local service signed in, the Google calendars to show beside the plan, Google
// Tasks and Gmail messages to plan as tasks, the Tasks view as the Google Tasks app, and writing completion and due
// dates back to Google Tasks the way the Linear integration writes back to Linear (ask, do, or not).
//
// One store with one view: `GoogleStore` holds the state, and its methods live in its parts, a module each, every
// method the store's own (`this` is the store; the interface below gives the store their types):
//   accounts.ts   sign-in and the accounts signed in
//   calendars.ts  Google calendars shown beside the plan
//   sources.ts    the sources panel's Google Tasks list and Gmail search, planned
//   linked.ts     Planner tasks kept in step with their Google tasks
//   board.ts      the Tasks view's lists and tasks as Google has them, and the reads a change makes first
//   kept.ts       what the Planner keeps for a Google task (a star, a time, Drive files, declined meetings)
//   edits.ts      a task's form saved, a task completed or deleted, and Undo
//   series.ts     repeating tasks
// What they share (the view, a form's fields, the errors and Google Tasks' refusals) is in types.ts.
import type { HostClient } from '@openchamber/sdk';
import { messageOf } from '../../../src/domain/core/values.ts';
import type { GoogleTaskItem } from '../../../src/domain/google/google.ts';
import { calendarUi } from '../calendar/calendarUi.ts';
import type { PlannerClient } from '../core/client.ts';
import { accountMethods } from './accounts.ts';
import { boardMethods } from './board.ts';
import { calendarMethods } from './calendars.ts';
import { editMethods } from './edits.ts';
import { keptMethods } from './kept.ts';
import { linkedMethods } from './linked.ts';
import { seriesMethods } from './series.ts';
import { sourceMethods } from './sources.ts';
import type { GoogleView, UndoEntry } from './types.ts';

// What the panel's other folders import from here.
export { DELETE_CHOICES, listKey, REPEATING_STAYS, TaskConflict } from './types.ts';
export type { GoogleFeature, GoogleView } from './types.ts';

const REFRESH_MS = 5 * 60_000;

export class GoogleStore {
  /** What the panel shows (`getView`); the parts change it with `set`. */
  view: GoogleView = {
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
    mailQuery: 'in:inbox',
    mail: [],
    mailLoading: false,
    mailError: null,
    mailNext: null,
    prompt: null,
    board: {},
  };
  readonly listeners = new Set<() => void>();
  started = false;
  /** The next look at the sign-in under way (accounts.ts). */
  signInTimer: ReturnType<typeof setTimeout> | null = null;
  /** First sights of accounts' calendars, one after another (two loads at once must not show a calendar twice; calendars.ts). */
  introductions: Promise<void> = Promise.resolve();
  /** The newest Gmail search, Tasks list read and Tasks-view read of each list: an older one's answer or error is dropped (sources.ts, board.ts). */
  mailSeq = 0;
  tasksSeq = 0;
  readonly boardSeq = new Map<string, number>();
  /** Each task's merged Google tasks being written, in turn (`writeMerged`, linked.ts). */
  readonly mergedWrites = new Map<string, Promise<void>>();
  /** Repeating tasks whose next occurrence is being made, so it is made once (series.ts). */
  readonly making = new Set<string>();
  /** Open tasks of series a read no longer found, being looked for (`missingHeads`, series.ts). */
  readonly looking = new Set<string>();
  /** The last deletion or completion of tasks, until it is undone or another one comes (edits.ts, series.ts). */
  lastUndo: UndoEntry | null = null;

  constructor(readonly host: HostClient, readonly client: PlannerClient, readonly surface: string) {}

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

  set(patch: Partial<GoogleView>): void {
    this.view = { ...this.view, ...patch };
    for (const listener of this.listeners) listener();
  }
}

type AccountMethods = typeof accountMethods;
type CalendarMethods = typeof calendarMethods;
type SourceMethods = typeof sourceMethods;
type LinkedMethods = typeof linkedMethods;
type BoardMethods = typeof boardMethods;
type KeptMethods = typeof keptMethods;
type EditMethods = typeof editMethods;
type SeriesMethods = typeof seriesMethods;
export interface GoogleStore extends AccountMethods, CalendarMethods, SourceMethods, LinkedMethods, BoardMethods, KeptMethods, EditMethods, SeriesMethods {}
Object.assign(GoogleStore.prototype, accountMethods, calendarMethods, sourceMethods, linkedMethods, boardMethods, keptMethods, editMethods, seriesMethods);

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
