// The journeys' days (tests/e2e/days.mjs): a phase's dates read when it begins, a midnight about to pass waited out.
import { describe, expect, test } from 'bun:test';
// @ts-expect-error: a plain ES module of the journeys, without types
import { addDays, dayIn, minutesToMidnight, waitOutMidnight } from './e2e/days.mjs';

const LA = 'America/Los_Angeles';

describe("the journeys' days", () => {
  test('the day in a zone turns at its midnight, not UTC\'s', () => {
    expect([dayIn(LA, Date.parse('2026-10-30T06:59:00Z')), dayIn(LA, Date.parse('2026-10-30T07:01:00Z'))]).toEqual(['2026-10-29', '2026-10-30']);
    expect(minutesToMidnight(LA, Date.parse('2026-10-30T06:50:00Z'))).toBeCloseTo(10, 5);
  });

  test("days after a day are calendar days: over a month's and a year's end, and Los Angeles' 25-hour November 1", () => {
    expect([addDays('2026-10-31', 1), addDays('2026-11-01', 1), addDays('2026-12-31', 1), addDays('2026-03-01', -1), addDays('2026-10-30', 2)]).toEqual(['2026-11-01', '2026-11-02', '2027-01-01', '2026-02-28', '2026-11-01']);
    // What 24 hours after the first hour of that day gave (sunsama.mjs's and linear.mjs's old dayKey): the same day.
    expect(dayIn(LA, Date.parse('2026-11-01T07:30:00Z') + 86_400_000)).toBe('2026-11-01');
  });

  test('no midnight within the margin: the day at once, without waiting', async () => {
    const before = Date.now();
    expect(await waitOutMidnight(LA, 0)).toBe(dayIn(LA));
    expect(Date.now() - before).toBeLessThan(1000);
  });
});
