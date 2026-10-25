import { useState } from 'preact/hooks';
import { addDays, monthDay } from '../../src/domain/dates.ts';
import { useView } from '../lib/context.ts';
import { DayColumn } from './DayColumn.tsx';

const DAYS = 7;

/** Home: Sunsama's multi-day board, one column per day. */
export const Board = () => {
  const view = useView();
  const [anchor, setAnchor] = useState(view.today);
  const days = Array.from({ length: DAYS }, (_, index) => addDays(anchor, index));
  return (
    <section class="view">
      <header class="view-header">
        <h1>Home</h1>
        <span class="view-sub">{monthDay(days[0]!)} – {monthDay(days[DAYS - 1]!)}</span>
        <div class="date-nav">
          <button aria-label="Earlier" onClick={() => setAnchor(addDays(anchor, -1))}>‹</button>
          <button onClick={() => setAnchor(view.today)} disabled={anchor === view.today}>Today</button>
          <button aria-label="Later" onClick={() => setAnchor(addDays(anchor, 1))}>›</button>
        </div>
      </header>
      <div class="board">
        {days.map((date) => <DayColumn key={date} date={date} />)}
      </div>
    </section>
  );
};
