import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { DateKey, Placement } from '../../src/domain/types.ts';
import { addDays, isDateKey, monthDay, weekdayName } from '../../src/domain/dates.ts';
import { useView } from '../lib/context.ts';
import { quickDays, useDayTargets } from '../lib/dayTargets.ts';
import { useFixedPlace } from '../lib/popover.ts';

/** A quick action's text: Today, Tmrw, or "Wed 28". */
export const shortDay = (date: DateKey, today: DateKey): string =>
  date === today ? 'Today' : date === addDays(today, 1) ? 'Tmrw' : `${weekdayName(date).slice(0, 3)} ${Number(date.slice(8, 10))}`;

/** How a label names the day: "today", "tomorrow", "on Wednesday, October 28". */
export const dayPhrase = (date: DateKey, today: DateKey): string =>
  date === today ? 'today' : date === addDays(today, 1) ? 'tomorrow' : `on ${weekdayName(date)}, ${monthDay(date)}`;

const menuDay = (date: DateKey, today: DateKey): string =>
  `${date === today ? 'Today · ' : date === addDays(today, 1) ? 'Tomorrow · ' : ''}${weekdayName(date).slice(0, 3)}, ${monthDay(date)}`;

/** The day menu, placed in the window beside its button. */
const PlanMenu = ({ label, children }: { label: string; children: ComponentChildren }) => {
  const ref = useRef<HTMLDivElement>(null);
  const style = useFixedPlace(ref, 'right');
  return (
    <div class="menu plan-menu" role="menu" aria-label={`Plan ${label} on`} ref={ref} style={style}>
      {children}
    </div>
  );
};

/**
 * A source row's "plan it" actions, for the days on screen: the first day and
 * the next one as buttons, every visible day, the backlog and any date in a
 * menu. `children` go between the buttons and the menu (the Agent button).
 */
export const PlanActions = ({ label, onPlan, children }: { label: string; onPlan: (placement: Placement) => void; children?: ComponentChildren }) => {
  const view = useView();
  const targets = useDayTargets();
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (ref.current?.contains(event.target as Node)) return;
      setOpen(false);
      setPicking(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', escape, true);
    };
  }, [open]);
  const plan = (placement: Placement) => {
    setOpen(false);
    setPicking(false);
    onPlan(placement);
  };
  const menuDays = [...new Set([...targets.days, view.today, addDays(view.today, 1)])].filter((day) => day >= view.today || targets.days.includes(day)).sort();
  return (
    <span class={`issue-actions plan-actions${open ? ' is-visible' : ''}`} ref={ref}>
      {quickDays(targets).map((date) => (
        <button key={date} onClick={() => plan({ kind: 'day', date })} aria-label={`Plan ${label} ${dayPhrase(date, view.today)}`} title={`Plan it ${dayPhrase(date, view.today)}`}>
          {shortDay(date, view.today)}
        </button>
      ))}
      {children}
      <span class="menu-anchor">
        <button class="plan-more" aria-label={`More days for ${label}`} aria-haspopup="menu" aria-expanded={open} title="Another day, or the backlog" onClick={() => setOpen(!open)}>▾</button>
        {open && (
          <PlanMenu label={label}>
            {menuDays.map((date) => (
              <button key={date} role="menuitem" class={date === targets.primary ? 'is-primary' : undefined} onClick={() => plan({ kind: 'day', date })} aria-label={`Plan ${label} ${dayPhrase(date, view.today)}`}>
                {menuDay(date, view.today)}
              </button>
            ))}
            <hr />
            <button role="menuitem" onClick={() => plan({ kind: 'backlog', bucket: 'next-weeks' })} aria-label={`Put ${label} in the backlog`}>Backlog</button>
            {picking ? (
              <input
                type="date"
                aria-label={`Day to plan ${label} on`}
                ref={(element) => element?.focus()}
                onChange={(event) => isDateKey(event.currentTarget.value) && plan({ kind: 'day', date: event.currentTarget.value })}
              />
            ) : (
              <button role="menuitem" onClick={() => setPicking(true)}>Pick a date…</button>
            )}
          </PlanMenu>
        )}
      </span>
    </span>
  );
};
