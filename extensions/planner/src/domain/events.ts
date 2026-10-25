// Planner events: the append-only log is the source of truth, state is a fold over it.
import { BACKLOG_BUCKETS, RITUALS, type CalendarSubscription, type Channel, type DateKey, type Objective, type Placement, type RecurrenceRule, type Ritual, type RitualRecord, type Series, type Settings, type Subtask, type Task, type TaskRun, type TaskSourceRef, type WorkBlock } from './types.ts';
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
  objectiveId?: string | null;
  source?: TaskSourceRef | null;
  subtasks?: Subtask[];
  recurrence?: { seriesId: string; date: DateKey } | null;
  sessionRef?: Task['sessionRef'];
}

export type NewRun = Pick<TaskRun, 'id' | 'taskId' | 'sessionId' | 'projectId' | 'directory' | 'worktree' | 'title'>;

export const PATCH_FIELDS = ['title', 'notes', 'plannedMinutes', 'priority', 'dueDate', 'channelId', 'objectiveId', 'subtasks', 'source'] as const;
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
  | { type: 'task.sourceSynced'; taskId: string; source: TaskSourceRef; title?: string }
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
  | { type: 'calendar.added'; calendar: Omit<CalendarSubscription, 'visible'> }
  | { type: 'calendar.updated'; calendarId: string; patch: Partial<Pick<CalendarSubscription, 'name' | 'color' | 'visible'>> }
  | { type: 'calendar.removed'; calendarId: string }
  | { type: 'objective.created'; objective: Pick<Objective, 'id' | 'weekStart' | 'title' | 'carriedFrom'> }
  | { type: 'objective.updated'; objectiveId: string; patch: { title?: string; completed?: boolean } }
  | { type: 'objective.deleted'; objectiveId: string }
  | { type: 'ritual.saved'; ritual: Ritual; date: DateKey; fields: RitualRecord }
  | { type: 'run.started'; run: NewRun }
  | { type: 'run.outcome'; runId: string; outcome: 'completed' | 'failed' }
  | { type: 'run.reviewed'; runId: string; verdict: 'accepted' | 'changes'; note?: string }
  | { type: 'run.removed'; runId: string }
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
  Array.isArray(value) && value.length <= 200 && value.every((item) => isRecord(item) && isId(item.id) && isTitle(item.title) && typeof item.done === 'boolean');

const isShortText = (value: unknown, max: number): boolean => typeof value === 'string' && value.length <= max;
const isSource = (value: unknown): value is TaskSourceRef =>
  isRecord(value) &&
  (value.kind === 'linear' || value.kind === 'github') &&
  isShortText(value.id, 200) && (value.id as string).length > 0 &&
  isShortText(value.key, 100) &&
  isShortText(value.url, 2000) && /^https:\/\//.test(value.url as string) &&
  (value.title === undefined || isShortText(value.title, TITLE_MAX)) &&
  (value.teamId === undefined || isShortText(value.teamId, 200)) &&
  (value.status === undefined || (isRecord(value.status) && isShortText(value.status.name, 100) && isShortText(value.status.type, 40) && isShortText(value.status.color, 40)));

const PRIORITY_VALUES = new Set(['urgent', 'high', 'medium', 'low']);
const isPriority = (value: unknown): boolean => value === null || (typeof value === 'string' && PRIORITY_VALUES.has(value));
const isColor = (value: unknown): boolean => typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
const isChannelName = (value: unknown): boolean => typeof value === 'string' && /^[\p{L}\p{N}_-]{1,40}$/u.test(value);

const validatePatch = (patch: unknown, channels: Record<string, Channel>, objectives: Record<string, Objective>): string | null => {
  if (!isRecord(patch)) return 'patch must be an object';
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'title' && !isTitle(value)) return 'title must be 1-500 characters';
    else if (key === 'notes' && !(typeof value === 'string' && value.length <= NOTES_MAX)) return 'notes are too long';
    else if (key === 'plannedMinutes' && !isMinutes(value)) return 'plannedMinutes must be a number of minutes or null';
    else if (key === 'priority' && !isPriority(value)) return 'priority is invalid';
    else if (key === 'dueDate' && !(value === null || isDateKey(value))) return 'dueDate must be a date or null';
    else if (key === 'channelId' && !(value === null || (isId(value) && channels[value as string]))) return 'unknown channel';
    else if (key === 'objectiveId' && !(value === null || (isId(value) && objectives[value as string]))) return 'unknown objective';
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
    else if (!['timezone', 'workloadMinutes', 'archiveAfterRollovers', 'weekStartsOn', 'plannedAsActual', 'workdayStart', 'workdayEnd', 'linearOnComplete', 'linearOnPlan', 'linearImportCompletion'].includes(key)) return `unknown setting ${key}`;
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
}

const isSessionRef = (value: unknown): boolean =>
  value === null ||
  (isRecord(value) && isShortText(value.sessionId, 200) && (value.sessionId as string).length > 0 && isShortText(value.title, 500) && (value.directory === null || isShortText(value.directory, 1024)));

const isRunShape = (value: unknown): string | null => {
  if (!isRecord(value) || !isId(value.id)) return 'run needs an id';
  if (!(isShortText(value.sessionId, 200) && (value.sessionId as string).length > 0)) return 'run needs a session';
  if (!(value.projectId === null || isShortText(value.projectId, 1024))) return 'projectId is invalid';
  if (!(value.directory === null || isShortText(value.directory, 1024))) return 'directory is invalid';
  if (!(value.worktree === null || (isRecord(value.worktree) && isShortText(value.worktree.directory, 1024) && (value.worktree.branch === null || isShortText(value.worktree.branch, 200))))) return 'worktree is invalid';
  return isShortText(value.title, TITLE_MAX) ? null : 'title is invalid';
};

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
      // Recurrence comes from series.created and the service's instances, never from a client's task.
      if (task.recurrence !== undefined && task.recurrence !== null) return 'recurrence is set through a series';
      if (task.sessionRef !== undefined && !isSessionRef(task.sessionRef)) return 'sessionRef is invalid';
      return null;
    }
    case 'task.updated':
      return needTask() ?? validatePatch(command.patch, channels, context.objectives);
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
    case 'calendar.added': {
      const calendar = command.calendar;
      if (!isRecord(calendar) || !isId(calendar.id)) return 'calendar needs an id';
      if (context.calendars[calendar.id as string]) return 'calendar id already exists';
      if (!(typeof calendar.name === 'string' && calendar.name.trim() && calendar.name.length <= 80)) return 'calendar name must be 1-80 characters';
      if (!isFeedUrl(calendar.url)) return 'calendar URL must be http(s), webcal or file';
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
    default:
      return `unknown command type ${String(type)}`;
  }
};

/** Strip the client envelope to the event body that gets stored. */
export const commandBody = (command: Command): EventBody => {
  const { cmd: _cmd, ...body } = command;
  return body as EventBody;
};
