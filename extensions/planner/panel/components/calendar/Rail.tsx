// Google Calendar's left rail: Create, the mini month, and "My calendars" and
// "Other calendars" with a colored checkbox each.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { CalendarSubscription, DateKey } from '../../../src/domain/types.ts';
import type { GoogleCalendarInfo } from '../../../src/domain/google.ts';
import { addDays } from '../../../src/domain/dates.ts';
import { addMonths, longDay, monthStart, monthWeeks } from '../../../src/domain/gcalendar.ts';
import { useGoogle, usePlanner, useView } from '../../lib/context.ts';
import { anchorOf, calendarUi, useCalendarUi } from '../../lib/gcal.ts';
import { Icon } from './Icon.tsx';
import { GOOGLE_TASKS_COLOR } from './items.ts';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const PALETTE = ['#d50000', '#e67c73', '#f4511e', '#f6bf26', '#33b679', '#0b8043', '#039be5', '#3f51b5', '#7986cb', '#8e24aa', '#616161', '#795548'];

/** The small month in the rail: today ringed, the days on screen shaded; a click goes to that day. */
export const MiniMonth = ({ anchor, shown, onPick }: { anchor: DateKey; shown: readonly DateKey[]; onPick: (date: DateKey) => void }) => {
  const view = useView();
  const weekStartsOn = view.state.settings.weekStartsOn;
  const [month, setMonth] = useState(monthStart(anchor));
  useEffect(() => setMonth(monthStart(anchor)), [anchor.slice(0, 7)]);
  const weeks = monthWeeks(month, weekStartsOn);
  // Always six rows, as Google's mini month.
  while (weeks.length < 6) weeks.push(weeks[weeks.length - 1]!.map((day) => addDays(day, 7)));
  const inView = new Set(shown);
  return (
    <div class="mini-month" role="group" aria-label="Mini month">
      <div class="mini-head">
        <span class="mini-title">{MONTHS[Number(month.slice(5, 7)) - 1]} {month.slice(0, 4)}</span>
        <button class="icon-button" aria-label="Previous month" onClick={() => setMonth(addMonths(month, -1))}><Icon name="left" size={16} /></button>
        <button class="icon-button" aria-label="Next month" onClick={() => setMonth(addMonths(month, 1))}><Icon name="right" size={16} /></button>
      </div>
      <div class="mini-grid" role="grid">
        <div class="mini-row" role="row">
          {weeks[0]!.map((day) => <span key={day} class="mini-letter" role="columnheader">{LETTERS[new Date(`${day}T00:00:00Z`).getUTCDay()]}</span>)}
        </div>
        {weeks.map((week) => (
          <div key={week[0]} class="mini-row" role="row">
            {week.map((day) => (
              <button
                key={day}
                role="gridcell"
                class={`mini-day${day === view.today ? ' is-today' : ''}${inView.has(day) ? ' is-shown' : ''}${day.slice(0, 7) !== month.slice(0, 7) ? ' is-other' : ''}`}
                aria-label={`${longDay(day)}${day === view.today ? ', today' : ''}`}
                aria-selected={day === anchor}
                onClick={() => onPick(day)}
              >
                {Number(day.slice(8))}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
};

const RowMenu = ({ name, onOnly, color, onColor, onClose }: { name: string; onOnly: () => void; color: string | null; onColor: ((color: string) => void) | null; onClose: () => void }) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (event: MouseEvent) => !ref.current?.contains(event.target as Node) && onClose();
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [onClose]);
  return (
    <div class="menu cal-menu" ref={ref} role="menu" aria-label={`Options for ${name}`}>
      <button role="menuitem" onClick={() => { onClose(); onOnly(); }}>Display this only</button>
      {onColor && (
        <div class="cal-palette" role="group" aria-label="Color">
          {PALETTE.map((swatch) => (
            <button key={swatch} class="cal-swatch" aria-label={`Color ${swatch}`} aria-pressed={swatch === color} style={{ background: swatch }} onClick={() => { onClose(); onColor(swatch); }} />
          ))}
        </div>
      )}
    </div>
  );
};

const CalendarRow = ({ name, color, checked, onToggle, onOnly, onColor, note }: { name: string; color: string; checked: boolean; onToggle: (checked: boolean) => void; onOnly: () => void; onColor: ((color: string) => void) | null; note?: string }) => {
  const [menu, setMenu] = useState(false);
  return (
    <li class={`cal-row${menu ? ' has-menu' : ''}`} style={{ '--cal-color': color }}>
      <label class="cal-check" title={note ?? name}>
        <input type="checkbox" checked={checked} onChange={(event) => onToggle(event.currentTarget.checked)} />
        <span class="cal-name">{name}</span>
      </label>
      <div class="menu-anchor">
        <button class="more" aria-label={`Options for ${name}`} aria-haspopup="menu" onClick={() => setMenu(!menu)}><Icon name="more" size={16} /></button>
        {menu && <RowMenu name={name} onOnly={onOnly} color={color} onColor={onColor} onClose={() => setMenu(false)} />}
      </div>
    </li>
  );
};

/** "My calendars" (the account's own, and Tasks) and "Other calendars" (shared, subscribed and ICS feeds). */
export const CalendarList = () => {
  const { client, google } = usePlanner();
  const view = useView();
  const gv = useGoogle();
  const { prefs } = useCalendarUi();
  const accounts = gv.status ? google.accountsWith('calendar') : [];
  const tasks = gv.status ? google.accountsWith('tasks').length > 0 : false;
  useEffect(() => {
    if (accounts.length && !gv.calendars.length) void google.loadCalendars();
  }, [accounts.length]);
  const subscriptions = Object.values(view.state.calendars);
  const subscriptionOf = (calendar: GoogleCalendarInfo) => subscriptions.find((item) => item.google?.account === calendar.account && item.google.calendarId === calendar.id) ?? null;
  const several = new Set(gv.calendars.map((calendar) => calendar.account)).size > 1;
  const mine = gv.calendars.filter((calendar) => (calendar.accessRole ?? (calendar.primary ? 'owner' : 'reader')) === 'owner');
  const others = gv.calendars.filter((calendar) => !mine.includes(calendar));
  // Google calendars shown here whose account is not listed (not read yet, or removed) and ICS feeds.
  const orphans = subscriptions.filter((item) => !item.google || !gv.calendars.some((calendar) => calendar.account === item.google!.account && calendar.id === item.google!.calendarId));
  const tasksOn = view.state.settings.googleTasksOnCalendar;
  /** Show only one calendar (or only tasks), as Google Calendar's "Display this only". */
  const only = async (keep: { google?: GoogleCalendarInfo; subscription?: CalendarSubscription; tasks?: boolean }) => {
    const target = keep.google ? subscriptionOf(keep.google) : keep.subscription ?? null;
    const bodies = subscriptions.filter((item) => item.visible && item.id !== target?.id).map((item) => ({ type: 'calendar.updated' as const, calendarId: item.id, patch: { visible: false } }));
    if (bodies.length) await client.dispatch(bodies);
    if (keep.google) await google.setVisible(keep.google, true);
    else if (keep.subscription && !keep.subscription.visible) await google.setVisible(keep.subscription, true);
    if (Boolean(keep.tasks) !== tasksOn) await client.dispatch([{ type: 'settings.updated', patch: { googleTasksOnCalendar: Boolean(keep.tasks) } }]);
  };
  const recolor = (subscription: CalendarSubscription | null) => (subscription ? (color: string) => void client.dispatch([{ type: 'calendar.updated', calendarId: subscription.id, patch: { color } }]) : null);
  const row = (calendar: GoogleCalendarInfo) => {
    const subscription = subscriptionOf(calendar);
    return (
      <CalendarRow
        key={`${calendar.account}:${calendar.id}`}
        name={`${calendar.name}${several ? ` · ${calendar.account}` : ''}`}
        color={subscription?.color ?? calendar.color}
        checked={Boolean(subscription?.visible)}
        onToggle={(checked) => void google.setVisible(calendar, checked)}
        onOnly={() => void only({ google: calendar })}
        onColor={recolor(subscription)}
      />
    );
  };
  return (
    <div class="cal-lists">
      <section class="cal-section">
        <button class="cal-section-head" aria-expanded={prefs.myCalendarsOpen} onClick={() => calendarUi.prefs({ myCalendarsOpen: !prefs.myCalendarsOpen })}>
          <span>My calendars</span>
          <Icon name={prefs.myCalendarsOpen ? 'up' : 'down'} size={18} />
        </button>
        {prefs.myCalendarsOpen && (
          <ul class="cal-rows" aria-label="My calendars">
            {mine.map(row)}
            {tasks && (
              <CalendarRow
                name="Tasks"
                color={GOOGLE_TASKS_COLOR}
                checked={tasksOn}
                note="Google tasks with a date, on that day"
                onToggle={(checked) => void client.dispatch([{ type: 'settings.updated', patch: { googleTasksOnCalendar: checked } }])}
                onOnly={() => void only({ tasks: true })}
                onColor={null}
              />
            )}
            {!accounts.length && !tasks && <li class="hint">Connect Google in Settings → Google to see your calendars here.</li>}
            {accounts.length > 0 && !gv.calendars.length && !gv.calendarErrors.length && <li class="hint">Loading calendars…</li>}
            {gv.calendarErrors.map((error) => <li key={error.account} class="danger">{error.account ? `${error.account}: ` : ''}{error.message}</li>)}
          </ul>
        )}
      </section>
      <section class="cal-section">
        <button class="cal-section-head" aria-expanded={prefs.otherCalendarsOpen} onClick={() => calendarUi.prefs({ otherCalendarsOpen: !prefs.otherCalendarsOpen })}>
          <span>Other calendars</span>
          <Icon name={prefs.otherCalendarsOpen ? 'up' : 'down'} size={18} />
        </button>
        {prefs.otherCalendarsOpen && (
          <ul class="cal-rows" aria-label="Other calendars">
            {others.map(row)}
            {orphans.map((subscription) => (
              <CalendarRow
                key={subscription.id}
                name={subscription.name}
                color={subscription.color}
                checked={subscription.visible}
                note={subscription.google ? `${subscription.google.account}` : 'Read-only calendar (ICS)'}
                onToggle={(checked) => void google.setVisible(subscription, checked)}
                onOnly={() => void only({ subscription })}
                onColor={recolor(subscription)}
              />
            ))}
            {!others.length && !orphans.length && <li class="hint">Subscribe to ICS calendars in Settings → Calendars.</li>}
          </ul>
        )}
      </section>
    </div>
  );
};

/** The rail: Create (an event, or a task), the mini month, the calendar lists. */
export const CalendarRail = ({ anchor, shown, onPick }: { anchor: DateKey; shown: readonly DateKey[]; onPick: (date: DateKey) => void }) => {
  const view = useView();
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (event: MouseEvent) => !menuRef.current?.contains(event.target as Node) && setMenu(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menu]);
  const day = shown.includes(view.today) ? view.today : anchor;
  const nextSlot = () => {
    const now = new Date();
    const minutes = now.getHours() * 60 + now.getMinutes();
    return Math.min(23 * 60, Math.ceil((minutes + 1) / 30) * 30);
  };
  return (
    <aside class="gcal-rail" aria-label="Calendars">
      <div class="menu-anchor gcal-create-anchor" ref={menuRef}>
        <button class="gcal-create" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
          <Icon name="add" size={22} />
          <span>Create</span>
          <Icon name="down" size={18} />
        </button>
        {menu && (
          <div class="menu" role="menu" aria-label="Create">
            <button
              role="menuitem"
              onClick={() => {
                setMenu(false);
                const start = day === view.today ? nextSlot() : 9 * 60;
                calendarUi.edit({ mode: 'new', draft: { date: day, endDate: day, start, end: Math.min(24 * 60, start + 60) } });
              }}
            >
              Event
            </button>
            <button
              role="menuitem"
              onClick={(event) => {
                setMenu(false);
                calendarUi.startDraft({ kind: 'task', date: day, endDate: day, start: null, end: null, anchor: anchorOf(event.currentTarget) });
              }}
            >
              Task
            </button>
          </div>
        )}
      </div>
      <MiniMonth anchor={anchor} shown={shown} onPick={onPick} />
      <CalendarList />
    </aside>
  );
};
