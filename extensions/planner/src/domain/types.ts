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

/** An external object the task plans; the source stays authoritative for its state. */
/** Where a linked task comes from, by name. */
export const SOURCE_NAMES = { linear: 'Linear', github: 'GitHub', gtask: 'Google Tasks', email: 'Gmail' } as const;

export interface TaskSourceRef {
  kind: keyof typeof SOURCE_NAMES;
  id: string;
  /** Short label at the source, such as NEX-110. */
  key: string;
  url: string;
  /** Title last seen at the source; a task still carrying it follows renames there. */
  title?: string;
  /** Linear team, for finding its workflow states. */
  teamId?: string;
  /** Workflow state last seen at the source. */
  status?: { name: string; type: string; color: string };
  /** The same item elsewhere, as `owner/repo#number` (a Linear issue Linear syncs with GitHub), so it is planned once. */
  mirrors?: string[];
  /** Linear workspace (organization id) the issue lives in; absent on links made before workspaces, which mean OpenChamber's own connection. */
  workspaceId?: string;
  /** Git branch Linear suggests for the issue; an agent's worktree uses it so its pull request links back. */
  branch?: string;
  /** Google account (email) a Google task or message belongs to. */
  account?: string;
  /** Google task list the task is in. */
  listId?: string;
}

/** How the Linear page groups and orders issues. */
export const LINEAR_GROUPS = ['status', 'priority', 'project', 'team', 'assignee', 'workspace', 'none'] as const;
export type LinearGroupBy = (typeof LINEAR_GROUPS)[number];
export const LINEAR_ORDERS = ['priority', 'updated', 'due', 'identifier'] as const;
export type LinearOrderBy = (typeof LINEAR_ORDERS)[number];

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
  /** Backlog folder; kept when the task is scheduled, shown in the backlog. */
  folderId: string | null;
  objectiveId: string | null;
  subtasks: Subtask[];
  source: TaskSourceRef | null;
  /** Set on an instance of a recurring task. */
  recurrence: { seriesId: string; date: DateKey } | null;
  /** The chat this task came from (a message action or /task). */
  sessionRef: { sessionId: string; title: string; directory: string | null } | null;
}

/** Actual time spent on a task; a timer run or a manual entry. */
export interface TimeEntry {
  id: string;
  taskId: string;
  start: string;
  end: string;
  source: 'timer' | 'manual';
}

/** The one running task timer. */
export interface TimerState {
  taskId: string;
  startedAt: string;
}

/** A working session: when, on the calendar, a task gets worked on. A task can have several. */
export interface WorkBlock {
  id: string;
  taskId: string;
  start: string;
  end: string;
  /** The Google Calendar event the Planner wrote for this session, when it writes sessions there. */
  google?: GoogleEventLink;
}

/** A Google Calendar event, by the account and calendar it is in. */
export interface GoogleEventLink {
  account: string;
  calendarId: string;
  eventId: string;
}

/** A backlog folder (Sunsama: folders exist only in the backlog). */
export interface Folder {
  id: string;
  name: string;
  createdAt: string;
  deletedAt: string | null;
}

/** A weekly objective: a goal for one week that tasks can align to. */
export interface Objective {
  id: string;
  /** First day of the objective's week. */
  weekStart: DateKey;
  title: string;
  completedAt: string | null;
  /** The objective this one continues from last week. */
  carriedFrom: string | null;
  createdAt: string;
  deletedAt: string | null;
}

export const RITUALS = ['planning', 'shutdown', 'highlights', 'weeklyPlanning', 'weeklyReview'] as const;
export type Ritual = (typeof RITUALS)[number];

export interface Highlight {
  id: string;
  text: string;
  taskId: string | null;
  starred: boolean;
  /** A task-derived item the user removed; kept so it is not merged back in. */
  hidden?: boolean;
}

/** What a ritual left behind for one day (or one week, keyed by its first day). */
export interface RitualRecord {
  completedAt?: string | null;
  /** Daily planning: what might get in the way. */
  obstacles?: string;
  /** Daily planning: when the workday should end, minutes after midnight. */
  shutdownTime?: number | null;
  /** Shutdown and highlights. */
  reflection?: string;
  /** Highlights. */
  items?: Highlight[];
  summary?: string;
  publishedAt?: string | null;
  /** Weekly planning and review. */
  journal?: string;
}

/** When a recurring task comes back. */
export interface RecurrenceRule {
  freq: 'daily' | 'weekly' | 'monthly' | 'yearly';
  /** Every n days, weeks, months or years. */
  interval: number;
  /** Weekly: which weekdays (0 = Sunday). Daily with [1..5] means weekdays. */
  weekdays?: number[];
  /** Monthly: the day of the month (negative counts from the end). */
  monthDay?: number;
}

/** A recurring task: the template every instance starts from. */
export interface Series {
  id: string;
  rule: RecurrenceRule;
  startDate: DateKey;
  stoppedFrom: DateKey | null;
  template: {
    title: string;
    notes: string;
    plannedMinutes: number | null;
    priority: Priority | null;
    channelId: string | null;
    subtasks: string[];
  };
  createdAt: string;
}

/**
 * An agent session working on a task: one the Planner started, or an existing
 * one linked to the task. A task can have several. The session's live state
 * comes from OpenChamber; the outcome is kept so a result waiting for review
 * survives reloads.
 */
export interface TaskRun {
  id: string;
  taskId: string;
  sessionId: string;
  projectId: string | null;
  directory: string | null;
  worktree: { directory: string; branch: string | null } | null;
  /** Task title when the run started, shown while the session list loads. */
  title: string;
  startedAt: string;
  outcome: 'completed' | 'failed' | null;
  outcomeAt: string | null;
  /** A finished turn is not an accepted task: the user reviews it. */
  review: { verdict: 'accepted' | 'changes'; at: string; note: string } | null;
  /** Assigned to the agent, as in GitHub or Linear: it was asked to open a pull request from its branch. */
  wantsPr?: boolean;
  /** The pull request opened from the run's branch, as gh last showed it. */
  pullRequest?: RunPullRequest | null;
}

/** A pull request on GitHub, opened from a run's worktree branch. */
export interface RunPullRequest {
  number: number;
  url: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  title: string;
  /** owner/repo */
  repo: string;
  /** When the Planner last saw it change. */
  seenAt: string;
}

/** A read-only calendar the service fetches (an ICS feed or file). */
export interface CalendarSubscription {
  id: string;
  name: string;
  url: string;
  color: string;
  visible: boolean;
  /** A Google calendar, read through its connected account rather than from `url`. */
  google?: { account: string; calendarId: string };
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
  /** Count planned time as actual when a task is completed without any tracked time. */
  plannedAsActual: boolean;
  /** Working hours, in minutes after local midnight; auto-scheduling stays inside them. */
  workdayStart: number;
  workdayEnd: number;
  /** After completing a task linked to Linear: ask, move the issue to Done, or leave Linear alone. */
  linearOnComplete: 'ask' | 'complete' | 'nothing';
  /** After planning a Linear issue for a day: ask, move it to In Progress, or leave it. */
  linearOnPlan: 'ask' | 'start' | 'nothing';
  /** Complete the task when its issue is completed or canceled in Linear (Sunsama does not). */
  linearImportCompletion: boolean;
  /** The Linear page: issues as a list or a board, grouped and ordered by. */
  linearLayout: 'list' | 'board';
  linearGroupBy: LinearGroupBy;
  linearOrderBy: LinearOrderBy;
  /** Suggest planned time and channel for new tasks from similar past tasks. */
  suggestFromHistory: boolean;
  /** Focus mode's Pomodoro lengths, in minutes. */
  pomodoroMinutes: number;
  breakMinutes: number;
  /** Google calendar the Planner writes working sessions to, as events; null writes none. */
  googleTimebox: { account: string; calendarId: string } | null;
  /** Completing a task linked to a Google task: complete it there too, ask first, or leave it. */
  googleTasksOnComplete: 'ask' | 'complete' | 'nothing';
  /** Complete a task when its Google task is completed. */
  googleTasksImportCompletion: boolean;
  /** Planning a Google task on a day sets its due date there, so Google Calendar shows it that day. */
  googleTasksDueFromPlan: boolean;
}

export interface PlannerState {
  /** Number of events applied; a cheap change counter for clients. */
  version: number;
  tasks: Record<string, Task>;
  channels: Record<string, Channel>;
  entries: Record<string, TimeEntry>;
  timer: TimerState | null;
  blocks: Record<string, WorkBlock>;
  calendars: Record<string, CalendarSubscription>;
  objectives: Record<string, Objective>;
  /** Keyed `${ritual}:${date}`. */
  rituals: Record<string, RitualRecord>;
  series: Record<string, Series>;
  runs: Record<string, TaskRun>;
  folders: Record<string, Folder>;
  settings: Settings;
}

export const ritualKey = (ritual: Ritual, date: DateKey): string => `${ritual}:${date}`;

export const DEFAULT_SETTINGS: Settings = {
  timezone: null,
  workloadMinutes: 6 * 60,
  archiveAfterRollovers: 7,
  weekStartsOn: 1,
  plannedAsActual: true,
  workdayStart: 9 * 60,
  workdayEnd: 18 * 60,
  linearOnComplete: 'ask',
  linearOnPlan: 'nothing',
  linearImportCompletion: false,
  linearLayout: 'list',
  linearGroupBy: 'status',
  linearOrderBy: 'priority',
  suggestFromHistory: true,
  pomodoroMinutes: 25,
  breakMinutes: 5,
  googleTimebox: null,
  googleTasksOnComplete: 'complete',
  googleTasksImportCompletion: true,
  googleTasksDueFromPlan: true,
};

export const emptyState = (): PlannerState => ({
  version: 0,
  tasks: {},
  channels: {},
  entries: {},
  timer: null,
  blocks: {},
  calendars: {},
  objectives: {},
  rituals: {},
  series: {},
  runs: {},
  folders: {},
  settings: { ...DEFAULT_SETTINGS },
});
