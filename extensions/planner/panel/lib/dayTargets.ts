// The days a source's items can be planned on from where they are shown: the
// Home board's visible columns, Today, or the day daily planning plans. A row's
// quick actions offer these days; elsewhere (the Linear or GitHub page) they
// are today and tomorrow.
import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import { addDays } from '../../src/domain/dates.ts';
import type { DateKey } from '../../src/domain/types.ts';
import { useView } from './context.ts';

export interface DayTargets {
  /** The days on screen, in order. */
  days: DateKey[];
  /** Where a click on the first quick action plans an item. */
  primary: DateKey;
}

export const DayTargetsContext = createContext<DayTargets | null>(null);

export const useDayTargets = (): DayTargets => {
  const view = useView();
  return useContext(DayTargetsContext) ?? { days: [view.today, addDays(view.today, 1)], primary: view.today };
};

/** Home: the board's columns, today first when it is on screen. */
export const boardTargets = (days: DateKey[], today: DateKey): DayTargets => ({ days, primary: days.includes(today) ? today : days[0] ?? today });

/** Today: today, and tomorrow a click away. */
export const todayTargets = (today: DateKey): DayTargets => ({ days: [today, addDays(today, 1)], primary: today });

/** Daily planning: only the day being planned, so every add lands on it. */
export const planningTargets = (date: DateKey): DayTargets => ({ days: [date], primary: date });

/** The quick actions a row shows: the primary day and the next day on screen; the rest are a menu away. */
export const quickDays = (targets: DayTargets): DateKey[] => {
  const rest = targets.days.filter((day) => day !== targets.primary);
  return [targets.primary, ...rest.filter((day) => day > targets.primary).slice(0, 1)];
};
