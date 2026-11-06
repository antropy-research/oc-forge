// The chat's own agent works on the plan with the Planner's command line (service/assistant/cli.ts), for Ask Planner,
// Braindump and the Daily highlights summary. Here is what it may do, checked against the plan before anything is
// written (known tasks, channels and folders only, never a delete), the commands each operation becomes, a sentence for
// each change, and the plan as the agent reads it: ids in brackets, times as 24-hour clocks, days as dates.
import { BACKLOG_BUCKETS, type BacklogBucket, type DateKey, type Placement, type PlannerState, type Priority, type Task } from '../core/types.ts';
import type { EventBody } from '../core/events.ts';
import { addDays, formatMinutes, instantAt, isDateKey, longDay, weekdayName, zonedDateMinutes } from '../core/dates.ts';
import { actualMinutes, backlogTasks, blocksFor, blocksOnDay, channelByName, liveChannels, plannedTotal, tasksForDay } from '../core/selectors.ts';
import { applyEvents } from '../core/reducer.ts';
import { asEvents } from '../plan/undo.ts';
import { createManyTaskCommands, moveTo } from '../plan/commands.ts';
import { completedOnDay, highlightItems, ritualRecord } from '../plan/rituals.ts';

/** today, tomorrow, a YYYY-MM-DD date, or a backlog bucket id. */
export type When = string;

export type AssistantOp =
  | { op: 'add'; title: string; when: When; minutes: number | null; channel: string | null; priority: Priority | null; notes: string | null; due: DateKey | null; folder: string | null }
  | { op: 'move'; taskId: string; when: When }
  | { op: 'done'; taskId: string }
  | { op: 'reopen'; taskId: string }
  | { op: 'archive'; taskId: string }
  | { op: 'estimate'; taskId: string; minutes: number | null }
  | { op: 'channel'; taskId: string; channel: string | null }
  | { op: 'rename'; taskId: string; title: string }
  | { op: 'notes'; taskId: string; notes: string; append: boolean }
  | { op: 'due'; taskId: string; due: DateKey | null }
  | { op: 'priority'; taskId: string; priority: Priority | null }
  | { op: 'subtask'; taskId: string; title: string; minutes: number | null }
  | { op: 'schedule'; taskId: string; date: DateKey; start: number; minutes: number }
  /** The Daily highlights summary of a day. */
  | { op: 'summary'; date: DateKey; text: string };

/** The operations a request may carry, in one batch (one change, one Undo). */
export const MAX_OPS = 40;
const TITLE_MAX = 500;
const NOTES_MAX = 20_000;
const SUMMARY_MAX = 4_000;
const PRIORITIES: readonly Priority[] = ['urgent', 'high', 'medium', 'low'];
const BUCKETS = new Set<string>(BACKLOG_BUCKETS.map((bucket) => bucket.id));

export const whenToPlacement = (when: When, today: DateKey): Placement | null => {
  if (when === 'today') return { kind: 'day', date: today };
  if (when === 'tomorrow') return { kind: 'day', date: addDays(today, 1) };
  if (isDateKey(when)) return { kind: 'day', date: when };
  return BUCKETS.has(when) ? { kind: 'backlog', bucket: when as BacklogBucket } : null;
};

const dayOf = (value: string, today: DateKey): DateKey | null =>
  value === 'today' ? today : value === 'tomorrow' ? addDays(today, 1) : value === 'yesterday' ? addDays(today, -1) : isDateKey(value) ? value : null;

/** `HH:MM` (24-hour) as minutes after midnight. */
export const clockMinutes = (value: string): number | null => {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};

/** Minutes after midnight as `HH:MM`, the form the agent reads and writes; an instant's seconds are dropped. */
export const clock = (minutes: number): string => {
  const whole = Math.floor(minutes);
  return `${String(Math.floor(whole / 60) % 24).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
};

const live = (state: PlannerState, id: unknown): Task | null => {
  const task = typeof id === 'string' ? state.tasks[id] : undefined;
  return task && !task.deletedAt ? task : null;
};

const text = (value: unknown, max: number): string | null => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);
const minutesOf = (value: unknown): number | null | undefined => {
  if (value === null) return null;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 24 * 60 ? value : undefined;
};
const channelOf = (state: PlannerState, value: unknown): string | null | undefined => {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  return channelByName(state, value.trim().replace(/^#/, ''))?.name;
};
const priorityOf = (value: unknown): Priority | null | undefined => (value === null ? null : PRIORITIES.includes(value as Priority) ? (value as Priority) : undefined);

const channelNames = (state: PlannerState): string => liveChannels(state).map((channel) => `#${channel.name}`).join(', ') || 'none';

const liveFolders = (state: PlannerState) => Object.values(state.folders).filter((folder) => !folder.deletedAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
const folderByName = (state: PlannerState, name: string) => {
  const lower = name.trim().toLowerCase();
  return liveFolders(state).find((folder) => folder.name.toLowerCase() === lower) ?? null;
};
const folderNames = (state: PlannerState): string => liveFolders(state).map((folder) => `"${folder.name}"`).join(', ') || 'none';

/**
 * One operation as sent, checked against the plan as it is: the operation, or why it cannot be done (the agent reads
 * this and can try again). Never a delete: a task the person no longer wants is archived.
 */
const readOp = (raw: unknown, state: PlannerState, today: DateKey): AssistantOp | string => {
  if (typeof raw !== 'object' || raw === null) return 'an operation must be an object';
  const op = raw as Record<string, unknown>;
  const kind = op.op;
  if (kind === 'add') {
    const title = text(op.title, TITLE_MAX);
    if (!title) return 'add needs a title';
    const when = op.when === undefined || op.when === null ? 'today' : op.when;
    if (typeof when !== 'string' || !whenToPlacement(when, today)) return `unknown day "${String(when)}": use today, tomorrow, a date YYYY-MM-DD or a backlog bucket (${[...BUCKETS].join(', ')})`;
    const minutes = minutesOf(op.minutes ?? null);
    if (minutes === undefined) return 'minutes must be a whole number from 1 to 1440';
    const channel = channelOf(state, op.channel ?? null);
    if (channel === undefined) return `unknown channel "${String(op.channel)}"; the channels are ${channelNames(state)}`;
    const priority = priorityOf(op.priority ?? null);
    if (priority === undefined) return `priority must be one of ${PRIORITIES.join(', ')}`;
    const due = op.due === undefined || op.due === null ? null : typeof op.due === 'string' ? dayOf(op.due, today) : null;
    if (op.due !== undefined && op.due !== null && !due) return 'due must be today, tomorrow or a date YYYY-MM-DD';
    const folder = op.folder === undefined || op.folder === null ? null : typeof op.folder === 'string' ? folderByName(state, op.folder)?.name : undefined;
    if (folder === undefined) return `unknown backlog folder "${String(op.folder)}"; the folders are ${folderNames(state)}`;
    return { op: 'add', title, when, minutes, channel, priority, notes: text(op.notes, NOTES_MAX), due, folder };
  }
  if (kind === 'summary') {
    const date = typeof op.date === 'string' ? dayOf(op.date, today) : null;
    if (!date) return 'summary needs a day: today, yesterday or a date YYYY-MM-DD';
    const summary = text(op.text, SUMMARY_MAX);
    return summary ? { op: 'summary', date, text: summary } : 'summary needs its text';
  }
  if (!['move', 'done', 'reopen', 'archive', 'estimate', 'channel', 'rename', 'notes', 'due', 'priority', 'subtask', 'schedule'].includes(String(kind))) {
    return kind === 'delete' ? 'tasks are never deleted here: archive one instead' : `unknown operation "${String(kind)}"`;
  }
  const task = live(state, op.taskId);
  if (!task) return `no task [${String(op.taskId)}] in the plan (find it with: planner find <words>)`;
  const taskId = task.id;
  switch (kind) {
    case 'move': {
      if (typeof op.when !== 'string' || !whenToPlacement(op.when, today)) return `unknown day "${String(op.when)}": use today, tomorrow, a date YYYY-MM-DD or a backlog bucket (${[...BUCKETS].join(', ')})`;
      return { op: 'move', taskId, when: op.when };
    }
    case 'done':
      return task.completedAt ? `[${taskId}] "${task.title}" is done already` : { op: 'done', taskId };
    case 'reopen':
      return task.completedAt ? { op: 'reopen', taskId } : `[${taskId}] "${task.title}" is not done`;
    case 'archive':
      return task.archivedAt ? `[${taskId}] "${task.title}" is archived already` : { op: 'archive', taskId };
    case 'estimate': {
      const minutes = minutesOf(op.minutes);
      return minutes === undefined ? 'minutes must be a whole number from 1 to 1440, or null to clear it' : { op: 'estimate', taskId, minutes };
    }
    case 'channel': {
      const channel = channelOf(state, op.channel);
      return channel === undefined ? `unknown channel "${String(op.channel)}"; the channels are ${channelNames(state)}` : { op: 'channel', taskId, channel };
    }
    case 'rename': {
      const title = text(op.title, TITLE_MAX);
      return title ? { op: 'rename', taskId, title } : 'rename needs a title';
    }
    case 'notes': {
      if (typeof op.notes !== 'string') return 'notes must be text';
      return { op: 'notes', taskId, notes: op.notes.slice(0, NOTES_MAX), append: op.append === true };
    }
    case 'due': {
      if (op.due === null) return { op: 'due', taskId, due: null };
      const due = typeof op.due === 'string' ? dayOf(op.due, today) : null;
      return due ? { op: 'due', taskId, due } : 'due must be today, tomorrow, a date YYYY-MM-DD, or null to clear it';
    }
    case 'priority': {
      const priority = priorityOf(op.priority);
      return priority === undefined ? `priority must be one of ${PRIORITIES.join(', ')}, or null to clear it` : { op: 'priority', taskId, priority };
    }
    case 'subtask': {
      const title = text(op.title, TITLE_MAX);
      if (!title) return 'subtask needs a title';
      const minutes = minutesOf(op.minutes ?? null);
      return minutes === undefined ? 'minutes must be a whole number from 1 to 1440' : { op: 'subtask', taskId, title, minutes };
    }
    case 'schedule': {
      // No day: the day the task is planned for, else today.
      const date = op.date === undefined || op.date === null ? (task.placement.kind === 'day' ? task.placement.date : today) : typeof op.date === 'string' ? dayOf(op.date, today) : null;
      if (!date) return 'schedule needs a day: today, tomorrow or a date YYYY-MM-DD';
      const start = typeof op.start === 'string' ? clockMinutes(op.start) : null;
      if (start === null) return 'schedule needs a start time HH:MM (24-hour)';
      const minutes = op.minutes === undefined || op.minutes === null ? Math.max(15, task.plannedMinutes ?? 30) : minutesOf(op.minutes);
      if (minutes === undefined || minutes === null) return 'minutes must be a whole number from 1 to 1440';
      if (start + minutes > 24 * 60) return 'the session must end by midnight';
      return { op: 'schedule', taskId, date, start, minutes };
    }
  }
  return `unknown operation "${String(kind)}"`;
};

/**
 * The operations as sent, every one checked against the plan as the earlier ones leave it; one that cannot be done
 * refuses the whole batch with its index and why, so nothing is half done.
 */
export const readOps = (raw: unknown, state: PlannerState, today: DateKey, zone: string): { ok: true; ops: AssistantOp[] } | { ok: false; error: string; index: number } => {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'ops must be a list of operations', index: -1 };
  if (raw.length > MAX_OPS) return { ok: false, error: `at most ${MAX_OPS} operations at once`, index: MAX_OPS };
  const ops: AssistantOp[] = [];
  let working = state;
  for (let index = 0; index < raw.length; index++) {
    const op = readOp(raw[index], working, today);
    if (typeof op === 'string') return { ok: false, error: op, index };
    ops.push(op);
    working = applyEvents(working, asEvents(opCommands(working, op, today, zone)));
  }
  return { ok: true, ops };
};

/** The commands one operation becomes, against the plan as it is. */
export const opCommands = (state: PlannerState, op: AssistantOp, today: DateKey, zone: string, newId: () => string = randomId): EventBody[] => {
  if (op.op === 'add') {
    const folderId = op.folder ? folderByName(state, op.folder)?.id ?? null : null;
    const bodies = createManyTaskCommands(state, [{ title: op.title, plannedMinutes: op.minutes, placement: whenToPlacement(op.when, today), channel: op.channel, priority: op.priority, objective: null }], { kind: 'day', date: today }, { today, folderId });
    const made = bodies.find((body): body is Extract<EventBody, { type: 'task.created' }> => body.type === 'task.created');
    if (made && (op.notes || op.due)) bodies.push({ type: 'task.updated', taskId: made.task.id, patch: { ...(op.notes ? { notes: op.notes } : {}), ...(op.due ? { dueDate: op.due } : {}) } });
    return bodies;
  }
  if (op.op === 'summary') return [{ type: 'ritual.saved', ritual: 'highlights', date: op.date, fields: { summary: op.text } }];
  const task = state.tasks[op.taskId]!;
  switch (op.op) {
    case 'move': {
      const placement = whenToPlacement(op.when, today)!;
      return [moveTo(state, task.id, placement)];
    }
    case 'done':
      return [{ type: 'task.completed', taskId: task.id, on: today }];
    case 'reopen':
      return [{ type: 'task.reopened', taskId: task.id }];
    case 'archive':
      return [{ type: 'task.archived', taskId: task.id }];
    case 'estimate':
      return [{ type: 'task.updated', taskId: task.id, patch: { plannedMinutes: op.minutes } }];
    case 'channel':
      return [{ type: 'task.updated', taskId: task.id, patch: { channelId: op.channel ? channelByName(state, op.channel)!.id : null } }];
    case 'rename':
      return [{ type: 'task.updated', taskId: task.id, patch: { title: op.title } }];
    case 'notes':
      return [{ type: 'task.updated', taskId: task.id, patch: { notes: op.append && task.notes.trim() ? `${task.notes.trimEnd()}\n\n${op.notes}` : op.notes } }];
    case 'due':
      return [{ type: 'task.updated', taskId: task.id, patch: { dueDate: op.due } }];
    case 'priority':
      return [{ type: 'task.updated', taskId: task.id, patch: { priority: op.priority } }];
    case 'subtask': {
      const after = task.subtasks.at(-1)?.id ?? null;
      return [{ type: 'subtask.added', taskId: task.id, subtask: { id: newId(), title: op.title, done: false, ...(op.minutes ? { plannedMinutes: op.minutes } : {}) }, after }];
    }
    case 'schedule': {
      // A session on a day the task is not planned for plans it there too, as one means by "Thursday at 3".
      const moved = task.placement.kind === 'day' && task.placement.date === op.date ? [] : [moveTo(state, task.id, { kind: 'day', date: op.date })];
      return [...moved, { type: 'block.created', block: { id: newId(), taskId: task.id, start: instantAt(op.date, op.start, zone), end: instantAt(op.date, op.start + op.minutes, zone) } }];
    }
  }
};

const randomId = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/** The commands of a whole batch, each operation against the plan as the ones before it leave it. */
export const opsCommands = (state: PlannerState, ops: readonly AssistantOp[], today: DateKey, zone: string, newId?: () => string): EventBody[] => {
  const bodies: EventBody[] = [];
  let working = state;
  for (const op of ops) {
    const next = opCommands(working, op, today, zone, newId);
    bodies.push(...next);
    working = applyEvents(working, asEvents(next));
  }
  return bodies;
};

const whenLabel = (when: When, today: DateKey): string => {
  const placement = whenToPlacement(when, today);
  if (!placement) return when;
  if (placement.kind === 'backlog') return `the backlog (${BACKLOG_BUCKETS.find((bucket) => bucket.id === placement.bucket)!.label.toLowerCase()})`;
  return dayLabel(placement.date, today);
};

const dayLabel = (date: DateKey, today: DateKey): string => (date === today ? 'today' : date === addDays(today, 1) ? 'tomorrow' : `${weekdayName(date)} ${date}`);

/** A sentence for a change, in the past tense, as the chat and the Planner list it. */
export const describeOp = (state: PlannerState, op: AssistantOp, today: DateKey): string => {
  if (op.op === 'add') return `Added "${op.title}" for ${whenLabel(op.when, today)}${op.minutes ? ` (${formatMinutes(op.minutes)})` : ''}${op.channel ? ` in #${op.channel}` : ''}${op.folder ? ` in the folder "${op.folder}"` : ''}`;
  if (op.op === 'summary') return `Wrote the highlights summary of ${dayLabel(op.date, today)}`;
  const title = `"${state.tasks[op.taskId]?.title ?? op.taskId}"`;
  switch (op.op) {
    case 'move':
      return `Moved ${title} to ${whenLabel(op.when, today)}`;
    case 'done':
      return `Completed ${title}`;
    case 'reopen':
      return `Reopened ${title}`;
    case 'archive':
      return `Archived ${title}`;
    case 'estimate':
      return op.minutes ? `Planned ${formatMinutes(op.minutes)} for ${title}` : `Cleared the planned time of ${title}`;
    case 'channel':
      return op.channel ? `Put ${title} in #${op.channel}` : `Took ${title} out of its channel`;
    case 'rename':
      return `Renamed ${title} to "${op.title}"`;
    case 'notes':
      return op.append ? `Added to the notes of ${title}` : `Rewrote the notes of ${title}`;
    case 'due':
      return op.due ? `Set ${title} due ${dayLabel(op.due, today)}` : `Cleared the due date of ${title}`;
    case 'priority':
      return op.priority ? `Gave ${title} ${op.priority} priority` : `Cleared the priority of ${title}`;
    case 'subtask':
      return `Added the subtask "${op.title}" to ${title}`;
    case 'schedule':
      return `Scheduled ${title} ${dayLabel(op.date, today)} ${clock(op.start)}–${clock(op.start + op.minutes)}`;
  }
};

/** A whole batch in one sentence: its one change, or how many. */
export const describeOps = (state: PlannerState, ops: readonly AssistantOp[], today: DateKey): string =>
  ops.length === 1 ? describeOp(state, ops[0]!, today) : `${ops.length} changes: ${ops.map((op) => describeOp(state, op, today)).join('; ')}`;

/** A calendar event as the agent reads it: when, what, and whether it blocks time. */
export interface AgentEvent {
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  busy: boolean;
}

const taskLine = (state: PlannerState, task: Task): string => {
  const channel = task.channelId ? state.channels[task.channelId]?.name : null;
  const folder = task.folderId ? state.folders[task.folderId] : null;
  const extras = [task.plannedMinutes ? formatMinutes(task.plannedMinutes) : null, channel ? `#${channel}` : null, folder && !folder.deletedAt ? `folder "${folder.name}"` : null, task.priority, task.dueDate ? `due ${task.dueDate}` : null, task.source ? `${task.source.kind} ${task.source.key}` : null, task.subtasks.length ? `${task.subtasks.filter((subtask) => subtask.done).length}/${task.subtasks.length} subtasks` : null].filter(Boolean);
  return `- [${task.id}] ${task.completedAt ? '(done) ' : ''}${task.title}${extras.length ? ` (${extras.join(', ')})` : ''}`;
};

const span = (start: string, end: string, zone: string): string => `${clock(zonedDateMinutes(start, zone).minutes)}–${clock(zonedDateMinutes(end, zone).minutes)}`;

/**
 * One day: its tasks in list order, the Planner's sessions on the calendar, and the calendars' events; today says what
 * time it is (`now`, HH:MM), for a request such as "what I can't finish today".
 */
export const dayText = (state: PlannerState, date: DateKey, today: DateKey, events: readonly AgentEvent[] | null, zone: string, now?: string): string => {
  const tasks = tasksForDay(state, date);
  const open = tasks.filter((task) => !task.completedAt);
  const when = date === today ? ` (today${now ? `, ${now} now` : ''})` : date === addDays(today, 1) ? ' (tomorrow)' : '';
  const lines = [`${longDay(date)}, ${date}${when}: ${tasks.length} task${tasks.length === 1 ? '' : 's'}, ${open.length} open, ${formatMinutes(plannedTotal(open))} planned for the open ones`];
  lines.push(...(tasks.length ? tasks.map((task) => taskLine(state, task)) : ['- (nothing planned)']));
  const blocks = blocksOnDay(state, date);
  if (blocks.length) lines.push('Sessions on the calendar:', ...blocks.map((block) => `- ${span(block.start, block.end, zone)} [${block.taskId}] ${state.tasks[block.taskId]?.title ?? ''}`));
  if (events === null) lines.push('Calendar events: not read (no calendar is connected, or it did not answer)');
  else if (events.length) lines.push('Calendar events:', ...events.map((event) => `- ${event.allDay ? 'all day' : span(event.start, event.end, zone)} ${event.title}${event.busy ? '' : ' (free)'}`));
  else lines.push('Calendar events: none');
  return lines.join('\n');
};

/** Today and the next six days, the days with nothing planned past tomorrow left out. */
export const weekText = (state: PlannerState, today: DateKey, eventsOf: (date: DateKey) => readonly AgentEvent[] | null, zone: string, now?: string): string => {
  const parts: string[] = [];
  for (let offset = 0; offset < 7; offset++) {
    const date = addDays(today, offset);
    if (offset > 1 && tasksForDay(state, date).length === 0 && !(eventsOf(date)?.length)) continue;
    parts.push(dayText(state, date, today, eventsOf(date), zone, now));
  }
  return parts.join('\n\n');
};

const BACKLOG_SHOWN = 100;

/** The backlog by bucket, each in list order. */
export const backlogText = (state: PlannerState): string => {
  const parts: string[] = [];
  for (const bucket of BACKLOG_BUCKETS) {
    const tasks = backlogTasks(state, bucket.id);
    if (!tasks.length) continue;
    parts.push(`Backlog, ${bucket.label.toLowerCase()} (${bucket.id}): ${tasks.length}`, ...tasks.slice(0, BACKLOG_SHOWN).map((task) => taskLine(state, task)));
    if (tasks.length > BACKLOG_SHOWN) parts.push(`- … and ${tasks.length - BACKLOG_SHOWN} more (planner find <words>)`);
  }
  return parts.length ? parts.join('\n') : 'The backlog is empty.';
};

const FIND_SHOWN = 50;

/** Open tasks, and ones completed in the last 30 days, whose title or notes hold every word. */
export const findText = (state: PlannerState, query: string, today: DateKey): string => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return 'find needs words to look for';
  const since = addDays(today, -30);
  const found = Object.values(state.tasks)
    .filter((task) => !task.deletedAt && !task.archivedAt && (!task.completedOn || task.completedOn >= since))
    .filter((task) => words.every((word) => `${task.title}\n${task.notes}`.toLowerCase().includes(word)))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (!found.length) return `No open task, nor one done in the last 30 days, holds "${query.trim()}".`;
  const where = (task: Task): string => (task.placement.kind === 'day' ? dayLabel(task.placement.date, today) : `backlog ${task.placement.bucket}`);
  return [`${found.length} task${found.length === 1 ? '' : 's'}:`, ...found.slice(0, FIND_SHOWN).map((task) => `${taskLine(state, task)} · ${where(task)}`), ...(found.length > FIND_SHOWN ? [`- … and ${found.length - FIND_SHOWN} more: say more words`] : [])].join('\n');
};

/** One task in full. */
export const taskText = (state: PlannerState, taskId: string, today: DateKey, zone: string): string => {
  const task = live(state, taskId);
  if (!task) return `No task [${taskId}] in the plan.`;
  const channel = task.channelId ? state.channels[task.channelId]?.name : null;
  const where = task.placement.kind === 'day' ? `${dayLabel(task.placement.date, today)} (${task.placement.date})` : `backlog ${task.placement.bucket}`;
  const lines = [
    `[${task.id}] ${task.title}`,
    `Status: ${task.archivedAt ? 'archived' : task.completedAt ? `done ${task.completedOn ?? ''}`.trim() : 'open'}`,
    `Planned for: ${where}`,
    `Planned time: ${task.plannedMinutes ? formatMinutes(task.plannedMinutes) : 'none'}; spent: ${formatMinutes(actualMinutes(state, task))}`,
    `Channel: ${channel ? `#${channel}` : 'none'}; priority: ${task.priority ?? 'none'}; due: ${task.dueDate ?? 'none'}`,
  ];
  if (task.source) lines.push(`From: ${task.source.kind} ${task.source.key} ${task.source.url}${task.source.status ? ` (${task.source.status.name})` : ''}`);
  if (task.sessionRef) lines.push(`Chat: ${task.sessionRef.title}`);
  const blocks = blocksFor(state, task.id);
  if (blocks.length) lines.push('Sessions:', ...blocks.map((block) => `- ${zonedDateMinutes(block.start, zone).date} ${span(block.start, block.end, zone)}`));
  if (task.subtasks.length) lines.push('Subtasks:', ...task.subtasks.map((subtask) => `- [${subtask.done ? 'x' : ' '}] ${subtask.title}${subtask.plannedMinutes ? ` (${formatMinutes(subtask.plannedMinutes)})` : ''}`));
  lines.push(task.notes.trim() ? `Notes:\n${task.notes.trim()}` : 'Notes: none');
  return lines.join('\n');
};

/** The channels, with the context each belongs to, and the backlog's folders. */
export const channelsText = (state: PlannerState): string => {
  const channels = liveChannels(state);
  const folders = liveFolders(state);
  return [
    channels.length ? `Channels:\n${channels.map((channel) => `#${channel.name} (${channel.context})`).join('\n')}` : 'No channels.',
    folders.length ? `Backlog folders:\n${folders.map((folder) => `"${folder.name}"`).join('\n')}` : 'No backlog folders.',
  ].join('\n\n');
};

/** A day's Daily highlights: what got done (starred first), the time tracked, the reflection and the summary. */
export const highlightsText = (state: PlannerState, date: DateKey, today: DateKey): string => {
  const items = highlightItems(state, date).filter((item) => !item.hidden);
  const ordered = [...items.filter((item) => item.starred), ...items.filter((item) => !item.starred)];
  const tracked = completedOnDay(state, date).reduce((sum, task) => sum + actualMinutes(state, task), 0);
  const record = ritualRecord(state, 'highlights', date);
  return [
    `Daily highlights, ${longDay(date)}, ${date}${date === today ? ' (today)' : date === addDays(today, -1) ? ' (yesterday)' : ''}: ${ordered.length} item${ordered.length === 1 ? '' : 's'}, ${formatMinutes(tracked)} tracked`,
    ...(ordered.length ? ordered.map((item) => `- ${item.starred ? '(starred) ' : ''}${item.text}${item.url ? ` (${item.url})` : ''}`) : ['- (nothing done yet)']),
    `Reflection: ${record.reflection?.trim() || 'none'}`,
    `Summary: ${record.summary?.trim() || 'none'}`,
  ].join('\n');
};
