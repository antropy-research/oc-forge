// Round 11: printing. Google Tasks' Print list (List options → Print list, or
// Ctrl/⌘+P; https://support.google.com/tasks/answer/12298851): the list's
// title, its open tasks in its order with subtasks under their task, each with
// its date and time, repeat, deadline, star and details, and its completed
// tasks only when Completed is open. Google Calendar's Print (Settings → Print;
// https://support.google.com/calendar/answer/41067): the preview's range,
// options and pages for Day, Week, Month and Schedule.
import { describe, expect, test } from 'bun:test';
import type { GoogleTaskItem } from '../src/domain/google.ts';
import type { GoogleTaskKept } from '../src/domain/types.ts';
import { printedList, type ListToPrint } from '../src/domain/gtaskPrint.ts';
import { defaultPrintOptions, pageOrientation, printHours, printLayout, printPages, printRange } from '../src/domain/calendarPrint.ts';
import { viewDays } from '../src/domain/gcalendar.ts';

const ME = 'me@example.com';
const TODAY = '2026-10-29';
const ZONE = 'America/Los_Angeles';
const item = (id: string, patch: Partial<GoogleTaskItem> = {}): GoogleTaskItem => ({
  account: ME, listId: 'L1', id, title: id, notes: '', due: null, completed: false, parent: null, position: id, url: `https://tasks.google.com/task/${id}`, updated: '2026-10-28T15:00:00.000Z', ...patch,
});
const kept = (taskId: string, patch: Partial<GoogleTaskKept>): GoogleTaskKept => ({ account: ME, listId: 'L1', taskId, time: null, duration: null, deadline: null, updatedAt: '2026-10-28T15:00:00.000Z', ...patch }) as GoogleTaskKept;

describe("Print list: the list as Google Tasks prints it", () => {
  const items = [
    item('a-report', { title: 'Send the report', notes: 'Numbers from Q3\nand the forecast', due: TODAY }),
    item('b-slides', { title: 'Slides', parent: 'a-report', position: 'b1' }),
    item('c-call', { title: 'Call the bank', due: '2026-10-27' }),
    item('d-trip', { title: 'Plan the trip', due: '2026-11-03' }),
    item('e-done', { title: 'Book the room', completed: true, completedAt: '2026-10-28T09:00:00.000Z' }),
    item('f-sub-done', { title: 'Old subtask', parent: 'a-report', completed: true, completedAt: '2026-10-27T09:00:00.000Z' }),
  ];
  const keeps: Record<string, GoogleTaskKept> = {
    'a-report': kept('a-report', { time: 14 * 60, duration: 60, deadline: '2026-10-31', starredAt: '2026-10-28T10:00:00.000Z' }),
    'd-trip': kept('d-trip', { repeat: { rule: 'RRULE:FREQ=WEEKLY', seriesId: 's', index: 1, next: null, on: '2026-11-03' } as GoogleTaskKept['repeat'] }),
  };
  const list = (patch: Partial<ListToPrint> = {}): ListToPrint => ({ title: 'Work', account: null, items, kept: (one) => keeps[one.id] ?? null, sort: 'mine', today: TODAY, zone: ZONE, showCompleted: false, complete: true, ...patch });

  test('every open task in its order, each subtask under its task; its date and time, deadline, star, repeat and whole details', () => {
    const sheet = printedList(list());
    expect(sheet.title).toBe('Work');
    expect(sheet.sections).toHaveLength(1);
    expect(sheet.sections[0]!.tasks.map((task) => [task.title, task.depth])).toEqual([
      ['Send the report', 0],
      ['Slides', 1],
      ['Call the bank', 0],
      ['Plan the trip', 0],
    ]);
    const [report, , call, trip] = sheet.sections[0]!.tasks;
    expect(report).toMatchObject({ notes: 'Numbers from Q3\nand the forecast', starred: true, deadline: 'Deadline Sat, Oct 31', overdue: false, completed: null });
    expect(report!.due).toStartWith('Today, ');
    expect(call).toMatchObject({ due: 'Tue, Oct 27', overdue: true, starred: false, deadline: null, repeat: null });
    expect(trip!.repeat).toStartWith('Repeats ');
    expect(trip!.due).toBe('Tue, Nov 3');
  });

  test('completed tasks print only while the Completed section is open, the latest first; their count either way', () => {
    expect(printedList(list()).completed).toBeNull();
    expect(printedList(list()).completedCount).toBe(2);
    const open = printedList(list({ showCompleted: true }));
    expect(open.completed!.map((task) => [task.title, task.completed])).toEqual([
      ['Book the room', 'Completed: Yesterday'],
      ['Old subtask', 'Completed: Tue, Oct 27'],
    ]);
  });

  test('sorted by date it prints by date, with the headings the list shows; by title, A to Z', () => {
    const byDate = printedList(list({ sort: 'date' }));
    expect(byDate.sections.map((section) => [section.heading, section.tasks.map((task) => task.title)])).toEqual([
      ['Past', ['Call the bank']],
      ['Today', ['Send the report']],
      ['Tue, Nov 3', ['Plan the trip']],
      ['No date', ['Slides']],
    ]);
    expect(printedList(list({ sort: 'title' })).sections[0]!.tasks.map((task) => task.title)).toEqual(['Call the bank', 'Plan the trip', 'Send the report', 'Slides']);
  });

  test("a list longer than the Planner reads says so on paper; Starred prints in its order, with each task's list", () => {
    expect(printedList(list({ complete: false })).partial).toBe(true);
    const starred = printedList(list({ title: 'Starred', sort: 'shown', items: [items[3]!, items[0]!], listOf: (one) => (one.id === 'd-trip' ? 'Home' : 'Work') }));
    expect(starred.sections[0]!.tasks.map((task) => [task.title, task.list])).toEqual([['Plan the trip', 'Home'], ['Send the report', 'Work']]);
  });
});

describe("Google Calendar's Print: the preview's range and options, and each view's pages", () => {
  test('the print range is the range the calendar shows: a day, its week, its month, its year, the Schedule\'s stretch', () => {
    expect(printRange('day', TODAY, viewDays('day', TODAY, 0))).toEqual({ from: TODAY, to: TODAY });
    expect(printRange('week', TODAY, viewDays('week', TODAY, 0))).toEqual({ from: '2026-10-25', to: '2026-10-31' });
    expect(printRange('week', TODAY, viewDays('week', TODAY, 1, false))).toEqual({ from: '2026-10-26', to: '2026-10-30' });
    expect(printRange('month', TODAY, viewDays('month', TODAY, 0))).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(printRange('year', TODAY, [])).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    expect(printRange('schedule', TODAY, viewDays('schedule', TODAY, 0))).toEqual({ from: TODAY, to: '2026-11-27' });
  });

  test("it opens with Google's defaults: View Auto, Font size Normal, Orientation Auto, Outline, weekends and declined events as shown", () => {
    expect(defaultPrintOptions('week', TODAY, viewDays('week', TODAY, 0), { weekends: false, declined: true })).toEqual({
      from: '2026-10-25', to: '2026-10-31', view: 'auto', fontSize: 'normal', orientation: 'auto', color: 'outline', weekends: false, declined: true, descriptions: false, responses: false,
    });
    expect([printLayout('auto', 'week'), printLayout('auto', 'year'), printLayout('schedule', 'week')]).toEqual(['week', 'month', 'schedule']);
    expect([pageOrientation('auto', 'week'), pageOrientation('auto', 'month'), pageOrientation('auto', 'day'), pageOrientation('auto', 'schedule'), pageOrientation('portrait', 'month')]).toEqual(['landscape', 'landscape', 'portrait', 'portrait', 'portrait']);
  });

  test('Day prints a day a page; Week a week a page (weekends as chosen); Month a month a page; Schedule one run', () => {
    expect(printPages('day', '2026-10-30', '2026-11-02', 0, true).map((page) => page.title)).toEqual(['Friday, October 30, 2026', 'Saturday, October 31, 2026', 'Sunday, November 1, 2026', 'Monday, November 2, 2026']);
    expect(printPages('day', '2026-10-30', '2026-11-02', 0, false).map((page) => page.days[0])).toEqual(['2026-10-30', '2026-11-02']);
    const weeks = printPages('week', '2026-10-28', '2026-11-10', 0, true);
    expect(weeks.map((page) => [page.title, page.days.length])).toEqual([
      ['Oct 28 – Oct 31, 2026', 4],
      ['Nov 1 – Nov 7, 2026', 7],
      ['Nov 8 – Nov 10, 2026', 3],
    ]);
    expect(printPages('week', '2026-11-01', '2026-11-07', 0, false)[0]!.days).toEqual(['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06']);
    const months = printPages('month', '2026-10-15', '2026-11-20', 0, true);
    expect(months.map((page) => [page.title, page.days[0], page.days.at(-1), page.weeks!.length])).toEqual([
      ['October 2026', '2026-10-15', '2026-10-31', 5],
      ['November 2026', '2026-11-01', '2026-11-20', 5],
    ]);
    expect(printPages('schedule', TODAY, '2026-11-27', 0, true).map((page) => [page.title, page.days.length])).toEqual([['Oct 29 – Nov 27, 2026', 30]]);
    expect(printPages('week', '2026-11-02', '2026-11-01', 0, true)).toEqual([]);
  });

  test("a Day or Week page draws 8 AM to 6 PM, or its events' hours beyond them", () => {
    expect(printHours([])).toEqual({ first: 8, last: 18 });
    expect(printHours([{ start: 7 * 60 + 30, end: 9 * 60 }, { start: 20 * 60, end: 21 * 60 + 15 }])).toEqual({ first: 7, last: 22 });
  });
});
