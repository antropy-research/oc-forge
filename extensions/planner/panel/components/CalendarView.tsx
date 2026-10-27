import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { GOOGLE_TASKS_CALENDAR } from '../../src/domain/google.ts';
import type { DateKey } from '../../src/domain/types.ts';
import { blocksFor, tasksForDay } from '../../src/domain/selectors.ts';
import { zonedDateMinutes } from '../../src/domain/dates.ts';
import { CALENDAR_MODES, monthWeeks, rangeTitle, stepAnchor, viewDays, type CalendarMode } from '../../src/domain/gcalendar.ts';
import { usePlanner, useView } from '../lib/context.ts';
import { useCalendarEvents } from '../lib/calendar.ts';
import { calendarUi, useCalendarUi } from '../lib/gcal.ts';
import { matchesFilter, useUi } from '../lib/ui.ts';
import { BacklogBuckets } from './Backlog.tsx';
import { ChannelFilter } from './ChannelFilter.tsx';
import { TaskList } from './TaskList.tsx';
import { TimeGrid } from './TimeGrid.tsx';
import { LinearIssues } from './LinearPanel.tsx';
import { TasksView } from './TasksView.tsx';
import { CalendarRail } from './calendar/Rail.tsx';
import { MonthView } from './calendar/MonthView.tsx';
import { ScheduleView, SearchResults } from './calendar/ScheduleView.tsx';
import { YearView } from './calendar/YearView.tsx';
import { CalendarOverlays } from './calendar/Overlays.tsx';
import { Icon } from './calendar/Icon.tsx';
import { isTaskEvent } from './calendar/items.ts';

/** Today's tasks that have no working session today yet. */
export const UnscheduledToday = () => {
  const view = useView();
  const { ui } = useUi();
  const zone = view.state.settings.timezone ?? 'UTC';
  const tasks = tasksForDay(view.state, view.today).filter(
    (task) => matchesFilter(task, ui.channelFilter, view.state.channels) && !task.completedAt && !blocksFor(view.state, task.id).some((block) => zonedDateMinutes(block.start, zone).date === view.today),
  );
  return <TaskList placement={{ kind: 'day', date: view.today }} tasks={tasks} empty="Everything today has a time" />;
};

const MODE_LABELS: Record<CalendarMode, string> = { day: 'Day', week: 'Week', month: 'Month', year: 'Year', schedule: 'Schedule' };
/** Google Calendar's view keys; its A for Schedule adds a task in the Planner, so Schedule keeps Google's other key, 5. */
const MODE_KEYS: Record<CalendarMode, string> = { day: 'D', week: 'W', month: 'M', year: 'Y', schedule: '5' };
const MODE_DIGITS: Record<string, CalendarMode> = { '1': 'day', '2': 'week', '3': 'month', '5': 'schedule' };
const STEP_NAMES: Record<CalendarMode, string> = { day: 'day', week: 'week', month: 'month', year: 'year', schedule: 'stretch' };
/** The rail takes this much, and the grid needs this much to stay readable. */
const RAIL_PX = 236;
const SIDE_PX = 280;
const GRID_MIN_PX = 640;

/** The width an element has, kept up to date. */
const useWidth = (ref: { current: HTMLElement | null }): number => {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return width;
};

const ViewMenu = ({ mode }: { mode: CalendarMode }) => {
  const { prefs } = useCalendarUi();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => !ref.current?.contains(event.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const pick = (patch: Parameters<typeof calendarUi.prefs>[0]) => {
    setOpen(false);
    calendarUi.prefs(patch);
  };
  return (
    <div class="menu-anchor" ref={ref}>
      <button class="gcal-view-button" aria-haspopup="menu" aria-expanded={open} aria-label={`View: ${MODE_LABELS[mode]}`} onClick={() => setOpen(!open)}>
        <span>{MODE_LABELS[mode]}</span>
        <Icon name="down" size={18} />
      </button>
      {open && (
        <div class="menu gcal-view-menu" role="menu" aria-label="View">
          {CALENDAR_MODES.map((item) => (
            <button key={item} role="menuitemradio" aria-checked={item === mode} onClick={() => pick({ mode: item })}>
              <span>{MODE_LABELS[item]}</span>
              <kbd>{MODE_KEYS[item]}</kbd>
            </button>
          ))}
          <hr />
          <button role="menuitemcheckbox" aria-checked={prefs.weekends} onClick={() => pick({ weekends: !prefs.weekends })}>
            <span class="menu-check">{prefs.weekends ? '✓' : ''}</span>Show weekends
          </button>
          <button role="menuitemcheckbox" aria-checked={prefs.declined} onClick={() => pick({ declined: !prefs.declined })}>
            <span class="menu-check">{prefs.declined ? '✓' : ''}</span>Show declined events
          </button>
          <button role="menuitemcheckbox" aria-checked={prefs.completedTasks} onClick={() => pick({ completedTasks: !prefs.completedTasks })}>
            <span class="menu-check">{prefs.completedTasks ? '✓' : ''}</span>Show completed tasks
          </button>
        </div>
      )}
    </div>
  );
};

/**
 * The calendar as Google Calendar lays it out: Create, the mini month and the
 * calendars in a rail; Today, the arrows, the range and the view (Day, Week,
 * Month, Schedule) above the grid; Calendar or Tasks. Beside it, the
 * Planner's unscheduled work to drag in. The rail and that panel fold away
 * when the grid would get too narrow.
 */
export const CalendarView = () => {
  const view = useView();
  const { google } = usePlanner();
  const { prefs } = useCalendarUi();
  const root = useRef<HTMLElement>(null);
  const width = useWidth(root);
  const anchor = prefs.anchor ?? view.today;
  const mode = prefs.mode;
  const weekStartsOn = view.state.settings.weekStartsOn;
  const days = viewDays(mode, anchor, weekStartsOn, prefs.weekends);
  // The year shows no events (as in Google, a date opens its day), so it reads only the anchor's day.
  const monthDays = mode === 'month' ? monthWeeks(anchor, weekStartsOn).flat() : mode === 'year' ? [anchor] : days;
  const feed = useCalendarEvents(monthDays[0]!, monthDays[monthDays.length - 1]!, { declined: prefs.declined });
  const events = prefs.completedTasks ? feed.events : feed.events.filter((event) => !(isTaskEvent(event) && event.googleTask?.completed));

  // What fits beside the grid: the rail first, as in Google Calendar; both when there is room.
  const roomy = width === 0 || width >= RAIL_PX + SIDE_PX + GRID_MIN_PX;
  const railWanted = prefs.rail ?? (width === 0 || width >= RAIL_PX + GRID_MIN_PX);
  const sideWanted = prefs.side ?? roomy;
  const showRail = railWanted && (roomy || !sideWanted || prefs.lastOpened !== 'side');
  const showSide = sideWanted && (roomy || !railWanted || prefs.lastOpened === 'side');
  const tasksAccounts = google.accountsWith('tasks').length;

  const setAnchor = (date: DateKey) => calendarUi.prefs({ anchor: date });
  const goDay = (date: DateKey) => calendarUi.prefs({ mode: 'day', anchor: date, page: 'calendar' });

  // Google Calendar's search: the header becomes a search box (or press /); Enter shows what matches.
  const [search, setSearch] = useState<{ text: string; shown: string | null } | null>(null);
  const searchBox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (search && search.shown === null) searchBox.current?.focus();
  }, [search !== null]);
  const leaveSearch = () => setSearch(null);

  // Google Calendar's keys: D, W, M (or 1, 2, 3), 5 for Schedule, J and K for next and previous.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.metaKey || event.ctrlKey || event.altKey || (target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable))) return;
      const ui = calendarUi.get();
      if (ui.popover || ui.draft || ui.editor || ui.question || ui.prefs.page !== 'calendar' || document.querySelector('.modal-backdrop')) return;
      const key = event.key.toLowerCase();
      const next = MODE_DIGITS[key] ?? (Object.keys(MODE_KEYS) as CalendarMode[]).find((item) => MODE_KEYS[item].toLowerCase() === key);
      if (key === '/') setSearch((current) => current ?? { text: '', shown: null });
      else if (next) calendarUi.prefs({ mode: next });
      else if (key === 'j') calendarUi.prefs({ anchor: stepAnchor(ui.prefs.mode, ui.prefs.anchor ?? view.today, 1) });
      else if (key === 'k') calendarUi.prefs({ anchor: stepAnchor(ui.prefs.mode, ui.prefs.anchor ?? view.today, -1) });
      else return;
      event.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [view.today]);

  const errors = feed.errors.map((error) => `${error.calendarId === GOOGLE_TASKS_CALENDAR ? 'Google Tasks' : view.state.calendars[error.calendarId]?.name ?? 'Calendar'}: ${error.message}`);
  const tasksPage = prefs.page === 'tasks';
  return (
    <section class={`view gcal-view${width && width < 720 ? ' is-narrow' : ''}`} ref={root}>
      <header class="gcal-header">
        {!tasksPage && (
          <button class="icon-button gcal-menu" aria-label="Main menu" aria-expanded={showRail} title={showRail ? 'Hide the calendars' : 'Show the calendars'} onClick={() => calendarUi.prefs({ rail: !showRail, ...(showRail ? {} : { lastOpened: 'rail' }) })}>
            <Icon name="menu" size={20} />
          </button>
        )}
        <h1 class="gcal-brand">{tasksPage ? 'Tasks' : 'Calendar'}</h1>
        {!tasksPage && search && (
          <div class="gcal-search" role="search">
            <button class="icon-button" aria-label="Back to the calendar" title="Back" onClick={leaveSearch}><Icon name="back" size={20} /></button>
            <input
              ref={searchBox}
              type="search"
              aria-label="Search events"
              placeholder="Search"
              value={search.text}
              onInput={(event) => setSearch({ text: event.currentTarget.value, shown: search.shown })}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && search.text.trim()) setSearch({ text: search.text, shown: search.text.trim() });
                else if (event.key === 'Escape') {
                  event.preventDefault();
                  leaveSearch();
                }
              }}
            />
            <button class="icon-button" aria-label="Search" title="Search" disabled={!search.text.trim()} onClick={() => search.text.trim() && setSearch({ text: search.text, shown: search.text.trim() })}><Icon name="search" size={20} /></button>
          </div>
        )}
        {!tasksPage && !search && (
          <>
            <button class="gcal-today" onClick={() => setAnchor(view.today)} title={`Today, ${view.today}`}>Today</button>
            <div class="gcal-arrows">
              <button class="icon-button" aria-label={`Previous ${STEP_NAMES[mode]}`} title={`Previous ${STEP_NAMES[mode]} (K)`} onClick={() => setAnchor(stepAnchor(mode, anchor, -1))}><Icon name="left" size={20} /></button>
              <button class="icon-button" aria-label={`Next ${STEP_NAMES[mode]}`} title={`Next ${STEP_NAMES[mode]} (J)`} onClick={() => setAnchor(stepAnchor(mode, anchor, 1))}><Icon name="right" size={20} /></button>
            </div>
            <h2 class="gcal-title" aria-live="polite">{rangeTitle(mode, anchor, days)}</h2>
            {feed.loading && <span class="gcal-sync hint">Syncing…</span>}
          </>
        )}
        <div class="gcal-actions">
          {!tasksPage && !search && <button class="icon-button gcal-search-button" aria-label="Search events" title="Search (/)" onClick={() => setSearch({ text: '', shown: null })}><Icon name="search" size={20} /></button>}
          {!tasksPage && !search && <ViewMenu mode={mode} />}
          {tasksAccounts > 0 && (
            <div class="segmented gcal-switch" role="radiogroup" aria-label="Calendar or Tasks">
              <button role="radio" aria-checked={!tasksPage} aria-label="Calendar" title="Calendar" onClick={() => calendarUi.prefs({ page: 'calendar' })}><Icon name="calendar" size={20} /></button>
              <button role="radio" aria-checked={tasksPage} aria-label="Tasks" title="Tasks" onClick={() => calendarUi.prefs({ page: 'tasks' })}><Icon name="task" size={20} /></button>
            </div>
          )}
          {!tasksPage && (
            <button class={`icon-button gcal-side-toggle${showSide ? ' is-on' : ''}`} aria-label={showSide ? 'Hide the task panel' : 'Show the task panel'} aria-expanded={showSide} title={showSide ? 'Hide unscheduled work' : 'Show unscheduled work, to drag onto the calendar'} onClick={() => calendarUi.prefs({ side: !showSide, ...(showSide ? {} : { lastOpened: 'side' }) })}>
              <Icon name="panel" size={20} />
            </button>
          )}
        </div>
      </header>
      {errors.length > 0 && !tasksPage && <p class="feed-errors" role="alert">{errors.join(' · ')}</p>}
      {tasksPage ? (
        <TasksView />
      ) : (
        <div class="gcal-body">
          {showRail && <CalendarRail anchor={anchor} shown={days} onPick={setAnchor} />}
          <div class="gcal-main">
            {(mode === 'day' || mode === 'week') && !search?.shown && <TimeGrid dates={days} events={events} onDay={mode === 'week' ? goDay : undefined} />}
            {mode === 'month' && !search?.shown && <MonthView anchor={anchor} events={events} onDay={goDay} />}
            {mode === 'year' && !search?.shown && <YearView anchor={anchor} onDay={goDay} />}
            {mode === 'schedule' && !search?.shown && <ScheduleView from={days[0]!} to={days[days.length - 1]!} events={events} onDay={goDay} />}
            {search?.shown && <SearchResults query={search.shown} onDay={(date) => { leaveSearch(); goDay(date); }} />}
          </div>
          {showSide && (
            <aside class="side-panel gcal-side" aria-label="Unscheduled work">
              <div class="tabs side-tabs" role="tablist">
                <button role="tab" aria-selected={prefs.sideTab === 'unscheduled'} onClick={() => calendarUi.prefs({ sideTab: 'unscheduled' })}>Unscheduled</button>
                <button role="tab" aria-selected={prefs.sideTab === 'backlog'} onClick={() => calendarUi.prefs({ sideTab: 'backlog' })}>Backlog</button>
                <button role="tab" aria-selected={prefs.sideTab === 'linear'} onClick={() => calendarUi.prefs({ sideTab: 'linear' })}>Linear</button>
              </div>
              <div class="gcal-side-tools">
                <span class="hint">Drag onto the calendar to timebox, or onto a day to plan it then.</span>
                {prefs.sideTab === 'unscheduled' && <ChannelFilter />}
              </div>
              {prefs.sideTab === 'unscheduled' && <UnscheduledToday />}
              {prefs.sideTab === 'backlog' && <BacklogBuckets compact />}
              {prefs.sideTab === 'linear' && <LinearIssues />}
            </aside>
          )}
        </div>
      )}
      <CalendarOverlays onDay={goDay} />
    </section>
  );
};
