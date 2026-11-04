// Google Calendar's Pending tasks: today's "N pending tasks" entry opens the
// open Google tasks dated in the past 365 days, the latest first, each with
// its date, time (or all day) and repeat. As in Google Calendar, a row's
// circle completes it (its subtasks first, a repeating one makes its next),
// Reschedule this task moves it to today, tomorrow or a date picked (Google's
// date; a time kept in the Planner stays), and Edit opens the task's editor
// over the calendar. A task done or moved past yesterday leaves the list.
import { useState } from 'preact/hooks';
import type { CalendarEvent } from '../../../src/domain/ics.ts';
import type { DateKey } from '../../../src/domain/types.ts';
import { addDays, isDateKey } from '../../../src/domain/dates.ts';
import { longDay } from '../../../src/domain/gcalendar.ts';
import { describeRecurrence } from '../../../src/domain/rrule.ts';
import type { GoogleTaskItem } from '../../../src/domain/google.ts';
import { keptFor, keptTimeLabel } from '../../../src/domain/gtaskKept.ts';
import { dateBlock, PENDING_DAYS } from '../../../src/domain/gtaskPending.ts';
import { useGoogle, usePlanner, useView } from '../../lib/context.ts';
import { calendarUi, type Anchor } from '../../lib/gcal.ts';
import { undoAction } from '../../lib/google.ts';
import { pendingStore, usePendingTasks } from '../../lib/pendingTasks.ts';
import { Icon } from './Icon.tsx';
import { Popover } from './Popover.tsx';

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const close = () => calendarUi.open(null);
const keyOf = (item: GoogleTaskItem): string => `${item.account}\n${item.id}`;

/** "Today", "Tomorrow" or "Monday, November 2": where a task was rescheduled to. */
const dayName = (date: DateKey, today: DateKey): string => (date === today ? 'today' : date === addDays(today, 1) ? 'tomorrow' : longDay(date));

export const PendingPopover = ({ anchor }: { event: CalendarEvent; anchor: Anchor }) => {
  const { client, google } = usePlanner();
  const view = useView();
  const gv = useGoogle();
  // Live: a task completed or moved here leaves at once, whatever the entry clicked held.
  const items = usePendingTasks(true);
  const zone = view.state.settings.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [menu, setMenu] = useState<string | null>(null);
  const [picked, setPicked] = useState<DateKey>(view.today);
  const [busy, setBusy] = useState<string | null>(null);
  const accounts = new Set(gv.lists.map((list) => list.account)).size;
  const listOf = (item: GoogleTaskItem) => gv.lists.find((list) => list.account === item.account && list.id === item.listId);

  /** Shown at once; Google's refusal puts it back and says why. */
  const change = (item: GoogleTaskItem, now: GoogleTaskItem | null, work: () => Promise<unknown>, done: string, undo: (() => Promise<void>) | null = null) => {
    setMenu(null);
    setBusy(keyOf(item));
    pendingStore.change(item, now);
    work()
      .then(() => calendarUi.snack(done, undo))
      .catch((error) => {
        pendingStore.forget(item);
        client.notify(`Google Tasks did not take it: ${messageOf(error)}`);
      })
      .finally(() => setBusy(null));
  };
  const complete = (item: GoogleTaskItem) => change(item, null, () => google.completeListTask(item, true), 'Task completed', undoAction(google, client.notify));
  const reschedule = (item: GoogleTaskItem, date: DateKey) => {
    if (date === item.due) return setMenu(null);
    change(item, { ...item, due: date }, () => google.setTaskDue(item, date), `Task rescheduled to ${dayName(date, view.today)}`);
  };

  return (
    <Popover anchor={anchor} label="Pending tasks" onClose={close} width={440} className="pending-popover">
      <div class="pop-tools">
        <button class="icon-button" aria-label="Close" title="Close" onClick={close}>
          <Icon name="close" />
        </button>
      </div>
      <div class="pending-head">
        <h2>Pending tasks</h2>
        <p class="muted">In the past {PENDING_DAYS} days</p>
      </div>
      {items.length === 0 ? (
        <p class="muted pending-empty">No pending tasks.</p>
      ) : (
        <ul class="pending-list" aria-label="Pending tasks">
          {items.map((item) => {
            const key = keyOf(item);
            const kept = keptFor(view.state, item);
            const block = dateBlock(item.due!);
            const time = keptTimeLabel(kept);
            const repeat = kept?.repeat ? describeRecurrence([kept.repeat.rule], kept.repeat.template?.start ?? item.due!, zone) : null;
            const list = listOf(item);
            const when = [time ?? 'All day', repeat, gv.lists.length > 1 && list ? `${list.title}${accounts > 1 ? ` · ${item.account}` : ''}` : null].filter(Boolean).join(' · ');
            return (
              <li key={key} class={`pending-row${menu === key ? ' has-menu' : ''}`} aria-label={`${item.title}, ${longDay(item.due!)}`}>
                <button class="gt-check pending-check" role="checkbox" aria-checked="false" aria-label={`Mark ${item.title} complete`} title="Mark completed" disabled={busy === key} onClick={() => complete(item)}>
                  <Icon name="circle" size={20} />
                  <span class="gt-check-hover"><Icon name="check" size={14} /></span>
                </button>
                <span class="pending-date" aria-hidden="true">
                  <span class="pending-month">{block.month}</span>
                  <span class="pending-day">{block.day}</span>
                </span>
                <span class="pending-main">
                  <span class="pending-title">{item.title}</span>
                  <span class="pending-when muted">{when}</span>
                </span>
                <span class="pending-actions">
                  <button
                    class="icon-button"
                    aria-label={`Reschedule ${item.title}`}
                    title="Reschedule this task"
                    aria-haspopup="menu"
                    aria-expanded={menu === key}
                    disabled={busy === key}
                    onClick={() => {
                      setPicked(view.today);
                      setMenu(menu === key ? null : key);
                    }}
                  >
                    <Icon name="reschedule" />
                  </button>
                  <button class="icon-button" aria-label={`Edit ${item.title}`} title="Edit task" disabled={busy === key} onClick={() => calendarUi.editTask({ item, series: false })}>
                    <Icon name="edit" />
                  </button>
                </span>
                {menu === key && (
                  <div class="pending-menu" role="menu" aria-label={`Reschedule ${item.title}`}>
                    <button role="menuitem" onClick={() => reschedule(item, view.today)}>Today</button>
                    <button role="menuitem" onClick={() => reschedule(item, addDays(view.today, 1))}>Tomorrow</button>
                    <div class="pending-pick">
                      <input type="date" aria-label="Pick a date" value={picked} onChange={(input) => isDateKey(input.currentTarget.value) && setPicked(input.currentTarget.value)} />
                      <button class="primary" onClick={() => reschedule(item, picked)}>Reschedule</button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Popover>
  );
};
