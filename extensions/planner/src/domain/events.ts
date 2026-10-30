// Planner events: the append-only log is the source of truth, state is a fold over it.
import { BACKLOG_BUCKETS, GMAIL_ACTIONS, LINEAR_GROUPS, LINEAR_ORDERS, MEETING_EXCLUSIONS, RITUALS, SOURCE_NAMES, type CalendarSubscription, type Channel, type DateKey, type GoogleEventLink, type GoogleTaskKept, type Folder, type Objective, type Placement, type RecurrenceRule, type Ritual, type RitualRecord, type RunPullRequest, type Series, type Settings, type Subtask, type Task, type TaskAttachment, type TaskDecline, type TaskRun, type TaskSourceRef, type TaskVisibility, type WorkBlock } from './types.ts';
import { isDateKey, isValidTimeZone } from './dates.ts';
import { parseRRule } from './rrule.ts';
import { linearDisplayProblem } from './linearDisplay.ts';
import { isAgentPreset, isRunAssignee } from './assignees.ts';
import { EVENT_NO_SUBTASKS, isEventTask } from './merge.ts';

export interface NewTask {
  id: string;
  title: string;
  notes?: string;
  plannedMinutes?: number | null;
  priority?: Task['priority'];
  dueDate?: DateKey | null;
  placement: Placement;
  position: number;
  channelId?: string | null;
  folderId?: string | null;
  objectiveId?: string | null;
  source?: TaskSourceRef | null;
  subtasks?: Subtask[];
  recurrence?: { seriesId: string; date: DateKey } | null;
  sessionRef?: Task['sessionRef'];
}

export type NewRun = Pick<TaskRun, 'id' | 'taskId' | 'sessionId' | 'projectId' | 'directory' | 'worktree' | 'title' | 'wantsPr' | 'assignee'>;

/** A pull request as gh shows it; the log adds when the Planner saw it. */
export type SeenPullRequest = Omit<RunPullRequest, 'seenAt'>;

export const PATCH_FIELDS = ['title', 'notes', 'plannedMinutes', 'priority', 'dueDate', 'channelId', 'folderId', 'objectiveId', 'subtasks', 'source'] as const;
export type TaskPatch = Partial<Pick<Task, (typeof PATCH_FIELDS)[number]>>;

export type NewChannel = Pick<Channel, 'id' | 'name' | 'color' | 'context'>;
export type ChannelPatch = Partial<Pick<Channel, 'name' | 'color' | 'context'>>;

export interface RolledTask {
  taskId: string;
  from: DateKey;
  position: number;
}

export type EventBody =
  | { type: 'task.created'; task: NewTask }
  | { type: 'task.updated'; taskId: string; patch: TaskPatch }
  | { type: 'task.moved'; taskId: string; placement: Placement; position: number }
  | { type: 'task.completed'; taskId: string; on: DateKey }
  | { type: 'task.reopened'; taskId: string }
  | { type: 'task.deleted'; taskId: string }
  | { type: 'task.restored'; taskId: string }
  | { type: 'task.archived'; taskId: string }
  | { type: 'task.sourceSynced'; taskId: string; source: TaskSourceRef; title?: string; notes?: string; dueDate?: DateKey | null }
  | { type: 'tasks.rolledOver'; date: DateKey; moved: RolledTask[]; archived: string[]; superseded?: string[] }
  | { type: 'tasks.recurred'; instances: NewTask[] }
  | { type: 'series.created'; series: Pick<Series, 'id' | 'rule' | 'startDate' | 'template'>; taskId: string }
  | { type: 'series.updated'; seriesId: string; patch: { rule?: RecurrenceRule; template?: Partial<Series['template']> } }
  | { type: 'series.stopped'; seriesId: string; from: DateKey }
  | { type: 'timer.started'; taskId: string }
  | { type: 'timer.stopped' }
  | { type: 'time.logged'; entry: { id: string; taskId: string; start: string; end: string } }
  | { type: 'time.deleted'; entryId: string }
  | { type: 'block.created'; block: WorkBlock }
  | { type: 'block.updated'; blockId: string; start: string; end: string }
  | { type: 'block.deleted'; blockId: string }
  | { type: 'block.linked'; blockId: string; google: GoogleEventLink | null }
  | { type: 'calendar.added'; calendar: Omit<CalendarSubscription, 'visible'> }
  | { type: 'calendar.updated'; calendarId: string; patch: Partial<Pick<CalendarSubscription, 'name' | 'color' | 'visible'>> }
  | { type: 'calendar.removed'; calendarId: string }
  | { type: 'objective.created'; objective: Pick<Objective, 'id' | 'weekStart' | 'title' | 'carriedFrom'> }
  | { type: 'objective.updated'; objectiveId: string; patch: { title?: string; completed?: boolean } }
  | { type: 'objective.deleted'; objectiveId: string }
  /** A deleted objective back (Undo); the tasks aligned with it are aligned again by their own updates. */
  | { type: 'objective.restored'; objectiveId: string }
  | { type: 'ritual.saved'; ritual: Ritual; date: DateKey; fields: RitualRecord }
  | { type: 'folder.created'; folder: Pick<Folder, 'id' | 'name'> }
  | { type: 'folder.renamed'; folderId: string; name: string }
  | { type: 'folder.deleted'; folderId: string }
  | { type: 'run.started'; run: NewRun }
  | { type: 'run.outcome'; runId: string; outcome: 'completed' | 'failed' }
  | { type: 'run.reviewed'; runId: string; verdict: 'accepted' | 'changes'; note?: string }
  | { type: 'run.removed'; runId: string }
  | { type: 'run.pullRequest'; runId: string; taskId: string; pullRequest: SeenPullRequest }
  | { type: 'channel.created'; channel: NewChannel }
  | { type: 'channel.updated'; channelId: string; patch: ChannelPatch }
  | { type: 'channel.deleted'; channelId: string }
  | { type: 'settings.updated'; patch: Partial<Settings> }
  | { type: 'gtask.kept'; account: string; listId: string; taskId: string; patch: GoogleTaskKeptPatch }
  | { type: 'gtask.moved'; account: string; taskId: string; listId: string; newTaskId?: string }
  | { type: 'gtask.dropped'; account: string; taskId: string };

/**
 * What a user sets on a Google task that the Planner keeps (Google Tasks' API cannot): `starred` stars or unstars it;
 * `busy` false makes it Free again, `visibility` 'default' gives it the calendar's default again, `color` null its
 * list's color, `attachments` [] none, `doNotDisturb` false and `decline` null turn those off. A decline without
 * `since` is on from when it is kept, or since it was turned on.
 */
export type GoogleTaskKeptPatch = Partial<
  Pick<GoogleTaskKept, 'time' | 'duration' | 'deadline' | 'repeat'> & { starred: boolean; busy: boolean; visibility: TaskVisibility; color: string | null; attachments: TaskAttachment[]; doNotDisturb: boolean; decline: DeclineInput | null }
>;

/** "Automatically decline meetings" as it is set: since when it is on is the Planner's to keep. */
export type DeclineInput = Omit<TaskDecline, 'since'> & { since?: string };

export type EventType = EventBody['type'];

/** What a client sends: an event body plus its own command id for retry-safe delivery. */
export type Command = EventBody & { cmd: string };

/** A stored event. `cmd` links it to the command that produced it. */
export type PlannerEvent = EventBody & { v: 1; id: string; at: string; cmd?: string };

/** Event types only the service may write. */
export const SERVICE_ONLY_TYPES: ReadonlySet<EventType> = new Set(['tasks.rolledOver', 'tasks.recurred']);

const TITLE_MAX = 500;
// serviceRequest bodies are capped at 64 000 characters; leave room for JSON escaping.
const NOTES_MAX = 40_000;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const isMinutes = (value: unknown): boolean => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 24 * 60 * 7);
const isTitle = (value: unknown): boolean => typeof value === 'string' && value.trim().length > 0 && value.length <= TITLE_MAX;
const BUCKET_IDS = new Set<string>(BACKLOG_BUCKETS.map((bucket) => bucket.id));

export const isPlacement = (value: unknown): value is Placement => {
  if (!isRecord(value)) return false;
  if (value.kind === 'day') return isDateKey(value.date);
  if (value.kind === 'backlog') return typeof value.bucket === 'string' && BUCKET_IDS.has(value.bucket);
  return false;
};

const isSubtasks = (value: unknown): value is Subtask[] =>
  Array.isArray(value) && value.length <= 200 && value.every((item) =>
    isRecord(item) && isId(item.id) && isTitle(item.title) && typeof item.done === 'boolean' &&
    // A task merged in keeps its notes, planned time and source (Sunsama's Merge tasks).
    (item.notes === undefined || (typeof item.notes === 'string' && item.notes.length <= NOTES_MAX)) &&
    (item.plannedMinutes === undefined || item.plannedMinutes === null || (Number.isInteger(item.plannedMinutes) && (item.plannedMinutes as number) >= 0 && (item.plannedMinutes as number) <= 24 * 60)) &&
    (item.source === undefined || isSource(item.source)));

/** One of Gmail's actions; applying or removing a label names it. */
const isGmailAction = (value: unknown): boolean =>
  isRecord(value) && (GMAIL_ACTIONS as readonly unknown[]).includes(value.kind) &&
  (value.kind === 'addLabel' || value.kind === 'removeLabel' ? isShortText(value.label, 225) && (value.label as string).trim().length > 0 : value.label === undefined);

const isShortText = (value: unknown, max: number): boolean => typeof value === 'string' && value.length <= max;
const isSource = (value: unknown): value is TaskSourceRef =>
  isRecord(value) &&
  typeof value.kind === 'string' && Object.hasOwn(SOURCE_NAMES, value.kind) &&
  isShortText(value.id, 200) && (value.id as string).length > 0 &&
  isShortText(value.key, 100) &&
  isShortText(value.url, 2000) && (value.kind === 'link' ? /^https?:\/\// : /^https:\/\//).test(value.url as string) &&
  (value.title === undefined || isShortText(value.title, TITLE_MAX)) &&
  (value.teamId === undefined || isShortText(value.teamId, 200)) &&
  (value.status === undefined || (isRecord(value.status) && isShortText(value.status.name, 100) && isShortText(value.status.type, 40) && isShortText(value.status.color, 40))) &&
  (value.mirrors === undefined || (Array.isArray(value.mirrors) && value.mirrors.length <= 10 && value.mirrors.every((key) => isShortText(key, 200)))) &&
  (value.workspaceId === undefined || (isShortText(value.workspaceId, 200) && (value.workspaceId as string).length > 0)) &&
  (value.branch === undefined || isShortText(value.branch, 200)) &&
  (value.account === undefined || (typeof value.account === 'string' && /^[^\s@]{1,100}@[^\s@]{1,100}$/.test(value.account))) &&
  (value.listId === undefined || (isShortText(value.listId, 200) && (value.listId as string).length > 0)) &&
  (value.notes === undefined || isShortText(value.notes, GOOGLE_NOTES_MAX)) &&
  (value.due === undefined || value.due === null || isDateKey(value.due)) &&
  (value.event === undefined || (isRecord(value.event) && isShortText(value.event.calendarId, 2000) && isInstant(value.event.start) && isInstant(value.event.end) &&
    typeof value.event.allDay === 'boolean' && typeof value.event.invitees === 'boolean' && (value.event.auto === undefined || typeof value.event.auto === 'boolean')));

/** Google Tasks keeps at most this much of a task's details. */
export const GOOGLE_NOTES_MAX = 8192;

const isGoogleTaskId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 1024;

const GTASK_TEMPLATE_FIELDS = ['title', 'notes', 'time', 'duration', 'deadline', 'start', 'busy', 'visibility', 'color', 'doNotDisturb', 'decline', 'attachments'];

/** Google Calendar attaches at most this many Drive files to a task. */
export const ATTACHMENTS_MAX = 25;
/** The longest message a declined meeting's organizer gets. */
export const DECLINE_MESSAGE_MAX = 500;
const ATTACHMENT_FIELDS = ['id', 'title', 'mimeType', 'url'];

/** Drive files attached to a task: Drive's id for each, a name, a type and an https address, once each, at most 25. */
const attachmentsProblem = (value: unknown): string | null => {
  if (!Array.isArray(value) || value.length > ATTACHMENTS_MAX) return `attachments are at most ${ATTACHMENTS_MAX} Drive files`;
  for (const file of value) {
    if (!isRecord(file) || typeof file.id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(file.id)) return "an attachment needs Drive's id for the file";
    if (typeof file.title !== 'string' || !file.title.trim() || file.title.length > 500) return "an attachment's name is 1-500 characters";
    if (typeof file.mimeType !== 'string' || file.mimeType.length > 200) return "an attachment's type is text, at most 200 characters";
    if (typeof file.url !== 'string' || file.url.length > 2000 || !/^https:\/\//.test(file.url)) return 'an attachment opens at an https address';
    if (Object.keys(file).some((field) => !ATTACHMENT_FIELDS.includes(field))) return 'an attachment has an unknown field';
  }
  return new Set(value.map((file: { id: string }) => file.id)).size === value.length ? null : 'a file is attached once';
};

/** "Automatically decline meetings": new and existing ('all') or only new ('new') invitations, a message, and since when. */
const declineProblem = (value: unknown): string | null => {
  if (!isRecord(value)) return 'decline is an object, or null';
  if (value.mode !== 'all' && value.mode !== 'new') return 'decline mode is all or new';
  if (typeof value.message !== 'string' || value.message.length > DECLINE_MESSAGE_MAX) return `a decline message is text, at most ${DECLINE_MESSAGE_MAX} characters`;
  if (value.since !== undefined && !(typeof value.since === 'string' && value.since.length <= 40 && !Number.isNaN(Date.parse(value.since)))) return 'decline since is an instant';
  return Object.keys(value).some((field) => !['mode', 'message', 'since'].includes(field)) ? 'decline has an unknown field' : null;
};

/** A repeating Google task's template: Google's title and details, and what the Planner keeps, for each next occurrence. */
const validateGtaskTemplate = (value: unknown): string | null => {
  if (!isRecord(value)) return 'repeat template must be an object';
  if (typeof value.title !== 'string' || value.title.length > 1024) return 'template title must be text, at most 1024 characters';
  if (typeof value.notes !== 'string' || value.notes.length > GOOGLE_NOTES_MAX) return `template notes must be text, at most ${GOOGLE_NOTES_MAX} characters`;
  if (!(value.time === null || (Number.isInteger(value.time) && (value.time as number) >= 0 && (value.time as number) < 24 * 60))) return 'template time must be minutes after midnight, or null';
  if (!(value.duration === null || (Number.isInteger(value.duration) && (value.duration as number) >= 5 && (value.duration as number) <= 24 * 60))) return 'template duration must be 5 to 1440 minutes, or null';
  if (!(value.deadline === null || (Number.isInteger(value.deadline) && Math.abs(value.deadline as number) <= 3660))) return 'template deadline must be days from the date, or null';
  if (!isDateKey(value.start)) return 'template start must be a date';
  if (value.busy !== undefined && value.busy !== true) return 'template busy is true, or left out (free)';
  if (value.visibility !== undefined && value.visibility !== 'public' && value.visibility !== 'private') return 'template visibility is public or private, or left out (the default)';
  if (value.color !== undefined && !isColor(value.color)) return 'template color must be #rrggbb';
  if (value.doNotDisturb !== undefined && value.doNotDisturb !== true) return 'template doNotDisturb is true, or left out';
  const problem = (value.decline !== undefined ? declineProblem(value.decline) : null) ?? (value.attachments !== undefined ? attachmentsProblem(value.attachments) : null);
  if (problem) return `template: ${problem}`;
  return Object.keys(value).some((field) => !GTASK_TEMPLATE_FIELDS.includes(field)) ? 'template has an unknown field' : null;
};

const GTASK_EXCEPTION_FIELDS = ['skip', 'title', 'notes', 'date', 'time', 'duration', 'deadline', 'attachments'];
/** A series keeps at most this many of its occurrences changed on their own. */
export const GTASK_EXCEPTIONS_MAX = 200;

/** An occurrence of a series changed on its own: skipped, or its own title, details, date, time or deadline. */
const validateGtaskException = (value: unknown): string | null => {
  if (!isRecord(value)) return 'an occurrence change must be an object';
  const fields = Object.keys(value);
  if (!fields.length) return 'an occurrence change needs a field';
  if (fields.some((field) => !GTASK_EXCEPTION_FIELDS.includes(field))) return 'an occurrence change has an unknown field';
  if (value.skip !== undefined && (value.skip !== true || fields.length > 1)) return 'a skipped occurrence is skip: true alone';
  if (value.title !== undefined && !(typeof value.title === 'string' && value.title.trim().length > 0 && value.title.length <= 1024)) return 'an occurrence title must be 1-1024 characters';
  if (value.notes !== undefined && !(typeof value.notes === 'string' && value.notes.length <= GOOGLE_NOTES_MAX)) return `an occurrence's notes must be text, at most ${GOOGLE_NOTES_MAX} characters`;
  if (value.date !== undefined && !isDateKey(value.date)) return 'an occurrence date must be a date';
  if (value.time !== undefined && !(value.time === null || (Number.isInteger(value.time) && (value.time as number) >= 0 && (value.time as number) < 24 * 60))) return 'an occurrence time must be minutes after midnight, or null';
  if (value.duration !== undefined && !(value.duration === null || (Number.isInteger(value.duration) && (value.duration as number) >= 5 && (value.duration as number) <= 24 * 60))) return 'an occurrence duration must be 5 to 1440 minutes, or null';
  if (value.deadline !== undefined && !(value.deadline === null || isDateKey(value.deadline))) return 'an occurrence deadline must be a date or null';
  const files = value.attachments !== undefined ? attachmentsProblem(value.attachments) : null;
  return files ? `an occurrence's ${files}` : null;
};

/**
 * What may be kept for a Google task: a time of day, a length, a deadline, a repeat rule (with its series' template), a
 * star, Busy, a visibility, a color, Drive attachments, Do not disturb and declining meetings.
 */
const validateKeptPatch = (patch: unknown): string | null => {
  if (!isRecord(patch)) return 'patch must be an object';
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'time' && !(value === null || (Number.isInteger(value) && (value as number) >= 0 && (value as number) < 24 * 60))) return 'time must be minutes after midnight, or null';
    else if (key === 'duration' && !(value === null || (Number.isInteger(value) && (value as number) >= 5 && (value as number) <= 24 * 60))) return 'duration must be 5 to 1440 minutes, or null';
    else if (key === 'deadline' && !(value === null || isDateKey(value))) return 'deadline must be a date or null';
    else if ((key === 'starred' || key === 'busy' || key === 'doNotDisturb') && typeof value !== 'boolean') return `${key} must be true or false`;
    else if (key === 'visibility' && value !== 'default' && value !== 'public' && value !== 'private') return 'visibility must be default, public or private';
    else if (key === 'color' && !(value === null || isColor(value))) return "color must be #rrggbb, or null (its list's)";
    else if (key === 'attachments' || key === 'decline') {
      const problem = key === 'attachments' ? attachmentsProblem(value) : value === null ? null : declineProblem(value);
      if (problem) return problem;
    } else if (key === 'repeat') {
      if (value === null) continue;
      if (!isRecord(value) || typeof value.rule !== 'string' || value.rule.length > 500 || !parseRRule(value.rule)) return 'repeat needs an RRULE';
      if (!isId(value.seriesId)) return 'repeat needs a series id';
      if (!(Number.isInteger(value.index) && (value.index as number) >= 1 && (value.index as number) <= 100_000)) return 'repeat index must be a count';
      if (!(value.next === null || isGoogleTaskId(value.next))) return 'repeat next must be a task id or null';
      if (value.on !== undefined && !isDateKey(value.on)) return 'repeat on must be a date';
      if (value.template !== undefined) {
        const error = validateGtaskTemplate(value.template);
        if (error) return error;
      }
      if (value.exceptions !== undefined) {
        if (!isRecord(value.exceptions) || Object.keys(value.exceptions).length > GTASK_EXCEPTIONS_MAX) return `repeat exceptions must be at most ${GTASK_EXCEPTIONS_MAX} occurrences by date`;
        for (const [date, change] of Object.entries(value.exceptions)) {
          if (!isDateKey(date)) return 'repeat exceptions are by date';
          const error = validateGtaskException(change);
          if (error) return error;
        }
      }
      if (Object.keys(value).some((field) => !['rule', 'seriesId', 'index', 'next', 'on', 'template', 'exceptions'].includes(field))) return 'repeat has an unknown field';
    } else if (!['time', 'duration', 'deadline', 'starred', 'repeat', 'busy', 'visibility', 'color', 'attachments', 'doNotDisturb', 'decline'].includes(key)) return `unknown field ${key}`;
  }
  return null;
};

const PRIORITY_VALUES = new Set(['urgent', 'high', 'medium', 'low']);
const isPriority = (value: unknown): boolean => value === null || (typeof value === 'string' && PRIORITY_VALUES.has(value));
const isColor = (value: unknown): boolean => typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
const isChannelName = (value: unknown): boolean => typeof value === 'string' && /^[\p{L}\p{N}_-]{1,40}$/u.test(value);

const validatePatch = (patch: unknown, channels: Record<string, Channel>, objectives: Record<string, Objective>, folders: Record<string, Folder>): string | null => {
  if (!isRecord(patch)) return 'patch must be an object';
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'title' && !isTitle(value)) return 'title must be 1-500 characters';
    else if (key === 'notes' && !(typeof value === 'string' && value.length <= NOTES_MAX)) return 'notes are too long';
    else if (key === 'plannedMinutes' && !isMinutes(value)) return 'plannedMinutes must be a number of minutes or null';
    else if (key === 'priority' && !isPriority(value)) return 'priority is invalid';
    else if (key === 'dueDate' && !(value === null || isDateKey(value))) return 'dueDate must be a date or null';
    else if (key === 'channelId' && !(value === null || (isId(value) && channels[value as string]))) return 'unknown channel';
    else if (key === 'objectiveId' && !(value === null || (isId(value) && objectives[value as string]))) return 'unknown objective';
    else if (key === 'folderId' && !(value === null || (isId(value) && folders[value as string] && !folders[value as string]!.deletedAt))) return 'unknown folder';
    else if (key === 'subtasks' && !isSubtasks(value)) return 'subtasks are invalid';
    else if (key === 'source' && !(value === null || isSource(value))) return 'source is invalid';
    else if (!(PATCH_FIELDS as readonly string[]).includes(key)) return `unknown field ${key}`;
  }
  return null;
};

const validateChannelPatch = (patch: unknown): string | null => {
  if (!isRecord(patch)) return 'patch must be an object';
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'name' && !isChannelName(value)) return 'channel name must be 1-40 letters, digits, _ or -';
    else if (key === 'color' && !isColor(value)) return 'color must be #rrggbb';
    else if (key === 'context' && value !== 'work' && value !== 'personal') return 'context must be work or personal';
    else if (!['name', 'color', 'context'].includes(key)) return `unknown field ${key}`;
  }
  return null;
};

const isGoogleAccount = (value: unknown): boolean => typeof value === 'string' && /^[^\s@]{1,100}@[^\s@]{1,100}$/.test(value);

/** A Google account and one of its calendars. */
const isGoogleCalendarRef = (value: unknown): boolean =>
  isRecord(value) && isGoogleAccount(value.account) && isShortText(value.calendarId, 1024) && (value.calendarId as string).length > 0;

const isGoogleEventLink = (value: unknown): value is GoogleEventLink =>
  isGoogleCalendarRef(value) && isShortText((value as Record<string, unknown>).eventId, 1024) && ((value as Record<string, unknown>).eventId as string).length > 0;

/** A task list in the settings: its account and id, as `${account}\n${listId}`. */
const isTaskListKey = (value: unknown): boolean => typeof value === 'string' && /^[^\s@]{1,100}@[^\s@]{1,100}\n[^\n]{1,1024}$/.test(value);
/** At most this many task lists have a color, a place, or are hidden. */
const TASK_LISTS_MAX = 500;

const validateSettingsPatch = (patch: unknown): string | null => {
  if (!isRecord(patch)) return 'patch must be an object';
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'timezone' && !isValidTimeZone(value)) return 'timezone must be an IANA zone';
    else if (key === 'workloadMinutes' && !(typeof value === 'number' && value > 0 && value <= 24 * 60)) return 'workloadMinutes must be 1-1440';
    else if (key === 'archiveAfterRollovers' && !(value === null || (Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 365))) return 'archiveAfterRollovers must be 1-365 or null';
    else if (key === 'weekStartsOn' && value !== 0 && value !== 1) return 'weekStartsOn must be 0 or 1';
    else if (key === 'plannedAsActual' && typeof value !== 'boolean') return 'plannedAsActual must be true or false';
    else if ((key === 'workdayStart' || key === 'workdayEnd') && !(Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 24 * 60)) return `${key} must be minutes after midnight`;
    else if (key === 'linearOnComplete' && !['ask', 'complete', 'nothing'].includes(value as string)) return 'linearOnComplete must be ask, complete or nothing';
    else if (key === 'linearOnPlan' && !['ask', 'start', 'nothing'].includes(value as string)) return 'linearOnPlan must be ask, start or nothing';
    else if (key === 'linearImportCompletion' && typeof value !== 'boolean') return 'linearImportCompletion must be true or false';
    else if (key === 'linearLayout' && value !== 'list' && value !== 'board') return 'linearLayout must be list or board';
    else if (key === 'linearGroupBy' && !(LINEAR_GROUPS as readonly unknown[]).includes(value)) return `linearGroupBy must be one of ${LINEAR_GROUPS.join(', ')}`;
    else if (key === 'linearOrderBy' && !(LINEAR_ORDERS as readonly unknown[]).includes(value)) return `linearOrderBy must be one of ${LINEAR_ORDERS.join(', ')}`;
    else if (key === 'linearDisplay') { const problem = linearDisplayProblem(value); if (problem) return problem; }
    else if (key === 'suggestFromHistory' && typeof value !== 'boolean') return 'suggestFromHistory must be true or false';
    else if ((key === 'pomodoroMinutes' || key === 'breakMinutes') && !(Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 180)) return `${key} must be 1-180`;
    else if (key === 'googleTimebox' && !(value === null || isGoogleCalendarRef(value))) return 'googleTimebox must be a Google account and calendar, or null';
    else if (key === 'channelTimebox' && !(isRecord(value) && Object.keys(value).length <= 200 && Object.entries(value).every(([channel, target]) => isId(channel) && isGoogleCalendarRef(target)))) return 'channelTimebox must map channel ids to a Google account and calendar';
    else if (key === 'googleTasksOnComplete' && !['ask', 'complete', 'nothing'].includes(value as string)) return 'googleTasksOnComplete must be ask, complete or nothing';
    else if ((key === 'googleTasksImportCompletion' || key === 'googleTasksDueFromPlan' || key === 'googleTasksOnCalendar' || key === 'googleTaskNotifications') && typeof value !== 'boolean') return `${key} must be true or false`;
    else if (key === 'googleCalendarsIntroduced' && !(Array.isArray(value) && value.length <= 50 && value.every((email) => typeof email === 'string' && email.length <= 254 && email.includes('@')))) return 'googleCalendarsIntroduced must be at most 50 email addresses';
    else if (key === 'googleTaskListColors' && !(isRecord(value) && Object.keys(value).length <= TASK_LISTS_MAX && Object.entries(value).every(([list, color]) => isTaskListKey(list) && isColor(color)))) return `googleTaskListColors must be at most ${TASK_LISTS_MAX} task lists, each a #rrggbb color`;
    else if ((key === 'googleTaskListsHidden' || key === 'googleTaskListOrder') && !(Array.isArray(value) && value.length <= TASK_LISTS_MAX && value.every(isTaskListKey) && new Set(value).size === value.length)) return `${key} must be at most ${TASK_LISTS_MAX} task lists, once each`;
    else if (key === 'agentPresets' && !(Array.isArray(value) && value.length <= 30 && value.every(isAgentPreset) && new Set(value.map((preset: { id: string }) => preset.id)).size === value.length)) return 'agentPresets must be at most 30 presets with distinct ids, each a name, an agent and a model or null';
    else if (key === 'agentPresets') continue;
    else if ((key === 'gmailOnImport' || key === 'gmailOnComplete') && !(Array.isArray(value) && value.length <= 12 && value.every(isGmailAction))) return `${key} must be at most 12 Gmail actions (a label with addLabel and removeLabel)`;
    else if ((key === 'gmailImportPrompt' || key === 'gmailCompletePrompt' || key === 'linearImportPrompt') && typeof value !== 'boolean') return `${key} must be true or false`;
    else if (key === 'emailClient' && value !== 'gmail' && value !== 'superhuman') return 'emailClient must be gmail or superhuman';
    else if (key === 'meetingImport' && value !== 'prompt' && value !== 'autoSync') return 'meetingImport must be prompt or autoSync';
    else if (key === 'meetingCalendars' && !(Array.isArray(value) && value.length <= 200 && value.every((id) => isShortText(id, 2000) && (id as string).length > 0))) return 'meetingCalendars must be calendar ids';
    else if (key === 'meetingExclusions' && !(Array.isArray(value) && value.every((kind) => (MEETING_EXCLUSIONS as readonly unknown[]).includes(kind)) && new Set(value).size === value.length)) return `meetingExclusions must be some of ${MEETING_EXCLUSIONS.join(', ')}`;
    else if (key === 'meetingAutoComplete' && !['always', 'never', 'invitees'].includes(value as string)) return 'meetingAutoComplete must be always, never or invitees';
    else if (key === 'meetingChannels' && !(isRecord(value) && Object.keys(value).length <= 200 && Object.entries(value).every(([calendar, channel]) => calendar.length > 0 && calendar.length <= 2000 && isId(channel)))) return 'meetingChannels must map calendar ids to channel ids';
    else if (!['timezone', 'workloadMinutes', 'archiveAfterRollovers', 'weekStartsOn', 'plannedAsActual', 'workdayStart', 'workdayEnd', 'linearOnComplete', 'linearOnPlan', 'linearImportCompletion', 'linearLayout', 'linearGroupBy', 'linearOrderBy', 'suggestFromHistory', 'pomodoroMinutes', 'breakMinutes', 'googleTimebox', 'googleTasksOnComplete', 'googleTasksImportCompletion', 'googleTasksDueFromPlan', 'googleTasksOnCalendar', 'googleTaskNotifications', 'googleCalendarsIntroduced', 'googleTaskListColors', 'googleTaskListsHidden', 'googleTaskListOrder', 'gmailOnImport', 'gmailOnComplete', 'gmailImportPrompt', 'gmailCompletePrompt', 'emailClient', 'linearImportPrompt', 'meetingImport', 'meetingCalendars', 'meetingExclusions', 'meetingAutoComplete', 'meetingChannels', 'channelTimebox'].includes(key)) return `unknown setting ${key}`;
  }
  return null;
};

/** The parts of state a command is checked against. */
export interface CommandContext {
  tasks: Record<string, Task>;
  channels: Record<string, Channel>;
  entries: Record<string, { id: string }>;
  blocks: Record<string, WorkBlock>;
  calendars: Record<string, CalendarSubscription>;
  objectives: Record<string, Objective>;
  series: Record<string, Series>;
  runs: Record<string, TaskRun>;
  folders: Record<string, Folder>;
}

const isFolderName = (value: unknown): boolean => typeof value === 'string' && value.trim().length > 0 && value.length <= 60;

const isSessionRef = (value: unknown): boolean =>
  value === null ||
  (isRecord(value) && isShortText(value.sessionId, 200) && (value.sessionId as string).length > 0 && isShortText(value.title, 500) && (value.directory === null || isShortText(value.directory, 1024)));

const isRunShape = (value: unknown): string | null => {
  if (!isRecord(value) || !isId(value.id)) return 'run needs an id';
  if (!(isShortText(value.sessionId, 200) && (value.sessionId as string).length > 0)) return 'run needs a session';
  if (!(value.projectId === null || isShortText(value.projectId, 1024))) return 'projectId is invalid';
  if (!(value.directory === null || isShortText(value.directory, 1024))) return 'directory is invalid';
  if (!(value.worktree === null || (isRecord(value.worktree) && isShortText(value.worktree.directory, 1024) && (value.worktree.branch === null || isShortText(value.worktree.branch, 200))))) return 'worktree is invalid';
  if (value.wantsPr !== undefined && typeof value.wantsPr !== 'boolean') return 'wantsPr must be true or false';
  if (!(value.assignee === undefined || value.assignee === null || isRunAssignee(value.assignee))) return 'assignee is invalid';
  return isShortText(value.title, TITLE_MAX) ? null : 'title is invalid';
};

const PULL_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}\/pull\/\d{1,9}$/;

const isPullRequest = (value: unknown): value is SeenPullRequest =>
  isRecord(value) &&
  Number.isInteger(value.number) && (value.number as number) > 0 &&
  typeof value.url === 'string' && PULL_URL.test(value.url) &&
  ['open', 'closed', 'merged'].includes(value.state as string) &&
  typeof value.draft === 'boolean' &&
  isShortText(value.title, TITLE_MAX) &&
  typeof value.repo === 'string' && /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(value.repo);

const isRule = (value: unknown): value is RecurrenceRule => {
  if (!isRecord(value)) return false;
  if (!['daily', 'weekly', 'monthly', 'yearly'].includes(value.freq as string)) return false;
  if (!(Number.isInteger(value.interval) && (value.interval as number) >= 1 && (value.interval as number) <= 365)) return false;
  if (value.weekdays !== undefined && !(Array.isArray(value.weekdays) && value.weekdays.length <= 7 && value.weekdays.every((day) => Number.isInteger(day) && day >= 0 && day <= 6))) return false;
  if (value.monthDay !== undefined && !(Number.isInteger(value.monthDay) && (value.monthDay as number) !== 0 && Math.abs(value.monthDay as number) <= 31)) return false;
  return true;
};

const validateTemplate = (template: unknown, channels: Record<string, Channel>, partial: boolean): string | null => {
  if (!isRecord(template)) return 'template must be an object';
  const has = (key: string) => key in template;
  if ((has('title') || !partial) && !isTitle(template.title)) return 'title must be 1-500 characters';
  if ((has('notes') || !partial) && !(typeof template.notes === 'string' && template.notes.length <= NOTES_MAX)) return 'notes are too long';
  if ((has('plannedMinutes') || !partial) && !isMinutes(template.plannedMinutes)) return 'plannedMinutes is invalid';
  if ((has('priority') || !partial) && !isPriority(template.priority)) return 'priority is invalid';
  if ((has('channelId') || !partial) && !(template.channelId === null || (isId(template.channelId) && channels[template.channelId as string]))) return 'unknown channel';
  if ((has('subtasks') || !partial) && !(Array.isArray(template.subtasks) && template.subtasks.length <= 200 && template.subtasks.every(isTitle))) return 'subtasks are invalid';
  return null;
};

const TEXT_MAX = 20_000;
const RITUAL_FIELDS: Record<Ritual, readonly string[]> = {
  planning: ['completedAt', 'obstacles', 'shutdownTime'],
  shutdown: ['completedAt', 'reflection'],
  highlights: ['completedAt', 'items', 'summary', 'reflection', 'publishedAt'],
  weeklyPlanning: ['completedAt', 'journal'],
  weeklyReview: ['completedAt', 'journal'],
};

const validateRitualFields = (ritual: Ritual, fields: unknown): string | null => {
  if (!isRecord(fields)) return 'fields must be an object';
  for (const [key, value] of Object.entries(fields)) {
    if (!RITUAL_FIELDS[ritual].includes(key)) return `${ritual} has no field ${key}`;
    if ((key === 'completedAt' || key === 'publishedAt') && !(value === null || isInstantString(value))) return `${key} must be an ISO instant or null`;
    if ((key === 'obstacles' || key === 'reflection' || key === 'summary' || key === 'journal') && !(typeof value === 'string' && value.length <= TEXT_MAX)) return `${key} is too long`;
    if (key === 'shutdownTime' && !(value === null || (Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 24 * 60))) return 'shutdownTime must be minutes after midnight';
    if (key === 'items') {
      if (!Array.isArray(value) || value.length > 100) return 'items must be a list of at most 100';
      for (const item of value) {
        if (!isRecord(item) || !isId(item.id) || !(typeof item.text === 'string' && item.text.trim() && item.text.length <= 1000) || typeof item.starred !== 'boolean' || !(item.taskId === null || isId(item.taskId)) || !(item.hidden === undefined || typeof item.hidden === 'boolean')) return 'a highlight is invalid';
        if (!(item.url === undefined || (typeof item.url === 'string' && item.url.length <= 2000 && /^https:\/\/\S+$/.test(item.url))) || !(item.ref === undefined || (typeof item.ref === 'string' && item.ref.length > 0 && item.ref.length <= 300))) return 'a highlight is invalid';
      }
    }
  }
  return null;
};

const isInstantString = (value: unknown): boolean => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));

const isFeedUrl = (value: unknown): boolean => typeof value === 'string' && value.length <= 2000 && /^(https?|webcal|file):\/\/\S+$/i.test(value);

const isInstant = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}T/.test(value);
const MAX_ENTRY_MS = 24 * 60 * 60 * 1000;

const validateSpan = (start: unknown, end: unknown): string | null => {
  if (!isInstant(start) || !isInstant(end)) return 'start and end must be ISO instants';
  const span = Date.parse(end) - Date.parse(start);
  return span >= 5 * 60_000 && span <= MAX_ENTRY_MS ? null : 'a working session lasts between 5 minutes and 24 hours';
};

/** Shape check for a client command against current state. Returns an error message or null. */
export const validateCommand = (command: unknown, context: CommandContext): string | null => {
  if (!isRecord(command)) return 'command must be an object';
  if (!isId(command.cmd)) return 'command needs a cmd id';
  const { tasks, channels } = context;
  const type = command.type as EventType;
  if (SERVICE_ONLY_TYPES.has(type)) return `${type} is written by the service only`;
  const needTask = (): string | null => (isId(command.taskId) && tasks[command.taskId as string] ? null : 'unknown task');
  const needChannel = (): string | null => (isId(command.channelId) && channels[command.channelId as string] ? null : 'unknown channel');
  switch (type) {
    case 'task.created': {
      const task = command.task;
      if (!isRecord(task) || !isId(task.id)) return 'task needs an id';
      if (tasks[task.id as string]) return 'task id already exists';
      if (!isTitle(task.title)) return 'title must be 1-500 characters';
      if (!isPlacement(task.placement)) return 'placement is invalid';
      if (typeof task.position !== 'number' || !Number.isFinite(task.position)) return 'position must be a number';
      if (task.notes !== undefined && !(typeof task.notes === 'string' && task.notes.length <= NOTES_MAX)) return 'notes are too long';
      if (task.plannedMinutes !== undefined && !isMinutes(task.plannedMinutes)) return 'plannedMinutes is invalid';
      if (task.priority !== undefined && !isPriority(task.priority)) return 'priority is invalid';
      if (task.dueDate !== undefined && !(task.dueDate === null || isDateKey(task.dueDate))) return 'dueDate must be a date or null';
      if (task.channelId !== undefined && !(task.channelId === null || (isId(task.channelId) && channels[task.channelId as string]))) return 'unknown channel';
      if (task.source !== undefined && !(task.source === null || isSource(task.source))) return 'source is invalid';
      if (task.objectiveId !== undefined && !(task.objectiveId === null || (isId(task.objectiveId) && context.objectives[task.objectiveId as string]))) return 'unknown objective';
      if (task.subtasks !== undefined && !isSubtasks(task.subtasks)) return 'subtasks are invalid';
      if (task.folderId !== undefined && !(task.folderId === null || (isId(task.folderId) && context.folders[task.folderId as string] && !context.folders[task.folderId as string]!.deletedAt))) return 'unknown folder';
      // Recurrence comes from series.created and the service's instances, never from a client's task.
      if (task.recurrence !== undefined && task.recurrence !== null) return 'recurrence is set through a series';
      if (task.sessionRef !== undefined && !isSessionRef(task.sessionRef)) return 'sessionRef is invalid';
      return null;
    }
    case 'task.updated': {
      const error = needTask() ?? validatePatch(command.patch, channels, context.objectives, context.folders);
      if (error) return error;
      // A calendar event task has no subtasks at all (Sunsama): none is added to one; the ones it had before stay, to
      // tick, rename, convert or remove.
      const task = tasks[command.taskId as string]!;
      const subtasks = (command.patch as TaskPatch).subtasks;
      return isEventTask(task) && subtasks?.some((subtask) => !task.subtasks.some((item) => item.id === subtask.id)) ? EVENT_NO_SUBTASKS : null;
    }
    case 'task.moved':
      if (!isPlacement(command.placement)) return 'placement is invalid';
      if (typeof command.position !== 'number' || !Number.isFinite(command.position)) return 'position must be a number';
      return needTask();
    case 'task.completed':
      return needTask() ?? (isDateKey(command.on) ? null : 'on must be a date');
    case 'task.reopened':
    case 'task.deleted':
    case 'task.restored':
    case 'task.archived':
      return needTask();
    case 'task.sourceSynced':
      if (!isSource(command.source)) return 'source is invalid';
      if (command.title !== undefined && !isTitle(command.title)) return 'title must be 1-500 characters';
      if (command.notes !== undefined && !(typeof command.notes === 'string' && command.notes.length <= NOTES_MAX)) return 'notes are too long';
      if (command.dueDate !== undefined && !(command.dueDate === null || isDateKey(command.dueDate))) return 'dueDate must be a date or null';
      return needTask();
    case 'timer.started':
      return needTask();
    case 'timer.stopped':
      return null;
    case 'time.logged': {
      const entry = command.entry;
      if (!isRecord(entry) || !isId(entry.id)) return 'entry needs an id';
      if (context.entries[entry.id as string]) return 'entry id already exists';
      if (!(isId(entry.taskId) && tasks[entry.taskId as string])) return 'unknown task';
      if (!isInstant(entry.start) || !isInstant(entry.end)) return 'start and end must be ISO instants';
      const span = Date.parse(entry.end as string) - Date.parse(entry.start as string);
      return span > 0 && span <= MAX_ENTRY_MS ? null : 'an entry must last between 0 and 24 hours';
    }
    case 'time.deleted':
      return isId(command.entryId) && context.entries[command.entryId as string] ? null : 'unknown entry';
    case 'block.created': {
      const block = command.block;
      if (!isRecord(block) || !isId(block.id)) return 'block needs an id';
      if (context.blocks[block.id as string]) return 'block id already exists';
      if (!(isId(block.taskId) && tasks[block.taskId as string])) return 'unknown task';
      return validateSpan(block.start, block.end);
    }
    case 'block.updated':
      if (!(isId(command.blockId) && context.blocks[command.blockId as string])) return 'unknown block';
      return validateSpan(command.start, command.end);
    case 'block.deleted':
      return isId(command.blockId) && context.blocks[command.blockId as string] ? null : 'unknown block';
    case 'block.linked':
      if (!(isId(command.blockId) && context.blocks[command.blockId as string])) return 'unknown block';
      return command.google === null || isGoogleEventLink(command.google) ? null : 'google must be an account, calendar and event, or null';
    case 'calendar.added': {
      const calendar = command.calendar;
      if (!isRecord(calendar) || !isId(calendar.id)) return 'calendar needs an id';
      if (context.calendars[calendar.id as string]) return 'calendar id already exists';
      if (!(typeof calendar.name === 'string' && calendar.name.trim() && calendar.name.length <= 80)) return 'calendar name must be 1-80 characters';
      if (!isFeedUrl(calendar.url)) return 'calendar URL must be http(s), webcal or file';
      if (calendar.google !== undefined && !isGoogleCalendarRef(calendar.google)) return 'google must be an account and a calendar';
      return isColor(calendar.color) ? null : 'color must be #rrggbb';
    }
    case 'calendar.updated': {
      if (!(isId(command.calendarId) && context.calendars[command.calendarId as string])) return 'unknown calendar';
      const patch = command.patch;
      if (!isRecord(patch)) return 'patch must be an object';
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'name' && !(typeof value === 'string' && value.trim() && value.length <= 80)) return 'calendar name must be 1-80 characters';
        else if (key === 'color' && !isColor(value)) return 'color must be #rrggbb';
        else if (key === 'visible' && typeof value !== 'boolean') return 'visible must be true or false';
        else if (!['name', 'color', 'visible'].includes(key)) return `unknown field ${key}`;
      }
      return null;
    }
    case 'calendar.removed':
      return isId(command.calendarId) && context.calendars[command.calendarId as string] ? null : 'unknown calendar';
    case 'objective.created': {
      const objective = command.objective;
      if (!isRecord(objective) || !isId(objective.id)) return 'objective needs an id';
      if (context.objectives[objective.id as string]) return 'objective id already exists';
      if (!isDateKey(objective.weekStart)) return 'weekStart must be a date';
      if (!(typeof objective.title === 'string' && objective.title.trim() && objective.title.length <= 200)) return 'objective title must be 1-200 characters';
      return objective.carriedFrom === null || objective.carriedFrom === undefined || (isId(objective.carriedFrom) && context.objectives[objective.carriedFrom as string]) ? null : 'unknown objective to continue';
    }
    case 'objective.updated': {
      if (!(isId(command.objectiveId) && context.objectives[command.objectiveId as string])) return 'unknown objective';
      const patch = command.patch;
      if (!isRecord(patch)) return 'patch must be an object';
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'title' && !(typeof value === 'string' && value.trim() && value.length <= 200)) return 'objective title must be 1-200 characters';
        else if (key === 'completed' && typeof value !== 'boolean') return 'completed must be true or false';
        else if (key !== 'title' && key !== 'completed') return `unknown field ${key}`;
      }
      return null;
    }
    case 'objective.deleted':
    case 'objective.restored':
      return isId(command.objectiveId) && context.objectives[command.objectiveId as string] ? null : 'unknown objective';
    case 'series.created': {
      const series = command.series;
      if (!isRecord(series) || !isId(series.id)) return 'series needs an id';
      if (context.series[series.id as string]) return 'series id already exists';
      if (!isRule(series.rule)) return 'rule is invalid';
      if (!isDateKey(series.startDate)) return 'startDate must be a date';
      if (!(isId(command.taskId) && tasks[command.taskId as string])) return 'unknown task';
      if (tasks[command.taskId as string]!.recurrence) return 'task already repeats';
      return validateTemplate(series.template, channels, false);
    }
    case 'series.updated': {
      if (!(isId(command.seriesId) && context.series[command.seriesId as string])) return 'unknown series';
      const patch = command.patch;
      if (!isRecord(patch)) return 'patch must be an object';
      if (patch.rule !== undefined && !isRule(patch.rule)) return 'rule is invalid';
      if (patch.template !== undefined) return validateTemplate(patch.template, channels, true);
      return Object.keys(patch).every((key) => key === 'rule' || key === 'template') ? null : 'unknown field';
    }
    case 'series.stopped':
      if (!(isId(command.seriesId) && context.series[command.seriesId as string])) return 'unknown series';
      return isDateKey(command.from) ? null : 'from must be a date';
    case 'folder.created': {
      const folder = command.folder;
      if (!isRecord(folder) || !isId(folder.id)) return 'folder needs an id';
      if (context.folders[folder.id as string]) return 'folder id already exists';
      return isFolderName(folder.name) ? null : 'folder name must be 1-60 characters';
    }
    case 'folder.renamed':
      if (!(isId(command.folderId) && context.folders[command.folderId as string])) return 'unknown folder';
      return isFolderName(command.name) ? null : 'folder name must be 1-60 characters';
    case 'folder.deleted':
      return isId(command.folderId) && context.folders[command.folderId as string] ? null : 'unknown folder';
    case 'run.started': {
      const run = command.run;
      const error = isRunShape(run);
      if (error) return error;
      if (context.runs[(run as { id: string }).id]) return 'run id already exists';
      const taskId = (run as { taskId: unknown }).taskId;
      return isId(taskId) && tasks[taskId as string] ? null : 'unknown task';
    }
    case 'run.outcome':
      if (!(isId(command.runId) && context.runs[command.runId as string])) return 'unknown run';
      return command.outcome === 'completed' || command.outcome === 'failed' ? null : 'outcome must be completed or failed';
    case 'run.reviewed':
      if (!(isId(command.runId) && context.runs[command.runId as string])) return 'unknown run';
      if (command.verdict !== 'accepted' && command.verdict !== 'changes') return 'verdict must be accepted or changes';
      return command.note === undefined || isShortText(command.note, 4000) ? null : 'note is too long';
    case 'run.removed':
      return isId(command.runId) && context.runs[command.runId as string] ? null : 'unknown run';
    case 'run.pullRequest': {
      const run = isId(command.runId) ? context.runs[command.runId as string] : undefined;
      if (!run) return 'unknown run';
      if (command.taskId !== run.taskId) return "taskId must be the run's task";
      return isPullRequest(command.pullRequest) ? null : 'pullRequest is invalid';
    }
    case 'ritual.saved':
      if (!(RITUALS as readonly string[]).includes(command.ritual as string)) return 'unknown ritual';
      if (!isDateKey(command.date)) return 'date must be a date';
      return validateRitualFields(command.ritual as Ritual, command.fields);
    case 'channel.created': {
      const channel = command.channel;
      if (!isRecord(channel) || !isId(channel.id)) return 'channel needs an id';
      if (channels[channel.id as string]) return 'channel id already exists';
      const error = validateChannelPatch({ name: channel.name, color: channel.color, context: channel.context });
      if (error) return error;
      const name = (channel.name as string).toLowerCase();
      return Object.values(channels).some((other) => !other.deletedAt && other.name.toLowerCase() === name) ? 'a channel with that name exists' : null;
    }
    case 'channel.updated':
      return needChannel() ?? validateChannelPatch(command.patch);
    case 'channel.deleted':
      return needChannel();
    case 'settings.updated':
      return validateSettingsPatch(command.patch);
    case 'gtask.kept':
      if (!isGoogleAccount(command.account) || !isGoogleTaskId(command.listId) || !isGoogleTaskId(command.taskId)) return 'a Google account, list and task are required';
      return validateKeptPatch(command.patch);
    case 'gtask.moved':
      if (!isGoogleAccount(command.account) || !isGoogleTaskId(command.taskId) || !isGoogleTaskId(command.listId)) return 'a Google account, task and list are required';
      return command.newTaskId === undefined || isGoogleTaskId(command.newTaskId) ? null : 'newTaskId must be a task id';
    case 'gtask.dropped':
      return isGoogleAccount(command.account) && isGoogleTaskId(command.taskId) ? null : 'a Google account and task are required';
    default:
      return `unknown command type ${String(type)}`;
  }
};

/** Strip the client envelope to the event body that gets stored. */
export const commandBody = (command: Command): EventBody => {
  const { cmd: _cmd, ...body } = command;
  return body as EventBody;
};
