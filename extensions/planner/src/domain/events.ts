// Planner events: the append-only log is the source of truth, state is a fold over it.
import { BACKLOG_BUCKETS, type Channel, type DateKey, type Placement, type Settings, type Subtask, type Task, type TaskSourceRef } from './types.ts';
import { isDateKey, isValidTimeZone } from './dates.ts';

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
  source?: TaskSourceRef | null;
}

export const PATCH_FIELDS = ['title', 'notes', 'plannedMinutes', 'priority', 'dueDate', 'channelId', 'subtasks'] as const;
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
  | { type: 'tasks.rolledOver'; date: DateKey; moved: RolledTask[]; archived: string[] }
  | { type: 'channel.created'; channel: NewChannel }
  | { type: 'channel.updated'; channelId: string; patch: ChannelPatch }
  | { type: 'channel.deleted'; channelId: string }
  | { type: 'settings.updated'; patch: Partial<Settings> };

export type EventType = EventBody['type'];

/** What a client sends: an event body plus its own command id for retry-safe delivery. */
export type Command = EventBody & { cmd: string };

/** A stored event. `cmd` links it to the command that produced it. */
export type PlannerEvent = EventBody & { v: 1; id: string; at: string; cmd?: string };

/** Event types only the service may write. */
export const SERVICE_ONLY_TYPES: ReadonlySet<EventType> = new Set(['tasks.rolledOver']);

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
  Array.isArray(value) && value.length <= 200 && value.every((item) => isRecord(item) && isId(item.id) && isTitle(item.title) && typeof item.done === 'boolean');

const isSource = (value: unknown): value is TaskSourceRef =>
  isRecord(value) && (value.kind === 'linear' || value.kind === 'github') && typeof value.id === 'string' && typeof value.key === 'string' && typeof value.url === 'string';

const PRIORITY_VALUES = new Set(['urgent', 'high', 'medium', 'low']);
const isPriority = (value: unknown): boolean => value === null || (typeof value === 'string' && PRIORITY_VALUES.has(value));
const isColor = (value: unknown): boolean => typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
const isChannelName = (value: unknown): boolean => typeof value === 'string' && /^[\p{L}\p{N}_-]{1,40}$/u.test(value);

const validatePatch = (patch: unknown, channels: Record<string, Channel>): string | null => {
  if (!isRecord(patch)) return 'patch must be an object';
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'title' && !isTitle(value)) return 'title must be 1-500 characters';
    else if (key === 'notes' && !(typeof value === 'string' && value.length <= NOTES_MAX)) return 'notes are too long';
    else if (key === 'plannedMinutes' && !isMinutes(value)) return 'plannedMinutes must be a number of minutes or null';
    else if (key === 'priority' && !isPriority(value)) return 'priority is invalid';
    else if (key === 'dueDate' && !(value === null || isDateKey(value))) return 'dueDate must be a date or null';
    else if (key === 'channelId' && !(value === null || (isId(value) && channels[value as string]))) return 'unknown channel';
    else if (key === 'subtasks' && !isSubtasks(value)) return 'subtasks are invalid';
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

const validateSettingsPatch = (patch: unknown): string | null => {
  if (!isRecord(patch)) return 'patch must be an object';
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'timezone' && !isValidTimeZone(value)) return 'timezone must be an IANA zone';
    else if (key === 'workloadMinutes' && !(typeof value === 'number' && value > 0 && value <= 24 * 60)) return 'workloadMinutes must be 1-1440';
    else if (key === 'archiveAfterRollovers' && !(value === null || (Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 365))) return 'archiveAfterRollovers must be 1-365 or null';
    else if (key === 'weekStartsOn' && value !== 0 && value !== 1) return 'weekStartsOn must be 0 or 1';
    else if (!['timezone', 'workloadMinutes', 'archiveAfterRollovers', 'weekStartsOn'].includes(key)) return `unknown setting ${key}`;
  }
  return null;
};

/** The parts of state a command is checked against. */
export interface CommandContext {
  tasks: Record<string, Task>;
  channels: Record<string, Channel>;
}

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
      return null;
    }
    case 'task.updated':
      return needTask() ?? validatePatch(command.patch, channels);
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
    default:
      return `unknown command type ${String(type)}`;
  }
};

/** Strip the client envelope to the event body that gets stored. */
export const commandBody = (command: Command): EventBody => {
  const { cmd: _cmd, ...body } = command;
  return body as EventBody;
};
