// Google Calendar's popovers: an event's details (with Edit, Delete, Duplicate,
// RSVP and the Planner's "Plan as task"), a Google task's (complete, delete,
// plan it), and a month day's "N more" list.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { CalendarEvent } from '../../../src/domain/ics.ts';
import type { DateKey, Task } from '../../../src/domain/types.ts';
import { addDays, zonedDateMinutes } from '../../../src/domain/dates.ts';
import { compactClock, compactRange, eventSpan, longDay, weekdayShort } from '../../../src/domain/gcalendar.ts';
import { describeRecurrence } from '../../../src/domain/rrule.ts';
import { descriptionText } from '../../../src/domain/gevents.ts';
import { taskForGoogleTask, type GoogleEventDetail, type GoogleReminder, type GoogleResponse } from '../../../src/domain/google.ts';
import { blocksOnDay, edgePosition } from '../../../src/domain/selectors.ts';
import { newId } from '../../../src/domain/ids.ts';
import { useGoogle, usePlanner, useView } from '../../lib/context.ts';
import { useUi } from '../../lib/ui.ts';
import { anchorOf, calendarUi, eventDetail, removeEvent, respond, type Anchor } from '../../lib/gcal.ts';
import { plannedLabel } from '../GitHubPanel.tsx';
import { Icon } from './Icon.tsx';
import { Popover } from './Popover.tsx';
import { answerClass, eventColor, eventLabel, GOOGLE_TASKS_COLOR, isTaskEvent } from './items.ts';

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

/** The Planner's task for an event: one on its day with its title. */
const taskForEvent = (tasks: Readonly<Record<string, Task>>, event: CalendarEvent, day: DateKey): Task | null =>
  Object.values(tasks).find((task) => task.title === event.title && !task.deletedAt && task.placement.kind === 'day' && task.placement.date === day) ?? null;

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
  const color = eventColor(event, view.state.calendars);
  const day = eventSpan(event, zone).first;
  const planned = taskForEvent(view.state.tasks, event, day);
  const minutes = event.allDay ? null : Math.round((Date.parse(event.end) - Date.parse(event.start)) / 60_000);
  const description = detail?.description ? descriptionText(detail.description) : '';
  const meet = detail?.meet?.url ?? ref?.meet ?? null;
  const guests = detail?.attendees.filter((guest) => !guest.resource) ?? [];
  const plan = () => {
    const placement = { kind: 'day' as const, date: day };
    void client.dispatch(
      [{ type: 'task.created', task: { id: newId(), title: event.title, placement, position: edgePosition(view.state, placement, 'bottom'), ...(minutes ? { plannedMinutes: Math.min(minutes, 24 * 60) } : {}), notes: `${whenText(event, zone)}, from the calendar` } }],
      { undo: 'Task added from the calendar' },
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
          <button class="link" onClick={plan} title="Add it to its day as a task, its length as planned time">
            <Icon name="task" size={16} /> Plan as task
          </button>
        )}
      </div>
    </Popover>
  );
};

/** A Google task on the calendar: complete it, delete it, open it in Google Tasks, or plan it. */
export const TaskPopover = ({ event, anchor }: { event: CalendarEvent; anchor: Anchor }) => {
  const { client, google, host } = usePlanner();
  const view = useView();
  const gv = useGoogle();
  const { setUi } = useUi();
  const item = event.googleTask!;
  const [busy, setBusy] = useState(false);
  const list = gv.lists.find((other) => other.account === item.account && other.id === item.listId);
  const planned = taskForGoogleTask(view.state, item);
  const due = item.due ?? event.start.slice(0, 10);
  const run = (work: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    work()
      .then(() => {
        close();
        if (done) calendarUi.snack(done);
      })
      .catch((error) => client.notify(`Google Tasks did not take it: ${messageOf(error)}`))
      .finally(() => setBusy(false));
  };
  return (
    <Popover anchor={anchor} label={`Google task: ${item.title}`} onClose={close} className="task-popover">
      <div class="pop-tools">
        <button class="icon-button" aria-label="Delete task" title="Delete task" disabled={busy} onClick={() => run(() => google.deleteListTask(item), 'Task deleted')}>
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
        <span class="pop-icon" style={{ color: GOOGLE_TASKS_COLOR }}><Icon name={item.completed ? 'done' : 'circle'} /></span>
        <div class="pop-main">
          <h2 class={`pop-title${item.completed ? ' is-done' : ''}`}>{item.title}</h2>
          <div class="pop-when">{longDay(due)}</div>
          <div class="muted pop-small" title="Google Tasks' API reads and writes a task's date only, never its time">Date only: Google Tasks shares no time for its tasks</div>
        </div>
      </div>
      {item.notes && (
        <div class="pop-row">
          <span class="pop-icon"><Icon name="notes" /></span>
          <div class="pop-main pop-description"><Linked text={item.notes} /></div>
        </div>
      )}
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
        <button class="primary" disabled={busy} onClick={() => run(() => google.completeListTask(item, !item.completed), item.completed ? 'Task marked not done' : 'Task completed')}>
          {item.completed ? 'Mark uncompleted' : 'Mark completed'}
        </button>
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
          const color = eventColor(event, view.state.calendars);
          const task = isTaskEvent(event);
          return (
            <li key={event.id}>
              <button
                class={`month-chip${event.allDay || task ? ' is-bar' : ''}${task ? ' is-task' : ''}${event.googleTask?.completed ? ' is-done' : ''}${answerClass(event)}`}
                style={{ '--item-color': color }}
                aria-label={eventLabel(event, zone)}
                onClick={(click) => calendarUi.open({ kind: task ? 'task' : 'event', event, anchor: anchorOf(click.currentTarget) })}
              >
                {!(event.allDay || task) && <span class="chip-dot" aria-hidden="true" />}
                {!(event.allDay || task) && <span class="chip-time">{compactClock(zonedDateMinutes(event.start, zone).minutes)}</span>}
                {task && <span aria-hidden="true">{event.googleTask?.completed ? '☑ ' : '☐ '}</span>}
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
