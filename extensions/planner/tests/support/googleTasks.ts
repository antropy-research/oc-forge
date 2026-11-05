// Google Tasks' scenarios, on top of the shared harness (planner.ts): Planner windows whose Google store starts as the
// panel starts it, what the fake Google has, what its calendar shows, and a task form's values as the editor sends them.
import type { CommitListener } from '../../panel/lib/core/client.ts';
import type { TaskFields } from '../../panel/lib/google/types.ts';
import { addDays, zonedDateMinutes } from '../../src/domain/core/dates.ts';
import type { GoogleTaskItem } from '../../src/domain/google/google.ts';
import { formValuesOf, withOccurrence, type FormValues } from '../../src/domain/google/taskForm.ts';
import { deadlineEvents, keptFor, upcomingEvent, upcomingTasks, upcomingValues, withTaskTimes, type UpcomingTask } from '../../src/domain/google/taskKept.ts';
import type { DateKey, GoogleTaskKept, PlannerState } from '../../src/domain/core/types.ts';
import { until, type Planner, type PlannerWindow, type WindowOptions } from './planner.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A zone where it is between 10 AM and 7 PM now: today's 9 AM has passed and today lasts the run. */
export const daytimeZone = (now = Date.now()): string =>
  ['America/Los_Angeles', 'America/New_York', 'UTC', 'Europe/Berlin', 'Asia/Kolkata', 'Asia/Tokyo', 'Pacific/Auckland', 'Pacific/Honolulu', 'America/Sao_Paulo', 'Asia/Dubai'].find((zone) => {
    const hour = zonedDateMinutes(now, zone).minutes / 60;
    return hour >= 10 && hour < 19;
  }) ?? 'UTC';

export type TasksWindow = PlannerWindow & {
  /** What the window said in its message line (`client.notify`), in order. */
  notes: string[];
  /** The service routes it asked for, in order. */
  calls: { method: string; path: string; body: any }[];
  today: DateKey;
  /** The window looks again, as its poll does every 5 s. */
  look(): Promise<void>;
};

/**
 * A Planner window whose Google store has started as `GoogleStore.start()` starts it, without its five-minute timer:
 * it hears this window's own changes (completing a linked task completes it in Google) and has read the accounts.
 */
export const openWindow = async (planner: Planner, options: WindowOptions = {}): Promise<TasksWindow> => {
  const window = (await planner.window(options)) as TasksWindow;
  const notes: string[] = [];
  let last: string | null = null;
  window.client.subscribe(() => {
    const error = window.client.getView().error;
    if (error && error !== last) notes.push(error);
    last = error;
  });
  const calls: TasksWindow['calls'] = [];
  const host = window.host as unknown as { serviceRequest: (request: { method: string; path: string; body?: string }) => Promise<{ status: number; body: string }> };
  const relay = host.serviceRequest;
  host.serviceRequest = (request) => {
    calls.push({ method: request.method, path: request.path, body: request.body === undefined ? undefined : JSON.parse(request.body) });
    return relay(request);
  };
  window.client.onCommitted((commands, before, after, origin) => (window.google as unknown as { afterCommit: CommitListener }).afterCommit(commands, before, after, origin));
  await window.google.checkStatus();
  return Object.assign(window, { notes, calls, today: window.client.getView().today, look: async () => void (await window.client.refresh()) });
};

/** The window's requests to these service routes fail (503) before they reach it, until the function returned is called. */
export const failing = (window: PlannerWindow, ...routes: string[]): (() => void) => {
  const host = window.host as unknown as { serviceRequest: (request: { method: string; path: string; body?: string }) => Promise<{ status: number; body: string }> };
  const relay = host.serviceRequest;
  host.serviceRequest = (request) => (routes.includes(request.path.split('?')[0]!) ? Promise.resolve({ status: 503, body: JSON.stringify({ error: 'Planner service answered 503' }) }) : relay(request));
  return () => void (host.serviceRequest = relay);
};

/** Until the fake Google has had no request for `quiet` ms and has answered every one: what a change started in the background has finished. */
export const idle = async (planner: Planner, quiet = 60, timeout = 8000): Promise<void> => {
  const requests = planner.google!.requests as Array<{ answeredAt?: number }>;
  const end = Date.now() + timeout;
  let seen = -1;
  let since = Date.now();
  while (Date.now() < end) {
    if (requests.length !== seen || requests.some((request) => !request.answeredAt)) {
      seen = requests.length;
      since = Date.now();
    } else if (Date.now() - since >= quiet) return;
    await sleep(15);
  }
};

/** A Google task as the fake Google has it now, wherever it is; null when Google has it no more. */
export const inGoogle = (planner: Planner, id: string): (Record<string, any> & { listId: string }) | null => {
  for (const [listId, tasks] of planner.google!.tasks) {
    const task = tasks.find((one: { id: string }) => one.id === id);
    if (task) return { ...task, listId };
  }
  return null;
};

/** The fake Google's open tasks with this title, in every list. */
export const openTitled = (planner: Planner, title: string): Array<Record<string, any> & { listId: string }> =>
  [...planner.google!.tasks].flatMap(([listId, tasks]) => tasks.filter((task: { title: string; status: string }) => task.title === title && task.status !== 'completed').map((task: object) => ({ ...task, listId }) as Record<string, any> & { listId: string }));

/** Its date, as Google Tasks keeps one (midnight UTC). */
export const dueOf = (task: Record<string, any> | null | undefined): DateKey | null => (typeof task?.due === 'string' ? task.due.slice(0, 10) : null);

/** Requests that changed Google Tasks (made, changed, moved or deleted a task), since `from` (an index into the requests). */
export const taskWrites = (planner: Planner, from = 0) => planner.google!.requests.slice(from).filter((request) => request.method !== 'GET' && request.path.startsWith('/tasks/v1/lists/'));

/** What the Planner keeps for a Google task, in a plan (the service's, or a window's view). */
export const keptOf = (state: Pick<PlannerState, 'googleTasks'>, account: string, id: string): GoogleTaskKept | null => keptFor(state, { account, id });

/** A series' open tasks, as kept: where it goes on from. */
export const heads = (state: Pick<PlannerState, 'googleTasks'>, seriesId: string): string[] =>
  Object.values(state.googleTasks ?? {}).filter((kept) => kept.repeat?.seriesId === seriesId && !kept.repeat.next).map((kept) => kept.taskId);

/** Google Tasks moved in Google's own apps: the task and its subtasks to another list, under a new id when given. */
export const moveInGoogle = (planner: Planner, id: string, listId: string, newId?: string): void => {
  const lists = planner.google!.tasks;
  for (const [from, tasks] of lists) {
    const moving = tasks.filter((task: { id: string; parent?: string }) => task.id === id || task.parent === id);
    if (!moving.length) continue;
    lists.set(from, tasks.filter((task: object) => !moving.includes(task)));
    lists.get(listId)!.push(...moving.map((task: { id: string; parent?: string }) => ({ ...task, ...(newId && task.id === id ? { id: newId } : {}), ...(newId && task.parent === id ? { parent: newId } : {}), updated: new Date().toISOString() })));
    return;
  }
  throw new Error(`the fake Google has no ${id}`);
};

/** A task changed in Google's own apps (`null` takes a field away), or added there (`listId`). */
export const changeInGoogle = (planner: Planner, id: string, patch: Record<string, unknown>): void => {
  for (const tasks of planner.google!.tasks.values()) {
    const task = tasks.find((one: { id: string }) => one.id === id);
    if (!task) continue;
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete task[key];
      else task[key] = value;
    }
    if (!('updated' in patch)) task.updated = new Date().toISOString();
    return;
  }
  throw new Error(`the fake Google has no ${id}`);
};
export const addInGoogle = (planner: Planner, listId: string, task: Record<string, unknown>): void =>
  void planner.google!.tasks.get(listId)!.push({ notes: '', status: 'needsAction', updated: new Date().toISOString(), ...task });
export const deleteInGoogle = (planner: Planner, id: string): void => {
  for (const [listId, tasks] of planner.google!.tasks) planner.google!.tasks.set(listId, tasks.filter((task: { id: string; parent?: string }) => task.id !== id && task.parent !== id));
};

/** One thing the calendar draws for Google Tasks: a task on its day (at its kept time, or all day), its deadline, or a series' upcoming task. */
export type CalendarTask = { kind: 'task' | 'deadline' | 'upcoming'; title: string; date: DateKey; time: number | null; completed: boolean; item?: GoogleTaskItem; upcoming?: UpcomingTask };

/**
 * The window's calendar between two days, as `useCalendarEvents(from, to, { tasks: true })` (panel/lib/calendar/events.ts)
 * composes it for the calendar views: the service's feed, the times the Planner keeps, deadlines on their day and the
 * series' upcoming tasks from the window's plan. (The hook itself needs Preact to render; this is its composition.)
 */
export const calendarOf = async (window: PlannerWindow, from: DateKey, to: DateKey, refresh = true): Promise<CalendarTask[]> => {
  const { state, today } = window.client.getView();
  const zone = state.settings.timezone ?? 'UTC';
  const feed = await window.client.calendarEvents(from, to, refresh);
  const kept = state.googleTasks ?? {};
  const timed = withTaskTimes(feed.events, kept, zone).filter((event) => event.googleTask);
  const shown = timed.map((event) => event.googleTask!);
  const beside = [...deadlineEvents([...shown, ...(feed.deadlineTasks ?? [])], kept, from, to, zone), ...upcomingTasks(kept, shown, from, to, today).map((task) => upcomingEvent(task, zone))];
  return [...timed, ...beside].map((event) => {
    const at = zonedDateMinutes(event.start, zone);
    const kind = event.upcoming ? 'upcoming' : event.taskDeadline ? 'deadline' : 'task';
    return { kind, title: event.title, date: event.upcoming ? upcomingValues(event.upcoming).due : at.date, time: event.allDay ? null : Math.round(at.minutes), completed: Boolean(event.googleTask?.completed), item: event.googleTask, upcoming: event.upcoming };
  }) as CalendarTask[];
};

/** "title date time" for each of these (of the kinds, with a title `only` matches), in date and time order: what a day or a week shows. */
export const lines = (items: readonly CalendarTask[], kinds: CalendarTask['kind'][] = ['task', 'upcoming', 'deadline'], only?: RegExp): string[] =>
  items
    .filter((item) => kinds.includes(item.kind) && (!only || only.test(item.title) || only.test(item.upcoming?.template.title ?? '')))
    .sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? -1) - (b.time ?? -1) || a.title.localeCompare(b.title))
    .map((item) => `${item.kind === 'deadline' ? 'deadline: ' : item.kind === 'upcoming' ? 'upcoming: ' : ''}${item.title} ${item.date}${item.time === null ? '' : ` ${item.time}`}${item.completed ? ' (done)' : ''}`);

/** The upcoming task of a series the window's calendar shows on `date` (what Edit or Delete on it act on). */
export const upcomingOn = async (window: PlannerWindow, date: DateKey, title?: string): Promise<UpcomingTask> => {
  const found = (await calendarOf(window, date, date, false)).find((item) => item.kind === 'upcoming' && item.date === date && (!title || item.upcoming!.template.title === title));
  if (!found?.upcoming) throw new Error(`no upcoming task on ${date}${title ? ` for ${title}` : ''}`);
  return found.upcoming;
};

/** What a task's form sends with `values`, from what it showed (`base`). */
export const sent = (values: FormValues, base?: FormValues): TaskFields => ({
  title: values.title,
  notes: values.notes,
  due: values.due,
  kept: { time: values.time, duration: values.duration, deadline: values.deadline, rule: values.rule, busy: values.busy, visibility: values.visibility, color: values.color, attachments: values.attachments, doNotDisturb: values.doNotDisturb, decline: values.decline },
  ...(base ? { base } : {}),
});

/** What a task's form shows, as the window has the task and the plan. */
export const shownIn = (window: PlannerWindow, item: GoogleTaskItem): FormValues => formValuesOf(item, keptFor(window.client.getView().state, item));

/** What one upcoming task's editor shows: the occurrence as the window has it, no repeat of its own. */
export const occurrenceShown = (window: PlannerWindow, upcoming: UpcomingTask, head: GoogleTaskItem): FormValues => ({
  ...withOccurrence(formValuesOf(head, keptFor(window.client.getView().state, head)), upcomingValues(upcoming)),
  rule: null,
  duration: null,
});

/** A simple form: these title, date and time, the rest as given. */
export const fields = (title: string, due: DateKey | null, time: number | null, extra: Partial<TaskFields['kept']> & { notes?: string } = {}): TaskFields => {
  const { notes = 'Series notes', ...kept } = extra;
  return { title, notes, due, kept: { time, duration: null, deadline: null, rule: null, ...kept } };
};

export { addDays, until };
