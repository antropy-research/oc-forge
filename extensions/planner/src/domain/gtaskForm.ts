// A Google task's form saved as an edit of what it showed when it opened (its
// baseline), never as a copy of everything it shows: another window, or the
// service, may have changed the task or its series since, and a field the form
// left alone keeps that newer value (its time, its repeat cut short, ...). A
// field the form changed that changed elsewhere too since it opened is a
// conflict, which the user settles (keep theirs, or save mine), never one side
// silently. Pure: the panel's forms and its tests use it.
import type { DeclineInput } from './events.ts';
import type { GoogleTaskItem } from './google.ts';
import { addDays } from './dates.ts';
import { occurrenceValues, seriesTemplate, type OccurrenceValues } from './gtaskKept.ts';
import type { DateKey, GoogleTaskKept, GoogleTaskTemplate, PlannerState, TaskAttachment, TaskVisibility } from './types.ts';

/** What a task's form shows of a task, and sends: Google's fields, what the Planner keeps for it, its star and its list. */
export interface FormValues {
  title: string;
  notes: string;
  due: DateKey | null;
  time: number | null;
  duration: number | null;
  deadline: DateKey | null;
  rule: string | null;
  busy: boolean;
  visibility: TaskVisibility;
  color: string | null;
  attachments: TaskAttachment[];
  doNotDisturb: boolean;
  decline: DeclineInput | null;
  starred: boolean;
  listId: string;
}

/** A form's fields, one each: `time` is a time and its end together, as Google Calendar sets them. */
export const FORM_FIELDS = ['title', 'notes', 'due', 'time', 'deadline', 'rule', 'busy', 'visibility', 'color', 'attachments', 'doNotDisturb', 'decline', 'starred', 'listId'] as const;
export type FormField = (typeof FORM_FIELDS)[number];

/** A series' own settings, as Google Calendar keeps one for all its tasks: changing one is for all of them. */
export const SERIES_FIELDS: readonly FormField[] = ['rule', 'busy', 'visibility', 'color', 'doNotDisturb', 'decline'];

/** Google's own fields of a task, which Google's apps change too; the rest only the Planner keeps. */
export const GOOGLE_FIELDS: readonly FormField[] = ['title', 'notes', 'due'];

/**
 * A task as its form shows it, with the form's own rules: a time only with a
 * date, an end only without a repeat, availability, visibility and Do not
 * disturb only with a time, declining only Busy.
 */
export const formValuesOf = (item: Pick<GoogleTaskItem, 'title' | 'notes' | 'due' | 'listId'>, kept: GoogleTaskKept | null): FormValues => {
  const rule = item.due ? kept?.repeat?.rule ?? null : null;
  const time = item.due ? kept?.time ?? null : null;
  const timed = time !== null;
  const busy = timed && Boolean(kept?.busy);
  return {
    title: item.title,
    notes: item.notes,
    due: item.due,
    time,
    duration: timed && !rule ? kept?.duration ?? null : null,
    deadline: kept?.deadline ?? null,
    rule,
    busy,
    visibility: timed ? kept?.visibility ?? 'default' : 'default',
    color: kept?.color ?? null,
    attachments: kept?.attachments ?? [],
    doNotDisturb: timed && Boolean(kept?.doNotDisturb),
    decline: busy ? kept?.decline ?? null : null,
    starred: Boolean(kept?.starredAt),
    listId: item.listId,
  };
};

/** Whether a field has the same value in both: a time with its end, attachments by their files, declining by its mode and message (not since when). */
export const sameFormValue = (field: FormField, a: FormValues, b: FormValues): boolean => {
  if (field === 'time') return a.time === b.time && a.duration === b.duration;
  if (field === 'attachments') return a.attachments.map((file) => file.id).join('\n') === b.attachments.map((file) => file.id).join('\n');
  if (field === 'decline') return (a.decline?.mode ?? null) === (b.decline?.mode ?? null) && (a.decline?.message ?? null) === (b.decline?.message ?? null);
  return a[field] === b[field];
};

/** The fields a form changed: its values against the baseline it showed. */
export const formChanges = (base: FormValues, mine: FormValues): FormField[] => FORM_FIELDS.filter((field) => !sameFormValue(field, mine, base));

/** Each field the form changed that is now neither what the form showed nor what the form has: changed elsewhere too, otherwise. */
export const formConflicts = (base: FormValues, mine: FormValues, now: FormValues): FormField[] =>
  formChanges(base, mine).filter((field) => !sameFormValue(field, now, base) && !sameFormValue(field, now, mine));

/**
 * Conflicts settled: `theirs` takes the value each has now (the form leaves it
 * as it is), `mine` keeps the form's to save over it. Either way that value is
 * the baseline now, so the save is the form's change over the task as it is.
 */
export const settleConflicts = (base: FormValues, mine: FormValues, now: FormValues, fields: readonly FormField[], choice: 'theirs' | 'mine'): { base: FormValues; mine: FormValues } => {
  const nextBase: Record<string, unknown> = { ...base };
  const nextMine: Record<string, unknown> = { ...mine };
  for (const field of fields.flatMap((one) => (one === 'time' ? (['time', 'duration'] as const) : [one]))) {
    nextBase[field] = now[field];
    if (choice === 'theirs') nextMine[field] = now[field];
  }
  return { base: nextBase as unknown as FormValues, mine: nextMine as unknown as FormValues };
};

/** A template's advanced settings and attachments, as a task's kept fields: what the series gives each task it makes. */
export const templateAdvanced = (template: GoogleTaskTemplate, kept: GoogleTaskKept | null, at: string) => ({
  busy: template.busy,
  visibility: template.visibility,
  color: template.color,
  doNotDisturb: template.doNotDisturb,
  // Declining stays on since it was turned on, for the series as for a task.
  decline: template.decline ? { ...template.decline, since: template.decline.since ?? kept?.decline?.since ?? kept?.updatedAt ?? at } : undefined,
  attachments: template.attachments,
});

/**
 * What Edit → All tasks shows of a series, from its open task: the template's
 * title, details, time, deadline (as many days after the task's date) and
 * advanced settings, on the task's date; null without a template.
 */
export const seriesShown = (item: GoogleTaskItem, kept: GoogleTaskKept, at = new Date().toISOString()): { item: GoogleTaskItem; kept: GoogleTaskKept } | null => {
  const template = seriesTemplate(kept, item);
  if (!template) return null;
  return {
    item: { ...item, title: template.title, notes: template.notes },
    kept: {
      ...kept,
      time: template.time,
      duration: template.duration,
      deadline: template.deadline !== null && item.due ? addDays(item.due, template.deadline) : null,
      ...templateAdvanced(template, kept, at),
    },
  };
};

/** A form's values with one occurrence's own over them (what its editor shows of it). */
export const withOccurrence = (values: FormValues, occurrence: OccurrenceValues): FormValues => ({
  ...values,
  title: occurrence.title,
  notes: occurrence.notes,
  due: occurrence.due,
  time: occurrence.time,
  duration: occurrence.time === null ? null : occurrence.duration,
  deadline: occurrence.deadline,
  attachments: occurrence.attachments ?? values.attachments,
});

/** An occurrence's values as a form has them. */
export const occurrenceOf = (values: FormValues, on: DateKey): OccurrenceValues => ({
  title: values.title,
  notes: values.notes,
  due: values.due ?? on,
  time: values.time,
  duration: values.time === null ? null : values.duration,
  deadline: values.deadline,
  attachments: values.attachments,
});

/**
 * One occurrence of a series (the one it puts on `on`) as the plan has it now:
 * the task the series made for it meanwhile, else its values from the open
 * task the series goes on from (`from`, or another open one); null when it
 * was deleted alone or its series is gone.
 */
export const occurrenceNow = (state: Pick<PlannerState, 'googleTasks'>, account: string, seriesId: string, on: DateKey, from?: string): { task: GoogleTaskKept } | { values: OccurrenceValues } | null => {
  const entries = Object.values(state.googleTasks ?? {}).filter((entry) => entry.account === account && entry.repeat?.seriesId === seriesId);
  const made = entries.find((entry) => entry.repeat!.on === on);
  if (made) return { task: made };
  const open = entries.filter((entry) => !entry.repeat!.next && entry.repeat!.template);
  const head = open.find((entry) => entry.taskId === from) ?? open[0];
  const change = head?.repeat?.exceptions?.[on];
  if (!head || change?.skip) return null;
  return { values: occurrenceValues(head.repeat!.template!, on, change) };
};
