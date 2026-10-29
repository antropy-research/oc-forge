// Google Calendar's Print (Settings → Print, or Ctrl/⌘+P;
// https://support.google.com/calendar/answer/41067): a "Print preview" of the
// range the calendar shows, with Google's options (print range, view, font
// size, orientation, color and style, show weekends, show events you have
// declined; in Schedule, descriptions and your response) beside the page as it
// will print, then Print. The printout has what the calendar shows in that
// range: events of the calendars shown, Google tasks (their deadlines, upcoming
// occurrences and Pending tasks) and the Planner's working sessions.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { CalendarEvent } from '../../../src/domain/ics.ts';
import type { DateKey } from '../../../src/domain/types.ts';
import type { GoogleResponse } from '../../../src/domain/google.ts';
import { clockLabel, daysBetween, zonedDateMinutes } from '../../../src/domain/dates.ts';
import { compactRange, scheduleDays, weekdayShort, longDay, type CalendarMode } from '../../../src/domain/gcalendar.ts';
import { layoutLanes } from '../../../src/domain/schedule.ts';
import {
  PRINT_COLORS,
  PRINT_FONT_SIZES,
  PRINT_ORIENTATIONS,
  PRINT_VIEWS,
  defaultPrintOptions,
  pageOrientation,
  printHours,
  printLayout,
  printPages,
  type PrintLayout,
  type PrintOptions,
  type PrintPage,
} from '../../../src/domain/calendarPrint.ts';
import { usePlanner, useView } from '../../lib/context.ts';
import { useCalendarEvents } from '../../lib/calendar.ts';
import { eventDetail, useCalendarUi } from '../../lib/gcal.ts';
import { useForge } from '../../lib/forge.ts';
import { PRINT_NEEDS_HOST, canPrint, clearPrintable, printNow, setPrintable } from '../../lib/print.ts';
import { calendarItems, eventColor, isTaskEvent } from './items.ts';

/** The longest print range: a year of days, so a printout stays one the browser can lay out. */
export const PRINT_DAYS_MAX = 366;

/** One thing on the calendar, as it prints. */
export interface PrintedItem {
  key: string;
  /** With a task's mark: "☐ Send the report", "⚑ Report", "↻ Standup". */
  title: string;
  /** "9 – 10am", "All day", "Deadline", "Pending". */
  time: string;
  allDay: boolean;
  /** Minutes in its day, for a Day or Week page's grid. */
  start: number;
  end: number;
  location: string;
  color: string;
  /** My answer as a guest; null when I organize it or am not one. */
  response: GoogleResponse | null;
  done: boolean;
  session: boolean;
  description: string;
}

const RESPONSE_WORDS: Record<GoogleResponse, string> = { accepted: 'Yes', declined: 'No', tentative: 'Maybe', needsAction: 'Not answered' };

const responseClass = (item: PrintedItem): string =>
  item.response === 'needsAction' ? ' is-unanswered' : item.response === 'declined' ? ' is-declined' : item.response === 'tentative' ? ' is-tentative' : '';

const ItemBox = ({ item, options, inGrid = false }: { item: PrintedItem; options: PrintOptions; inGrid?: boolean }) => (
  <div class={`pc-item${responseClass(item)}${item.done ? ' is-done' : ''}${item.session ? ' is-session' : ''}${item.allDay ? ' is-allday' : ''}`} style={{ '--c': item.color }}>
    {item.response === 'tentative' && options.color === 'full' && <span class="pc-mark">? </span>}
    {item.response === 'declined' && <span class="pc-mark">⊘ </span>}
    {!item.allDay && !inGrid && <span class="pc-time">{item.time} </span>}
    <span class="pc-title">{item.title}</span>
    {inGrid && !item.allDay && <span class="pc-time"> {item.time}</span>}
    {item.location && (inGrid || options.view !== 'month') && <span class="pc-where">, {item.location}</span>}
  </div>
);

/** A Day or Week page: the all-day row, then the hours with each day's timed items side by side where they overlap. */
const GridPage = ({ page, byDay, options }: { page: PrintPage; byDay: ReadonlyMap<DateKey, PrintedItem[]>; options: PrintOptions }) => {
  const timed = page.days.flatMap((day) => (byDay.get(day) ?? []).filter((item) => !item.allDay));
  const { first, last } = printHours(timed);
  const span = (last - first) * 60;
  return (
    <div class="pg-grid" style={{ '--days': String(page.days.length), '--hours': String(last - first) }}>
      <div class="pg-row pg-heads">
        <div class="pg-gutter" />
        {page.days.map((day) => (
          <div key={day} class="pg-day-head">
            <span>{weekdayShort(day)}</span> <strong>{Number(day.slice(8))}</strong>
          </div>
        ))}
      </div>
      <div class="pg-row pg-allday">
        <div class="pg-gutter" />
        {page.days.map((day) => (
          <div key={day} class="pg-allday-cell">
            {(byDay.get(day) ?? []).filter((item) => item.allDay).map((item) => <ItemBox key={item.key} item={item} options={options} inGrid />)}
          </div>
        ))}
      </div>
      <div class="pg-row pg-body">
        <div class="pg-gutter pg-hours">
          {Array.from({ length: last - first }, (_, index) => (
            <div key={index} class="pg-hour">{clockLabel((first + index) * 60)}</div>
          ))}
        </div>
        {page.days.map((day) => (
          <div key={day} class="pg-col">
            {layoutLanes((byDay.get(day) ?? []).filter((item) => !item.allDay)).map(({ item, lane, lanes }) => (
              <div
                key={item.key}
                class="pg-slot"
                style={{
                  top: `${((Math.max(item.start, first * 60) - first * 60) / span) * 100}%`,
                  height: `${(Math.max(15, Math.min(item.end, last * 60) - Math.max(item.start, first * 60)) / span) * 100}%`,
                  left: `${(lane / lanes) * 100}%`,
                  width: `${100 / lanes}%`,
                }}
              >
                <ItemBox item={item} options={options} inGrid />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
};

/** A Month page: its weeks, each day with everything on it (nothing hidden behind "N more" on paper). */
const MonthPage = ({ page, byDay, options }: { page: PrintPage; byDay: ReadonlyMap<DateKey, PrintedItem[]>; options: PrintOptions }) => (
  <table class="pm-table">
    <thead>
      <tr>{page.weeks![0]!.map((day) => <th key={day}>{weekdayShort(day)}</th>)}</tr>
    </thead>
    <tbody>
      {page.weeks!.map((week) => (
        <tr key={week[0]}>
          {week.map((day) => {
            const inPage = page.days.includes(day);
            return (
              <td key={day} class={inPage ? '' : 'is-outside'}>
                <div class="pm-date">{Number(day.slice(8))}</div>
                {inPage && (byDay.get(day) ?? []).map((item) => <ItemBox key={item.key} item={item} options={options} />)}
              </td>
            );
          })}
        </tr>
      ))}
    </tbody>
  </table>
);

/** The Schedule: day after day, each thing with its time and place, and with them, if asked, its description and my answer. */
const SchedulePage = ({ page, byDay, options }: { page: PrintPage; byDay: ReadonlyMap<DateKey, PrintedItem[]>; options: PrintOptions }) => {
  const days = page.days.filter((day) => byDay.get(day)?.length);
  if (!days.length) return <p class="print-meta">Nothing on your calendars from {longDay(page.days[0]!)} to {longDay(page.days.at(-1)!)}.</p>;
  return (
    <div class="ps-days">
      {days.map((day) => (
        <section key={day} class="ps-day">
          <div class="ps-date">{longDay(day)}</div>
          <ul class="ps-items">
            {byDay.get(day)!.map((item) => (
              <li key={item.key} class={`ps-item${responseClass(item)}${item.done ? ' is-done' : ''}`} style={{ '--c': item.color }}>
                <span class="ps-time">{item.allDay ? item.time : item.time}</span>
                <span class="ps-dot" aria-hidden="true" />
                <span class="ps-what">
                  <span class="pc-title">{item.title}</span>
                  {item.location && <span class="pc-where">{item.location}</span>}
                  {options.responses && item.response && <span class="ps-response">Your response: {RESPONSE_WORDS[item.response]}</span>}
                  {options.descriptions && item.description && <span class="ps-description">{item.description}</span>}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
};

/** The printout: a page per day, week or month (Schedule: one run, broken between days), in the options' size, orientation and colors. */
export const CalendarSheet = ({ pages, layout, byDay, options, zoneLabel }: { pages: PrintPage[]; layout: PrintLayout; byDay: ReadonlyMap<DateKey, PrintedItem[]>; options: PrintOptions; zoneLabel: string }) => {
  const scale = PRINT_FONT_SIZES.find((size) => size.id === options.fontSize)?.scale ?? 1;
  const orientation = pageOrientation(options.orientation, layout);
  return (
    <article class={`print-sheet print-calendar pc-${options.color} is-${layout} is-${orientation}`} style={{ '--print-scale': String(scale) }} aria-label="Calendar, printed" data-from={options.from} data-to={options.to}>
      <style>{`@page { size: ${orientation}; margin: 10mm; }`}</style>
      {pages.map((page) => (
        <section key={page.title} class="print-page" aria-label={page.title}>
          <header class="print-page-head">
            <h1>{page.title}</h1>
            <span class="print-meta">{zoneLabel}</span>
          </header>
          {(layout === 'day' || layout === 'week') && <GridPage page={page} byDay={byDay} options={options} />}
          {layout === 'month' && <MonthPage page={page} byDay={byDay} options={options} />}
          {layout === 'schedule' && <SchedulePage page={page} byDay={byDay} options={options} />}
        </section>
      ))}
    </article>
  );
};

/** Where an instant falls in `day`: its minutes, or the day's start or end when it is before or after it. */
const minutesOn = (iso: string, day: DateKey, zone: string): number => {
  const at = zonedDateMinutes(iso, zone);
  return at.date < day ? 0 : at.date > day ? 24 * 60 : at.minutes;
};

/** Settings → Print: the print preview, its options beside the page as it will print, and Print. */
export const PrintPreview = ({ mode, anchor, days, onClose }: { mode: CalendarMode; anchor: DateKey; days: DateKey[]; onClose: () => void }) => {
  const { client } = usePlanner();
  const view = useView();
  const { prefs } = useCalendarUi();
  const forge = useForge();
  const printing = canPrint(forge);
  const [options, setOptions] = useState<PrintOptions>(() => defaultPrintOptions(mode, anchor, days, { weekends: prefs.weekends, declined: prefs.declined }));
  const set = (patch: Partial<PrintOptions>) => setOptions((current) => ({ ...current, ...patch }));
  const zone = view.state.settings.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const layout = printLayout(options.view, mode);
  const length = options.to >= options.from ? daysBetween(options.from, options.to) + 1 : 0;
  const problem = !length ? 'The print range ends before it starts' : length > PRINT_DAYS_MAX ? `The Planner prints up to ${PRINT_DAYS_MAX} days at a time: choose a shorter range` : null;
  const [from, to] = problem ? [options.from, options.from] : [options.from, options.to];
  const feed = useCalendarEvents(from, to, { declined: options.declined, tasks: true });
  // Schedule's "Print descriptions": each Google event's own, read as its details are.
  const [descriptions, setDescriptions] = useState<Record<string, string>>({});
  const googleEvents = feed.events.filter((event) => event.google && !isTaskEvent(event));
  const wanted = options.descriptions && layout === 'schedule' ? googleEvents.filter((event) => descriptions[event.id] === undefined) : [];
  useEffect(() => {
    if (!wanted.length) return;
    let live = true;
    const queue = [...wanted];
    const next = async (): Promise<void> => {
      const event = queue.shift();
      if (!event || !live) return;
      const text = await eventDetail(client, event.google!).then((detail) => plainText(detail.description), () => '');
      if (live) setDescriptions((current) => ({ ...current, [event.id]: text }));
      return next();
    };
    void Promise.all([next(), next(), next(), next()]);
    return () => {
      live = false;
    };
  }, [wanted.map((event) => event.id).join('|')]);
  const byDay = new Map<DateKey, PrintedItem[]>();
  if (!problem) {
    for (const day of scheduleDays(calendarItems(view.state, feed.events, from, to, zone, { completedTasks: prefs.completedTasks, channel: () => true }), from, to)) {
      byDay.set(day.date, day.items.map(({ item, bar }) => {
        if (item.kind === 'block') {
          const start = minutesOn(item.block.start, day.date, zone);
          const end = Math.max(start, minutesOn(item.block.end, day.date, zone));
          return { key: `block:${item.block.id}`, title: item.task.title, time: compactRange(start, end), allDay: false, start, end, location: 'Working session', color: '#b35017', response: null, done: Boolean(item.task.completedAt), session: true, description: '' };
        }
        return printedEvent(item.event, day.date, bar, view.state, zone, descriptions[item.event.id] ?? '');
      }));
    }
  }
  const pages = problem ? [] : printPages(layout, from, to, view.state.settings.weekStartsOn, options.weekends);
  const sheet = <CalendarSheet pages={pages} layout={layout} byDay={byDay} options={options} zoneLabel={zone} />;
  const reading = feed.loading || wanted.length > 0;
  // While the preview is open, print media finds this printout.
  const owner = useRef({}).current;
  const signature = JSON.stringify([options, pages.map((page) => page.title), [...byDay]]);
  useEffect(() => setPrintable(owner, sheet), [signature]);
  useEffect(() => () => clearPrintable(owner), []);
  const print = () => {
    if (printing && !problem) printNow(sheet);
  };
  // The dialog takes the focus, so its keys (Escape, Ctrl/⌘+P) are its own.
  const fromRef = useRef<HTMLInputElement>(null);
  useEffect(() => fromRef.current?.focus(), []);
  const select = <T extends string>(label: string, value: T, choices: readonly { id: T; label: string }[], pick: (value: T) => void) => (
    <label class="pp-field">
      <span>{label}</span>
      <select aria-label={label} value={value} onChange={(event) => pick(event.currentTarget.value as T)}>
        {choices.map((choice) => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
      </select>
    </label>
  );
  return (
    <div
      class="modal-backdrop is-top print-preview-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        } else if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'p') {
          // Ctrl/⌘+P again: Print.
          event.preventDefault();
          print();
        }
      }}
    >
      <div class="modal print-preview" role="dialog" aria-modal="true" aria-label="Print preview">
        <div class="pp-options">
          <h2>Print preview</h2>
          <fieldset class="pp-range">
            <legend>Print range</legend>
            <input type="date" aria-label="Print range from" value={options.from} ref={fromRef} onChange={(event) => event.currentTarget.value && set({ from: event.currentTarget.value })} />
            <span>to</span>
            <input type="date" aria-label="Print range to" value={options.to} onChange={(event) => event.currentTarget.value && set({ to: event.currentTarget.value })} />
          </fieldset>
          {select('View', options.view, PRINT_VIEWS, (value) => set({ view: value }))}
          {select('Font size', options.fontSize, PRINT_FONT_SIZES, (value) => set({ fontSize: value }))}
          {select('Orientation', options.orientation, PRINT_ORIENTATIONS, (value) => set({ orientation: value }))}
          {select('Color & style', options.color, PRINT_COLORS, (value) => set({ color: value }))}
          <label class="pp-check">
            <input type="checkbox" checked={options.weekends} onChange={(event) => set({ weekends: event.currentTarget.checked })} />
            Show weekends
          </label>
          <label class="pp-check">
            <input type="checkbox" checked={options.declined} onChange={(event) => set({ declined: event.currentTarget.checked })} />
            Show events you have declined
          </label>
          {layout === 'schedule' && (
            <>
              <label class="pp-check">
                <input type="checkbox" checked={options.descriptions} onChange={(event) => set({ descriptions: event.currentTarget.checked })} />
                Print descriptions
              </label>
              <label class="pp-check">
                <input type="checkbox" checked={options.responses} onChange={(event) => set({ responses: event.currentTarget.checked })} />
                Print your response
              </label>
            </>
          )}
          {problem && <p class="danger" role="alert">{problem}</p>}
          {feed.errors.length > 0 && <p class="feed-errors" role="alert">{feed.errors.map((error) => error.message).join(' · ')}</p>}
          {reading && !problem && <p class="hint" role="status">Reading your calendars…</p>}
          <div class="row pp-actions">
            <span class="nav-spacer" />
            <button class="link" onClick={onClose}>Cancel</button>
            <button class="primary" disabled={!printing || Boolean(problem)} title={printing ? 'Ctrl/⌘ + P' : PRINT_NEEDS_HOST} aria-describedby={printing ? undefined : 'pp-needs-host'} onClick={print}>
              Print
            </button>
          </div>
          {!printing && <p class="hint" id="pp-needs-host">{PRINT_NEEDS_HOST}</p>}
        </div>
        <div class="pp-pane" aria-label="The page as it will print">
          <div class={`pp-paper is-${pageOrientation(options.orientation, layout)}`}>{sheet}</div>
        </div>
      </div>
    </div>
  );
};

/** A description as text: Google keeps HTML when it was written in Google Calendar. */
const plainText = (html: string): string => {
  if (!/<[a-z][\s\S]*>/i.test(html)) return html;
  const doc = new DOMParser().parseFromString(html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n'), 'text/html');
  return (doc.body.textContent ?? '').trim();
};

/** An event or a task as it prints on `day`. */
const printedEvent = (event: CalendarEvent, day: DateKey, bar: boolean, state: Parameters<typeof eventColor>[1], zone: string, description: string): PrintedItem => {
  const task = isTaskEvent(event) ? event.googleTask! : null;
  const start = minutesOn(event.start, day, zone);
  const end = Math.max(start, minutesOn(event.end, day, zone));
  const allDay = event.allDay || bar || Boolean(event.taskDeadline || event.pendingTasks);
  const mark = event.taskDeadline ? '⚑ ' : task ? (task.completed ? '☑ ' : '☐ ') : event.upcoming ? '↻ ' : '';
  const time = event.taskDeadline ? 'Deadline' : event.pendingTasks ? 'Pending' : allDay ? 'All day' : start === 0 && end === 24 * 60 ? 'All day' : compactRange(start, end);
  return {
    key: event.id,
    title: `${mark}${event.title}`,
    time,
    allDay,
    start,
    end,
    location: event.location,
    color: eventColor(event, state),
    response: event.google?.response ?? null,
    done: Boolean(task?.completed),
    session: false,
    description,
  };
};
