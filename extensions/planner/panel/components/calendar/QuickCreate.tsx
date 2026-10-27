// Google Calendar's quick create: a click or drag on the grid opens it with
// that time. An Event goes to a Google calendar; a Task is planned in the
// Planner at that time (a working session) and, as in Google Calendar, added to
// a Google Tasks list due that day.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { EventInput } from '../../../src/domain/gevents.ts';
import { gtaskSource } from '../../../src/domain/google.ts';
import { addDays, instantAt, isDateKey } from '../../../src/domain/dates.ts';
import { edgePosition } from '../../../src/domain/selectors.ts';
import { newId } from '../../../src/domain/ids.ts';
import type { EventBody } from '../../../src/domain/events.ts';
import { useGoogle, usePlanner, useView } from '../../lib/context.ts';
import { useUi } from '../../lib/ui.ts';
import { addEvent, calendarUi, useCalendarUi, type Draft } from '../../lib/gcal.ts';
import { Icon } from './Icon.tsx';
import { Popover } from './Popover.tsx';
import { defaultCalendar, defaultList, endChoices, listKeyOf, startChoices, writableCalendars } from './form.ts';

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const QuickCreate = ({ draft }: { draft: Draft }) => {
  const { client, google } = usePlanner();
  const view = useView();
  const gv = useGoogle();
  const { prefs } = useCalendarUi();
  const { setUi } = useUi();
  const zone = view.state.settings.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const calendarAccounts = gv.status ? google.accountsWith('calendar').length : 0;
  useEffect(() => {
    if (calendarAccounts && !gv.calendars.length) void google.loadCalendars();
  }, [calendarAccounts]);
  const writable = writableCalendars(gv.calendars, view.state.calendars);
  const [kind, setKind] = useState(draft.kind);
  const [title, setTitle] = useState('');
  const [allDay, setAllDay] = useState(draft.start === null);
  const [date, setDate] = useState(draft.date);
  const [endDate, setEndDate] = useState(draft.endDate);
  const [start, setStart] = useState(draft.start ?? 9 * 60);
  const [end, setEnd] = useState(draft.end ?? (draft.start ?? 9 * 60) + 60);
  const [target, setTarget] = useState<string | null>(null);
  const [list, setList] = useState<string>(defaultList(gv.lists, prefs));
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const calendar = writable.find((item) => item.key === target) ?? defaultCalendar(writable, view.state, prefs);
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => titleRef.current?.focus({ preventScroll: true }), []);

  // The new event on the grid follows the times chosen here.
  useEffect(() => {
    calendarUi.set({ draft: { ...draft, kind, date, endDate: allDay ? endDate : date, start: allDay ? null : start, end: allDay ? null : end } });
  }, [kind, date, endDate, start, end, allDay]);

  const closeDraft = () => calendarUi.startDraft(null);
  const timed = !allDay;

  const saveEvent = async () => {
    if (!calendar) return setProblem('Connect a Google account with Calendar in Settings → Google to add events.');
    const input: EventInput = {
      summary: title.trim(),
      ...(timed ? { start: { dateTime: instantAt(date, start, zone), timeZone: zone }, end: { dateTime: instantAt(date, end, zone), timeZone: zone } } : { start: { date }, end: { date: addDays(endDate < date ? date : endDate, 1) } }),
    };
    // A calendar that is not shown yet is turned on, so the new event shows.
    if (!calendar.subscription?.visible) await google.setVisible(calendar, true);
    const subscription = Object.values(client.getView().state.calendars).find((item) => item.google?.account === calendar.account && item.google.calendarId === calendar.id) ?? null;
    await addEvent(client, { account: calendar.account, calendarId: calendar.id, subscriptionId: subscription?.id ?? null, color: calendar.color }, input, 'none', {
      title: title.trim() || '(No title)',
      location: '',
      start: timed ? instantAt(date, start, zone) : instantAt(date, 0, zone),
      end: timed ? instantAt(date, end, zone) : instantAt(addDays(endDate < date ? date : endDate, 1), 0, zone),
      allDay: !timed,
      busy: timed,
      google: { account: calendar.account, calendarId: calendar.id, eventId: '', recurringEventId: null, editable: false, response: null, guests: false, color: null, htmlLink: '', meet: null },
    });
    calendarUi.prefs({ lastCalendar: { account: calendar.account, calendarId: calendar.id } });
    calendarUi.snack('Event saved');
  };

  /** A Planner task on that day (at that time), added to the chosen Google Tasks list too. */
  const saveTask = async (): Promise<string> => {
    const name = title.trim();
    if (!name) throw new Error('Give the task a title');
    const chosen = gv.lists.find((item) => listKeyOf(item) === list) ?? null;
    const created = chosen ? await google.addListTask(chosen.account, chosen.id, { title: name, ...(notes.trim() ? { notes: notes.trim() } : {}), due: date }) : null;
    const id = newId();
    const placement = { kind: 'day' as const, date };
    const bodies: EventBody[] = [
      { type: 'task.created', task: { id, title: name, placement, position: edgePosition(view.state, placement, 'bottom'), ...(notes.trim() ? { notes: notes.trim() } : {}), ...(timed ? { plannedMinutes: end - start } : {}), ...(created ? { source: gtaskSource(created), dueDate: date } : {}) } },
    ];
    if (timed) bodies.push({ type: 'block.created', block: { id: newId(), taskId: id, start: instantAt(date, start, zone), end: instantAt(date, end, zone) } });
    await client.dispatch(bodies, { undo: 'Task added' });
    calendarUi.prefs({ lastList: list });
    return id;
  };

  const save = (then?: (taskId: string) => void) => {
    if (timed && end <= start) return setProblem('The end must be after the start');
    setBusy(true);
    setProblem(null);
    (kind === 'event' ? saveEvent().then(() => '') : saveTask())
      .then((taskId) => {
        closeDraft();
        if (then && taskId) then(taskId);
      })
      .catch((error) => setProblem(messageOf(error)))
      .finally(() => setBusy(false));
  };

  return (
    <Popover anchor={draft.anchor} label={kind === 'event' ? 'New event' : 'New task'} onClose={closeDraft} width={420} className="quick-create">
      <div class="pop-tools">
        <button class="icon-button" aria-label="Close" onClick={closeDraft}><Icon name="close" /></button>
      </div>
      <input
        class="qc-title"
        aria-label="Title"
        placeholder="Add title"
        value={title}
        ref={titleRef}
        onInput={(event) => setTitle(event.currentTarget.value)}
        onKeyDown={(event) => event.key === 'Enter' && !busy && save()}
      />
      <div class="segmented qc-kinds" role="radiogroup" aria-label="Make">
        <button role="radio" aria-checked={kind === 'event'} onClick={() => setKind('event')}>Event</button>
        <button role="radio" aria-checked={kind === 'task'} onClick={() => setKind('task')}>Task</button>
      </div>
      <div class="qc-row">
        <span class="pop-icon"><Icon name="clock" /></span>
        <div class="qc-times">
          <div class="qc-line">
            <input type="date" aria-label="Date" value={date} onChange={(event) => isDateKey(event.currentTarget.value) && setDate(event.currentTarget.value)} />
            {!timed && kind === 'event' && (
              <>
                <span aria-hidden="true">–</span>
                <input type="date" aria-label="End date" value={endDate < date ? date : endDate} min={date} onChange={(event) => isDateKey(event.currentTarget.value) && setEndDate(event.currentTarget.value)} />
              </>
            )}
          </div>
          <div class="qc-line">
            {timed && (
              <>
                <select aria-label="Start time" value={String(start)} onChange={(event) => {
                  const next = Number(event.currentTarget.value);
                  setEnd(Math.min(24 * 60, next + (end - start)));
                  setStart(next);
                }}>
                  {startChoices().map((choice) => <option key={choice.value} value={String(choice.value)}>{choice.label}</option>)}
                </select>
                <span aria-hidden="true">–</span>
                <select aria-label="End time" value={String(end)} onChange={(event) => setEnd(Number(event.currentTarget.value))}>
                  {endChoices(start).map((choice) => <option key={choice.value} value={String(choice.value)}>{choice.label}</option>)}
                </select>
              </>
            )}
            <label class="inline qc-allday">
              <input type="checkbox" checked={allDay} onChange={(event) => setAllDay(event.currentTarget.checked)} />
              All day
            </label>
          </div>
        </div>
      </div>
      {kind === 'event' ? (
        <div class="qc-row">
          <span class="pop-icon"><Icon name="calendar" /></span>
          {writable.length ? (
            <select aria-label="Calendar" value={calendar?.key ?? ''} onChange={(event) => setTarget(event.currentTarget.value)}>
              {writable.map((item) => <option key={item.key} value={item.key}>{new Set(writable.map((other) => other.account)).size > 1 ? `${item.name} · ${item.account}` : item.name}</option>)}
            </select>
          ) : (
            <span class="hint">{calendarAccounts ? 'Loading your calendars…' : 'Connect a Google account with Calendar in Settings → Google to add events.'}</span>
          )}
        </div>
      ) : (
        <>
          <div class="qc-row">
            <span class="pop-icon"><Icon name="notes" /></span>
            <textarea class="qc-notes" aria-label="Description" placeholder="Add description" rows={2} value={notes} onInput={(event) => setNotes(event.currentTarget.value)} />
          </div>
          <div class="qc-row">
            <span class="pop-icon"><Icon name="task" /></span>
            <select aria-label="Google Tasks list" value={list} onChange={(event) => setList(event.currentTarget.value)}>
              <option value="">The Planner only</option>
              {gv.lists.map((item) => <option key={listKeyOf(item)} value={listKeyOf(item)}>{new Set(gv.lists.map((other) => other.account)).size > 1 ? `${item.title} · ${item.account}` : item.title}</option>)}
            </select>
          </div>
          <p class="hint qc-hint">{timed ? 'Planned in the Planner at this time' : 'Planned in the Planner on this day'}{list ? ', and due that day in Google Tasks (which keeps no time).' : '.'}</p>
        </>
      )}
      {problem && <p class="danger" role="alert">{problem}</p>}
      <div class="pop-footer qc-footer">
        {kind === 'event' ? (
          <button class="link" disabled={!calendar} onClick={() => calendarUi.edit({ mode: 'new', draft: { date, endDate: allDay ? endDate : date, start: timed ? start : null, end: timed ? end : null, title, calendar: calendar ? { account: calendar.account, calendarId: calendar.id } : null } })}>
            More options
          </button>
        ) : (
          <button class="link" disabled={busy} onClick={() => save((taskId) => setUi({ openTaskId: taskId }))}>More options</button>
        )}
        <button class="primary" disabled={busy || (kind === 'event' && !calendar)} onClick={() => save()}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </Popover>
  );
};
