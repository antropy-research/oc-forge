// "Ask Planner": a small Sunny. The model sees a compact plan and answers with
// operations; only known operations on known tasks survive, and the user
// confirms them before anything changes.
import { BACKLOG_BUCKETS, type BacklogBucket, type DateKey, type Placement, type PlannerState, type Task } from './types.ts';
import { addDays, formatMinutes, isDateKey, monthDay, weekdayName } from './dates.ts';
import { backlogTasks, liveChannels, tasksForDay } from './selectors.ts';

/** today, tomorrow, a YYYY-MM-DD date, or a backlog bucket id. */
export type When = string;

export type AssistantOp =
  | { op: 'create'; title: string; when: When; minutes: number | null; channel: string | null }
  | { op: 'move'; taskId: string; when: When }
  | { op: 'complete'; taskId: string }
  | { op: 'reopen'; taskId: string }
  | { op: 'estimate'; taskId: string; minutes: number }
  | { op: 'channel'; taskId: string; channel: string }
  | { op: 'archive'; taskId: string };

const BUCKETS = new Set<string>(BACKLOG_BUCKETS.map((bucket) => bucket.id));
const MAX_OPS = 40;
const CONTEXT_MAX = 24_000;

export const whenToPlacement = (when: When, today: DateKey): Placement | null => {
  if (when === 'today') return { kind: 'day', date: today };
  if (when === 'tomorrow') return { kind: 'day', date: addDays(today, 1) };
  if (isDateKey(when)) return { kind: 'day', date: when };
  return BUCKETS.has(when) ? { kind: 'backlog', bucket: when as BacklogBucket } : null;
};

const line = (state: PlannerState, task: Task): string => {
  const channel = task.channelId ? state.channels[task.channelId]?.name : null;
  const extras = [task.plannedMinutes ? formatMinutes(task.plannedMinutes) : null, channel ? `#${channel}` : null, task.priority, task.completedAt ? 'done' : null].filter(Boolean);
  return `- [${task.id}] ${task.title}${extras.length ? ` (${extras.join(', ')})` : ''}`;
};

/** The plan as the model sees it: the next week by day, then the backlog. */
export const assistantContext = (state: PlannerState, today: DateKey): string => {
  const parts = [`Today is ${weekdayName(today)}, ${today}.`, `Channels: ${liveChannels(state).map((channel) => channel.name).join(', ') || '(none)'}`];
  for (let offset = 0; offset < 7; offset++) {
    const date = addDays(today, offset);
    const tasks = tasksForDay(state, date);
    if (offset > 1 && tasks.length === 0) continue;
    parts.push(`${offset === 0 ? 'Today' : offset === 1 ? 'Tomorrow' : weekdayName(date)} (${date}):`, ...(tasks.length ? tasks.map((task) => line(state, task)) : ['(nothing planned)']));
  }
  for (const bucket of BACKLOG_BUCKETS) {
    const tasks = backlogTasks(state, bucket.id).slice(0, 25);
    if (tasks.length) parts.push(`Backlog, ${bucket.label.toLowerCase()} (${bucket.id}):`, ...tasks.map((task) => line(state, task)));
  }
  return parts.join('\n').slice(0, CONTEXT_MAX);
};

export const ASSISTANT_SYSTEM = [
  'You help a person rearrange their day planner. You get their plan, with task ids in brackets, and one request.',
  'Answer with only one JSON object: {"reply": one short sentence for the person, "ops": [operations]}.',
  'Operations:',
  '{"op":"create","title":string,"when":W,"minutes":number|null,"channel":channel name|null}',
  '{"op":"move","taskId":id,"when":W}',
  '{"op":"complete","taskId":id} {"op":"reopen","taskId":id} {"op":"archive","taskId":id}',
  '{"op":"estimate","taskId":id,"minutes":number} {"op":"channel","taskId":id,"channel":channel name}',
  'W is "today", "tomorrow", a date "YYYY-MM-DD", or a backlog bucket: next-weeks, next-month, next-quarter, next-year, someday, never.',
  'Use only task ids from the plan. If the request is unclear or cannot be done, return no operations and say why in reply. Never delete.',
].join('\n');

const str = (value: unknown, max: number): string | null => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);
const minutes = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 24 * 60 ? Math.round(value) : null);

/** The model's answer, keeping only operations that make sense for this plan. */
export const readAssistantAnswer = (answer: string, state: PlannerState, today: DateKey): { reply: string; ops: AssistantOp[] } | null => {
  const match = /\{[\s\S]*\}/.exec(answer);
  if (!match) return null;
  let data: unknown;
  try {
    data = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const raw = data as { reply?: unknown; ops?: unknown };
  const channels = new Map(liveChannels(state).map((channel) => [channel.name.toLowerCase(), channel.name]));
  const known = (id: unknown): string | null => (typeof id === 'string' && state.tasks[id] && !state.tasks[id]!.deletedAt ? id : null);
  const ops = (Array.isArray(raw.ops) ? raw.ops : []).flatMap((entry): AssistantOp[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const op = entry as Record<string, unknown>;
    const taskId = known(op.taskId);
    const when = typeof op.when === 'string' && whenToPlacement(op.when, today) ? op.when : null;
    switch (op.op) {
      case 'create': {
        const title = str(op.title, 500);
        const channel = typeof op.channel === 'string' ? channels.get(op.channel.toLowerCase().replace(/^#/, '')) ?? null : null;
        return title ? [{ op: 'create', title, when: when ?? 'today', minutes: minutes(op.minutes), channel }] : [];
      }
      case 'move':
        return taskId && when ? [{ op: 'move', taskId, when }] : [];
      case 'complete':
      case 'reopen':
      case 'archive':
        return taskId ? [{ op: op.op, taskId }] : [];
      case 'estimate': {
        const value = minutes(op.minutes);
        return taskId && value ? [{ op: 'estimate', taskId, minutes: value }] : [];
      }
      case 'channel': {
        const channel = typeof op.channel === 'string' ? channels.get(op.channel.toLowerCase().replace(/^#/, '')) : undefined;
        return taskId && channel ? [{ op: 'channel', taskId, channel }] : [];
      }
      default:
        return [];
    }
  });
  return { reply: str(raw.reply, 500) ?? (ops.length ? 'Here is what I would change.' : 'I could not find anything to change.'), ops: ops.slice(0, MAX_OPS) };
};

const whenLabel = (when: When, today: DateKey): string => {
  const placement = whenToPlacement(when, today);
  if (!placement) return when;
  if (placement.kind === 'backlog') return BACKLOG_BUCKETS.find((bucket) => bucket.id === placement.bucket)!.label.toLowerCase();
  if (placement.date === today) return 'today';
  if (placement.date === addDays(today, 1)) return 'tomorrow';
  return `${weekdayName(placement.date)}, ${monthDay(placement.date)}`;
};

/** A sentence for the preview. */
export const describeOp = (state: PlannerState, op: AssistantOp, today: DateKey): string => {
  const title = 'taskId' in op ? `"${state.tasks[op.taskId]?.title ?? op.taskId}"` : '';
  switch (op.op) {
    case 'create':
      return `Add "${op.title}" for ${whenLabel(op.when, today)}${op.minutes ? ` (${formatMinutes(op.minutes)})` : ''}${op.channel ? ` in #${op.channel}` : ''}`;
    case 'move':
      return `Move ${title} to ${whenLabel(op.when, today)}`;
    case 'complete':
      return `Complete ${title}`;
    case 'reopen':
      return `Reopen ${title}`;
    case 'archive':
      return `Archive ${title}`;
    case 'estimate':
      return `Plan ${formatMinutes(op.minutes)} for ${title}`;
    case 'channel':
      return `Put ${title} in #${op.channel}`;
  }
};
