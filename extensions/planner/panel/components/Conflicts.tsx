// What an edit says when something it changed was changed elsewhere too while
// it was open (in another window, by the service, in Google's own apps): what
// that is now and what this edit has, with Keep theirs and Save mine, as an
// editor asks; never one side silently. For a Google task's form
// (`TaskConflict`) and for the Planner's own fields edited in place
// (`useDraft`: a task's notes, title and planned time, a subtask's title).
import { useState } from 'preact/hooks';
import { GOOGLE_FIELDS, type FormField, type FormValues } from '../../src/domain/gtaskForm.ts';
import { VISIBILITY_LABELS, keptTimeLabel } from '../../src/domain/gtaskKept.ts';
import { colorName } from '../../src/domain/gtaskAdvanced.ts';
import { longDay } from '../../src/domain/gcalendar.ts';
import { describeRecurrence } from '../../src/domain/rrule.ts';
import type { GoogleTaskList } from '../../src/domain/google.ts';
import type { DateKey } from '../../src/domain/types.ts';
import type { TaskConflict } from '../lib/google.ts';

/** Changed elsewhere while it was edited here: each change, and the two ways on. */
export const ConflictBanner = ({ lines, onTheirs, onMine }: { lines: readonly string[]; onTheirs: () => void; onMine: () => void }) => (
  <div class="banner is-warning edit-conflict" role="alert">
    <ul>
      {lines.map((line) => <li key={line}>{line}</li>)}
    </ul>
    <span class="edit-conflict-actions">
      <button class="link" onClick={onTheirs}>Keep theirs</button>
      <button class="link" onClick={onMine}>Save mine</button>
    </span>
  </div>
);

/** A text as a conflict quotes it: on one line, cut short when long. */
export const quoted = (text: string): string => {
  const line = text.replace(/\s+/g, ' ').trim();
  return `“${line.length > 60 ? `${line.slice(0, 59)}…` : line}”`;
};

const LABELS: Record<FormField, string> = {
  title: 'Title',
  notes: 'Details',
  due: 'Date',
  time: 'Time',
  deadline: 'Deadline',
  rule: 'Repeat',
  busy: 'Availability',
  visibility: 'Visibility',
  color: 'Color',
  attachments: 'Attachments',
  doNotDisturb: 'Do not disturb',
  decline: 'Automatically decline meetings',
  starred: 'Star',
  listId: 'List',
};

interface Context {
  zone: string;
  today: DateKey;
  lists: readonly GoogleTaskList[];
}

/** A field's value as the form says it: "1pm", "Daily, until Oct 30, 2026", "Saturday, October 31". */
const valueText = (field: FormField, values: FormValues, context: Context): string => {
  switch (field) {
    case 'title':
      return quoted(values.title);
    case 'notes':
      return values.notes.trim() ? quoted(values.notes) : 'none';
    case 'due':
      return values.due ? longDay(values.due) : 'no date';
    case 'time':
      return keptTimeLabel(values) ?? 'all day';
    case 'deadline':
      return values.deadline ? longDay(values.deadline) : 'none';
    case 'rule':
      return values.rule ? describeRecurrence([values.rule], values.due ?? context.today, context.zone) : 'Does not repeat';
    case 'busy':
      return values.busy ? 'Busy' : 'Free';
    case 'visibility':
      return VISIBILITY_LABELS[values.visibility];
    case 'color':
      return values.color ? colorName(values.color) : "its list's";
    case 'attachments':
      return values.attachments.length ? values.attachments.map((file) => quoted(file.title)).join(', ') : 'none';
    case 'doNotDisturb':
      return values.doNotDisturb ? 'on' : 'off';
    case 'decline':
      return values.decline ? (values.decline.mode === 'all' ? 'new and existing meetings' : 'only new meeting invitations') : 'off';
    case 'starred':
      return values.starred ? 'starred' : 'not starred';
    case 'listId':
      return context.lists.find((list) => list.id === values.listId)?.title ?? 'another list';
  }
};

/**
 * What a Google task's form says of a conflict, one line a field: "Time was
 * changed to 1pm in another window (yours: 10am)". Google's own fields may
 * have been changed in Google Tasks too.
 */
export const taskConflictLines = (conflict: Pick<TaskConflict, 'fields' | 'now' | 'mine'>, context: Context): string[] =>
  conflict.fields.map(
    (field) => `${LABELS[field]} was changed to ${valueText(field, conflict.now, context)} ${GOOGLE_FIELDS.includes(field) ? 'in Google Tasks or another window' : 'in another window'} (yours: ${valueText(field, conflict.mine, context)})`,
  );

/**
 * A field edited in place over a value that may change elsewhere meanwhile.
 * Its draft starts from the value when editing begins (its baseline). When
 * editing ends, a draft left as it was saves nothing (the value as it is now
 * shows), a changed one is saved unless the value changed elsewhere
 * meanwhile too, as the plan has it then (`latest`), which is asked
 * (`conflict`: `theirs` drops the draft, `mine` saves it).
 */
export const useDraft = <T,>(value: T, save: (value: T) => void, latest: () => Promise<T>, same: (a: T, b: T) => boolean = Object.is) => {
  const [draft, setDraft] = useState<{ base: T; mine: T } | null>(null);
  const [conflict, setConflict] = useState<{ theirs: T; mine: T } | null>(null);
  const done = () => {
    setDraft(null);
    setConflict(null);
  };
  return {
    /** What the field shows: the draft while there is one, else the value as it is. */
    shown: draft ? draft.mine : value,
    conflict,
    begin: () => setDraft((current) => current ?? { base: value, mine: value }),
    change: (mine: T) => setDraft((current) => ({ base: current?.base ?? value, mine })),
    /** Editing ends (the field left, Enter): with `mine`, the draft's last value when the field gives it. */
    end: async (mine?: T) => {
      if (!draft) return;
      const typed = mine === undefined ? draft.mine : mine;
      if (same(typed, draft.base)) return done();
      setDraft({ base: draft.base, mine: typed });
      const now = await latest().catch(() => value);
      if (same(now, draft.base) || same(now, typed)) {
        if (!same(now, typed)) save(typed);
        return done();
      }
      setConflict({ theirs: now, mine: typed });
    },
    theirs: done,
    mine: () => {
      if (conflict) save(conflict.mine);
      done();
    },
    /** The draft dropped (Escape): the value as it is shows. */
    cancel: done,
  };
};
