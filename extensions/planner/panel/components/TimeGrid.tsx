import { useEffect, useRef, useState } from 'preact/hooks';
import type { CalendarEvent } from '../../src/domain/ics.ts';
import type { DateKey, WorkBlock } from '../../src/domain/types.ts';
import { clockLabel, instantAt, monthDay, weekdayName, zonedDateMinutes } from '../../src/domain/dates.ts';
import { blocksOnDay, edgePosition } from '../../src/domain/selectors.ts';
import { taskForGoogleTask } from '../../src/domain/google.ts';
import { layoutLanes } from '../../src/domain/schedule.ts';
import { newId } from '../../src/domain/ids.ts';
import { DRAG_TYPE, GITHUB_DRAG_TYPE, GOOGLE_DRAG_TYPE, LINEAR_DRAG_TYPE, usePlanner, useView } from '../lib/context.ts';
import { isGitHubItem } from '../../src/domain/github.ts';
import { isLinearIssue } from '../../src/domain/linear.ts';
import { useUi } from '../lib/ui.ts';
import { useNow } from '../lib/time.ts';
import { useCalendarEvents } from '../lib/calendar.ts';
import { dayLabel } from './DayColumn.tsx';

const HOUR_PX = 48;
const PX_PER_MIN = HOUR_PX / 60;
const SNAP = 15;
const DAY_MIN = 24 * 60;
const snap = (minutes: number): number => Math.round(minutes / SNAP) * SNAP;
const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

interface Drag {
  block: WorkBlock;
  mode: 'move' | 'resize';
  date: DateKey;
  startMinutes: number;
  endMinutes: number;
  pointerX: number;
  pointerY: number;
  deltaMinutes: number;
  targetDate: DateKey;
  moved: boolean;
}

interface Item {
  kind: 'block' | 'event';
  id: string;
  start: number;
  end: number;
  title: string;
  color: string;
  detail: string;
  block?: WorkBlock;
  done?: boolean;
}

/** A Sunsama-style calendar: time grid for `dates`, working sessions you can drop, drag and resize. */
export const TimeGrid = ({ dates, events }: { dates: DateKey[]; events: CalendarEvent[] }) => {
  const { client, linear, github, google } = usePlanner();
  /** Sunsama's "add an event as a task": on its day, with the event's length as planned time. */
  const addEventAsTask = (title: string, date: DateKey, minutes: number | null, note: string) => {
    const placement = { kind: 'day' as const, date };
    void client.dispatch(
      [{ type: 'task.created', task: { id: newId(), title, placement, position: edgePosition(view.state, placement, 'bottom'), ...(minutes ? { plannedMinutes: Math.min(minutes, 24 * 60) } : {}), notes: note } }],
      { undo: 'Task added from the calendar' },
    );
  };
  const inPlan = (title: string, date: DateKey) => Object.values(view.state.tasks).some((task) => task.title === title && !task.deletedAt && task.placement.kind === 'day' && task.placement.date === date);
  const view = useView();
  const { setUi } = useUi();
  const zone = view.state.settings.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const scroller = useRef<HTMLDivElement>(null);
  const lanes = useRef<Record<string, HTMLDivElement | null>>({});
  const [drag, setDrag] = useState<Drag | null>(null);
  const [dropHint, setDropHint] = useState<{ date: DateKey; minutes: number } | null>(null);
  const now = useNow(true, 60_000);
  const nowLocal = zonedDateMinutes(now, zone);

  useEffect(() => {
    scroller.current?.scrollTo({ top: Math.max(0, (view.state.settings.workdayStart - 60) * PX_PER_MIN) });
  }, []);

  const minutesAt = (date: DateKey, clientY: number): number => {
    const lane = lanes.current[date];
    if (!lane) return 0;
    return clamp(snap((clientY - lane.getBoundingClientRect().top) / PX_PER_MIN), 0, DAY_MIN - SNAP);
  };
  const dateAt = (clientX: number): DateKey | null =>
    dates.find((date) => {
      const box = lanes.current[date]?.getBoundingClientRect();
      return box && clientX >= box.left && clientX < box.right;
    }) ?? null;

  // Pointer drag for moving and resizing sessions; HTML drag and drop is only for tasks.
  useEffect(() => {
    if (!drag) return;
    const onMove = (event: PointerEvent) => {
      const deltaMinutes = snap((event.clientY - drag.pointerY) / PX_PER_MIN);
      const targetDate = drag.mode === 'move' ? dateAt(event.clientX) ?? drag.targetDate : drag.date;
      const moved = drag.moved || Math.abs(event.clientY - drag.pointerY) > 3 || Math.abs(event.clientX - drag.pointerX) > 3;
      if (deltaMinutes !== drag.deltaMinutes || targetDate !== drag.targetDate || moved !== drag.moved) setDrag({ ...drag, deltaMinutes, targetDate, moved });
    };
    const onUp = () => {
      const current = drag;
      setDrag(null);
      if (!current.moved) {
        setUi({ openTaskId: current.block.taskId });
        return;
      }
      const length = current.endMinutes - current.startMinutes;
      let start = current.startMinutes;
      let end = current.endMinutes;
      if (current.mode === 'move') {
        start = clamp(current.startMinutes + current.deltaMinutes, 0, DAY_MIN - length);
        end = start + length;
      } else {
        end = clamp(current.endMinutes + current.deltaMinutes, current.startMinutes + SNAP, DAY_MIN);
      }
      if (start === current.startMinutes && end === current.endMinutes && current.targetDate === current.date) return;
      void client.dispatch(
        [{ type: 'block.updated', blockId: current.block.id, start: instantAt(current.targetDate, start, zone), end: instantAt(current.targetDate, end, zone) }],
        { undo: current.mode === 'move' ? 'Session moved' : 'Session resized' },
      );
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp, { once: true });
    return () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
  }, [drag]);

  const itemsFor = (date: DateKey): Item[] => {
    const items: Item[] = [];
    for (const block of blocksOnDay(view.state, date)) {
      const task = view.state.tasks[block.taskId]!;
      const start = zonedDateMinutes(block.start, zone).minutes;
      const endLocal = zonedDateMinutes(block.end, zone);
      const end = endLocal.date === date ? endLocal.minutes : DAY_MIN;
      const channel = task.channelId ? view.state.channels[task.channelId] : null;
      items.push({ kind: 'block', id: block.id, start, end: Math.max(end, start + SNAP), title: task.title, color: channel?.color ?? 'var(--oc-primary)', detail: `${clockLabel(start)} – ${clockLabel(end)}`, block, done: Boolean(task.completedAt) });
    }
    for (const event of events) {
      if (event.allDay) continue;
      const startLocal = zonedDateMinutes(event.start, zone);
      const endLocal = zonedDateMinutes(event.end, zone);
      if (startLocal.date > date || endLocal.date < date || (endLocal.date === date && endLocal.minutes === 0 && startLocal.date < date)) continue;
      const start = startLocal.date < date ? 0 : startLocal.minutes;
      const end = endLocal.date > date ? DAY_MIN : endLocal.minutes;
      const calendar = view.state.calendars[event.calendarId];
      items.push({ kind: 'event', id: event.id, start, end: Math.max(end, start + SNAP), title: event.title, color: calendar?.color ?? '#868e96', detail: `${clockLabel(start)} – ${clockLabel(end)}${event.location ? ` · ${event.location}` : ''}` });
    }
    return items;
  };

  const allDay = (date: DateKey) =>
    events.filter((event) => event.allDay && zonedDateMinutes(event.start, zone).date <= date && zonedDateMinutes(event.end, zone).date > date);

  return (
    <div class="time-grid">
      <div class="grid-head" style={{ gridTemplateColumns: `52px repeat(${dates.length}, minmax(0, 1fr))` }}>
        <div />
        {dates.map((date) => (
          <div key={date} class={`grid-day-head${date === view.today ? ' is-today' : ''}`}>
            <div class="day-name">{dates.length > 1 && !['Today', 'Tomorrow', 'Yesterday'].includes(dayLabel(date, view.today)) ? weekdayName(date).slice(0, 3) : dayLabel(date, view.today)}</div>
            <div class="day-date">{monthDay(date).replace(/^(\w{3})\w*/, '$1')}</div>
            <div class="all-day">
              {allDay(date).map((event) =>
                event.googleTask ? (
                  // A Google task due that day, as Google Calendar shows it; one click plans it here.
                  taskForGoogleTask(view.state, event.googleTask) ? null : (
                    <button
                      key={event.id}
                      class="all-day-event is-task"
                      style={{ '--item-color': '#1a73e8' }}
                      title={`Google task due ${monthDay(date)}: plan it on this day`}
                      aria-label={`Plan the Google task ${event.title} on ${monthDay(date)}`}
                      onClick={() => void google.planTask(event.googleTask!, { kind: 'day', date })}
                    >
                      ☐ {event.title}
                    </button>
                  )
                ) : (
                  <div key={event.id} class="all-day-event" style={{ '--item-color': view.state.calendars[event.calendarId]?.color ?? '#868e96' }} title={event.title}>
                    {event.title}
                    {!inPlan(event.title, date) && <button class="item-add" aria-label={`Add ${event.title} as a task`} title="Add it to this day as a task" onClick={() => addEventAsTask(event.title, date, null, `All day, from the calendar`)}>+</button>}
                  </div>
                ),
              )}
            </div>
          </div>
        ))}
      </div>
      <div class="grid-scroll" ref={scroller}>
        <div class="grid-body" style={{ gridTemplateColumns: `52px repeat(${dates.length}, minmax(0, 1fr))`, height: `${24 * HOUR_PX}px` }}>
          <div class="hours" aria-hidden="true">
            {Array.from({ length: 23 }, (_, index) => (
              <div key={index} class="hour-label" style={{ top: `${(index + 1) * HOUR_PX}px` }}>{clockLabel((index + 1) * 60)}</div>
            ))}
          </div>
          {dates.map((date) => {
            const items = itemsFor(date);
            return (
              <div
                key={date}
                class="day-lane"
                data-date={date}
                aria-label={`Calendar for ${monthDay(date)}`}
                ref={(element) => {
                  lanes.current[date] = element;
                }}
                onDragOver={(event) => {
                  const types = event.dataTransfer?.types ?? [];
                  if (!types.includes(DRAG_TYPE) && !types.includes(LINEAR_DRAG_TYPE) && !types.includes(GITHUB_DRAG_TYPE) && !types.includes(GOOGLE_DRAG_TYPE)) return;
                  event.preventDefault();
                  setDropHint({ date, minutes: minutesAt(date, event.clientY) });
                }}
                onDragLeave={() => setDropHint(null)}
                onDrop={(event) => {
                  event.preventDefault();
                  setDropHint(null);
                  const start = minutesAt(date, event.clientY);
                  const issueData = event.dataTransfer?.getData(LINEAR_DRAG_TYPE);
                  if (issueData) {
                    let issue: unknown = null;
                    try {
                      issue = JSON.parse(issueData);
                    } catch {
                      return;
                    }
                    if (!isLinearIssue(issue)) return;
                    // Plan the issue on this day and timebox it in one undoable step.
                    const { bodies, taskId: planned } = linear.importCommands(issue, { kind: 'day', date });
                    const length = Math.max(SNAP, view.state.tasks[planned]?.plannedMinutes ?? 30);
                    bodies.push({ type: 'block.created', block: { id: newId(), taskId: planned, start: instantAt(date, start, zone), end: instantAt(date, Math.min(DAY_MIN, start + length), zone) } });
                    void client.dispatch(bodies, { undo: 'Timeboxed' });
                    return;
                  }
                  const githubData = event.dataTransfer?.getData(GITHUB_DRAG_TYPE);
                  if (githubData) {
                    let item: unknown = null;
                    try {
                      item = JSON.parse(githubData);
                    } catch {
                      return;
                    }
                    if (!isGitHubItem(item)) return;
                    const { bodies, taskId: planned } = github.importCommands(item, { kind: 'day', date });
                    const length = Math.max(SNAP, view.state.tasks[planned]?.plannedMinutes ?? 30);
                    bodies.push({ type: 'block.created', block: { id: newId(), taskId: planned, start: instantAt(date, start, zone), end: instantAt(date, Math.min(DAY_MIN, start + length), zone) } });
                    void client.dispatch(bodies, { undo: 'Timeboxed' });
                    return;
                  }
                  const googleData = event.dataTransfer?.getData(GOOGLE_DRAG_TYPE);
                  if (googleData) {
                    const planned = google.importDropped(googleData, { kind: 'day', date });
                    if (!planned) return;
                    const length = Math.max(SNAP, view.state.tasks[planned.taskId]?.plannedMinutes ?? 30);
                    planned.bodies.push({ type: 'block.created', block: { id: newId(), taskId: planned.taskId, start: instantAt(date, start, zone), end: instantAt(date, Math.min(DAY_MIN, start + length), zone) } });
                    void client.dispatch(planned.bodies, { undo: 'Timeboxed' });
                    return;
                  }
                  const taskId = event.dataTransfer?.getData(DRAG_TYPE);
                  const task = taskId ? view.state.tasks[taskId] : null;
                  if (!task) return;
                  const length = Math.max(SNAP, task.plannedMinutes ?? 30);
                  const end = Math.min(DAY_MIN, start + length);
                  void client.dispatch([{ type: 'block.created', block: { id: newId(), taskId: task.id, start: instantAt(date, start, zone), end: instantAt(date, end, zone) } }], { undo: 'Timeboxed' });
                }}
              >
                {Array.from({ length: 24 }, (_, hour) => <div key={hour} class="hour-line" style={{ top: `${hour * HOUR_PX}px` }} />)}
                {date === nowLocal.date && <div class="now-line" style={{ top: `${nowLocal.minutes * PX_PER_MIN}px` }} aria-hidden="true" />}
                {dropHint?.date === date && <div class="drop-slot" style={{ top: `${dropHint.minutes * PX_PER_MIN}px` }}>{clockLabel(dropHint.minutes)}</div>}
                {layoutLanes(items).map(({ item, lane, lanes: total }) => {
                  let { start, end } = item;
                  const dragging = drag && item.block && drag.block.id === item.block.id;
                  if (dragging && drag.targetDate !== date) return null;
                  if (dragging) {
                    if (drag.mode === 'move') {
                      start = clamp(drag.startMinutes + drag.deltaMinutes, 0, DAY_MIN - (drag.endMinutes - drag.startMinutes));
                      end = start + (drag.endMinutes - drag.startMinutes);
                    } else end = clamp(drag.endMinutes + drag.deltaMinutes, drag.startMinutes + SNAP, DAY_MIN);
                  }
                  const style = {
                    top: `${start * PX_PER_MIN}px`,
                    height: `${Math.max(14, (end - start) * PX_PER_MIN - 2)}px`,
                    left: `calc(${(lane / total) * 100}% + 2px)`,
                    width: `calc(${100 / total}% - 4px)`,
                    '--item-color': item.color,
                  };
                  if (item.kind === 'event') {
                    return (
                      <div key={item.id} class="grid-item is-event" style={style} title={`${item.title}\n${item.detail}`}>
                        <span class="item-title">{item.title}</span>
                        <span class="item-time">{item.detail}</span>
                        {!inPlan(item.title, date) && (
                          <button class="item-add" aria-label={`Add ${item.title} as a task`} title="Add it to this day as a task, its length as planned time" onClick={() => addEventAsTask(item.title, date, item.end - item.start, `${item.detail}, from the calendar`)}>+</button>
                        )}
                      </div>
                    );
                  }
                  return (
                    <div
                      key={item.id}
                      class={`grid-item is-block${item.done ? ' is-done' : ''}${dragging ? ' is-dragging' : ''}`}
                      style={style}
                      role="button"
                      aria-label={`${item.title}, ${item.detail}`}
                      onPointerDown={(event) => {
                        if (event.button !== 0 || !item.block) return;
                        event.preventDefault();
                        const startMinutes = zonedDateMinutes(item.block.start, zone).minutes;
                        setDrag({ block: item.block, mode: 'move', date, startMinutes, endMinutes: startMinutes + (Date.parse(item.block.end) - Date.parse(item.block.start)) / 60_000, pointerX: event.clientX, pointerY: event.clientY, deltaMinutes: 0, targetDate: date, moved: false });
                      }}
                    >
                      <span class="item-title">{item.title}</span>
                      <span class="item-time">{item.detail}</span>
                      <button
                        class="item-remove"
                        aria-label={`Remove working session for ${item.title}`}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (item.block) void client.dispatch([{ type: 'block.deleted', blockId: item.block.id }], { undo: 'Session removed' });
                        }}
                      >×</button>
                      <div
                        class="resize-handle"
                        aria-hidden="true"
                        onPointerDown={(event) => {
                          if (!item.block) return;
                          event.preventDefault();
                          event.stopPropagation();
                          const startMinutes = zonedDateMinutes(item.block.start, zone).minutes;
                          setDrag({ block: item.block, mode: 'resize', date, startMinutes, endMinutes: startMinutes + (Date.parse(item.block.end) - Date.parse(item.block.start)) / 60_000, pointerX: event.clientX, pointerY: event.clientY, deltaMinutes: 0, targetDate: date, moved: false });
                        }}
                      />
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

/** One day's time grid with its calendar events. */
export const DayCalendar = ({ date }: { date: DateKey }) => {
  const feed = useCalendarEvents(date, date);
  return <TimeGrid dates={[date]} events={feed.events} />;
};
