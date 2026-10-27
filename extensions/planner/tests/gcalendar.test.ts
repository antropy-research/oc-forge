import { describe, expect, test } from 'bun:test';
import { addMonths, compactClock, compactRange, eventSpan, fitRow, layoutRow, longDay, monthWeeks, rangeTitle, scheduleDays, stepAnchor, viewDays, type RowItem } from '../src/domain/gcalendar.ts';

const LA = 'America/Los_Angeles';

describe('the days each view shows', () => {
  test('day, week (with and without weekends), month as whole weeks, schedule', () => {
    expect(viewDays('day', '2026-10-28', 1)).toEqual(['2026-10-28']);
    expect(viewDays('week', '2026-10-28', 1)).toEqual(['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
    expect(viewDays('week', '2026-10-28', 0)[0]).toBe('2026-10-25');
    expect(viewDays('week', '2026-10-28', 1, false)).toEqual(['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30']);
    const weeks = monthWeeks('2026-10-28', 0);
    expect(weeks.length).toBe(5);
    expect(weeks[0]![0]).toBe('2026-09-27');
    expect(weeks.at(-1)!.at(-1)).toBe('2026-10-31');
    // A month that needs six rows (August 2026 starts on a Saturday).
    expect(monthWeeks('2026-08-10', 0).length).toBe(6);
    expect(viewDays('month', '2026-10-28', 1, false).every((day) => ![0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay()))).toBe(true);
    const schedule = viewDays('schedule', '2026-10-28', 1);
    expect([schedule.length, schedule[0], schedule.at(-1)]).toEqual([30, '2026-10-28', '2026-11-26']);
    // Year: every day of the anchor's year (a leap year has 366).
    const year = viewDays('year', '2026-10-28', 1);
    expect([year.length, year[0], year.at(-1), viewDays('year', '2028-02-29', 1).length]).toEqual([365, '2026-01-01', '2026-12-31', 366]);
  });
  test('the arrows step a day, a week, a month (shorter months clamp) or the schedule’s stretch', () => {
    expect(stepAnchor('day', '2026-10-31', 1)).toBe('2026-11-01');
    expect(stepAnchor('week', '2026-10-28', -1)).toBe('2026-10-21');
    expect(stepAnchor('month', '2026-01-31', 1)).toBe('2026-02-28');
    expect(stepAnchor('month', '2026-12-15', 1)).toBe('2027-01-15');
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28');
    expect(stepAnchor('schedule', '2026-10-28', 1)).toBe('2026-11-27');
    expect([stepAnchor('year', '2026-10-28', 1), stepAnchor('year', '2028-02-29', 1)]).toEqual(['2027-10-28', '2029-02-28']);
  });
  test('titles as Google Calendar writes them', () => {
    expect(rangeTitle('day', '2026-10-26', ['2026-10-26'])).toBe('October 26, 2026');
    expect(rangeTitle('month', '2026-10-26', [])).toBe('October 2026');
    expect(rangeTitle('year', '2026-10-26', [])).toBe('2026');
    expect(rangeTitle('week', '2026-10-14', viewDays('week', '2026-10-14', 1))).toBe('October 2026');
    expect(rangeTitle('week', '2026-10-28', viewDays('week', '2026-10-28', 1))).toBe('Oct – Nov 2026');
    expect(rangeTitle('week', '2026-12-30', viewDays('week', '2026-12-30', 1))).toBe('Dec 2026 – Jan 2027');
    expect(rangeTitle('schedule', '2026-10-28', viewDays('schedule', '2026-10-28', 1))).toBe('Oct 28 – Nov 26, 2026');
    expect(longDay('2026-10-26')).toBe('Monday, October 26');
  });
  test('Google’s compact times', () => {
    expect([compactClock(9 * 60), compactClock(9 * 60 + 30), compactClock(12 * 60), compactClock(0)]).toEqual(['9am', '9:30am', '12pm', '12am']);
    expect(compactRange(9 * 60, 10 * 60)).toBe('9 – 10am');
    expect(compactRange(11 * 60, 12 * 60 + 30)).toBe('11am – 12:30pm');
    expect(compactRange(13 * 60, 14 * 60 + 30)).toBe('1 – 2:30pm');
  });
});

describe('placing events in a month row', () => {
  test('the days an event covers: midnight ends do not touch the next day', () => {
    expect(eventSpan({ start: '2026-10-27T07:00:00.000Z', end: '2026-10-29T07:00:00.000Z', allDay: true }, LA)).toEqual({ first: '2026-10-27', last: '2026-10-28' });
    expect(eventSpan({ start: '2026-10-27T16:00:00.000Z', end: '2026-10-28T07:00:00.000Z', allDay: false }, LA)).toEqual({ first: '2026-10-27', last: '2026-10-27' });
    expect(eventSpan({ start: '2026-10-27T16:00:00.000Z', end: '2026-10-28T18:00:00.000Z', allDay: false }, LA)).toEqual({ first: '2026-10-27', last: '2026-10-28' });
  });

  const week = ['2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31'];
  const item = (id: string, first: string, last: string, bar: boolean, hour = 9): RowItem<string> => ({ item: id, span: { first, last }, bar, startMs: Date.parse(`${first}T${String(hour).padStart(2, '0')}:00:00Z`) });

  test('bars first, longest first, each timed event in the first free line of its day', () => {
    const { placements, lines } = layoutRow([item('standup', '2026-10-26', '2026-10-26', false, 9), item('lunch', '2026-10-26', '2026-10-26', false, 12), item('trip', '2026-10-24', '2026-10-27', true), item('offsite', '2026-10-26', '2026-10-29', true)], week);
    const where = Object.fromEntries(placements.map((entry) => [entry.item, [entry.col, entry.span, entry.slot, entry.fromBefore, entry.toAfter]]));
    expect(where).toEqual({ trip: [0, 3, 0, true, false], offsite: [1, 4, 1, false, false], standup: [1, 1, 2, false, false], lunch: [1, 1, 3, false, false] });
    expect(lines).toBe(4);
  });
  test('a row without weekends leaves weekend-only events out and clips the rest', () => {
    const weekdays = week.slice(1, 6);
    const { placements } = layoutRow([item('sat', '2026-10-31', '2026-10-31', true), item('long', '2026-10-24', '2026-11-02', true)], weekdays);
    expect(placements.map((entry) => [entry.item, entry.col, entry.span, entry.fromBefore, entry.toAfter])).toEqual([['long', 0, 5, true, true]]);
  });
  test('a full day keeps its last line for "N more"; a bar shows only where it fits', () => {
    const busy = [item('bar', '2026-10-26', '2026-10-27', true), ...['a', 'b', 'c', 'd'].map((id, index) => item(id, '2026-10-26', '2026-10-26', false, 8 + index))];
    const { placements } = layoutRow(busy, week);
    const { shown, more } = fitRow(placements, 7, 3);
    expect(shown.map((entry) => entry.item)).toEqual(['bar', 'a']);
    expect(more).toEqual([0, 3, 0, 0, 0, 0, 0]);
    // The bar's other day has room, but the bar is cut where the day is full only when its own line is the one given up.
    const { shown: tight, more: tightMore } = fitRow(placements, 7, 2);
    expect(tight.map((entry) => entry.item)).toEqual(['bar']);
    expect(tightMore).toEqual([0, 4, 0, 0, 0, 0, 0]);
    const { shown: one, more: oneMore } = fitRow(placements, 7, 1);
    expect(one).toEqual([]);
    expect(oneMore).toEqual([0, 5, 1, 0, 0, 0, 0]);
  });
});

describe('the schedule', () => {
  test('days with something on them, all-day first, then by start; several-day events on each of their days', () => {
    const items: RowItem<string>[] = [
      { item: 'late', span: { first: '2026-10-26', last: '2026-10-26' }, bar: false, startMs: Date.parse('2026-10-26T20:00:00Z') },
      { item: 'early', span: { first: '2026-10-26', last: '2026-10-26' }, bar: false, startMs: Date.parse('2026-10-26T16:00:00Z') },
      { item: 'trip', span: { first: '2026-10-26', last: '2026-10-27' }, bar: true, startMs: Date.parse('2026-10-26T07:00:00Z') },
    ];
    expect(scheduleDays(items, '2026-10-25', '2026-10-30').map((day) => [day.date, day.items.map((entry) => entry.item)])).toEqual([
      ['2026-10-26', ['trip', 'early', 'late']],
      ['2026-10-27', ['trip']],
    ]);
  });
});
