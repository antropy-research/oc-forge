// Google Calendar's popovers: an event's details (with Edit, Delete, Duplicate,
// RSVP and Sunsama's "Add to tasks"), a Google task's (edit, complete,
// delete, plan it), one upcoming occurrence of a repeating task (edit or
// delete it alone, or its series), and a month day's "N more" list.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { CalendarEvent } from '../../../src/domain/ics.ts';
import type { DateKey, PlannerState, Task } from '../../../src/domain/types.ts';
import { addMeetingCommands, eventKey, taskForEvent as meetingTaskFor } from '../../../src/domain/meetings.ts';
import { addDays, zonedDateMinutes } from '../../../src/domain/dates.ts';
import { compactClock, compactRange, eventSpan, longDay, weekdayShort } from '../../../src/domain/gcalendar.ts';
import { describeRecurrence } from '../../../src/domain/rrule.ts';
import { descriptionText } from '../../../src/domain/gevents.ts';
import { taskForGoogleTask, type GoogleEventDetail, type GoogleReminder, type GoogleResponse } from '../../../src/domain/google.ts';
import { KEPT_HINT, advancedLabel, keptFor, keptTimeLabel, upcomingValues } from '../../../src/domain/gtaskKept.ts';
import { colorName, declineCarriesOn, driveKind, quietLabel, taskOrigins, type DeclinedMeeting } from '../../../src/domain/gtaskAdvanced.ts';
import { blocksOnDay, edgePosition } from '../../../src/domain/selectors.ts';
import { newId } from '../../../src/domain/ids.ts';
import { useGoogle, usePlanner, useView } from '../../lib/context.ts';
import { DELETE_CHOICES, undoAction } from '../../lib/google.ts';
import { useUi } from '../../lib/ui.ts';
import { anchorOf, calendarUi, eventDetail, popoverKind, removeEvent, respond, type Anchor } from '../../lib/gcal.ts';
import { plannedLabel } from '../GitHubPanel.tsx';
import { Icon } from './Icon.tsx';
import { Popover } from './Popover.tsx';
import { answerClass, eventColor, eventLabel, inkOn, isTaskEvent, taskClass, taskEventLabel } from './items.ts';

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const close = () => calendarUi.open(null);

/** Text with its web addresses as links that open in the browser. */
export const Linked = ({ text }: { text: string }) => {
  const { host } = usePlanner();
  const parts = text.split(/(https?:\/\/[^\s<>()"]+)/g);
  return <>{parts.map((part, index) => (index % 2 ? <button key={index} class="link" onClick={() => void host.openUrl(part)}>{part}</button> : part))}</>;
};

/** "Monday, October 26 ⋅ 2 – 3pm", as the popover's second line. */
export const whenText = (event: CalendarEvent, zone: string): string => {
  const span = eventSpan(event, zone);
  if (event.allDay) return span.first === span.last ? longDay(span.first) : `${longDay(span.first)} – ${longDay(span.last)}`;
  const start = zonedDateMinutes(event.start, zone);
  const end = zonedDateMinutes(event.end, zone);
  if (span.first === span.last) return `${longDay(start.date)} ⋅ ${compactRange(start.minutes, end.date > start.date ? 1440 : end.minutes)}`;
  return `${longDay(start.date)}, ${compactClock(start.minutes)} – ${longDay(end.date)}, ${compactClock(end.minutes)}`;
};

const reminderText = (reminder: GoogleReminder): string => {
  const { minutes } = reminder;
  const amount = minutes % 10_080 === 0 && minutes ? `${minutes / 10_080} week${minutes === 10_080 ? '' : 's'}` : minutes % 1440 === 0 && minutes ? `${minutes / 1440} day${minutes === 1440 ? '' : 's'}` : minutes % 60 === 0 && minutes ? `${minutes / 60} hour${minutes === 60 ? '' : 's'}` : `${minutes} minute${minutes === 1 ? '' : 's'}`;
  return `${minutes === 0 ? 'At the start' : `${amount} before`}${reminder.method === 'email' ? ', as email' : ''}`;
};

const RESPONSE_LABEL: Record<GoogleResponse, string> = { accepted: 'yes', declined: 'no', tentative: 'maybe', needsAction: 'awaiting' };
const RESPONSE_MARK: Record<GoogleResponse, string> = { accepted: '✓', declined: '✕', tentative: '?', needsAction: '' };

/** "2 yes, 1 maybe, 1 awaiting" */
const guestSummary = (detail: GoogleEventDetail): string => {
  const counts = new Map<GoogleResponse, number>();
  for (const guest of detail.attendees) if (!guest.resource) counts.set(guest.response, (counts.get(guest.response) ?? 0) + 1);
  return (['accepted', 'declined', 'tentative', 'needsAction'] as const).filter((response) => counts.get(response)).map((response) => `${counts.get(response)} ${RESPONSE_LABEL[response]}`).join(', ');
};

/** The Planner's task for an event: the one added from it (not removed), else one on its day with its title. */
const taskForEvent = (state: PlannerState, event: CalendarEvent, day: DateKey): Task | null => {
  const key = eventKey(event);
  const added = key ? meetingTaskFor(state, key) : null;
  if (added && !added.deletedAt) return added;
  return Object.values(state.tasks).find((task) => task.title === event.title && !task.deletedAt && task.placement.kind === 'day' && task.placement.date === day) ?? null;
};

export const EventPopover = ({ event, anchor }: { event: CalendarEvent; anchor: Anchor }) => {
  const { client, host } = usePlanner();
  const view = useView();
  const { setUi } = useUi();
  const zone = view.state.settings.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [detail, setDetail] = useState<GoogleEventDetail | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [answer, setAnswer] = useState<GoogleResponse | null>(event.google?.response ?? null);
  const [options, setOptions] = useState(false);
  const optionsRef = useRef<HTMLDivElement>(null);
  const ref = event.google;
  useEffect(() => {
    if (!options) return;
    const shut = (click: MouseEvent) => !optionsRef.current?.contains(click.target as Node) && setOptions(false);
    document.addEventListener('mousedown', shut);
    return () => document.removeEventListener('mousedown', shut);
  }, [options]);
  useEffect(() => {
    if (!ref || event.id.startsWith('new:')) return;
    let live = true;
    eventDetail(client, ref)
      .then((found) => {
        if (!live) return;
        setDetail(found);
        setAnswer(found.response);
      })
      .catch((error) => live && setProblem(messageOf(error)));
    return () => {
      live = false;
    };
  }, [event.id]);
  const calendar = view.state.calendars[event.calendarId];
  const color = eventColor(event, view.state);
  const day = eventSpan(event, zone).first;
  const planned = taskForEvent(view.state, event, day);
  const minutes = event.allDay ? null : Math.round((Date.parse(event.end) - Date.parse(event.start)) / 60_000);
  const description = detail?.description ? descriptionText(detail.description) : '';
  const meet = detail?.meet?.url ?? ref?.meet ?? null;
  const guests = detail?.attendees.filter((guest) => !guest.resource) ?? [];
  // Sunsama's "Add to tasks": a task linked to the event, by its start time (an event of a calendar feed, unlinked).
  const plan = () => {
    const linked = addMeetingCommands(view.state, event, zone, newId);
    if (linked.length) {
      void client.dispatch(linked, { undo: 'Added to tasks' });
      return;
    }
    const placement = { kind: 'day' as const, date: day };
    void client.dispatch(
      [{ type: 'task.created', task: { id: newId(), title: event.title, placement, position: edgePosition(view.state, placement, 'bottom'), ...(minutes ? { plannedMinutes: Math.min(minutes, 24 * 60) } : {}), notes: `${whenText(event, zone)}, from the calendar` } }],
      { undo: 'Added to tasks' },
    );
  };
  return (
    <Popover anchor={anchor} label={`Event: ${event.title}`} onClose={close} className="event-popover">
      <div class="pop-tools">
        {ref?.editable && (
          <button class="icon-button" aria-label="Edit event" title="Edit event" onClick={() => calendarUi.edit({ mode: 'edit', event })}>
            <Icon name="edit" />
          </button>
        )}
        {ref?.editable && (
          <button
            class="icon-button"
            aria-label="Delete event"
            title="Delete event"
            onClick={() => {
              close();
              void removeEvent(client, event);
            }}
          >
            <Icon name="delete" />
          </button>
        )}
        {ref?.htmlLink && (
          <button class="icon-button" aria-label="Open in Google Calendar" title="Open in Google Calendar" onClick={() => void host.openUrl(ref.htmlLink)}>
            <Icon name="open" />
          </button>
        )}
        {detail && (
          <div class="menu-anchor" ref={optionsRef}>
            <button class="icon-button" aria-label="Options" title="Options" aria-haspopup="menu" aria-expanded={options} onClick={() => setOptions(!options)}>
              <Icon name="more" />
            </button>
            {options && (
              <div class="menu pop-menu" role="menu" aria-label="Options">
                <button
                  role="menuitem"
                  onClick={() => {
                    const span = eventSpan(event, zone);
                    const start = zonedDateMinutes(event.start, zone);
                    const end = zonedDateMinutes(event.end, zone);
                    calendarUi.edit({
                      mode: 'new',
                      draft: { date: span.first, endDate: span.last, start: event.allDay ? null : start.minutes, end: event.allDay ? null : end.date > start.date ? 24 * 60 : end.minutes, title: detail.title, calendar: { account: detail.account, calendarId: detail.calendarId } },
                      copy: { event, detail },
                    });
                  }}
                >
                  Duplicate
                </button>
              </div>
            )}
          </div>
        )}
        <button class="icon-button" aria-label="Close" title="Close" onClick={close}>
          <Icon name="close" />
        </button>
      </div>
      <div class="pop-row pop-head">
        <span class="pop-icon"><span class="pop-swatch" style={{ background: color }} /></span>
        <div class="pop-main">
          <h2 class={`pop-title${answerClass(event)}`}>{event.title}</h2>
          <div class="pop-when">{whenText(event, zone)}</div>
          {detail && detail.recurrence.length > 0 && <div class="pop-when">{describeRecurrence(detail.recurrence, day, zone)}</div>}
        </div>
      </div>
      {meet && (
        <div class="pop-row">
          <span class="pop-icon"><Icon name="video" /></span>
          <div class="pop-main">
            <button class="primary" onClick={() => void host.openUrl(meet)}>Join with Google Meet</button>
            <div class="muted pop-small">{meet.replace(/^https:\/\//, '')}</div>
          </div>
        </div>
      )}
      {event.location && (
        <div class="pop-row">
          <span class="pop-icon"><Icon name="place" /></span>
          <div class="pop-main">
            <button class="link pop-location" title="Open in Google Maps" onClick={() => void host.openUrl(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(event.location)}`)}>{event.location}</button>
          </div>
        </div>
      )}
      {guests.length > 0 && detail && (
        <div class="pop-row">
          <span class="pop-icon"><Icon name="people" /></span>
          <div class="pop-main">
            <div>{guests.length} guest{guests.length === 1 ? '' : 's'}</div>
            <div class="muted pop-small">{guestSummary(detail)}</div>
            <ul class="guest-list" aria-label="Guests">
              {guests.map((guest) => (
                <li key={guest.email} class={`guest is-${guest.response}`}>
                  <span class="guest-avatar" aria-hidden="true">{guest.name.slice(0, 1).toUpperCase()}<span class="guest-mark">{RESPONSE_MARK[guest.response]}</span></span>
                  <span class="guest-name">
                    {guest.name}
                    {guest.organizer && <span class="muted"> · Organizer</span>}
                    {guest.optional && <span class="muted"> · Optional</span>}
                  </span>
                  <span class="visually-hidden">{RESPONSE_LABEL[guest.response]}</span>
                </li>
              ))}
            </ul>
            {detail.attendeesOmitted && <p class="hint">Google shows only part of the guest list.</p>}
          </div>
        </div>
      )}
      {description && (
        <div class="pop-row">
          <span class="pop-icon"><Icon name="notes" /></span>
          <div class="pop-main pop-description"><Linked text={description} /></div>
        </div>
      )}
      {detail && (detail.reminders.overrides.length > 0 || !detail.reminders.useDefault) && (
        <div class="pop-row">
          <span class="pop-icon"><Icon name="bell" /></span>
          <div class="pop-main">{detail.reminders.overrides.length ? detail.reminders.overrides.map((reminder, index) => <div key={index}>{reminderText(reminder)}</div>) : 'No notifications'}</div>
        </div>
      )}
      <div class="pop-row">
        <span class="pop-icon"><Icon name="calendar" /></span>
        <div class="pop-main">
          {calendar?.name ?? 'Calendar'}
          {detail?.organizer && !detail.organizer.self && <div class="muted pop-small">Organized by {detail.organizer.name}</div>}
          {!ref && <div class="muted pop-small">A read-only calendar (ICS): change it where it comes from.</div>}
          {ref && !ref.editable && !answer && <div class="muted pop-small">You can see this event but not change it.</div>}
        </div>
      </div>
      {problem && <p class="danger pop-problem" role="alert">{problem}</p>}
      {ref && answer && (
        <div class="pop-rsvp" role="group" aria-label="Going?">
          <span>Going?</span>
          {(['accepted', 'declined', 'tentative'] as const).map((response) => (
            <button
              key={response}
              aria-pressed={answer === response}
              onClick={async () => {
                const before = answer;
                setAnswer(response);
                if (!(await respond(client, event, response))) setAnswer(before);
              }}
            >
              {response === 'accepted' ? 'Yes' : response === 'declined' ? 'No' : 'Maybe'}
            </button>
          ))}
        </div>
      )}
      <div class="pop-footer">
        {planned ? (
          <button class="link" onClick={() => { close(); setUi({ openTaskId: planned.id }); }}>
            <Icon name="check" size={16} /> In your plan: open the task
          </button>
        ) : (
          <button class="link" onClick={plan} title="Add it to its day as a task, its length as planned time; it is checked off when it ends (Settings → Meeting import)">
            <Icon name="task" size={16} /> Add to tasks
          </button>
        )}
      </div>
    </Popover>
  );
};

/** A Google task on the calendar (on its date or its deadline's day): edit it, complete it, delete it, open it in Google Tasks, or plan it. */
export const TaskPopover = ({ event, anchor }: { event: CalendarEvent; anchor: Anchor }) => {
  const { client, google, host } = usePlanner();
  const view = useView();
  const gv = useGoogle();
  const { setUi } = useUi();
  const item = event.googleTask!;
  const [busy, setBusy] = useState(false);
  const list = gv.lists.find((other) => other.account === item.account && other.id === item.listId);
  const planned = taskForGoogleTask(view.state, item);
  const zone = view.state.settings.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Its date; a task without one plans on the day it shows (its deadline's).
  const due = item.due ?? zonedDateMinutes(event.start, zone).date;
  const kept = keptFor(view.state, item);
  const time = keptTimeLabel(kept);
  const color = eventColor(event, view.state);
  const quiet = quietLabel(kept);
  // The meetings the Planner declined during it ("Automatically decline meetings").
  // While declining carries on after a pass stopped at one of its bounds, it says so (`more`).
  const [{ declined, more }, setDeclined] = useState<{ declined: DeclinedMeeting[]; more: string | null }>({ declined: [], more: null });
  useEffect(() => {
    if (!kept?.decline) return;
    let live = true;
    google.declinedFor(item.account, item.id).then((found) => live && setDeclined(found)).catch(() => {});
    return () => {
      live = false;
    };
  }, [item.id, Boolean(kept?.decline)]);
  const remove = async () => {
    // A repeating task asks, as Google Calendar does: this one (the series goes on), this and the following ones, or all of them.
    const scope = kept?.repeat ? await calendarUi.ask({ title: 'Delete repeating task', style: 'radio', choices: DELETE_CHOICES }) : 'this';
    // Undo, as Google offers it after a deletion.
    if (scope === 'this' || scope === 'following' || scope === 'all') run(() => google.deleteListTask(item, scope), scope === 'this' ? 'Task deleted' : 'Tasks deleted', undoAction(google, client.notify));
  };
  const run = (work: () => Promise<unknown>, done?: string, undo: (() => Promise<void>) | null = null) => {
    setBusy(true);
    work()
      .then(() => {
        close();
        if (done) calendarUi.snack(done, undo);
      })
      .catch((error) => client.notify(`Google Tasks did not take it: ${messageOf(error)}`))
      .finally(() => setBusy(false));
  };
  return (
    <Popover anchor={anchor} label={`Google task: ${item.title}`} onClose={close} className="task-popover">
      <div class="pop-tools">
        <button class={`icon-button pop-star${kept?.starredAt ? ' is-on' : ''}`} aria-label={`Star ${item.title}`} aria-pressed={Boolean(kept?.starredAt)} title={KEPT_HINT} onClick={() => void google.toggleStar(item)}>
          <Icon name={kept?.starredAt ? 'starred' : 'star'} />
        </button>
        <button class="icon-button" aria-label="Edit task" title="Edit task" disabled={busy} onClick={() => calendarUi.editTask({ item, series: false })}>
          <Icon name="edit" />
        </button>
        <button class="icon-button" aria-label="Delete task" title="Delete task" disabled={busy} onClick={() => void remove()}>
          <Icon name="delete" />
        </button>
        <button class="icon-button" aria-label="Open in Google Tasks" title="Open in Google Tasks" onClick={() => void host.openUrl(item.url)}>
          <Icon name="open" />
        </button>
        <button class="icon-button" aria-label="Close" title="Close" onClick={close}>
          <Icon name="close" />
        </button>
      </div>
      <div class="pop-row pop-head">
        <span class="pop-icon" style={{ color }} title={kept?.color ? colorName(kept.color) : 'List color'}><Icon name={item.completed ? 'done' : 'circle'} /></span>
        <div class="pop-main">
          <h2 class={`pop-title${item.completed ? ' is-done' : ''}`}>{item.title}</h2>
          <div class="pop-when">{item.due ? `${longDay(item.due)}${time ? ` ⋅ ${time}` : ''}` : 'No date'}</div>
          {kept?.repeat && <div class="pop-when">{describeRecurrence([kept.repeat.rule], kept.repeat.template?.start ?? due, zone)}</div>}
        </div>
      </div>
      {kept?.deadline && (
        <div class="pop-row">
          <span class="pop-icon"><Icon name="flag" /></span>
          <div class={`pop-main${kept.deadline < view.today && !item.completed ? ' danger' : ''}`}>Deadline: {longDay(kept.deadline)}</div>
        </div>
      )}
      {advancedLabel(kept) && (
        <div class="pop-row">
          <span class="pop-icon"><Icon name="tune" /></span>
          <div class="pop-main">{advancedLabel(kept)}</div>
        </div>
      )}
      {quiet && (
        <div class="pop-row">
          <span class="pop-icon"><Icon name={kept?.doNotDisturb ? 'dnd' : 'declined'} /></span>
          <div class="pop-main">
            {quiet}
            {kept?.decline && kept.busy && <div class="muted pop-small">"{kept.decline.message}" · {kept.decline.mode === 'all' ? 'new and existing meetings' : 'only new meeting invitations'}</div>}
            {declined.length > 0 && (
              <ul class="pop-declined" aria-label="Meetings declined">
                {declined.map((meeting) => <li key={meeting.eventId}>Declined: {meeting.summary}</li>)}
              </ul>
            )}
            {more && kept?.decline && <div class="muted pop-small" role="status">{declineCarriesOn(more, zone)}.</div>}
          </div>
        </div>
      )}
      {(kept?.attachments?.length ?? 0) > 0 && (
        <div class="pop-row">
          <span class="pop-icon"><Icon name="attach" /></span>
          <ul class="pop-main pop-attachments" aria-label="Attachments">
            {kept!.attachments!.map((file) => (
              <li key={file.id}>
                <button class="link" aria-label={`Open ${file.title}`} title="Open in Google Drive" onClick={() => void host.openUrl(file.url)}>
                  <span class="pop-file" style={{ color: driveKind(file.mimeType).color }}><Icon name="file" size={16} /></span>
                  {file.title}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {(time || kept?.deadline || kept?.repeat || kept?.starredAt || kept?.color || kept?.attachments) && (
        <div class="pop-row">
          <span class="pop-icon"><Icon name="info" /></span>
          <div class="muted pop-small">{KEPT_HINT}.</div>
        </div>
      )}
      {item.notes && (
        <div class="pop-row">
          <span class="pop-icon"><Icon name="notes" /></span>
          <div class="pop-main pop-description"><Linked text={item.notes} /></div>
        </div>
      )}
      {taskOrigins(item).map((origin, index) => (
        <div key={`origin-${index}`} class="pop-row">
          <span class="pop-icon"><Icon name="link" /></span>
          <div class="pop-main">
            {origin.url ? <button class="link" onClick={() => void host.openUrl(origin.url!)}>{origin.label}</button> : origin.label}
            {origin.detail && <div class="muted pop-small">{origin.detail}</div>}
          </div>
        </div>
      ))}
      <div class="pop-row">
        <span class="pop-icon"><Icon name="task" /></span>
        <div class="pop-main">{list?.title ?? 'Google Tasks'}{new Set(gv.lists.map((other) => other.account)).size > 1 ? <span class="muted"> · {item.account}</span> : null}</div>
      </div>
      <div class="pop-row">
        <span class="pop-icon"><Icon name="link" /></span>
        <div class="pop-main">
          {planned ? (
            <button class="link" onClick={() => { close(); setUi({ openTaskId: planned.id }); }}>
              Planned in the Planner: {plannedLabel(planned, view.today)}
            </button>
          ) : (
            <div class="row-buttons">
              <button onClick={() => run(() => google.planTask(item, { kind: 'day', date: due }))}>Plan on {due === view.today ? 'today' : due === addDays(view.today, 1) ? 'tomorrow' : longDay(due)}</button>
              {due !== view.today && <button onClick={() => run(() => google.planTask(item, { kind: 'day', date: view.today }))}>Plan today</button>}
            </div>
          )}
        </div>
      </div>
      <div class="pop-footer">
        <button class="primary" disabled={busy} onClick={() => run(() => google.completeListTask(item, !item.completed), item.completed ? 'Task marked not done' : 'Task completed', item.completed ? null : undoAction(google, client.notify))}>
          {item.completed ? 'Mark uncompleted' : 'Mark completed'}
        </button>
      </div>
    </Popover>
  );
};

/**
 * An upcoming occurrence of a repeating task, as Google Calendar shows a
 * future one: its title, when, and how its series repeats, with Edit (This
 * task or All tasks) and Delete (This task, This and following tasks or All
 * tasks), as Google Calendar asks. This task changes or deletes that
 * occurrence alone, kept with its series until the series makes it
 * (`setOccurrence`); the series and its other tasks stay as they are. This
 * and following tasks ends the series the day before it, so the tasks before
 * it stay as they are (`deleteSeries`). Editing all tasks acts on the series
 * through the occurrence open now, which Google has; deleting them deletes
 * the series, its completed tasks too.
 */
export const UpcomingPopover = ({ event, anchor }: { event: CalendarEvent; anchor: Anchor }) => {
  const { client, google } = usePlanner();
  const view = useView();
  const gv = useGoogle();
  const upcoming = event.upcoming!;
  const { template } = upcoming;
  const values = upcomingValues(upcoming);
  const [busy, setBusy] = useState(false);
  const zone = view.state.settings.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const list = gv.lists.find((other) => other.account === upcoming.account && other.id === upcoming.listId);
  const time = keptTimeLabel(values);
  /** The occurrence open now, as Google has it. */
  const current = async () => {
    const item = await google.findTask(upcoming.account, upcoming.listId, upcoming.taskId);
    if (!item) throw new Error('Google Tasks no longer has this series');
    return item;
  };
  const run = (work: () => Promise<unknown>) => {
    setBusy(true);
    work()
      .catch((error) => client.notify(`Google Tasks did not take it: ${messageOf(error)}`))
      .finally(() => setBusy(false));
  };
  const edit = async () => {
    const scope = await calendarUi.ask({ title: 'Edit repeating task', style: 'radio', choices: [{ id: 'this', label: 'This task' }, { id: 'all', label: 'All tasks' }] });
    // This task: the editor shows it as it is; its series' open task names its list and series.
    if (scope === 'this') calendarUi.editTask({ item: { account: upcoming.account, listId: upcoming.listId, id: upcoming.taskId, title: values.title, notes: values.notes, due: values.due, completed: false, parent: null, position: '', url: 'https://tasks.google.com/', updated: '' }, series: false, occurrence: upcoming });
    else if (scope === 'all') calendarUi.editTask({ item: await current(), series: true });
  };
  const remove = async () => {
    const scope = await calendarUi.ask({ title: 'Delete repeating task', style: 'radio', choices: DELETE_CHOICES });
    if (scope === 'this') {
      // The series passes over this date and goes on; Undo gives it back as it was then: what the service replaced, not
      // what this window last saw (another window may have changed it since).
      const before = await google.setOccurrence(upcoming, { skip: true });
      close();
      calendarUi.snack('Task deleted', async () => {
        await google.setOccurrence(upcoming, before).catch((error) => client.notify(`The Planner did not put "${values.title}" back: ${messageOf(error)}`));
      });
    } else if (scope === 'following' || scope === 'all') {
      // By the date the series puts this one on: the tasks before it stay (This and following), or none does (All tasks).
      await google.deleteSeries({ account: upcoming.account, seriesId: upcoming.seriesId, from: scope === 'following' ? upcoming.on : null });
      close();
      calendarUi.snack('Tasks deleted');
    }
  };
  return (
    <Popover anchor={anchor} label={`Repeating Google task: ${values.title}`} onClose={close} className="task-popover">
      <div class="pop-tools">
        <button class="icon-button" aria-label="Edit task" title="Edit task" disabled={busy} onClick={() => run(edit)}>
          <Icon name="edit" />
        </button>
        <button class="icon-button" aria-label="Delete task" title="Delete task" disabled={busy} onClick={() => run(remove)}>
          <Icon name="delete" />
        </button>
        <button class="icon-button" aria-label="Close" title="Close" onClick={close}>
          <Icon name="close" />
        </button>
      </div>
      <div class="pop-row pop-head">
        <span class="pop-icon" style={{ color: eventColor(event, view.state) }}><Icon name="repeat" /></span>
        <div class="pop-main">
          <h2 class="pop-title">{values.title}</h2>
          <div class="pop-when">{longDay(upcoming.date)}{time ? ` ⋅ ${time}` : ''}</div>
          <div class="pop-when">{describeRecurrence([upcoming.rule], template.start, zone)}</div>
        </div>
      </div>
      {values.deadline && (
        <div class="pop-row">
          <span class="pop-icon"><Icon name="flag" /></span>
          <div class="pop-main">Deadline: {longDay(values.deadline)}</div>
        </div>
      )}
      {advancedLabel({ time: values.time, busy: template.busy, visibility: template.visibility }) && (
        <div class="pop-row">
          <span class="pop-icon"><Icon name="tune" /></span>
          <div class="pop-main">{advancedLabel({ time: values.time, busy: template.busy, visibility: template.visibility })}</div>
        </div>
      )}
      {values.notes && (
        <div class="pop-row">
          <span class="pop-icon"><Icon name="notes" /></span>
          <div class="pop-main pop-description"><Linked text={values.notes} /></div>
        </div>
      )}
      <div class="pop-row">
        <span class="pop-icon"><Icon name="info" /></span>
        <div class="muted pop-small">
          {upcoming.change ? 'An upcoming task of this series, changed for this task alone: Google Tasks adds it as shown here when the one before it is done.' : 'An upcoming task of this series: Google Tasks adds it when the one before it is done.'} {KEPT_HINT}.
        </div>
      </div>
      <div class="pop-row">
        <span class="pop-icon"><Icon name="task" /></span>
        <div class="pop-main">{list?.title ?? 'Google Tasks'}{new Set(gv.lists.map((other) => other.account)).size > 1 ? <span class="muted"> · {upcoming.account}</span> : null}</div>
      </div>
    </Popover>
  );
};

/** A month day's "N more": everything on that day, each opening its own details. */
export const DayPopover = ({ date, events, anchor, onDay }: { date: DateKey; events: readonly CalendarEvent[]; anchor: Anchor; onDay?: (date: DateKey) => void }) => {
  const view = useView();
  const { setUi } = useUi();
  const zone = view.state.settings.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = events.filter((event) => {
    const span = eventSpan(event, zone);
    return span.first <= date && span.last >= date;
  });
  const blocks = blocksOnDay(view.state, date);
  return (
    <Popover anchor={anchor} label={`Everything on ${longDay(date)}`} onClose={close} width={260} className="day-popover">
      <div class="pop-tools">
        <button class="icon-button" aria-label="Close" onClick={close}><Icon name="close" /></button>
      </div>
      <div class="day-popover-head">
        <div class="day-name">{weekdayShort(date)}</div>
        {onDay ? <button class="day-number" aria-label={`${longDay(date)}: show this day`} onClick={() => { close(); onDay(date); }}>{Number(date.slice(8))}</button> : <div class="day-number">{Number(date.slice(8))}</div>}
      </div>
      <ul class="day-popover-list">
        {today.map((event) => {
          const color = eventColor(event, view.state);
          const task = isTaskEvent(event) || Boolean(event.upcoming);
          return (
            <li key={event.id}>
              <button
                class={`month-chip${event.allDay || task ? ' is-bar' : ''}${taskClass(event)}${event.googleTask?.completed ? ' is-done' : ''}${answerClass(event)}`}
                style={{ '--item-color': color, '--item-ink': inkOn(color) }}
                aria-label={task ? taskEventLabel(event, view.state, view.today, zone) : eventLabel(event, zone)}
                onClick={(click) => calendarUi.open({ kind: popoverKind(event), event, anchor: anchorOf(click.currentTarget) })}
              >
                {!(event.allDay || task) && <span class="chip-dot" aria-hidden="true" />}
                {!(event.allDay || task) && <span class="chip-time">{compactClock(zonedDateMinutes(event.start, zone).minutes)}</span>}
                {task && <span aria-hidden="true">{event.taskDeadline ? '⚑ ' : event.upcoming ? '↻ ' : event.googleTask?.completed ? '☑ ' : '☐ '}</span>}
                <span class="chip-title">{event.title}</span>
              </button>
            </li>
          );
        })}
        {blocks.map((block) => {
          const task = view.state.tasks[block.taskId]!;
          return (
            <li key={block.id}>
              <button class="month-chip is-session" onClick={() => { close(); setUi({ openTaskId: task.id }); }} aria-label={`Working session: ${task.title}`}>
                <span class="chip-dot" aria-hidden="true" />
                <span class="chip-time">{compactClock(zonedDateMinutes(block.start, zone).minutes)}</span>
                <span class="chip-title">{task.title}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </Popover>
  );
};
