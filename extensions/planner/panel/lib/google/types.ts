// What the Google store (store.ts) and its parts share: the view the panel shows, a task form's fields, what a
// change throws (a field changed meanwhile, a state it could not read, Google Tasks' own refusals), the scopes Google
// Calendar asks a repeating task's change for, and what Undo does.
import type { DeclineInput } from '../../../src/domain/core/events.ts';
import type { GoogleCalendarInfo, GoogleTaskItem, GoogleTaskList, MailItem } from '../../../src/domain/google/google.ts';
import type { FormField, FormValues } from '../../../src/domain/google/taskForm.ts';
import type { DateKey, GoogleTaskKept, TaskAttachment, TaskVisibility } from '../../../src/domain/core/types.ts';

export type GoogleFeature = 'calendar' | 'tasks' | 'mail' | 'drive' | 'mailActions' | 'contacts';

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

interface SignInView {
  id: string;
  authUrl: string;
  redirectUri: string;
  result: SignInResult;
}

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
  /**
   * Asking whether to complete the Google task too: the task's own (`own`), and Google tasks merged into it
   * (`subtaskIds`), checked off on their own (`by: 'tick'`) or with their task. `title` says which.
   */
  prompt: { taskId: string; title: string; own: boolean; subtaskIds: string[]; by: 'tick' | 'task' } | null;
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

/** Where a Google task is: its account, its list and its id there. */
export type GoogleTaskRef = Pick<GoogleTaskItem, 'account' | 'listId' | 'id'>;

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
  /**
   * What the form showed when it opened, as it saves its values: the save is
   * the change from this, so a field it left alone keeps what was given it
   * meanwhile (in another window, or by the service). Without it, the task as
   * this window has it is taken for what the form showed.
   */
  base?: FormValues;
}

/** The form's values its fields give, `base`'s where they leave one out (as it is), with the form's rules (`formValuesOf`). */
export const formValuesOfFields = (fields: TaskFields, base: FormValues, extra: { starred?: boolean; listId?: string } = {}): FormValues => {
  const timed = fields.kept.time !== null;
  const busy = timed && (fields.kept.busy ?? base.busy);
  return {
    title: fields.title,
    notes: fields.notes,
    due: fields.due,
    time: fields.kept.time,
    duration: fields.kept.time === null ? null : fields.kept.duration,
    deadline: fields.kept.deadline,
    rule: fields.due ? fields.kept.rule : null,
    busy,
    visibility: timed ? fields.kept.visibility ?? base.visibility : 'default',
    color: fields.kept.color !== undefined ? fields.kept.color : base.color,
    attachments: fields.kept.attachments ?? base.attachments,
    doNotDisturb: timed && (fields.kept.doNotDisturb ?? base.doNotDisturb),
    decline: busy ? (fields.kept.decline !== undefined ? fields.kept.decline : base.decline) : null,
    starred: extra.starred ?? base.starred,
    listId: extra.listId || base.listId,
  };
};

/**
 * A form's save the user settles first, as an editor asks: fields it changed
 * that changed meanwhile too (in another window, by the service, or in
 * Google), with what each is now (`now`), the form's (`mine`) and what it
 * showed (`base`). Nothing was written.
 */
export class TaskConflict extends Error {
  constructor(
    readonly fields: FormField[],
    readonly now: FormValues,
    readonly mine: FormValues,
    readonly base: FormValues,
  ) {
    super(`changed meanwhile (${fields.join(', ')}): open it again to see how it is now`);
    this.name = 'TaskConflict';
  }
}

/**
 * A save, deletion or completion that could not read what it needs as it is
 * now (the plan from the service, a task or its list from Google): nothing was
 * written, and it can be tried again. Never taken for "nothing changed".
 */
export class FreshnessError extends Error {
  constructor(
    readonly what: string,
    readonly reason: string | null = null,
  ) {
    super(`couldn't read ${what} as it is now${reason ? ` (${reason})` : ''}`);
    this.name = 'FreshnessError';
  }
}

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

/** What Google Tasks' Undo does, once: what to say then, and (`note`) anything that stayed as it is. */
export type UndoEntry = () => Promise<{ done: string; note: string | null }>;
