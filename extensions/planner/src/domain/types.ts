// Planner domain types, shared by the local service and the panel.

/** A calendar day in the user's timezone, `YYYY-MM-DD`. Never a UTC instant. */
export type DateKey = string;

/** Sunsama's backlog time buckets, in display order. */
export const BACKLOG_BUCKETS = [
  { id: 'next-weeks', label: 'Someday in the next week or two' },
  { id: 'next-month', label: 'Someday in the next month' },
  { id: 'next-quarter', label: 'Someday in the next quarter' },
  { id: 'next-year', label: 'Someday in the next year' },
  { id: 'someday', label: 'Someday' },
  { id: 'never', label: 'Never' },
] as const;

export type BacklogBucket = (typeof BACKLOG_BUCKETS)[number]['id'];

/** Where a task lives: committed to a day, or parked in a backlog bucket. */
export type Placement = { kind: 'day'; date: DateKey } | { kind: 'backlog'; bucket: BacklogBucket };

export interface Subtask {
  id: string;
  title: string;
  done: boolean;
}

/** An external object the task plans; the source stays authoritative for its title and state. */
export interface TaskSourceRef {
  kind: 'linear' | 'github';
  id: string;
  key: string;
  url: string;
}

export type Priority = 'urgent' | 'high' | 'medium' | 'low';

/** Sunsama channel; its context decides whether the time counts toward the work workload. */
export interface Channel {
  id: string;
  name: string;
  color: string;
  context: 'work' | 'personal';
  createdAt: string;
  deletedAt: string | null;
}

export const CHANNEL_COLORS = ['#e8590c', '#1c7ed6', '#2f9e44', '#ae3ec9', '#f08c00', '#0c8599', '#e64980', '#5c940d'] as const;

export interface Task {
  id: string;
  title: string;
  notes: string;
  plannedMinutes: number | null;
  priority: Priority | null;
  placement: Placement;
  /** Order within the placement; fractional so a move rewrites one task. */
  position: number;
  /** Deadline, separate from the day the task is planned for. */
  dueDate: DateKey | null;
  completedAt: string | null;
  /** Local date the task was completed on. */
  completedOn: DateKey | null;
  /** Days this task has been carried forward past its planned day. */
  rolloverCount: number;
  archivedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  channelId: string | null;
  subtasks: Subtask[];
  source: TaskSourceRef | null;
}

export interface Settings {
  /** IANA zone that decides what "today" and midnight mean. Null until the panel reports one. */
  timezone: string | null;
  /** Daily planned-time threshold for the workload warning. */
  workloadMinutes: number;
  /** Archive a task instead of rolling it after this many consecutive rollovers; null keeps rolling. */
  archiveAfterRollovers: number | null;
  /** 0 = Sunday, 1 = Monday. */
  weekStartsOn: 0 | 1;
}

export interface PlannerState {
  /** Number of events applied; a cheap change counter for clients. */
  version: number;
  tasks: Record<string, Task>;
  channels: Record<string, Channel>;
  settings: Settings;
}

export const DEFAULT_SETTINGS: Settings = {
  timezone: null,
  workloadMinutes: 6 * 60,
  archiveAfterRollovers: 7,
  weekStartsOn: 1,
};

export const emptyState = (): PlannerState => ({
  version: 0,
  tasks: {},
  channels: {},
  settings: { ...DEFAULT_SETTINGS },
});
