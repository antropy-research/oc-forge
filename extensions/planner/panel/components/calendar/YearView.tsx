// Google Calendar's Year view: the twelve months of the year side by side,
// today ringed; a date opens that day.
import type { DateKey } from '../../../src/domain/types.ts';
import { addDays } from '../../../src/domain/dates.ts';
import { longDay, monthWeeks } from '../../../src/domain/gcalendar.ts';
import { useView } from '../../lib/context.ts';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

export const YearView = ({ anchor, onDay }: { anchor: DateKey; onDay: (date: DateKey) => void }) => {
  const view = useView();
  const weekStartsOn = view.state.settings.weekStartsOn;
  const year = anchor.slice(0, 4);
  return (
    <div class="year-view">
      {MONTHS.map((name, index) => {
        const first = `${year}-${String(index + 1).padStart(2, '0')}-01` as DateKey;
        const weeks = monthWeeks(first, weekStartsOn);
        // Six rows each, as Google draws them, so the months line up.
        while (weeks.length < 6) weeks.push(weeks[weeks.length - 1]!.map((day) => addDays(day, 7)));
        return (
          <section key={name} class={`year-month${view.today.slice(0, 7) === first.slice(0, 7) ? ' is-current' : ''}`} aria-label={`${name} ${year}`}>
            <h3 class="year-month-name">{name}</h3>
            <div class="mini-grid" role="grid" aria-label={`${name} ${year}`}>
              <div class="mini-row" role="row">
                {weeks[0]!.map((day) => <span key={day} class="mini-letter" role="columnheader">{LETTERS[new Date(`${day}T00:00:00Z`).getUTCDay()]}</span>)}
              </div>
              {weeks.map((week) => (
                <div key={week[0]} class="mini-row" role="row">
                  {week.map((day) =>
                    day.slice(0, 7) === first.slice(0, 7) ? (
                      <button
                        key={day}
                        role="gridcell"
                        class={`mini-day${day === view.today ? ' is-today' : ''}`}
                        aria-label={`${longDay(day)}, ${year}${day === view.today ? ', today' : ''}`}
                        onClick={() => onDay(day)}
                      >
                        {Number(day.slice(8))}
                      </button>
                    ) : (
                      <span key={day} class="mini-day is-blank" aria-hidden="true" />
                    ),
                  )}
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
};
