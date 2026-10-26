// Google Calendar's event editor ("More options", or Edit): title, times, all
// day, repeat (its presets and a custom rule), calendar, Google Meet,
// location, notifications, color, busy or free, visibility, description and
// guests. Saving a change to a series asks which events it is for, and an
// event with guests asks whether to email them, as Google Calendar does.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { CalendarEvent } from '../../../src/domain/ics.ts';
import type { DateKey } from '../../../src/domain/types.ts';
import { addDays, daysBetween, instantAt, isDateKey, zonedDateMinutes } from '../../../src/domain/dates.ts';
import { customOf, customRule, describeRecurrence, monthlyLabels, presetIdOf, recurrencePresets, splitRecurrence, type CustomRecurrence } from '../../../src/domain/rrule.ts';
import { descriptionText, isEmailAddress, type EditScope, type EventInput } from '../../../src/domain/gevents.ts';
import { EVENT_COLORS, type GoogleEventDetail, type GoogleReminder, type GoogleResponse } from '../../../src/domain/google.ts';
import { useGoogle, usePlanner, useView } from '../../lib/context.ts';
import { addEvent, askScope, askSend, calendarUi, eventDetail, moveEventToCalendar, updateEvent, useCalendarUi, type EditorTarget } from '../../lib/gcal.ts';
import { Icon } from './Icon.tsx';
import { calendarKey, defaultCalendar, endChoices, startChoices, writableCalendars } from './form.ts';

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

interface Guest {
  email: string;
  name: string;
  response: GoogleResponse | null;
  organizer: boolean;
  self: boolean;
}

interface Form {
  title: string;
  allDay: boolean;
  startDate: DateKey;
  /** The last day (all day), or the day it ends (timed). */
  endDate: DateKey;
  start: number;
  end: number;
  recurrence: string[];
  calendar: string;
  location: string;
  description: string;
  guests: Guest[];
  reminders: { useDefault: boolean; overrides: GoogleReminder[] };
  colorId: string | null;
  transparency: 'opaque' | 'transparent';
  visibility: 'default' | 'public' | 'private';
  meet: boolean;
}

const fromDetail = (detail: GoogleEventDetail, event: CalendarEvent, zone: string): Form => {
  const start = detail.allDay ? { date: detail.start.date!, minutes: 9 * 60 } : zonedDateMinutes(detail.start.dateTime ?? event.start, zone);
  const end = detail.allDay ? { date: addDays(detail.end.date ?? addDays(detail.start.date!, 1), -1), minutes: 10 * 60 } : zonedDateMinutes(detail.end.dateTime ?? event.end, zone);
  return {
    title: detail.title === '(No title)' ? '' : detail.title,
    allDay: detail.allDay,
    startDate: start.date,
    endDate: end.minutes === 0 && !detail.allDay && end.date > start.date ? addDays(end.date, -1) : end.date,
    start: Math.round(start.minutes),
    end: !detail.allDay && end.minutes === 0 && end.date > start.date ? 24 * 60 : Math.round(end.minutes),
    recurrence: detail.recurrence,
    calendar: calendarKey(detail.account, detail.calendarId),
    location: detail.location,
    description: descriptionText(detail.description),
    guests: detail.attendees.filter((guest) => !guest.resource).map((guest) => ({ email: guest.email, name: guest.name, response: guest.response, organizer: guest.organizer, self: guest.self })),
    reminders: detail.reminders,
    colorId: detail.colorId,
    transparency: detail.transparency,
    visibility: detail.visibility === 'confidential' ? 'private' : detail.visibility,
    meet: Boolean(detail.meet),
  };
};

/** The Google fields for the form's times. */
const times = (form: Form, zone: string): Pick<EventInput, 'start' | 'end'> =>
  form.allDay
    ? { start: { date: form.startDate }, end: { date: addDays(form.endDate < form.startDate ? form.startDate : form.endDate, 1) } }
    : { start: { dateTime: instantAt(form.startDate, form.start, zone), timeZone: zone }, end: { dateTime: instantAt(form.endDate < form.startDate ? form.startDate : form.endDate, form.end, zone), timeZone: zone } };

/** What changed between two forms, as Google event fields. */
const changes = (before: Form, after: Form, zone: string): EventInput => {
  const input: EventInput = {};
  if (after.title !== before.title) input.summary = after.title.trim();
  if (after.allDay !== before.allDay || after.startDate !== before.startDate || after.endDate !== before.endDate || (!after.allDay && (after.start !== before.start || after.end !== before.end))) Object.assign(input, times(after, zone));
  if (JSON.stringify(after.recurrence) !== JSON.stringify(before.recurrence)) input.recurrence = after.recurrence;
  if (after.location !== before.location) input.location = after.location;
  if (after.description !== before.description) input.description = after.description;
  if (JSON.stringify(after.guests.map((guest) => guest.email)) !== JSON.stringify(before.guests.map((guest) => guest.email))) input.attendees = after.guests.filter((guest) => !guest.self || guest.organizer).map((guest) => ({ email: guest.email }));
  if (JSON.stringify(after.reminders) !== JSON.stringify(before.reminders)) input.reminders = after.reminders;
  if (after.colorId !== before.colorId) input.colorId = after.colorId;
  if (after.transparency !== before.transparency) input.transparency = after.transparency;
  if (after.visibility !== before.visibility) input.visibility = after.visibility;
  if (after.meet !== before.meet) input.meet = after.meet;
  return input;
};

const UNITS = [
  { id: 'minutes', label: 'minutes', minutes: 1 },
  { id: 'hours', label: 'hours', minutes: 60 },
  { id: 'days', label: 'days', minutes: 1440 },
  { id: 'weeks', label: 'weeks', minutes: 10_080 },
] as const;
const unitOf = (minutes: number) => [...UNITS].reverse().find((unit) => minutes > 0 && minutes % unit.minutes === 0) ?? UNITS[0];

const FREQ_UNITS = [
  { id: 'DAILY', one: 'day', many: 'days' },
  { id: 'WEEKLY', one: 'week', many: 'weeks' },
  { id: 'MONTHLY', one: 'month', many: 'months' },
  { id: 'YEARLY', one: 'year', many: 'years' },
] as const;
const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Google Calendar's "Custom recurrence" dialog, inline. */
const CustomRepeat = ({ start, allDay, zone, lines, onDone, onCancel }: { start: DateKey; allDay: boolean; zone: string; lines: string[]; onDone: (rule: string) => void; onCancel: () => void }) => {
  const [custom, setCustom] = useState<CustomRecurrence>(customOf(lines, start, zone));
  const set = (patch: Partial<CustomRecurrence>) => setCustom({ ...custom, ...patch });
  const monthly = monthlyLabels(start);
  return (
    <div class="ee-custom" role="group" aria-label="Custom recurrence">
      <div class="ee-custom-row">
        <span>Repeat every</span>
        <input type="number" min={1} max={999} aria-label="Repeat every" value={custom.interval} onInput={(event) => set({ interval: Number(event.currentTarget.value) || 1 })} />
        <select aria-label="Repeat unit" value={custom.freq} onChange={(event) => set({ freq: event.currentTarget.value as CustomRecurrence['freq'] })}>
          {FREQ_UNITS.map((unit) => <option key={unit.id} value={unit.id}>{custom.interval === 1 ? unit.one : unit.many}</option>)}
        </select>
      </div>
      {custom.freq === 'WEEKLY' && (
        <div class="ee-custom-row">
          <span>Repeat on</span>
          <div class="ee-days">
            {DAY_LETTERS.map((letter, day) => (
              <button
                key={day}
                class="ee-day"
                aria-label={`Repeat on ${DAY_NAMES[day]}`}
                aria-pressed={custom.weekdays.includes(day)}
                onClick={() => set({ weekdays: custom.weekdays.includes(day) ? custom.weekdays.filter((other) => other !== day) : [...custom.weekdays, day] })}
              >
                {letter}
              </button>
            ))}
          </div>
        </div>
      )}
      {custom.freq === 'MONTHLY' && (
        <div class="ee-custom-row">
          <select aria-label="Monthly on" value={custom.monthly} onChange={(event) => set({ monthly: event.currentTarget.value as 'day' | 'weekday' })}>
            <option value="day">{monthly.day}</option>
            <option value="weekday">{monthly.weekday}</option>
          </select>
        </div>
      )}
      <fieldset class="ee-ends">
        <legend>Ends</legend>
        <label class="inline"><input type="radio" name="ends" checked={custom.ends.kind === 'never'} onChange={() => set({ ends: { kind: 'never' } })} /> Never</label>
        <label class="inline">
          <input type="radio" name="ends" checked={custom.ends.kind === 'on'} onChange={() => set({ ends: { kind: 'on', date: addDays(start, 30) } })} /> On
          <input type="date" aria-label="Ends on" disabled={custom.ends.kind !== 'on'} value={custom.ends.kind === 'on' ? custom.ends.date : addDays(start, 30)} min={start} onChange={(event) => isDateKey(event.currentTarget.value) && set({ ends: { kind: 'on', date: event.currentTarget.value } })} />
        </label>
        <label class="inline">
          <input type="radio" name="ends" checked={custom.ends.kind === 'after'} onChange={() => set({ ends: { kind: 'after', count: 13 } })} /> After
          <input type="number" min={1} max={730} aria-label="Ends after occurrences" disabled={custom.ends.kind !== 'after'} value={custom.ends.kind === 'after' ? custom.ends.count : 13} onInput={(event) => set({ ends: { kind: 'after', count: Number(event.currentTarget.value) || 1 } })} /> occurrences
        </label>
      </fieldset>
      <div class="ee-custom-actions">
        <button class="link" onClick={onCancel}>Cancel</button>
        <button class="primary" onClick={() => onDone(customRule(custom, start, allDay, zone))}>Done</button>
      </div>
    </div>
  );
};

export const EventEditor = ({ target }: { target: EditorTarget }) => {
  const { client, google } = usePlanner();
  const view = useView();
  const gv = useGoogle();
  const { prefs } = useCalendarUi();
  const zone = view.state.settings.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const writable = writableCalendars(gv.calendars, view.state.calendars);
  const event: CalendarEvent | null = target.mode === 'edit' ? target.event : null;
  const [detail, setDetail] = useState<GoogleEventDetail | null>(null);
  const [initial, setInitial] = useState<Form | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [guestDraft, setGuestDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const calendarAccounts = gv.status ? google.accountsWith('calendar').length : 0;

  useEffect(() => {
    if (calendarAccounts && !gv.calendars.length) void google.loadCalendars();
  }, [calendarAccounts]);

  useEffect(() => {
    if (target.mode === 'edit') {
      if (!target.event.google) return;
      let live = true;
      eventDetail(client, target.event.google)
        .then((found) => {
          if (!live) return;
          const loaded = fromDetail(found, target.event, zone);
          setDetail(found);
          setInitial(loaded);
          setForm(loaded);
        })
        .catch((error) => live && setProblem(messageOf(error)));
      return () => {
        live = false;
      };
    }
    const draft = target.draft;
    const start = draft.start ?? 9 * 60;
    const fresh: Form = {
      title: draft.title ?? '',
      allDay: draft.start === null,
      startDate: draft.date,
      endDate: draft.endDate,
      start,
      end: draft.end ?? Math.min(24 * 60, start + 60),
      recurrence: [],
      calendar: draft.calendar ? calendarKey(draft.calendar.account, draft.calendar.calendarId) : '',
      location: '',
      description: '',
      guests: [],
      reminders: { useDefault: true, overrides: [] },
      colorId: null,
      transparency: 'opaque',
      visibility: 'default',
      meet: false,
    };
    setInitial(fresh);
    setForm(fresh);
    return undefined;
  }, []);

  useEffect(() => {
    dialog.current?.focus();
    const onKey = (key: KeyboardEvent) => {
      if (key.key !== 'Escape' || document.querySelector('.gcal-question')) return;
      key.stopPropagation();
      calendarUi.edit(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const close = () => calendarUi.edit(null);
  const set = (patch: Partial<Form>) => form && setForm({ ...form, ...patch });
  const chosen = form ? writable.find((calendar) => calendar.key === form.calendar) ?? (target.mode === 'new' ? defaultCalendar(writable, view.state, prefs) : null) : null;
  const isSeries = Boolean(detail?.recurringEventId) || Boolean(detail && detail.recurrence.length);
  const presets = form ? recurrencePresets(form.startDate) : [];
  const presetId = form ? presetIdOf(form.recurrence, form.startDate) : 'none';

  const save = async () => {
    if (!form || !initial) return;
    if (!form.allDay && form.endDate <= form.startDate && form.end <= form.start) return setProblem('The event must end after it starts');
    if (form.endDate < form.startDate) return setProblem('The event must end after it starts');
    setProblem(null);
    if (target.mode === 'new') {
      const calendar = chosen;
      if (!calendar) return setProblem('Choose a calendar');
      const input: EventInput = {
        summary: form.title.trim(),
        ...times(form, zone),
        ...(form.recurrence.length ? { recurrence: form.recurrence } : {}),
        ...(form.location ? { location: form.location } : {}),
        ...(form.description ? { description: form.description } : {}),
        ...(form.guests.length ? { attendees: form.guests.map((guest) => ({ email: guest.email })) } : {}),
        reminders: form.reminders,
        ...(form.colorId ? { colorId: form.colorId } : {}),
        transparency: form.transparency,
        visibility: form.visibility,
        ...(form.meet ? { meet: true } : {}),
      };
      const send = form.guests.length ? await askSend('invite') : 'none';
      if (!send) return;
      setBusy(true);
      try {
        if (!calendar.subscription?.visible) await google.setVisible(calendar, true);
        const subscription = Object.values(client.getView().state.calendars).find((item) => item.google?.account === calendar.account && item.google.calendarId === calendar.id) ?? null;
        const spanTimes = times(form, zone);
        await addEvent(client, { account: calendar.account, calendarId: calendar.id, subscriptionId: subscription?.id ?? null, color: calendar.color }, input, send, {
          title: form.title.trim() || '(No title)',
          location: form.location,
          start: spanTimes.start!.dateTime ?? instantAt(form.startDate, 0, zone),
          end: spanTimes.end!.dateTime ?? instantAt(spanTimes.end!.date!, 0, zone),
          allDay: form.allDay,
          busy: !form.allDay,
          google: { account: calendar.account, calendarId: calendar.id, eventId: '', recurringEventId: null, editable: false, response: null, guests: form.guests.length > 0, color: form.colorId ? EVENT_COLORS[form.colorId]?.color ?? null : null, htmlLink: '', meet: null },
        });
        calendarUi.prefs({ lastCalendar: { account: calendar.account, calendarId: calendar.id } });
        client.notify('Event saved');
        close();
      } catch (error) {
        setProblem(messageOf(error));
      } finally {
        setBusy(false);
      }
      return;
    }
    if (!event?.google || !detail) return;
    const input = changes(initial, form, zone);
    const moving = form.calendar !== initial.calendar && chosen ? chosen : null;
    if (!Object.keys(input).length && !moving) return close();
    let scope: EditScope = 'this';
    if (detail.recurringEventId) {
      const ruleChanged = input.recurrence !== undefined;
      const picked = await askScope('edit', moving ? ['all'] : ruleChanged ? ['following', 'all'] : ['this', 'following', 'all']);
      if (!picked) return;
      scope = picked;
    }
    const others = form.guests.some((guest) => !guest.self) || initial.guests.some((guest) => !guest.self);
    const added = form.guests.some((guest) => !initial.guests.some((before) => before.email === guest.email));
    const send = others ? await askSend(added ? 'invite' : 'update') : 'none';
    if (!send) return;
    setBusy(true);
    try {
      if (Object.keys(input).length) await updateEvent(client, event.google, input, scope, send);
      if (moving) await moveEventToCalendar(client, event.google, moving.id, send);
      calendarUi.confirm([]);
      client.notify('Event saved');
      close();
    } catch (error) {
      setProblem(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  const addGuest = () => {
    if (!form) return;
    const emails = guestDraft.split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean);
    const bad = emails.filter((email) => !isEmailAddress(email));
    if (bad.length) return setProblem(`Not an email address: ${bad.join(', ')}`);
    const fresh = emails.filter((email) => !form.guests.some((guest) => guest.email.toLowerCase() === email.toLowerCase()));
    set({ guests: [...form.guests, ...fresh.map((email) => ({ email, name: email, response: null, organizer: false, self: false }))] });
    setGuestDraft('');
    setProblem(null);
  };

  const title = target.mode === 'new' ? 'New event' : 'Edit event';
  return (
    <div class="modal-backdrop is-top" onMouseDown={(click) => click.target === click.currentTarget && close()}>
      <div class="modal event-editor" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={dialog}>
        <div class="ee-bar">
          <button class="icon-button" aria-label="Close" onClick={close}><Icon name="close" /></button>
          <input class="ee-title" aria-label="Title" placeholder="Add title" value={form?.title ?? ''} disabled={!form} onInput={(input) => set({ title: input.currentTarget.value })} />
          <button class="primary" disabled={!form || busy || (target.mode === 'new' && !chosen)} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
        {!form && !problem && <p class="hint">Loading the event…</p>}
        {problem && <p class="danger" role="alert">{problem}</p>}
        {form && (
          <div class="ee-grid">
            <div class="ee-main">
              <div class="ee-row ee-times">
                <span class="pop-icon"><Icon name="clock" /></span>
                <div class="ee-fields">
                  <input type="date" aria-label="Start date" value={form.startDate} onChange={(input) => {
                    const next = input.currentTarget.value;
                    if (!isDateKey(next)) return;
                    set({ startDate: next, endDate: addDays(next, Math.max(0, daysBetween(form.startDate, form.endDate))) });
                  }} />
                  {!form.allDay && (
                    <select aria-label="Start time" value={String(form.start)} onChange={(input) => {
                      const next = Number(input.currentTarget.value);
                      set({ start: next, end: Math.min(24 * 60, next + (form.end - form.start)) });
                    }}>
                      {startChoices().map((choice) => <option key={choice.value} value={String(choice.value)}>{choice.label}</option>)}
                    </select>
                  )}
                  <span>to</span>
                  {!form.allDay && (
                    <select aria-label="End time" value={String(form.end)} onChange={(input) => set({ end: Number(input.currentTarget.value) })}>
                      {(form.endDate > form.startDate ? startChoices().map((choice) => ({ ...choice })) : endChoices(form.start)).map((choice) => <option key={choice.value} value={String(choice.value)}>{choice.label}</option>)}
                    </select>
                  )}
                  <input type="date" aria-label="End date" value={form.endDate} min={form.startDate} onChange={(input) => isDateKey(input.currentTarget.value) && set({ endDate: input.currentTarget.value })} />
                </div>
              </div>
              <div class="ee-row">
                <span class="pop-icon" />
                <div class="ee-fields">
                  <label class="inline"><input type="checkbox" checked={form.allDay} onChange={(input) => set({ allDay: input.currentTarget.checked })} /> All day</label>
                  <span class="muted" title="Times are in the Planner's time zone (Settings)">{zone.replace(/_/g, ' ')}</span>
                </div>
              </div>
              <div class="ee-row">
                <span class="pop-icon"><Icon name="repeat" /></span>
                <div class="ee-fields ee-column">
                  <select
                    aria-label="Repeat"
                    value={customOpen ? 'custom-open' : presetId}
                    onChange={(input) => {
                      const value = input.currentTarget.value;
                      if (value === 'custom-open') return setCustomOpen(true);
                      if (value === 'custom') return;
                      setCustomOpen(false);
                      const preset = presets.find((item) => item.id === value);
                      set({ recurrence: preset?.rule ? [preset.rule, ...splitRecurrence(form.recurrence).rest] : [] });
                    }}
                  >
                    {presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
                    {presetId === 'custom' && <option value="custom">{describeRecurrence(form.recurrence, form.startDate, zone)}</option>}
                    <option value="custom-open">Custom…</option>
                  </select>
                  {customOpen && (
                    <CustomRepeat
                      start={form.startDate}
                      allDay={form.allDay}
                      zone={zone}
                      lines={form.recurrence}
                      onCancel={() => setCustomOpen(false)}
                      onDone={(rule) => {
                        setCustomOpen(false);
                        set({ recurrence: [rule, ...splitRecurrence(form.recurrence).rest] });
                      }}
                    />
                  )}
                  {isSeries && <span class="hint">Saving asks whether the change is for this event, this and the following ones, or all of them.</span>}
                </div>
              </div>
              <div class="ee-row">
                <span class="pop-icon"><Icon name="calendar" /></span>
                <div class="ee-fields">
                  <select aria-label="Calendar" value={chosen?.key ?? form.calendar} onChange={(input) => set({ calendar: input.currentTarget.value })}>
                    {target.mode === 'edit' && !writable.some((calendar) => calendar.key === form.calendar) && <option value={form.calendar}>{view.state.calendars[event!.calendarId]?.name ?? 'This calendar'}</option>}
                    {writable.map((calendar) => <option key={calendar.key} value={calendar.key}>{new Set(writable.map((other) => other.account)).size > 1 ? `${calendar.name} · ${calendar.account}` : calendar.name}</option>)}
                  </select>
                  <div class="ee-colors" role="radiogroup" aria-label="Event color">
                    <button role="radio" class="ee-color is-calendar" aria-checked={!form.colorId} aria-label="Calendar color" title="Calendar color" style={{ background: chosen?.color ?? '#4285f4' }} onClick={() => set({ colorId: null })} />
                    {Object.entries(EVENT_COLORS).map(([id, color]) => (
                      <button key={id} role="radio" class="ee-color" aria-checked={form.colorId === id} aria-label={color.name} title={color.name} style={{ background: color.color }} onClick={() => set({ colorId: id })} />
                    ))}
                  </div>
                </div>
              </div>
              <div class="ee-row">
                <span class="pop-icon"><Icon name="video" /></span>
                <div class="ee-fields">
                  {detail?.meet && form.meet ? (
                    <>
                      <span>Google Meet: {detail.meet.url.replace(/^https:\/\//, '')}</span>
                      <button class="link danger" onClick={() => set({ meet: false })}>Remove the call</button>
                    </>
                  ) : (
                    <label class="inline"><input type="checkbox" checked={form.meet} onChange={(input) => set({ meet: input.currentTarget.checked })} /> Add Google Meet video conferencing</label>
                  )}
                </div>
              </div>
              <div class="ee-row">
                <span class="pop-icon"><Icon name="place" /></span>
                <input class="ee-wide" aria-label="Location" placeholder="Add location" value={form.location} onInput={(input) => set({ location: input.currentTarget.value })} />
              </div>
              <div class="ee-row">
                <span class="pop-icon"><Icon name="bell" /></span>
                <div class="ee-fields ee-column">
                  <label class="inline"><input type="checkbox" checked={form.reminders.useDefault} onChange={(input) => set({ reminders: { useDefault: input.currentTarget.checked, overrides: input.currentTarget.checked ? [] : form.reminders.overrides.length ? form.reminders.overrides : [{ method: 'popup', minutes: 10 }] } })} /> The calendar's default notifications</label>
                  {!form.reminders.useDefault && form.reminders.overrides.map((reminder, index) => {
                    const unit = unitOf(reminder.minutes);
                    const update = (patch: Partial<GoogleReminder>) => set({ reminders: { useDefault: false, overrides: form.reminders.overrides.map((item, at) => (at === index ? { ...item, ...patch } : item)) } });
                    return (
                      <div key={index} class="ee-reminder">
                        <select aria-label="Notification by" value={reminder.method} onChange={(input) => update({ method: input.currentTarget.value as GoogleReminder['method'] })}>
                          <option value="popup">Notification</option>
                          <option value="email">Email</option>
                        </select>
                        <input type="number" min={0} aria-label="Notification time" value={reminder.minutes / unit.minutes} onInput={(input) => update({ minutes: Math.max(0, Math.min(40_320, Math.round((Number(input.currentTarget.value) || 0) * unit.minutes))) })} />
                        <select aria-label="Notification unit" value={unit.id} onChange={(input) => {
                          const next = UNITS.find((item) => item.id === input.currentTarget.value) ?? UNITS[0];
                          update({ minutes: Math.min(40_320, (reminder.minutes / unit.minutes) * next.minutes) });
                        }}>
                          {UNITS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                        </select>
                        <span>before</span>
                        <button class="icon-button" aria-label="Remove notification" onClick={() => set({ reminders: { useDefault: false, overrides: form.reminders.overrides.filter((_, at) => at !== index) } })}><Icon name="close" size={16} /></button>
                      </div>
                    );
                  })}
                  {!form.reminders.useDefault && form.reminders.overrides.length < 5 && (
                    <button class="link" onClick={() => set({ reminders: { useDefault: false, overrides: [...form.reminders.overrides, { method: 'popup', minutes: 30 }] } })}>Add notification</button>
                  )}
                </div>
              </div>
              <div class="ee-row">
                <span class="pop-icon" />
                <div class="ee-fields">
                  <select aria-label="Show me as" value={form.transparency} onChange={(input) => set({ transparency: input.currentTarget.value as Form['transparency'] })}>
                    <option value="opaque">Busy</option>
                    <option value="transparent">Free</option>
                  </select>
                  <select aria-label="Visibility" value={form.visibility} onChange={(input) => set({ visibility: input.currentTarget.value as Form['visibility'] })}>
                    <option value="default">Default visibility</option>
                    <option value="public">Public</option>
                    <option value="private">Private</option>
                  </select>
                </div>
              </div>
              <div class="ee-row">
                <span class="pop-icon"><Icon name="notes" /></span>
                <div class="ee-fields ee-column">
                  <textarea class="ee-description" aria-label="Description" placeholder="Add description" rows={6} value={form.description} onInput={(input) => set({ description: input.currentTarget.value })} />
                  {detail && /<[a-z!/]/i.test(detail.description) && <span class="hint">Google Calendar wrote this description with formatting; it shows, and saves, as plain text here.</span>}
                </div>
              </div>
            </div>
            <aside class="ee-side" aria-label="Guests">
              <h3>Guests</h3>
              <div class="ee-guest-add">
                <input aria-label="Add guests" placeholder="Add guests" value={guestDraft} onInput={(input) => setGuestDraft(input.currentTarget.value)} onKeyDown={(key) => key.key === 'Enter' && addGuest()} />
                <button onClick={addGuest} disabled={!guestDraft.trim()}>Add</button>
              </div>
              <ul class="guest-list" aria-label="Guest list">
                {form.guests.map((guest) => (
                  <li key={guest.email} class={`guest is-${guest.response ?? 'needsAction'}`}>
                    <span class="guest-avatar" aria-hidden="true">{guest.name.slice(0, 1).toUpperCase()}</span>
                    <span class="guest-name">
                      {guest.name}
                      {guest.organizer && <span class="muted"> · Organizer</span>}
                      {guest.response && guest.response !== 'needsAction' && <span class="muted"> · {guest.response === 'accepted' ? 'Yes' : guest.response === 'declined' ? 'No' : 'Maybe'}</span>}
                    </span>
                    {!guest.organizer && (
                      <button class="icon-button" aria-label={`Remove ${guest.email}`} onClick={() => set({ guests: form.guests.filter((other) => other.email !== guest.email) })}><Icon name="close" size={16} /></button>
                    )}
                  </li>
                ))}
              </ul>
              {form.guests.length === 0 && <p class="hint">Invite people by email; they get Google Calendar's invitation when you choose to send it.</p>}
            </aside>
          </div>
        )}
      </div>
    </div>
  );
};
