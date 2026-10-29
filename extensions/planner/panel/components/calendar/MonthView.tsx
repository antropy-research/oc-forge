// Google Calendar's Month view: weeks of days, all-day and several-day events
// as bars, timed ones as a dot, a time and a title, "N more" when a day is
// full. Drag anything to another day; drop a task on a day to plan it there.
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { CalendarEvent } from '../../../src/domain/ics.ts';
import type { DateKey, Placement } from '../../../src/domain/types.ts';
import { addDays, daysBetween, instantAt, zonedDateMinutes } from '../../../src/domain/dates.ts';
import { eventSpan, fitRow, layoutRow, longDay, monthWeeks, weekdayShort, type RowItem } from '../../../src/domain/gcalendar.ts';
import { isGoogleTaskItem } from '../../../src/domain/google.ts';
import { isGitHubItem } from '../../../src/domain/github.ts';
import { isLinearIssue } from '../../../src/domain/linear.ts';
import { edgePosition } from '../../../src/domain/selectors.ts';
import { DRAG_TYPE, GITHUB_DRAG_TYPE, GOOGLE_DRAG_TYPE, LINEAR_DRAG_TYPE, usePlanner, useView } from '../../lib/context.ts';
import { useUi } from '../../lib/ui.ts';
import { anchorOf, calendarUi, changeEventTimes, popoverKind, useCalendarUi } from '../../lib/gcal.ts';
import { answerClass, calendarItems, deadlineOf, deadlinePassed, eventColor, eventLabel, GCAL_BLOCK_TYPE, GCAL_EVENT_TYPE, GCAL_TASK_TYPE, inkOn, isMovableTask, isTaskEvent, itemKey, plannedTask, startLabel, taskClass, taskEventLabel, type CalItem } from './items.ts';
import { Icon } from './Icon.tsx';

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DATE_ROW = 26;
const LINE = 21;
const isWeekend = (date: DateKey): boolean => [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const MonthView = ({ anchor, events, onDay }: { anchor: DateKey; events: CalendarEvent[]; onDay: (date: DateKey) => void }) => {
  const { client, google, linear, github } = usePlanner();
  const view = useView();
  const { setUi } = useUi();
  const { prefs } = useCalendarUi();
  const zone = view.state.settings.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const weeks = monthWeeks(anchor, view.state.settings.weekStartsOn).map((week) => (prefs.weekends ? week : week.filter((day) => !isWeekend(day))));
  const first = weeks[0]![0]!;
  const last = weeks[weeks.length - 1]![weeks[0]!.length - 1]!;
  const items = calendarItems(view.state, events, first, last, zone, { completedTasks: prefs.completedTasks, channel: () => true });
  const grid = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState(3);
  const [over, setOver] = useState<DateKey | null>(null);

  // As many lines as a row has room for, the last one kept for "N more".
  useLayoutEffect(() => {
    const element = grid.current;
    if (!element) return;
    const measure = () => setLines(Math.max(1, Math.floor((element.clientHeight / weeks.length - DATE_ROW - 4) / LINE)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [weeks.length]);

  const drop = (event: DragEvent, date: DateKey) => {
    const data = event.dataTransfer;
    if (!data) return;
    const placement: Placement = { kind: 'day', date };
    const taskData = data.getData(GCAL_TASK_TYPE);
    if (taskData) {
      let item: unknown = null;
      try {
        item = JSON.parse(taskData);
      } catch {
        return;
      }
      if (isGoogleTaskItem(item) && item.due !== date) void google.setTaskDue(item, date).catch((error) => client.notify(`Google Tasks did not move it: ${messageOf(error)}`));
      return;
    }
    const eventId = data.getData(GCAL_EVENT_TYPE);
    if (eventId) {
      const moving = events.find((item) => item.id === eventId);
      if (!moving?.google?.editable) return;
      const span = eventSpan(moving, zone);
      const days = daysBetween(span.first, date);
      if (!days) return;
      if (moving.allDay) void changeEventTimes(client, moving, { allDay: true, startDate: addDays(span.first, days), endDate: addDays(span.last, days + 1) }, zone);
      else {
        // The same clock times, another day.
        const start = zonedDateMinutes(moving.start, zone);
        const end = zonedDateMinutes(moving.end, zone);
        void changeEventTimes(client, moving, { allDay: false, start: instantAt(addDays(start.date, days), start.minutes, zone), end: instantAt(addDays(end.date, days), end.minutes, zone) }, zone);
      }
      return;
    }
    const blockId = data.getData(GCAL_BLOCK_TYPE);
    if (blockId) {
      const block = view.state.blocks[blockId];
      if (!block) return;
      const start = zonedDateMinutes(block.start, zone);
      const days = daysBetween(start.date, date);
      if (!days) return;
      const end = zonedDateMinutes(block.end, zone);
      void client.dispatch([{ type: 'block.updated', blockId, start: instantAt(date, start.minutes, zone), end: instantAt(addDays(end.date, days), end.minutes, zone) }], { undo: 'Session moved' });
      return;
    }
    const googleData = data.getData(GOOGLE_DRAG_TYPE);
    if (googleData) {
      const planned = google.importDropped(googleData, placement);
      if (planned) void client.dispatch(planned.bodies, { undo: planned.label });
      return;
    }
    const issueData = data.getData(LINEAR_DRAG_TYPE);
    if (issueData) {
      try {
        const issue: unknown = JSON.parse(issueData);
        if (isLinearIssue(issue)) void client.dispatch(linear.importCommands(issue, placement).bodies, { undo: `Planned ${issue.identifier}` });
      } catch {
        // Not an issue.
      }
      return;
    }
    const githubData = data.getData(GITHUB_DRAG_TYPE);
    if (githubData) {
      try {
        const item: unknown = JSON.parse(githubData);
        if (isGitHubItem(item)) void client.dispatch(github.importCommands(item, placement).bodies, { undo: `Planned ${item.key}` });
      } catch {
        // Not an item.
      }
      return;
    }
    const taskId = data.getData(DRAG_TYPE);
    if (taskId && view.state.tasks[taskId]) void client.dispatch([{ type: 'task.moved', taskId, placement, position: edgePosition(view.state, placement, 'bottom') }], { undo: 'Task moved' });
  };
  const accepted = [GCAL_TASK_TYPE, GCAL_EVENT_TYPE, GCAL_BLOCK_TYPE, GOOGLE_DRAG_TYPE, LINEAR_DRAG_TYPE, GITHUB_DRAG_TYPE, DRAG_TYPE];
  const columns = `repeat(${weeks[0]!.length}, minmax(0, 1fr))`;

  const chip = (entry: RowItem<CalItem>, style: Record<string, string>, extraClass = '') => {
    const item = entry.item;
    if (item.kind === 'block') {
      const color = item.task.channelId ? view.state.channels[item.task.channelId]?.color ?? 'var(--oc-primary)' : 'var(--oc-primary)';
      return (
        <button
          key={itemKey(item)}
          class={`month-chip is-session${item.task.completedAt ? ' is-done' : ''}${extraClass}`}
          style={{ ...style, '--item-color': color }}
          draggable
          aria-label={`Working session: ${item.task.title}, ${startLabel(item.block.start, zone)}`}
          onDragStart={(event) => {
            event.dataTransfer?.setData(GCAL_BLOCK_TYPE, item.block.id);
            if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
          }}
          onClick={() => setUi({ openTaskId: item.task.id })}
        >
          <span class="chip-dot is-square" aria-hidden="true" />
          <span class="chip-time">{startLabel(item.block.start, zone)}</span>
          <span class="chip-title">{item.task.title}</span>
        </button>
      );
    }
    const event = item.event;
    const color = eventColor(event, view.state.calendars);
    const task = isTaskEvent(event) ? event.googleTask! : null;
    const movable = isMovableTask(event);
    const planned = task ? plannedTask(view.state, event) : null;
    const deadline = task ? deadlineOf(event, view.state, view.today) : null;
    const draggable = movable || Boolean(event.google?.editable);
    const label = task || event.upcoming ? taskEventLabel(event, view.state, view.today, zone) : eventLabel(event, zone);
    return (
      <button
        key={itemKey(item)}
        class={`month-chip${entry.bar ? ' is-bar' : ''}${taskClass(event)}${task?.completed ? ' is-done' : ''}${deadlinePassed(event, view.state, view.today) ? ' is-overdue' : ''}${answerClass(event)}${extraClass}`}
        style={{ ...style, '--item-color': color, '--item-ink': inkOn(color) }}
        draggable={draggable}
        aria-label={label}
        title={label}
        onDragStart={(drag) => {
          if (!drag.dataTransfer) return;
          if (task) {
            drag.dataTransfer.setData(GCAL_TASK_TYPE, JSON.stringify(task));
            drag.dataTransfer.setData(GOOGLE_DRAG_TYPE, JSON.stringify({ kind: 'gtask', item: task }));
          } else drag.dataTransfer.setData(GCAL_EVENT_TYPE, event.id);
          drag.dataTransfer.effectAllowed = 'copyMove';
        }}
        onClick={(click) => calendarUi.open({ kind: popoverKind(event), event, anchor: anchorOf(click.currentTarget) })}
      >
        {!entry.bar && <span class="chip-dot" aria-hidden="true" />}
        {!entry.bar && <span class="chip-time">{startLabel(event.start, zone)}</span>}
        {movable && <span class="task-box" aria-hidden="true">{task!.completed ? '☑' : '☐'}</span>}
        {event.taskDeadline && <span class="task-flag" aria-hidden="true">⚑</span>}
        {event.upcoming && <span class="task-repeat" aria-hidden="true"><Icon name="repeat" size={12} /></span>}
        {event.pendingTasks && <span class="task-pending" aria-hidden="true"><Icon name="taskAlt" size={14} /></span>}
        <span class="chip-title">{event.title}</span>
        {deadline && <span class={`task-deadline${deadline.overdue ? ' is-overdue' : ''}`} aria-hidden="true">⚑ {deadline.label}</span>}
        {planned && <span class="bar-badge" aria-hidden="true">✓</span>}
      </button>
    );
  };

  return (
    <div class="month-view">
      <div class="month-head" style={{ gridTemplateColumns: columns }}>
        {weeks[0]!.map((day) => <div key={day} class="month-weekday">{weekdayShort(day)}</div>)}
      </div>
      <div class="month-grid" ref={grid} style={{ gridTemplateRows: `repeat(${weeks.length}, minmax(0, 1fr))` }}>
        {weeks.map((week) => {
          const { placements } = layoutRow(items, week);
          const { shown, more } = fitRow(placements, week.length, lines);
          // A drop anywhere in the row, on a day or on what is shown on it, lands on the day under the pointer.
          const dayUnder = (event: DragEvent): DateKey | null => {
            const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
            return week[Math.floor(((event.clientX - box.left) / box.width) * week.length)] ?? null;
          };
          return (
            <div
              key={week[0]}
              class="month-row"
              style={{ gridTemplateColumns: columns, gridTemplateRows: `${DATE_ROW}px repeat(${lines}, ${LINE}px) 1fr` }}
              onDragOver={(event) => {
                if (!accepted.some((type) => event.dataTransfer?.types.includes(type))) return;
                event.preventDefault();
                setOver(dayUnder(event));
              }}
              onDragLeave={(event) => {
                if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) setOver(null);
              }}
              onDrop={(event) => {
                event.preventDefault();
                setOver(null);
                const day = dayUnder(event);
                if (day) drop(event, day);
              }}
            >
              {week.map((day, index) => {
                const firstOfMonth = day.endsWith('-01');
                const label = firstOfMonth ? `${MONTH_SHORT[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8))}` : String(Number(day.slice(8)));
                return (
                  <div
                    key={day}
                    class={`month-cell${day.slice(0, 7) !== anchor.slice(0, 7) ? ' is-other' : ''}${over === day ? ' is-over' : ''}`}
                    style={{ gridColumn: `${index + 1}`, gridRow: '1 / -1' }}
                    data-date={day}
                    aria-label={longDay(day)}
                    onClick={(event) => {
                      if (event.target !== event.currentTarget) return;
                      calendarUi.startDraft({ kind: 'event', date: day, endDate: day, start: null, end: null, anchor: anchorOf(event.currentTarget) });
                    }}
                  >
                    <button class={`month-date${day === view.today ? ' is-today' : ''}`} aria-label={`${longDay(day)}${day === view.today ? ', today' : ''}: show this day`} onClick={() => onDay(day)}>
                      {label}
                    </button>
                  </div>
                );
              })}
              {shown.map((entry) =>
                chip({ item: entry.item, span: { first: week[entry.col]!, last: week[entry.col + entry.span - 1]! }, bar: items.find((candidate) => candidate.item === entry.item)?.bar ?? false, startMs: 0 }, { gridColumn: `${entry.col + 1} / span ${entry.span}`, gridRow: `${entry.slot + 2}` }, `${entry.fromBefore ? ' from-before' : ''}${entry.toAfter ? ' to-after' : ''}`),
              )}
              {more.map((count, index) =>
                count > 0 ? (
                  <button
                    key={`more-${week[index]}`}
                    class="month-more"
                    style={{ gridColumn: `${index + 1}`, gridRow: `${lines + 1}` }}
                    onClick={(event) => calendarUi.open({ kind: 'day', date: week[index]!, events, anchor: anchorOf(event.currentTarget) })}
                  >
                    {count} more
                  </button>
                ) : null,
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
