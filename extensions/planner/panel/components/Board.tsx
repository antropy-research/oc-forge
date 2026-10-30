import { useRef, useState } from 'preact/hooks';
import { addDays, isDateKey, monthDay } from '../../src/domain/dates.ts';
import { useView } from '../lib/context.ts';
import { DayColumn } from './DayColumn.tsx';
import { ChannelFilter } from './ChannelFilter.tsx';
import { SourcePanel } from './SourcePanel.tsx';
import { boardTargets } from '../lib/dayTargets.ts';

const DAYS = 7;

/** Home: Sunsama's multi-day board, one column per day, with the sources panel and its rail on the right. */
export const Board = () => {
  const view = useView();
  const [anchor, setAnchor] = useState(view.today);
  const days = Array.from({ length: DAYS }, (_, index) => addDays(anchor, index));
  const board = useRef<HTMLDivElement>(null);
  /** Dragging near the board's edge scrolls the days, so a later day can take the drop even when only one fits. */
  const edgeScroll = (event: DragEvent) => {
    const element = board.current;
    if (!element || element.scrollWidth <= element.clientWidth) return;
    const box = element.getBoundingClientRect();
    const edge = Math.min(72, box.width / 4);
    const right = event.clientX - (box.right - edge);
    const left = box.left + edge - event.clientX;
    if (right > 0) element.scrollLeft += Math.ceil(right / 3) + 4;
    else if (left > 0) element.scrollLeft -= Math.ceil(left / 3) + 4;
  };
  return (
    <section class="view">
      <header class="view-header">
        <h1>Home</h1>
        <span class="view-sub">{monthDay(days[0]!)} – {monthDay(days[DAYS - 1]!)}</span>
        <div class="date-nav">
          <ChannelFilter />
          <button aria-label="Earlier" onClick={() => setAnchor(addDays(anchor, -1))}>‹</button>
          <button onClick={() => setAnchor(view.today)} disabled={anchor === view.today}>Today</button>
          <button aria-label="Later" onClick={() => setAnchor(addDays(anchor, 1))}>›</button>
          <input class="date-jump" type="date" aria-label="Jump to date" value={anchor} onChange={(event) => isDateKey(event.currentTarget.value) && setAnchor(event.currentTarget.value)} />
        </div>
      </header>
      <div class="sunsama-layout">
        <div class="board" ref={board} onDragOver={edgeScroll}>
          {days.map((date) => <DayColumn key={date} date={date} />)}
        </div>
        <SourcePanel {...boardTargets(days, view.today)} />
      </div>
    </section>
  );
};
