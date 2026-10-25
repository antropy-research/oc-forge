// Read models for the daily and weekly rituals.
import { ritualKey, type DateKey, type Highlight, type Objective, type PlannerState, type Ritual, type RitualRecord, type Task } from './types.ts';
import { addDays, startOfWeek } from './dates.ts';
import { actualMinutes } from './selectors.ts';

export const ritualRecord = (state: PlannerState, ritual: Ritual, date: DateKey): RitualRecord => state.rituals[ritualKey(ritual, date)] ?? {};

export const weekStartOf = (state: PlannerState, date: DateKey): DateKey => startOfWeek(date, state.settings.weekStartsOn);

export const weekDates = (weekStart: DateKey): DateKey[] => Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));

/** Live objectives of one week, in creation order. */
export const objectivesForWeek = (state: PlannerState, weekStart: DateKey): Objective[] =>
  Object.values(state.objectives).filter((objective) => !objective.deletedAt && objective.weekStart === weekStart).sort((a, b) => a.createdAt.localeCompare(b.createdAt));

export const tasksForObjective = (state: PlannerState, objectiveId: string): Task[] =>
  Object.values(state.tasks).filter((task) => task.objectiveId === objectiveId && !task.deletedAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt));

/** The week's objective a `$text` in Add Task means: exact title, then prefix, then substring. */
export const objectiveByText = (state: PlannerState, weekStart: DateKey, text: string): Objective | null => {
  const needle = text.toLowerCase().replace(/[-_]/g, ' ');
  const list = objectivesForWeek(state, weekStart);
  const title = (objective: Objective) => objective.title.toLowerCase();
  return list.find((objective) => title(objective) === needle) ?? list.find((objective) => title(objective).startsWith(needle)) ?? list.find((objective) => title(objective).includes(needle)) ?? null;
};

/** Tasks completed on a local date, wherever they are planned. */
export const completedOnDay = (state: PlannerState, date: DateKey): Task[] =>
  Object.values(state.tasks).filter((task) => task.completedOn === date && !task.deletedAt).sort((a, b) => (a.completedAt ?? '').localeCompare(b.completedAt ?? ''));

export interface ChannelTime {
  channelId: string | null;
  minutes: number;
}

/** Actual minutes per channel over `tasks`, largest first. */
export const timeByChannel = (state: PlannerState, tasks: readonly Task[]): ChannelTime[] => {
  const totals = new Map<string | null, number>();
  for (const task of tasks) totals.set(task.channelId, (totals.get(task.channelId) ?? 0) + actualMinutes(state, task));
  return [...totals.entries()].filter(([, minutes]) => minutes > 0).map(([channelId, minutes]) => ({ channelId, minutes })).sort((a, b) => b.minutes - a.minutes);
};

/** Sunsama plans tomorrow when daily planning starts at 3 PM or later. */
export const planningDate = (today: DateKey, localMinutesNow: number): DateKey => (localMinutesNow >= 15 * 60 ? addDays(today, 1) : today);

/** The week weekly planning should look at: this week early on, next week from Thursday. */
export const planningWeek = (state: PlannerState, today: DateKey): DateKey => {
  const start = weekStartOf(state, today);
  const dayIndex = (new Date(`${today}T00:00:00Z`).getUTCDay() - state.settings.weekStartsOn + 7) % 7;
  return dayIndex >= 3 ? addDays(start, 7) : start;
};

/**
 * A day's highlights: the saved items (minus those whose task was deleted),
 * followed by tasks completed since that are not represented yet. Hidden
 * items stay in the list so a removed task is not merged back in.
 */
export const highlightItems = (state: PlannerState, date: DateKey): Highlight[] => {
  const saved = ritualRecord(state, 'highlights', date).items ?? [];
  const live = saved.filter((item) => !item.taskId || (state.tasks[item.taskId] && !state.tasks[item.taskId]!.deletedAt));
  const known = new Set(saved.map((item) => item.taskId).filter(Boolean));
  const fresh = completedOnDay(state, date)
    .filter((task) => !known.has(task.id))
    .map((task) => ({ id: task.id, text: task.title, taskId: task.id, starred: false }));
  return [...live, ...fresh];
};
