// A Google task's form saved against the baseline it showed (review 10, P0):
// what it changed, what changed meanwhile too, how a conflict is settled, and
// what Edit → All tasks and one occurrence's editor show.
import { describe, expect, test } from 'bun:test';
import type { GoogleTaskItem } from '../src/domain/google.ts';
import { formChanges, formConflicts, formValuesOf, occurrenceNow, seriesShown, settleConflicts, withOccurrence, type FormValues } from '../src/domain/gtaskForm.ts';
import { templateOf } from '../src/domain/gtaskKept.ts';
import type { GoogleTaskKept } from '../src/domain/types.ts';

const ME = 'me@example.com';
const item = (patch: Partial<GoogleTaskItem> = {}): GoogleTaskItem => ({ account: ME, listId: 'L1', id: 'gt1', title: 'Focus', notes: 'Series notes', due: '2026-10-29', completed: false, completedAt: null, parent: null, position: '0', updated: '2026-10-29T08:00:00.000Z', ...patch }) as GoogleTaskItem;
const template = templateOf({ title: 'Focus', notes: 'Series notes' }, { time: 540, duration: null, deadline: null }, '2026-10-29');
const kept = (patch: Partial<GoogleTaskKept> = {}): GoogleTaskKept => ({
  account: ME,
  listId: 'L1',
  taskId: 'gt1',
  time: 540,
  duration: null,
  deadline: null,
  repeat: { rule: 'RRULE:FREQ=DAILY', seriesId: 's1', index: 1, next: null, on: '2026-10-29', template },
  starredAt: null,
  updatedAt: '2026-10-29T08:00:00.000Z',
  ...patch,
});
const shown = formValuesOf(item(), kept());
const DOC = { id: 'd1', title: 'Plan', mimeType: 'application/vnd.google-apps.document', url: 'https://docs.google.com/document/d/d1/edit' };

describe("a task's form against what it showed", () => {
  test('a task as its form shows it: no end with a repeat, no availability or declining without a time', () => {
    expect(shown).toMatchObject({ title: 'Focus', due: '2026-10-29', time: 540, duration: null, rule: 'RRULE:FREQ=DAILY', busy: false, visibility: 'default', starred: false, listId: 'L1' });
    const untimed = formValuesOf(item(), kept({ time: null, duration: 30, busy: true, visibility: 'private', decline: { mode: 'new', message: 'No', since: '2026-10-29T08:00:00.000Z' }, doNotDisturb: true, repeat: null }));
    expect(untimed).toMatchObject({ time: null, duration: null, busy: false, visibility: 'default', decline: null, doNotDisturb: false });
    expect(formValuesOf(item({ due: null }), kept()).rule).toBeNull();
  });

  test('what it changed: only the fields the user changed, a time and its end as one', () => {
    expect(formChanges(shown, { ...shown, title: 'Focus time' })).toEqual(['title']);
    expect(formChanges(shown, shown)).toEqual([]);
    const timed = formValuesOf(item(), kept({ repeat: null, duration: 30 }));
    expect(formChanges(timed, { ...timed, duration: 60 })).toEqual(['time']);
    // Attachments by their files, declining by its mode and message (not since when).
    expect(formChanges({ ...shown, attachments: [DOC] }, { ...shown, attachments: [{ ...DOC, title: 'Plan (renamed)' }] })).toEqual([]);
    expect(formChanges({ ...shown, decline: { mode: 'new', message: 'No', since: 'a' } }, { ...shown, decline: { mode: 'new', message: 'No', since: 'b' } })).toEqual([]);
  });

  test("a field left alone never conflicts, nor one changed elsewhere to the form's own value; one changed both ways does", () => {
    // Another window moved it to 1pm; the form renamed it only.
    const now = { ...shown, time: 780 };
    expect(formConflicts(shown, { ...shown, title: 'Focus time' }, now)).toEqual([]);
    // The form moved it to 1pm too: no conflict.
    expect(formConflicts(shown, { ...shown, time: 780 }, now)).toEqual([]);
    // The form moved it to 10am: a conflict.
    expect(formConflicts(shown, { ...shown, time: 600 }, now)).toEqual(['time']);
    // The series cut short meanwhile, the form's repeat changed to weekly: a conflict; left alone: none.
    const cut = { ...shown, rule: 'RRULE:FREQ=DAILY;UNTIL=20261030' };
    expect(formConflicts(shown, { ...shown, rule: 'RRULE:FREQ=WEEKLY' }, cut)).toEqual(['rule']);
    expect(formConflicts(shown, { ...shown, title: 'Focus time' }, cut)).toEqual([]);
  });

  test("settled: theirs takes what each is now, mine keeps the form's; either way the baseline moves on to now", () => {
    const mine = { ...shown, title: 'Focus time', time: 600 };
    const now: FormValues = { ...shown, time: 780, duration: null };
    const theirs = settleConflicts(shown, mine, now, ['time'], 'theirs');
    expect(theirs.mine).toMatchObject({ title: 'Focus time', time: 780 });
    expect(formChanges(theirs.base, theirs.mine)).toEqual(['title']);
    const kept = settleConflicts(shown, mine, now, ['time'], 'mine');
    expect(kept.mine.time).toBe(600);
    expect(formChanges(kept.base, kept.mine)).toEqual(['title', 'time']);
    expect(formConflicts(kept.base, kept.mine, now)).toEqual([]);
  });

  test("Edit → All tasks shows the template on the open task's date; one occurrence's editor, that occurrence", () => {
    const series = seriesShown(item({ title: 'Focus (this one)' }), kept({ time: 660, repeat: { ...kept().repeat!, template: { ...template, deadline: 2, color: '#d50000' } } }), '2026-10-29T09:00:00.000Z')!;
    expect(formValuesOf(series.item, series.kept)).toMatchObject({ title: 'Focus', time: 540, deadline: '2026-10-31', color: '#d50000' });
    const values = withOccurrence(shown, { title: 'Focus late', notes: 'Series notes', due: '2026-10-31', time: 900, duration: null, deadline: null, attachments: [DOC] });
    expect(values).toMatchObject({ title: 'Focus late', due: '2026-10-31', time: 900, attachments: [DOC], rule: 'RRULE:FREQ=DAILY' });
  });

  test('one occurrence as the plan has it now: from its series, as the task the series made meanwhile, or none once deleted alone', () => {
    const head = kept({ repeat: { ...kept().repeat!, exceptions: { '2026-10-30': { title: 'Focus with Ann' }, '2026-10-31': { skip: true } } } });
    const state = { googleTasks: { [`${ME}\ngt1`]: head } };
    expect(occurrenceNow(state, ME, 's1', '2026-10-30', 'gt1')).toEqual({ values: { title: 'Focus with Ann', notes: 'Series notes', due: '2026-10-30', time: 540, duration: null, deadline: null, attachments: [] } });
    expect(occurrenceNow(state, ME, 's1', '2026-10-31', 'gt1')).toBeNull();
    const made = kept({ taskId: 'gt2', repeat: { ...kept().repeat!, index: 2, on: '2026-10-30' } });
    const later = { googleTasks: { [`${ME}\ngt1`]: { ...head, repeat: { ...head.repeat!, next: 'gt2' } }, [`${ME}\ngt2`]: made } };
    expect(occurrenceNow(later, ME, 's1', '2026-10-30', 'gt1')).toEqual({ task: made });
    expect(occurrenceNow(later, ME, 'other', '2026-10-30')).toBeNull();
  });
});
