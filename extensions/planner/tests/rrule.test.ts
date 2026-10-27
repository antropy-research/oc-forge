import { describe, expect, test } from 'bun:test';
import { customOf, customRule, describeRecurrence, formatRRule, monthlyLabels, parseRRule, presetIdOf, recurrencePresets, shiftRule, splitRecurrence, untilBefore, untilDate, untilOn, weekdayOrdinal } from '../src/domain/rrule.ts';

const LA = 'America/Los_Angeles';

describe('repeat presets, as Google Calendar offers them', () => {
  test('for Monday, October 26, 2026 (the fourth and last Monday)', () => {
    expect(weekdayOrdinal('2026-10-26')).toEqual({ nth: 4, last: true });
    expect(recurrencePresets('2026-10-26').map((preset) => [preset.label, preset.rule])).toEqual([
      ['Does not repeat', null],
      ['Daily', 'RRULE:FREQ=DAILY'],
      ['Weekly on Monday', 'RRULE:FREQ=WEEKLY;BYDAY=MO'],
      ['Monthly on the fourth Monday', 'RRULE:FREQ=MONTHLY;BYDAY=4MO'],
      ['Monthly on the last Monday', 'RRULE:FREQ=MONTHLY;BYDAY=-1MO'],
      ['Annually on October 26', 'RRULE:FREQ=YEARLY'],
      ['Every weekday (Monday to Friday)', 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'],
    ]);
  });
  test('a fifth weekday only repeats as the last one; a first one is not the last', () => {
    expect(recurrencePresets('2026-10-29').filter((preset) => preset.id.startsWith('monthly')).map((preset) => preset.label)).toEqual(['Monthly on the last Thursday']);
    expect(recurrencePresets('2026-10-05').filter((preset) => preset.id.startsWith('monthly')).map((preset) => preset.label)).toEqual(['Monthly on the first Monday']);
  });
  test('an event’s rule is found among the presets, else it is custom', () => {
    expect(presetIdOf([], '2026-10-26')).toBe('none');
    expect(presetIdOf(['RRULE:FREQ=WEEKLY;BYDAY=MO'], '2026-10-26')).toBe('weekly');
    expect(presetIdOf(['RRULE:BYDAY=MO;FREQ=WEEKLY'], '2026-10-26')).toBe('weekly');
    expect(presetIdOf(['RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=5'], '2026-10-26')).toBe('custom');
    expect(presetIdOf(['RRULE:FREQ=WEEKLY;BYDAY=MO', 'EXDATE:20261102T170000Z'], '2026-10-26')).toBe('custom');
  });
});

describe('reading and writing rules', () => {
  test('parse and format keep what they do not edit', () => {
    const rule = parseRRule('RRULE:FREQ=WEEKLY;WKST=SU;INTERVAL=2;BYDAY=MO,WE;UNTIL=20261231T075959Z')!;
    expect(rule).toMatchObject({ freq: 'WEEKLY', interval: 2, byDay: ['MO', 'WE'], until: '20261231T075959Z', count: null, other: [['WKST', 'SU']] });
    expect(formatRRule(rule)).toBe('RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;WKST=SU;UNTIL=20261231T075959Z');
    expect(parseRRule('RRULE:FREQ=HOURLY')).toBeNull();
    expect(parseRRule('RRULE:FREQ=WEEKLY;BYDAY=XX')).toBeNull();
    expect(parseRRule('RRULE:FREQ=DAILY;COUNT=0')).toBeNull();
    expect(splitRecurrence(['RRULE:FREQ=DAILY', 'EXDATE;TZID=America/Los_Angeles:20261027T090000'])).toMatchObject({ line: 'RRULE:FREQ=DAILY', rest: ['EXDATE;TZID=America/Los_Angeles:20261027T090000'] });
    expect(splitRecurrence(['RRULE:FREQ=DAILY', 'RRULE:FREQ=WEEKLY']).rule).toBeNull();
  });
  test('the sentence Google Calendar shows', () => {
    const say = (line: string, start = '2026-10-26') => describeRecurrence([line], start, LA);
    expect(describeRecurrence([], '2026-10-26')).toBe('Does not repeat');
    expect(say('RRULE:FREQ=DAILY')).toBe('Daily');
    expect(say('RRULE:FREQ=DAILY;INTERVAL=3')).toBe('Every 3 days');
    expect(say('RRULE:FREQ=WEEKLY')).toBe('Weekly on Monday');
    expect(say('RRULE:FREQ=WEEKLY;BYDAY=MO,WE')).toBe('Weekly on Monday, Wednesday');
    expect(say('RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU')).toBe('Every 2 weeks on Tuesday');
    expect(say('RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')).toBe('Weekly on weekdays');
    expect(say('RRULE:FREQ=MONTHLY;BYDAY=4MO')).toBe('Monthly on the fourth Monday');
    expect(say('RRULE:FREQ=MONTHLY;BYDAY=-1FR')).toBe('Monthly on the last Friday');
    expect(say('RRULE:FREQ=MONTHLY')).toBe('Monthly on day 26');
    expect(say('RRULE:FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=5')).toBe('Every 3 months on day 5');
    expect(say('RRULE:FREQ=YEARLY')).toBe('Annually on October 26');
    expect(say('RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10')).toBe('Weekly on Monday, 10 times');
    expect(say('RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261231T075959Z')).toBe('Weekly on Monday, until Dec 30, 2026');
    expect(say('RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20270101T075959Z')).toBe('Weekly on Monday, until Dec 31, 2026');
    expect(say('RRULE:FREQ=DAILY;UNTIL=20261231')).toBe('Daily, until Dec 31, 2026');
    expect(describeRecurrence(['RRULE:FREQ=SECONDLY'], '2026-10-26')).toBe('Repeats (a custom rule)');
  });
  test('UNTIL just before an occurrence, and on a day', () => {
    expect(untilBefore({ dateTime: '2026-11-02T09:00:00-08:00' })).toBe('20261102T165959Z');
    expect(untilBefore({ date: '2026-11-02' })).toBe('20261101');
    expect(untilOn('2026-12-31', false, LA)).toBe('20270101T075959Z');
    expect(untilOn('2026-12-31', true, LA)).toBe('20261231');
    expect(untilDate('20270101T075959Z', LA)).toBe('2026-12-31');
    expect(untilDate('20261231', LA)).toBe('2026-12-31');
  });
});

describe('moving every event of a series to another day', () => {
  const shift = (line: string, from: string, to: string) => {
    const shifted = shiftRule(parseRRule(line)!, from, to);
    return shifted ? formatRRule(shifted) : null;
  };
  test('weekdays and month days follow the move', () => {
    expect(shift('RRULE:FREQ=WEEKLY;BYDAY=MO', '2026-10-26', '2026-10-27')).toBe('RRULE:FREQ=WEEKLY;BYDAY=TU');
    expect(shift('RRULE:FREQ=WEEKLY;BYDAY=MO,WE', '2026-10-26', '2026-10-25')).toBe('RRULE:FREQ=WEEKLY;BYDAY=SU,TU');
    expect(shift('RRULE:FREQ=WEEKLY;BYDAY=FR', '2026-10-30', '2026-11-02')).toBe('RRULE:FREQ=WEEKLY;BYDAY=MO');
    expect(shift('RRULE:FREQ=DAILY', '2026-10-26', '2026-10-28')).toBe('RRULE:FREQ=DAILY');
    expect(shift('RRULE:FREQ=MONTHLY;BYMONTHDAY=26', '2026-10-26', '2026-10-28')).toBe('RRULE:FREQ=MONTHLY;BYMONTHDAY=28');
    expect(shift('RRULE:FREQ=MONTHLY;BYDAY=4MO', '2026-10-26', '2026-10-20')).toBe('RRULE:FREQ=MONTHLY;BYDAY=3TU');
    expect(shift('RRULE:FREQ=MONTHLY;BYDAY=-1MO', '2026-10-26', '2026-10-27')).toBe('RRULE:FREQ=MONTHLY;BYDAY=-1TU');
    expect(shift('RRULE:FREQ=YEARLY', '2026-10-26', '2026-10-27')).toBe('RRULE:FREQ=YEARLY');
    expect(shift('RRULE:FREQ=WEEKLY;BYDAY=MO', '2026-10-26', '2026-10-26')).toBe('RRULE:FREQ=WEEKLY;BYDAY=MO');
  });
  test('rules it cannot carry over say so', () => {
    expect(shift('RRULE:FREQ=MONTHLY;BYDAY=MO;BYSETPOS=2', '2026-10-26', '2026-10-27')).toBeNull();
    expect(shift('RRULE:FREQ=MONTHLY;BYMONTHDAY=1,15', '2026-10-15', '2026-10-16')).toBeNull();
    expect(shift('RRULE:FREQ=YEARLY;BYDAY=1MO;BYMONTH=9', '2026-09-07', '2026-09-08')).toBeNull();
  });
});

describe('the custom recurrence dialog', () => {
  test('fields from a rule, and a rule from fields', () => {
    expect(customOf([], '2026-10-26', LA)).toEqual({ freq: 'WEEKLY', interval: 1, weekdays: [1], monthly: 'day', ends: { kind: 'never' } });
    expect(customOf(['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=WE,MO;COUNT=6'], '2026-10-26', LA)).toEqual({ freq: 'WEEKLY', interval: 2, weekdays: [1, 3], monthly: 'day', ends: { kind: 'after', count: 6 } });
    expect(customOf(['RRULE:FREQ=MONTHLY;BYDAY=4MO;UNTIL=20270101T075959Z'], '2026-10-26', LA)).toMatchObject({ freq: 'MONTHLY', monthly: 'weekday', ends: { kind: 'on', date: '2026-12-31' } });
    expect(customRule({ freq: 'WEEKLY', interval: 2, weekdays: [3, 1], monthly: 'day', ends: { kind: 'after', count: 6 } }, '2026-10-26', false, LA)).toBe('RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=6');
    expect(customRule({ freq: 'MONTHLY', interval: 1, weekdays: [], monthly: 'weekday', ends: { kind: 'on', date: '2026-12-31' } }, '2026-10-26', false, LA)).toBe('RRULE:FREQ=MONTHLY;BYDAY=4MO;UNTIL=20270101T075959Z');
    expect(customRule({ freq: 'MONTHLY', interval: 1, weekdays: [], monthly: 'day', ends: { kind: 'never' } }, '2026-10-26', true, LA)).toBe('RRULE:FREQ=MONTHLY;BYMONTHDAY=26');
    expect(customRule({ freq: 'DAILY', interval: 0, weekdays: [], monthly: 'day', ends: { kind: 'on', date: '2026-10-01' } }, '2026-10-26', true, LA)).toBe('RRULE:FREQ=DAILY;UNTIL=20261026');
    expect(monthlyLabels('2026-10-26')).toEqual({ day: 'Monthly on day 26', weekday: 'Monthly on the fourth Monday' });
  });
});
