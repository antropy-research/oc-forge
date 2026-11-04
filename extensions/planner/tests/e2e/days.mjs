// Days in a time zone, for the journeys: the day it is there now, days after it, and how far midnight is. A journey
// reads its dates when each phase begins and first waits out a midnight about to pass, so a phase runs on one day and
// its dates and selectors are the visible day's (round 12's review: sunsama.mjs read its dates once, at the start; a
// run that crossed midnight in Los Angeles compared yesterday's dates and looked for a menu label that had become
// "Tomorrow").

/** The day it is in `zone` at `ms`, as YYYY-MM-DD. */
export const dayIn = (zone, ms = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));

/** The day `days` calendar days after `date` (YYYY-MM-DD), whatever a zone's daylight saving does to its length. */
export const addDays = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** Minutes into the day in `zone` at `ms`. */
export const minutesIn = (zone, ms = Date.now()) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms)).map((part) => [part.type, Number(part.value)]));
  return (parts.hour % 24) * 60 + parts.minute + parts.second / 60;
};

/** Minutes until the next midnight in `zone` (a day of 23 or 25 hours counts as 24, near enough for a margin). */
export const minutesToMidnight = (zone, ms = Date.now()) => 24 * 60 - minutesIn(zone, ms);

/**
 * The day it is in `zone` once no midnight is less than `margin` minutes away: when one is, wait until it has passed
 * (and a minute more), saying so. What runs next, for less than `margin` minutes, runs on that one day.
 */
export const waitOutMidnight = async (zone, margin, label = 'journey') => {
  const left = minutesToMidnight(zone);
  if (left < margin) {
    console.log(`INFO ${label}: midnight in ${zone} is ${left.toFixed(1)} min away (under ${margin}): waiting ${(left + 1).toFixed(1)} min for the new day`);
    await new Promise((resolve) => setTimeout(resolve, (left + 1) * 60_000));
  }
  return dayIn(zone);
};
