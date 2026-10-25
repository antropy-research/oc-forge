// Auto-scheduling: the first free slot of a given length inside working hours.
import type { DateKey } from './types.ts';
import { instantAt } from './dates.ts';

export interface Interval {
  start: number;
  end: number;
}

const SNAP_MS = 15 * 60_000;
const snapUp = (ms: number): number => Math.ceil(ms / SNAP_MS) * SNAP_MS;

/**
 * Earliest gap of `durationMinutes` between `workdayStart` and `workdayEnd` on
 * `date` (minutes after local midnight in `timeZone`) that starts no earlier
 * than `notBefore` and overlaps none of `busy`. Start times snap to 15 minutes.
 */
export const findFreeSlot = (
  date: DateKey,
  timeZone: string,
  workdayStart: number,
  workdayEnd: number,
  durationMinutes: number,
  busy: readonly Interval[],
  notBefore: number,
): Interval | null => {
  const dayStart = Date.parse(instantAt(date, workdayStart, timeZone));
  const dayEnd = Date.parse(instantAt(date, workdayEnd, timeZone));
  const length = durationMinutes * 60_000;
  let cursor = snapUp(Math.max(dayStart, notBefore));
  const sorted = busy.filter((item) => item.end > cursor && item.start < dayEnd).sort((a, b) => a.start - b.start);
  for (const item of sorted) {
    if (item.start - cursor >= length) break;
    cursor = Math.max(cursor, snapUp(item.end));
  }
  return cursor + length <= dayEnd ? { start: cursor, end: cursor + length } : null;
};

/** Side-by-side lanes for overlapping calendar items, as calendars draw them. */
export const layoutLanes = <T extends Interval>(items: readonly T[]): { item: T; lane: number; lanes: number }[] => {
  const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end);
  const result: { item: T; lane: number; lanes: number }[] = [];
  let group: { item: T; lane: number; lanes: number }[] = [];
  let groupEnd = -Infinity;
  const laneEnds: number[] = [];
  const closeGroup = () => {
    const lanes = Math.max(1, ...group.map((entry) => entry.lane + 1));
    for (const entry of group) entry.lanes = lanes;
    result.push(...group);
    group = [];
    laneEnds.length = 0;
  };
  for (const item of sorted) {
    if (item.start >= groupEnd && group.length) closeGroup();
    let lane = laneEnds.findIndex((end) => end <= item.start);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = item.end;
    group.push({ item, lane, lanes: 1 });
    groupEnd = Math.max(groupEnd, item.end);
  }
  if (group.length) closeGroup();
  return result;
};
