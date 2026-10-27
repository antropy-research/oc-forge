import { useEffect, useRef, useState } from 'preact/hooks';
import type { CalendarEvent } from '../../src/domain/ics.ts';
import type { DateKey, Placement, WorkBlock } from '../../src/domain/types.ts';
import { addDays, clockLabel, daysBetween, instantAt, zonedDateMinutes } from '../../src/domain/dates.ts';
import { blocksOnDay, edgePosition } from '../../src/domain/selectors.ts';
import { isGoogleTaskItem } from '../../src/domain/google.ts';
import { compactClock, compactRange, eventSpan, fitRow, layoutRow, longDay, weekdayShort, type RowItem } from '../../src/domain/gcalendar.ts';
import { layoutLanes } from '../../src/domain/schedule.ts';
import { newId } from '../../src/domain/ids.ts';
import { DRAG_TYPE, GITHUB_DRAG_TYPE, GOOGLE_DRAG_TYPE, LINEAR_DRAG_TYPE, usePlanner, useView } from '../lib/context.ts';
import { isGitHubItem } from '../../src/domain/github.ts';
import { isLinearIssue } from '../../src/domain/linear.ts';
import { useUi } from '../lib/ui.ts';
import { useNow } from '../lib/time.ts';
import { useCalendarEvents } from '../lib/calendar.ts';
import { anchorOf, boxAnchor, calendarUi, changeEventTimes, useCalendarUi, type Anchor } from '../lib/gcal.ts';
import { answerClass, eventColor, eventLabel, GCAL_EVENT_TYPE, GCAL_TASK_TYPE, inkOn, isTaskEvent, plannedTask } from './calendar/items.ts';
import { CalendarOverlays } from './calendar/Overlays.tsx';

const HOUR_PX = 48;
const PX_PER_MIN = HOUR_PX / 60;
const SNAP = 15;
const DAY_MIN = 24 * 60;
const ALL_DAY_LINES = 3;
const snap = (minutes: number): number => Math.round(minutes / SNAP) * SNAP;
const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/** A pointer drag on the grid: a session or a Google event moved or resized, or a new event drawn. */
type Drag =
  | { kind: 'block' | 'event'; block?: WorkBlock; event?: CalendarEvent; mode: 'move' | 'resize'; date: DateKey; startMinutes: number; endMinutes: number; pointerX: number; pointerY: number; deltaMinutes: number; targetDate: DateKey; moved: boolean; anchor: Anchor }
  | { kind: 'create'; date: DateKey; from: number; to: number; pointerY: number; moved: boolean };

interface Item {
  kind: 'block' | 'event';
  id: string;
  start: number;
  end: number;
  title: string;
  color: string;
  detail: string;
  block?: WorkBlock;
  event?: CalendarEvent;
  done?: boolean;
  /** Begins before this day or ends after it: shown here in part, moved only from its details. */
  clipped?: boolean;
}

/** Google Calendar's grid: a day or a week of hours, with the all-day row above. Working sessions drop, drag and resize; Google events open, drag and resize too. */
export const TimeGrid = ({ dates, events, onDay }: { dates: DateKey[]; events: CalendarEvent[]; onDay?: (date: DateKey) => void }) => {
  const { client, linear, github, google } = usePlanner();
  const view = useView();
  const { setUi } = useUi();
  const calendar = useCalendarUi();
  const zone = view.state.settings.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  /** Sunsama's "add an event as a task": on its day, with the event's length as planned time. */
  const addEventAsTask = (title: string, date: DateKey, minutes: number | null, note: string) => {
    const placement = { kind: 'day' as const, date };
    void client.dispatch(
      [{ type: 'task.created', task: { id: newId(), title, placement, position: edgePosition(view.state, placement, 'bottom'), ...(minutes ? { plannedMinutes: Math.min(minutes, 24 * 60) } : {}), notes: note } }],
      { undo: 'Task added from the calendar' },
    );
  };
  const inPlan = (title: string, date: DateKey) => Object.values(view.state.tasks).some((task) => task.title === title && !task.deletedAt && task.placement.kind === 'day' && task.placement.date === date);
  const scroller = useRef<HTMLDivElement>(null);
  const lanes = useRef<Record<string, HTMLDivElement | null>>({});
  const [drag, setDrag] = useState<Drag | null>(null);
  const [dropHint, setDropHint] = useState<{ date: DateKey; minutes: number } | null>(null);
  const [allDayOver, setAllDayOver] = useState<DateKey | null>(null);
  const [allDayOpen, setAllDayOpen] = useState(false);
  const now = useNow(true, 60_000);
  const nowLocal = zonedDateMinutes(now, zone);

  useEffect(() => {
    scroller.current?.scrollTo({ top: Math.max(0, (view.state.settings.workdayStart - 60) * PX_PER_MIN) });
  }, []);

  /** The minute under the pointer: the nearest 15 for drops, the 15 the pointer is in when drawing an event. */
  const minutesAt = (date: DateKey, clientY: number, slot: 'nearest' | 'under' = 'nearest'): number => {
    const lane = lanes.current[date];
    if (!lane) return 0;
    const raw = (clientY - lane.getBoundingClientRect().top) / PX_PER_MIN;
    return clamp(slot === 'nearest' ? snap(raw) : Math.floor(raw / SNAP) * SNAP, 0, DAY_MIN - SNAP);
  };
  const dateAt = (clientX: number): DateKey | null =>
    dates.find((date) => {
      const box = lanes.current[date]?.getBoundingClientRect();
      return box && clientX >= box.left && clientX < box.right;
    }) ?? null;
  /** The box of a time span in a day's lane, for a popover to point at. */
  const spanAnchor = (date: DateKey, start: number, end: number) => {
    const box = lanes.current[date]?.getBoundingClientRect();
    return box ? { x: box.left, y: box.top + start * PX_PER_MIN, width: box.width, height: Math.max(20, (end - start) * PX_PER_MIN) } : { x: 0, y: 0, width: 0, height: 0 };
  };

  // Pointer drags: sessions and Google events move and resize; on empty grid a new event is drawn.
  // HTML drag and drop is only for tasks and chips. The listeners go on at the pointer's press,
  // not after a render, so a quick click's release is never missed.
  const dragRef = useRef<Drag | null>(null);
  const stopDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => stopDrag.current?.(), []);
  const beginDrag = (initial: Drag) => {
    stopDrag.current?.();
    dragRef.current = initial;
    setDrag(initial);
    const update = (next: Drag) => {
      dragRef.current = next;
      setDrag(next);
    };
    const onMove = (event: PointerEvent) => {
      const current = dragRef.current;
      if (!current) return;
      if (current.kind === 'create') {
        const to = minutesAt(current.date, event.clientY, 'under');
        const moved = current.moved || Math.abs(event.clientY - current.pointerY) > 4;
        if (to !== current.to || moved !== current.moved) update({ ...current, to, moved });
        return;
      }
      const deltaMinutes = snap((event.clientY - current.pointerY) / PX_PER_MIN);
      const targetDate = current.mode === 'move' ? dateAt(event.clientX) ?? current.targetDate : current.date;
      const moved = current.moved || Math.abs(event.clientY - current.pointerY) > 3 || Math.abs(event.clientX - current.pointerX) > 3;
      if (deltaMinutes !== current.deltaMinutes || targetDate !== current.targetDate || moved !== current.moved) update({ ...current, deltaMinutes, targetDate, moved });
    };
    const onUp = () => {
      stop();
      const current = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (current) finishDrag(current);
    };
    const stop = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      stopDrag.current = null;
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    stopDrag.current = stop;
  };
  const finishDrag = (current: Drag) => {
    if (current.kind === 'create') {
      // A click makes an hour from the half hour under it, a drag the span drawn, as in Google Calendar.
      const start = current.moved ? Math.min(current.from, current.to) : Math.floor(current.from / 30) * 30;
      const end = current.moved ? Math.max(current.from, current.to) + SNAP : Math.min(DAY_MIN, start + 60);
      calendarUi.startDraft({ kind: 'event', date: current.date, endDate: current.date, start, end, anchor: spanAnchor(current.date, start, end) });
      return;
    }
    if (!current.moved) {
      if (current.kind === 'block' && current.block) setUi({ openTaskId: current.block.taskId });
      else if (current.event) calendarUi.open({ kind: 'event', event: current.event, anchor: current.anchor });
      return;
    }
    const length = current.endMinutes - current.startMinutes;
    let start = current.startMinutes;
    let end = current.endMinutes;
    if (current.mode === 'move') {
      start = clamp(current.startMinutes + current.deltaMinutes, 0, DAY_MIN - length);
      end = start + length;
    } else end = clamp(current.endMinutes + current.deltaMinutes, current.startMinutes + SNAP, DAY_MIN);
    if (start === current.startMinutes && end === current.endMinutes && current.targetDate === current.date) return;
    if (current.kind === 'event' && current.event) {
      void changeEventTimes(client, current.event, { allDay: false, start: instantAt(current.targetDate, start, zone), end: instantAt(current.targetDate, end, zone) }, zone);
      return;
    }
    if (!current.block) return;
    void client.dispatch(
      [{ type: 'block.updated', blockId: current.block.id, start: instantAt(current.targetDate, start, zone), end: instantAt(current.targetDate, end, zone) }],
      { undo: current.mode === 'move' ? 'Session moved' : 'Session resized' },
    );
  };

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
      if (event.allDay || isTaskEvent(event)) continue;
      const startLocal = zonedDateMinutes(event.start, zone);
      const endLocal = zonedDateMinutes(event.end, zone);
      if (startLocal.date > date || endLocal.date < date || (endLocal.date === date && endLocal.minutes === 0 && startLocal.date < date)) continue;
      const start = startLocal.date < date ? 0 : startLocal.minutes;
      const end = endLocal.date > date ? DAY_MIN : endLocal.minutes;
      items.push({ kind: 'event', id: event.id, start, end: Math.max(end, start + SNAP), title: event.title, color: eventColor(event, view.state.calendars), detail: `${compactRange(start, end)}${event.location ? `, ${event.location}` : ''}`, event, clipped: startLocal.date < date || endLocal.date > date });
    }
    return items;
  };

  // The all-day row: all-day events as bars across their days, and Google tasks on their due day.
  const allDayItems: RowItem<CalendarEvent>[] = events.filter((event) => event.allDay || isTaskEvent(event)).map((event) => ({ item: event, span: eventSpan(event, zone), bar: true, startMs: Date.parse(event.start) }));
  const row = layoutRow(allDayItems, dates);
  const fitted = allDayOpen ? { shown: row.placements, more: dates.map(() => 0) } : fitRow(row.placements, dates.length, ALL_DAY_LINES);
  const allDayLines = Math.max(1, allDayOpen ? row.lines : Math.min(row.lines, ALL_DAY_LINES));
  const columns = `52px repeat(${dates.length}, minmax(0, 1fr))`;

  const dropOnDay = (event: DragEvent, date: DateKey) => {
    const data = event.dataTransfer;
    if (!data) return;
    const taskData = data.getData(GCAL_TASK_TYPE);
    if (taskData) {
      let item: unknown = null;
      try {
        item = JSON.parse(taskData);
      } catch {
        return;
      }
      if (isGoogleTaskItem(item) && item.due !== date) void google.setTaskDue(item, date).catch((error) => client.notify(`Google Tasks did not move it: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    const eventId = data.getData(GCAL_EVENT_TYPE);
    if (eventId) {
      const moving = events.find((item) => item.id === eventId);
      if (!moving?.google?.editable) return;
      const span = eventSpan(moving, zone);
      const days = daysBetween(span.first, date);
      if (days === 0) return;
      void changeEventTimes(client, moving, { allDay: true, startDate: addDays(span.first, days), endDate: addDays(span.last, days + 1) }, zone);
      return;
    }
    const placement: Placement = { kind: 'day', date };
    const googleData = data.getData(GOOGLE_DRAG_TYPE);
    if (googleData) {
      const planned = google.importDropped(googleData, placement);
      if (planned) void client.dispatch(planned.bodies, { undo: planned.label });
      return;
    }
    const taskId = data.getData(DRAG_TYPE);
    if (taskId && view.state.tasks[taskId]) void client.dispatch([{ type: 'task.moved', taskId, placement, position: edgePosition(view.state, placement, 'bottom') }], { undo: 'Task moved' });
  };
  const dayDropTypes = [GCAL_TASK_TYPE, GCAL_EVENT_TYPE, GOOGLE_DRAG_TYPE, DRAG_TYPE];
  /**
   * The day whose column is under the pointer (the hours' lanes line up with the
   * all-day cells): a drop on a day, or on a bar over it, lands on that day.
   */
  const allDayAt = (clientX: number): DateKey | null => dateAt(clientX);
  const draftOn = calendar.draft && calendar.draft.start !== null ? calendar.draft : null;
  const offset = zonedOffsetLabel(zone, now);

  return (
    <div class="time-grid gcal-grid">
      <div class="grid-head" style={{ gridTemplateColumns: columns }}>
        <div class="grid-zone" title={zone}>{offset}</div>
        {dates.map((date) => {
          const today = date === view.today;
          const name = weekdayShort(date);
          const number = Number(date.slice(8));
          return (
            <div key={date} class={`grid-day-head${today ? ' is-today' : ''}${date < view.today ? ' is-past' : ''}`}>
              <div class="day-name">{name}</div>
              {onDay ? (
                <button class="day-number" aria-label={`${longDay(date)}${today ? ', today' : ''}: show this day`} onClick={() => onDay(date)}>{number}</button>
              ) : (
                <div class="day-number" aria-label={longDay(date)}>{number}</div>
              )}
            </div>
          );
        })}
      </div>
      <div
        class="all-day-row"
        style={{ gridTemplateColumns: columns, gridTemplateRows: `repeat(${allDayLines}, 22px)` }}
        aria-label="All-day events"
        onDragOver={(event) => {
          if (!dayDropTypes.some((type) => event.dataTransfer?.types.includes(type))) return;
          const date = allDayAt(event.clientX);
          if (!date) return;
          event.preventDefault();
          setAllDayOver(date);
        }}
        onDragLeave={(event) => {
          if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) setAllDayOver(null);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setAllDayOver(null);
          const date = allDayAt(event.clientX);
          if (date) dropOnDay(event, date);
        }}
      >
        <div class="all-day-gutter" style={{ gridRow: `1 / span ${allDayLines}` }}>
          {row.lines > ALL_DAY_LINES && (
            <button class="all-day-toggle" aria-expanded={allDayOpen} aria-label={allDayOpen ? 'Show fewer all-day events' : 'Show all all-day events'} onClick={() => setAllDayOpen(!allDayOpen)}>{allDayOpen ? '▴' : '▾'}</button>
          )}
        </div>
        {dates.map((date, index) => (
          <div
            key={date}
            class={`all-day-cell${allDayOver === date ? ' is-over' : ''}`}
            data-date={date}
            style={{ gridColumn: `${index + 2}`, gridRow: `1 / span ${allDayLines}` }}
            onClick={(event) => {
              if (event.target !== event.currentTarget) return;
              calendarUi.startDraft({ kind: 'event', date, endDate: date, start: null, end: null, anchor: anchorOf(event.currentTarget) });
            }}
          />
        ))}
        {fitted.shown.map(({ item: event, col, span, slot, fromBefore, toAfter }) => {
          const color = eventColor(event, view.state.calendars);
          const task = isTaskEvent(event) ? event.googleTask! : null;
          const planned = task ? plannedTask(view.state, event) : null;
          const style = { gridColumn: `${col + 2} / span ${span}`, gridRow: `${slot + 1}`, '--item-color': color, '--item-ink': inkOn(color) };
          const label = task ? `Google task ${event.title}, due ${longDay(task.due ?? event.start.slice(0, 10))}${task.completed ? ', completed' : ''}${planned ? ', planned in the Planner' : ''}` : eventLabel(event, zone);
          return (
            <button
              key={event.id}
              class={`all-day-bar${task ? ' is-task' : ''}${task?.completed ? ' is-done' : ''}${fromBefore ? ' from-before' : ''}${toAfter ? ' to-after' : ''}${answerClass(event)}`}
              style={style}
              draggable={Boolean(task) || Boolean(event.google?.editable)}
              aria-label={label}
              title={label}
              onDragStart={(drag) => {
                if (!drag.dataTransfer) return;
                if (task) {
                  drag.dataTransfer.setData(GCAL_TASK_TYPE, JSON.stringify(task));
                  // Onto the hours, it is planned and timeboxed there, like a task from the list.
                  drag.dataTransfer.setData(GOOGLE_DRAG_TYPE, JSON.stringify({ kind: 'gtask', item: task }));
                } else drag.dataTransfer.setData(GCAL_EVENT_TYPE, event.id);
                drag.dataTransfer.effectAllowed = 'copyMove';
              }}
              onClick={(click) => calendarUi.open({ kind: task ? 'task' : 'event', event, anchor: anchorOf(click.currentTarget) })}
            >
              {task && <span class="task-box" aria-hidden="true">{task.completed ? '☑' : '☐'}</span>}
              <span class="bar-title">{event.title}</span>
              {planned && <span class="bar-badge" aria-hidden="true" title="Planned in the Planner">✓</span>}
            </button>
          );
        })}
        {fitted.more.map((count, index) =>
          count > 0 ? (
            <button key={`more-${dates[index]}`} class="all-day-more" style={{ gridColumn: `${index + 2}`, gridRow: `${ALL_DAY_LINES}` }} onClick={() => setAllDayOpen(true)}>
              {count} more
            </button>
          ) : null,
        )}
      </div>
      <div class="grid-scroll" ref={scroller}>
        <div class="grid-body" style={{ gridTemplateColumns: columns, height: `${24 * HOUR_PX}px` }}>
          <div class="hours" aria-hidden="true">
            {Array.from({ length: 23 }, (_, index) => (
              <div key={index} class="hour-label" style={{ top: `${(index + 1) * HOUR_PX}px` }}>{clockLabel((index + 1) * 60)}</div>
            ))}
          </div>
          {dates.map((date) => {
            const items = itemsFor(date);
            const creating = drag?.kind === 'create' && drag.date === date ? { start: Math.min(drag.from, drag.to), end: Math.max(drag.from, drag.to) + SNAP } : null;
            const ghost = creating ?? (draftOn && draftOn.date === date ? { start: draftOn.start!, end: draftOn.end! } : null);
            return (
              <div
                key={date}
                class={`day-lane${date === view.today ? ' is-today' : ''}`}
                data-date={date}
                aria-label={`Calendar for ${longDay(date)}`}
                ref={(element) => {
                  lanes.current[date] = element;
                }}
                onPointerDown={(event) => {
                  if (event.button !== 0 || (event.target as HTMLElement).closest('.grid-item, button')) return;
                  event.preventDefault();
                  const from = minutesAt(date, event.clientY, 'under');
                  beginDrag({ kind: 'create', date, from, to: from, pointerY: event.clientY, moved: false });
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
                {ghost && (
                  <div class="grid-item is-draft" style={{ top: `${ghost.start * PX_PER_MIN}px`, height: `${Math.max(14, (ghost.end - ghost.start) * PX_PER_MIN - 2)}px`, left: '2px', width: 'calc(100% - 8px)' }} aria-hidden="true">
                    <span class="item-title">{creating ? '(No title)' : calendar.draft?.kind === 'task' ? '(New task)' : '(No title)'}</span>
                    <span class="item-time">{compactRange(ghost.start, ghost.end)}</span>
                  </div>
                )}
                {layoutLanes(items).map(({ item, lane, lanes: total }) => {
                  let { start, end } = item;
                  const moving = drag && drag.kind !== 'create' && ((item.block && drag.block?.id === item.block.id) || (item.event && drag.event?.id === item.event.id)) ? drag : null;
                  const dragging = Boolean(moving);
                  if (moving && moving.targetDate !== date) return null;
                  if (moving) {
                    if (moving.mode === 'move') {
                      start = clamp(moving.startMinutes + moving.deltaMinutes, 0, DAY_MIN - (moving.endMinutes - moving.startMinutes));
                      end = start + (moving.endMinutes - moving.startMinutes);
                    } else end = clamp(moving.endMinutes + moving.deltaMinutes, moving.startMinutes + SNAP, DAY_MIN);
                  }
                  const style = {
                    top: `${start * PX_PER_MIN}px`,
                    height: `${Math.max(14, (end - start) * PX_PER_MIN - 2)}px`,
                    left: `calc(${(lane / total) * 100}% + 2px)`,
                    width: `calc(${100 / total}% - 4px)`,
                    '--item-color': item.color,
                    '--item-ink': inkOn(item.color),
                  };
                  const short = end - start < 45;
                  if (item.kind === 'event' && item.event) {
                    const event = item.event;
                    const movable = Boolean(event.google?.editable) && !item.clipped;
                    const startDrag = (pointer: PointerEvent, mode: 'move' | 'resize') => {
                      if (pointer.button !== 0) return;
                      pointer.preventDefault();
                      pointer.stopPropagation();
                      const element = (pointer.currentTarget as HTMLElement).closest('.grid-item') as HTMLElement;
                      beginDrag({ kind: 'event', event, mode, date, startMinutes: item.start, endMinutes: item.end, pointerX: pointer.clientX, pointerY: pointer.clientY, deltaMinutes: 0, targetDate: date, moved: false, anchor: anchorOf(element) });
                    };
                    return (
                      <div
                        key={item.id}
                        class={`grid-item is-event${movable ? ' is-movable' : ''}${short ? ' is-short' : ''}${dragging ? ' is-dragging' : ''}${answerClass(event)}`}
                        style={style}
                        role="button"
                        tabIndex={0}
                        aria-label={eventLabel(event, zone)}
                        title={`${item.title}\n${item.detail}`}
                        onPointerDown={(pointer) => {
                          if ((pointer.target as HTMLElement).closest('button')) return;
                          if (movable) startDrag(pointer, 'move');
                          else if (pointer.button === 0) {
                            pointer.stopPropagation();
                          }
                        }}
                        onClick={(click) => {
                          if (movable || (click.target as HTMLElement).closest('button')) return;
                          calendarUi.open({ kind: 'event', event, anchor: anchorOf(click.currentTarget) });
                        }}
                        onKeyDown={(key) => {
                          if (key.key !== 'Enter' && key.key !== ' ') return;
                          key.preventDefault();
                          calendarUi.open({ kind: 'event', event, anchor: anchorOf(key.currentTarget) });
                        }}
                      >
                        <span class="item-title">{item.title}{short ? <span class="item-time">, {compactClock(start)}</span> : null}</span>
                        {!short && <span class="item-time">{dragging ? compactRange(start, end) : item.detail}</span>}
                        {!inPlan(item.title, date) && (
                          <button class="item-add" aria-label={`Add ${item.title} as a task`} title="Add it to this day as a task, its length as planned time" onClick={() => addEventAsTask(item.title, date, item.end - item.start, `${item.detail}, from the calendar`)}>+</button>
                        )}
                        {movable && <div class="resize-handle" aria-hidden="true" onPointerDown={(pointer) => startDrag(pointer, 'resize')} />}
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
                        event.stopPropagation();
                        const startMinutes = zonedDateMinutes(item.block.start, zone).minutes;
                        beginDrag({ kind: 'block', block: item.block, mode: 'move', date, startMinutes, endMinutes: startMinutes + (Date.parse(item.block.end) - Date.parse(item.block.start)) / 60_000, pointerX: event.clientX, pointerY: event.clientY, deltaMinutes: 0, targetDate: date, moved: false, anchor: boxAnchor(event.currentTarget.getBoundingClientRect()) });
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
                          beginDrag({ kind: 'block', block: item.block, mode: 'resize', date, startMinutes, endMinutes: startMinutes + (Date.parse(item.block.end) - Date.parse(item.block.start)) / 60_000, pointerX: event.clientX, pointerY: event.clientY, deltaMinutes: 0, targetDate: date, moved: false, anchor: boxAnchor(event.currentTarget.getBoundingClientRect()) });
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

/** "GMT-07", as Google Calendar labels the hours with the zone's offset. */
const zonedOffsetLabel = (zone: string, now: number): string => {
  const local = zonedDateMinutes(now, zone);
  const utc = zonedDateMinutes(now, 'UTC');
  const days = local.date === utc.date ? 0 : local.date > utc.date ? 1 : -1;
  const minutes = Math.round(local.minutes - utc.minutes + days * DAY_MIN);
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `GMT${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}${abs % 60 ? `:${String(abs % 60).padStart(2, '0')}` : ''}`;
};

/** One day's time grid with its calendar events, its details and editor. */
export const DayCalendar = ({ date }: { date: DateKey }) => {
  const feed = useCalendarEvents(date, date);
  return (
    <>
      <TimeGrid dates={[date]} events={feed.events} />
      <CalendarOverlays />
    </>
  );
};
