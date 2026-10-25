// Recurring tasks: when a series occurs and which instances to create.
import type { DateKey, PlannerState, RecurrenceRule, Series, Task } from './types.ts';
import type { NewTask } from './events.ts';
import { addDays, daysBetween, monthDay, startOfWeek, weekday, weekdayName } from './dates.ts';
import { edgePosition } from './selectors.ts';

/** How far ahead instances are created, so upcoming days show them. */
export const RECURRENCE_HORIZON_DAYS = 7;

const parts = (date: DateKey): [number, number, number] => date.split('-').map(Number) as [number, number, number];
const daysInMonth = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();

export const occursOn = (rule: RecurrenceRule, startDate: DateKey, date: DateKey): boolean => {
  if (date < startDate) return false;
  const interval = Math.max(1, rule.interval || 1);
  switch (rule.freq) {
    case 'daily':
      return daysBetween(startDate, date) % interval === 0 && (!rule.weekdays?.length || rule.weekdays.includes(weekday(date)));
    case 'weekly': {
      const days = rule.weekdays?.length ? rule.weekdays : [weekday(startDate)];
      const weeks = Math.round(daysBetween(startOfWeek(startDate, 1), startOfWeek(date, 1)) / 7);
      return weeks % interval === 0 && days.includes(weekday(date));
    }
    case 'monthly': {
      const [sy, sm, sd] = parts(startDate);
      const [y, m, d] = parts(date);
      if (((y - sy) * 12 + (m - sm)) % interval !== 0) return false;
      const total = daysInMonth(y, m);
      const wanted = rule.monthDay ?? sd;
      // The 31st falls back to a shorter month's last day; negative days count from the end.
      const target = wanted < 0 ? total + wanted + 1 : Math.min(wanted, total);
      return d === target;
    }
    case 'yearly': {
      const [sy, sm, sd] = parts(startDate);
      const [y, m, d] = parts(date);
      return (y - sy) % interval === 0 && m === sm && d === Math.min(sd, daysInMonth(y, m));
    }
  }
};

const ORDINAL = (n: number): string => {
  if (n < 0) return n === -1 ? 'last day' : `${-n}th-to-last day`;
  const suffix = n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th';
  return `${n}${suffix}`;
};
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const describeRule = (rule: RecurrenceRule, startDate: DateKey): string => {
  const every = (unit: string) => (rule.interval > 1 ? `Every ${rule.interval} ${unit}s` : `Every ${unit}`);
  switch (rule.freq) {
    case 'daily':
      if (rule.weekdays?.length === 5 && [1, 2, 3, 4, 5].every((day) => rule.weekdays!.includes(day))) return 'Every weekday';
      return every('day');
    case 'weekly': {
      const days = (rule.weekdays?.length ? rule.weekdays : [weekday(startDate)]).slice().sort();
      return `${every('week')} on ${days.map((day) => WEEKDAY_SHORT[day]).join(', ')}`;
    }
    case 'monthly':
      return `${every('month')} on the ${ORDINAL(rule.monthDay ?? parts(startDate)[2])}`;
    case 'yearly':
      return `${every('year')} on ${monthDay(startDate)}`;
  }
};

/** Preset rules offered in the task detail, anchored on the task's day. */
export const rulePresets = (date: DateKey): { id: string; label: string; rule: RecurrenceRule }[] => [
  { id: 'daily', label: 'Every day', rule: { freq: 'daily', interval: 1 } },
  { id: 'weekdays', label: 'Every weekday', rule: { freq: 'daily', interval: 1, weekdays: [1, 2, 3, 4, 5] } },
  { id: 'weekly', label: `Every week on ${weekdayName(date)}`, rule: { freq: 'weekly', interval: 1, weekdays: [weekday(date)] } },
  { id: 'biweekly', label: `Every 2 weeks on ${weekdayName(date)}`, rule: { freq: 'weekly', interval: 2, weekdays: [weekday(date)] } },
  { id: 'monthly', label: `Every month on the ${ORDINAL(parts(date)[2])}`, rule: { freq: 'monthly', interval: 1, monthDay: parts(date)[2] } },
  { id: 'yearly', label: `Every year on ${monthDay(date)}`, rule: { freq: 'yearly', interval: 1 } },
];

/** Deterministic instance id, so two replicas generating the same instance agree. */
export const instanceId = (seriesId: string, date: DateKey): string => `r-${seriesId}-${date.replaceAll('-', '')}`.slice(0, 64);

/**
 * Instances to create from today through the horizon: one per series per
 * occurring day that has no instance yet. A deleted instance counts as
 * existing, so deleting one occurrence does not bring it back.
 */
export const planInstances = (state: PlannerState, today: DateKey, horizon = RECURRENCE_HORIZON_DAYS): NewTask[] => {
  const existing = new Set(Object.values(state.tasks).filter((task) => task.recurrence).map((task) => `${task.recurrence!.seriesId}|${task.recurrence!.date}`));
  const out: NewTask[] = [];
  const offsets = new Map<DateKey, number>();
  for (const series of Object.values(state.series)) {
    const first = series.startDate > today ? series.startDate : today;
    for (let date = first; date <= addDays(today, horizon); date = addDays(date, 1)) {
      if (series.stoppedFrom && date >= series.stoppedFrom) break;
      if (!occursOn(series.rule, series.startDate, date) || existing.has(`${series.id}|${date}`)) continue;
      const offset = (offsets.get(date) ?? 0) + 1;
      offsets.set(date, offset);
      out.push(instanceFrom(series, date, edgePosition(state, { kind: 'day', date }, 'bottom') + (offset - 1) * 1024));
    }
  }
  return out;
};

const instanceFrom = (series: Series, date: DateKey, position: number): NewTask => ({
  id: instanceId(series.id, date),
  title: series.template.title,
  notes: series.template.notes,
  plannedMinutes: series.template.plannedMinutes,
  priority: series.template.priority,
  channelId: series.template.channelId,
  placement: { kind: 'day', date },
  position,
  subtasks: series.template.subtasks.map((title, index) => ({ id: `${instanceId(series.id, date)}-s${index}`, title, done: false })),
  recurrence: { seriesId: series.id, date },
});

/** An instance nobody worked on: same text as the template, no subtask done. */
export const isUntouchedInstance = (task: Task, series: Series): boolean =>
  task.title === series.template.title && task.notes === series.template.notes && !task.subtasks.some((subtask) => subtask.done);
