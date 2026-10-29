// A Google task's advanced settings beyond availability and visibility, as
// Google Calendar has them for a task with a time, and what the Planner does
// with each (Google Tasks' API has none of them, so the Planner keeps them):
// its color on the calendar (each list has one too, under "My calendars"),
// Google Drive files attached to it, and, for work and school accounts, Do not
// disturb (the Planner's own notifications that come during it wait until it
// ends) and automatically declining the meetings it overlaps while it is Busy.
import type { DateKey, GoogleTaskKept, PlannerState, Settings, TaskAttachment, TaskDecline } from './types.ts';
import { googleTaskKey } from './types.ts';
import { instantAt } from './dates.ts';
import type { GoogleResponse, GoogleTaskItem } from './google.ts';
import { TASK_MINUTES, keptFor, upcomingTasks, upcomingValues } from './gtaskKept.ts';
import type { TaskNotification } from './gtaskNotify.ts';

/** Google Calendar's color for tasks, and a task list's until one is chosen. */
export const TASKS_COLOR = '#1a73e8';

/** Google Calendar's colors for an event or a task, in its menu's order. */
export const TASK_COLORS: readonly { name: string; color: string }[] = [
  { name: 'Tomato', color: '#d50000' },
  { name: 'Flamingo', color: '#e67c73' },
  { name: 'Tangerine', color: '#f4511e' },
  { name: 'Banana', color: '#f6bf26' },
  { name: 'Sage', color: '#33b679' },
  { name: 'Basil', color: '#0b8043' },
  { name: 'Peacock', color: '#039be5' },
  { name: 'Blueberry', color: '#3f51b5' },
  { name: 'Lavender', color: '#7986cb' },
  { name: 'Grape', color: '#8e24aa' },
  { name: 'Graphite', color: '#616161' },
];

/** A color's name in Google Calendar's menu, or the color itself. */
export const colorName = (color: string): string => TASK_COLORS.find((choice) => choice.color === color.toLowerCase())?.name ?? color;

/** A task list in the settings (its color, its place, hidden or shown): its account and id. */
export const taskListKey = (account: string, listId: string): string => `${account}\n${listId}`;

/** A task list's color on the calendar: the one chosen for it under "My calendars", else Google Calendar's tasks color. */
export const taskListColor = (settings: Pick<Settings, 'googleTaskListColors'>, account: string, listId: string): string => settings.googleTaskListColors?.[taskListKey(account, listId)] ?? TASKS_COLOR;

/** A task's color on the calendar: its own, else its list's. */
export const taskColor = (state: Pick<PlannerState, 'googleTasks' | 'settings'>, item: { account: string; listId: string; id: string }): string =>
  keptFor(state, item)?.color ?? taskListColor(state.settings, item.account, item.listId);

/** Whether a task list's tasks show on the calendar (its checkbox under "My calendars"). */
export const taskListShown = (settings: Pick<Settings, 'googleTaskListsHidden'>, account: string, listId: string): boolean => !(settings.googleTaskListsHidden ?? []).includes(taskListKey(account, listId));

/** Lists in the order the user put them (`googleTaskListOrder`); the rest after them, as Google lists them. */
export const orderedLists = <T extends { account: string; id: string }>(lists: readonly T[], order: readonly string[] | undefined): T[] => {
  const place = new Map((order ?? []).map((key, index) => [key, index]));
  return lists
    .map((list, index) => ({ list, index, at: place.get(taskListKey(list.account, list.id)) }))
    .sort((a, b) => (a.at ?? Number.MAX_SAFE_INTEGER) - (b.at ?? Number.MAX_SAFE_INTEGER) || a.index - b.index)
    .map((entry) => entry.list);
};

/** The order after moving a list up or down by one (or to `to`), written as every list's key. */
export const moveList = (lists: readonly { account: string; id: string }[], from: number, to: number): string[] => {
  const keys = lists.map((list) => taskListKey(list.account, list.id));
  if (from < 0 || from >= keys.length || to < 0 || to >= keys.length || from === to) return keys;
  const [moved] = keys.splice(from, 1);
  keys.splice(to, 0, moved!);
  return keys;
};

// ── Drive attachments ────────────────────────────────────────────────────────

/** A Drive file as the Planner's Drive search finds it. */
export interface DriveFile extends TaskAttachment {
  /** When it last changed, for the search's list. */
  modifiedTime?: string;
}

/** What kind of file it is, by Drive's type: its name and Google's color for it. */
export const driveKind = (mimeType: string): { label: string; color: string } => {
  if (mimeType === 'application/vnd.google-apps.document') return { label: 'Google Docs', color: '#4285f4' };
  if (mimeType === 'application/vnd.google-apps.spreadsheet') return { label: 'Google Sheets', color: '#0f9d58' };
  if (mimeType === 'application/vnd.google-apps.presentation') return { label: 'Google Slides', color: '#f4b400' };
  if (mimeType === 'application/vnd.google-apps.form') return { label: 'Google Forms', color: '#7248b9' };
  if (mimeType === 'application/pdf') return { label: 'PDF', color: '#db4437' };
  if (mimeType.startsWith('image/')) return { label: 'Image', color: '#db4437' };
  if (mimeType.startsWith('video/')) return { label: 'Video', color: '#db4437' };
  return { label: 'File', color: '#5f6368' };
};

/** Attachments with these files added (each once, in the order chosen), at most `max`; null when that is more than `max`. */
export const withAttachments = (current: readonly TaskAttachment[], added: readonly TaskAttachment[], max: number): TaskAttachment[] | null => {
  const out = [...current];
  for (const file of added) if (!out.some((other) => other.id === file.id)) out.push({ id: file.id, title: file.title, mimeType: file.mimeType, url: file.url });
  return out.length > max ? null : out;
};

/** Drive's search for files whose name has `text` (all of them, newest first, when empty): its `q`, quoted as Drive asks. */
export const driveQuery = (text: string): string => {
  const words = text.trim();
  const base = "trashed = false and mimeType != 'application/vnd.google-apps.folder'";
  return words ? `${base} and name contains '${words.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'` : base;
};

// ── Do not disturb and declining meetings ───────────────────────────────────

/** "Automatically decline meetings"' message until one is written, as Google Calendar fills one in. */
export const DEFAULT_DECLINE_MESSAGE = 'Declined because I am busy';

/** The time of a task with Do not disturb or declining meetings on, on one date. */
export interface TaskWindow {
  account: string;
  listId: string;
  /** The Google task; for an upcoming occurrence of a series, its series' open task. */
  taskId: string;
  /** Which task and date it is, for remembering what was declined for it. */
  key: string;
  title: string;
  date: DateKey;
  /** Instants. */
  start: string;
  end: string;
  doNotDisturb: boolean;
  /** Its meetings are declined (it is Busy): how, with what message, and since when. */
  decline: TaskDecline | null;
}

/**
 * The times between `from` and `to` of open tasks with Do not disturb, or set
 * Busy and declining meetings: a task Google has (`items`), at its kept time
 * on its date, and the upcoming occurrences of a series whose template has
 * them, as Google Calendar blocks each of a repeating task's times. A task
 * without a time has neither, as in Google Calendar.
 */
export const taskWindows = (items: readonly GoogleTaskItem[], kept: Readonly<Record<string, GoogleTaskKept>>, from: DateKey, to: DateKey, today: DateKey, zone: string): TaskWindow[] => {
  const out: TaskWindow[] = [];
  const seen = new Set<string>();
  const window = (base: Omit<TaskWindow, 'start' | 'end'>, time: number, duration: number | null): TaskWindow => ({
    ...base,
    start: instantAt(base.date, time, zone),
    end: instantAt(base.date, Math.min(24 * 60, time + (duration ?? TASK_MINUTES)), zone),
  });
  for (const item of items) {
    const found = kept[googleTaskKey(item.account, item.id)];
    const own = googleTaskKey(item.account, item.id);
    if (!found || seen.has(own) || item.completed || !item.due || item.due < from || item.due > to || found.time === null) continue;
    const decline = found.busy && found.decline ? found.decline : null;
    if (!found.doNotDisturb && !decline) continue;
    seen.add(own);
    out.push(window({ account: item.account, listId: item.listId, taskId: item.id, key: `task:${item.id}:${item.due}`, title: item.title, date: item.due, doNotDisturb: Boolean(found.doNotDisturb), decline }, found.time, found.duration));
  }
  for (const upcoming of upcomingTasks(kept, items, from, to, today)) {
    const template = upcoming.template;
    const values = upcomingValues(upcoming);
    const declines = Boolean(template.busy && template.decline);
    if (values.time === null || (!template.doNotDisturb && !declines)) continue;
    const head = kept[googleTaskKey(upcoming.account, upcoming.taskId)];
    const decline = declines ? { mode: template.decline!.mode, message: template.decline!.message, since: template.decline!.since ?? head?.decline?.since ?? head?.updatedAt ?? new Date(0).toISOString() } : null;
    out.push(window({ account: upcoming.account, listId: upcoming.listId, taskId: upcoming.taskId, key: `upcoming:${upcoming.seriesId}:${upcoming.on}`, title: values.title, date: values.due, doNotDisturb: Boolean(template.doNotDisturb), decline }, values.time, values.duration));
  }
  return out.sort((a, b) => a.start.localeCompare(b.start) || a.key.localeCompare(b.key));
};

/**
 * Task notifications with Do not disturb kept: one that comes while a task
 * with Do not disturb is on comes when it ends (and when the next one it then
 * falls in ends), so nothing interrupts it and none is lost. A task's own
 * notification, at its start, comes as ever: it is the one that says to begin.
 */
export const quietNotifications = (all: readonly TaskNotification[], windows: readonly TaskWindow[]): TaskNotification[] => {
  const quiet = windows.filter((window) => window.doNotDisturb).map((window) => ({ window, start: Date.parse(window.start), end: Date.parse(window.end) }));
  if (!quiet.length) return [...all];
  return all
    .map((item) => {
      const others = quiet.filter(({ window }) => !(window.account === item.account && window.taskId === item.taskId && window.date === item.date));
      let at = Date.parse(item.at);
      const was = at;
      for (let moved = true, rounds = 0; moved && rounds < 50; rounds++) {
        moved = false;
        for (const { start, end } of others) {
          if (at >= start && at < end) {
            at = end;
            moved = true;
          }
        }
      }
      return at === was ? item : { ...item, at: new Date(at).toISOString(), held: true as const };
    })
    .sort((a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key));
};

/** A meeting on the account's own calendar, as the Planner reads one to decline it. */
export interface Invitation {
  /** This event's (or occurrence's) id. */
  id: string;
  summary: string;
  /** Instants; all-day events are never declined. */
  start: string;
  end: string;
  /** When it was made: "only new invitations" declines the ones made once declining was on. */
  created: string;
  /** My answer as a guest; null when I am not one. */
  response: GoogleResponse | null;
  /** I organize it: never declined. */
  mine: boolean;
  /** Only Google's ordinary events are meetings: not focus time, out of office or working location. */
  meeting: boolean;
}

/**
 * The invitations a task's time declines, as Google Calendar declines them for
 * a Busy task with "Automatically decline meetings": meetings someone else
 * organizes that overlap it and that I have not declined yet; "Only new
 * meeting invitations" leaves the ones made before it was turned on. One the
 * Planner declined before (`declined`) and that was answered again since is
 * left as answered: the user took it back.
 */
export const invitationsToDecline = (window: TaskWindow, events: readonly Invitation[], declined: ReadonlySet<string> = new Set()): Invitation[] => {
  const decline = window.decline;
  if (!decline) return [];
  const [start, end] = [Date.parse(window.start), Date.parse(window.end)];
  const since = Date.parse(decline.since);
  return events.filter((event) => {
    if (event.mine || !event.meeting || event.response === null || event.response === 'declined' || declined.has(event.id)) return false;
    if (!(Date.parse(event.start) < end && Date.parse(event.end) > start)) return false;
    return decline.mode === 'all' || Date.parse(event.created) > since;
  });
};

/** A meeting the Planner declined for a task. */
export interface DeclinedMeeting {
  account: string;
  /** The Google task (a series' open task, for one of its upcoming occurrences). */
  taskId: string;
  task: string;
  eventId: string;
  summary: string;
  /** When the meeting starts. */
  start: string;
  /** When it was declined. */
  at: string;
}

/** What a calendar's day shows of a task with Do not disturb or declining meetings, in its details: "Do not disturb · Declines meetings". */
export const quietLabel = (kept: Pick<GoogleTaskKept, 'time' | 'doNotDisturb' | 'decline' | 'busy'> | null | undefined): string | null => {
  if (!kept || kept.time === null) return null;
  const parts = [kept.doNotDisturb ? 'Do not disturb' : '', kept.busy && kept.decline ? 'Declines meetings' : ''].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
};
