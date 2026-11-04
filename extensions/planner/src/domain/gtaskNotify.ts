// Google Calendar's task notifications, which the Planner gives itself: Google
// learns no time or deadline the Planner keeps, so its own apps cannot. As in
// Google Calendar: a task with a date and time at that time, one with a date
// alone at 9 AM, and on a deadline's day at 9 AM, to complete the task (a task
// due all day on its deadline's day gets that one alone). Open tasks only, and
// the upcoming occurrences of a repeating series as Google would have them by
// then. As Google sends none for a time gone by, there is none when the task
// got its time, date or deadline after it (that last change is when it was
// set). Each has a key, so it comes once.
import type { DateKey, GoogleTaskKept } from './types.ts';
import { instantAt } from './dates.ts';
import type { GoogleTaskItem } from './google.ts';
import { keptFor, keptTimeLabel, upcomingTasks, upcomingValues } from './gtaskKept.ts';

/** When a task without a time, and a deadline, notify: 9 AM local time, as Google Calendar does. */
export const TASK_NOTIFY_MINUTES = 9 * 60;

export type TaskNotificationKind = 'time' | 'day' | 'deadline';

export interface TaskNotification {
  /** Which notification it is (kind, task or occurrence, date and time), so it comes once. */
  key: string;
  kind: TaskNotificationKind;
  title: string;
  account: string;
  listId: string;
  /** The Google task; for an upcoming occurrence, its series' open task. */
  taskId: string;
  /** The instant it comes. */
  at: string;
  date: DateKey;
  /** The task's time and length ('time'), for its message. */
  time: number | null;
  duration: number | null;
  /** It came later than its time: a task with Do not disturb was on then (`quietNotifications`). */
  held?: true;
}

/**
 * The notifications of `today`'s tasks: `dueToday`, the tasks Google has on
 * today (completed ones too: their date is taken), and `deadlineTasks`, those
 * read for a deadline kept on today, with what is kept for them. One whose
 * time had passed when it was set is left out: a time and a deadline are set
 * with what the Planner keeps (its `updatedAt`), a date in Google (the task's
 * `updated` there), an upcoming occurrence's with its series.
 */
export const taskNotifications = (dueToday: readonly GoogleTaskItem[], deadlineTasks: readonly GoogleTaskItem[], kept: Readonly<Record<string, GoogleTaskKept>>, today: DateKey, zone: string): TaskNotification[] => {
  const out: TaskNotification[] = [];
  const state = { googleTasks: kept as Record<string, GoogleTaskKept> };
  const nine = instantAt(today, TASK_NOTIFY_MINUTES, zone);
  const add = (notification: TaskNotification, setAt: string | undefined) => {
    if (!setAt || !(Date.parse(setAt) > Date.parse(notification.at))) out.push(notification);
  };
  const seen = new Set<string>();
  for (const item of [...dueToday, ...deadlineTasks]) {
    const own = `${item.account}\n${item.id}`;
    if (item.completed || seen.has(own)) continue;
    seen.add(own);
    const found = keptFor(state, item);
    const base = { title: item.title, account: item.account, listId: item.listId, taskId: item.id, date: today };
    const deadline = found?.deadline === today;
    if (item.due === today) {
      const time = found?.time ?? null;
      if (time !== null) add({ ...base, key: `time:${item.account}:${item.id}:${today}:${time}`, kind: 'time', at: instantAt(today, time, zone), time, duration: found?.duration ?? null }, found?.updatedAt);
      else if (!deadline) add({ ...base, key: `day:${item.account}:${item.id}:${today}`, kind: 'day', at: nine, time: null, duration: null }, item.updated);
    }
    if (deadline) add({ ...base, key: `deadline:${item.account}:${item.id}:${today}`, kind: 'deadline', at: nine, time: null, duration: null }, found?.updatedAt);
  }
  // A series' occurrence for today that Google does not have yet (the one before it is still open).
  for (const upcoming of upcomingTasks(kept, dueToday, today, today, today)) {
    const values = upcomingValues(upcoming);
    if (values.due !== today) continue;
    const base = { title: values.title, account: upcoming.account, listId: upcoming.listId, taskId: upcoming.taskId, date: today };
    const id = `upcoming:${upcoming.seriesId}:${upcoming.on}`;
    const setAt = keptFor(state, { account: upcoming.account, id: upcoming.taskId })?.updatedAt;
    const deadline = values.deadline === today;
    if (values.time !== null) add({ ...base, key: `time:${id}:${today}:${values.time}`, kind: 'time', at: instantAt(today, values.time, zone), time: values.time, duration: values.duration }, setAt);
    else if (!deadline) add({ ...base, key: `day:${id}:${today}`, kind: 'day', at: nine, time: null, duration: null }, setAt);
    if (deadline) add({ ...base, key: `deadline:${id}:${today}`, kind: 'deadline', at: nine, time: null, duration: null }, setAt);
  }
  return out.sort((a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key));
};

/** The ones come by `now` that have not come yet (`given`: the keys already given), in the order they came. */
export const dueNotifications = (all: readonly TaskNotification[], now: number, given: ReadonlySet<string>): TaskNotification[] => all.filter((item) => Date.parse(item.at) <= now && !given.has(item.key));

/** When the next one comes after `now`; null when none is left today. */
export const nextNotificationAt = (all: readonly TaskNotification[], now: number, given: ReadonlySet<string>): string | null =>
  all.find((item) => Date.parse(item.at) > now && !given.has(item.key))?.at ?? null;

const TITLE_SHOWN = 300;

/** "Task at 2 – 3pm: Send the report", "Task today: Send the report", "Deadline today: Send the report". */
export const notificationMessage = (item: Pick<TaskNotification, 'kind' | 'title' | 'time' | 'duration'>): string => {
  const title = item.title.length > TITLE_SHOWN ? `${item.title.slice(0, TITLE_SHOWN - 1)}…` : item.title;
  if (item.kind === 'deadline') return `Deadline today: ${title}`;
  if (item.kind === 'day' || item.time === null) return `Task today: ${title}`;
  return `Task at ${keptTimeLabel({ time: item.time, duration: item.duration })}: ${title}`;
};
