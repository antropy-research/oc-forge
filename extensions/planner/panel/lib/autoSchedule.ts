// Sunsama's "X": put a task into the first free slot of its day.
import type { DateKey, PlannerState, Task } from '../../src/domain/types.ts';
import { blocksOnDay } from '../../src/domain/selectors.ts';
import { findFreeSlot, type Interval } from '../../src/domain/schedule.ts';
import { busyTaskEvents } from '../../src/domain/gtaskKept.ts';
import { newId } from '../../src/domain/ids.ts';
import type { PlannerClient } from './client.ts';

/**
 * Timebox `task` on `date` in the first free working-hours slot, around sessions, busy events and Google tasks set
 * Busy (at the time the Planner keeps for them). Returns an error message, or null.
 */
export const autoTimebox = async (client: PlannerClient, state: PlannerState, today: DateKey, task: Task, date: DateKey): Promise<string | null> => {
  const zone = state.settings.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const busy: Interval[] = blocksOnDay(state, date).map((block) => ({ start: Date.parse(block.start), end: Date.parse(block.end) }));
  try {
    const feed = await client.calendarEvents(date, date);
    for (const event of [...feed.events, ...busyTaskEvents(feed.events, state.googleTasks, date, date, today, zone)]) if (event.busy) busy.push({ start: Date.parse(event.start), end: Date.parse(event.end) });
  } catch {
    // Without calendar feeds, schedule around the working sessions alone.
  }
  const minutes = Math.max(15, task.plannedMinutes ?? 30);
  const slot = findFreeSlot(date, zone, state.settings.workdayStart, state.settings.workdayEnd, minutes, busy, date === today ? Date.now() : 0);
  if (!slot) return 'No free time left in your working hours for this task.';
  await client.dispatch([{ type: 'block.created', block: { id: newId(), taskId: task.id, start: new Date(slot.start).toISOString(), end: new Date(slot.end).toISOString() } }], { undo: 'Timeboxed' });
  return null;
};
