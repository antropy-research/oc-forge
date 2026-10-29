import { useEffect, useState } from 'preact/hooks';
import type { Task } from '../../src/domain/types.ts';
import { formatMinutes, monthDay, weekdayName } from '../../src/domain/dates.ts';
import { actualMinutes, tasksForDay } from '../../src/domain/selectors.ts';
import { usePlanner, useView } from '../lib/context.ts';
import { useUi } from '../lib/ui.ts';
import { formatClock, useNow } from '../lib/time.ts';
import { TimerButton } from './TimerButton.tsx';
import { NotesField, Subtasks } from './TaskDetail.tsx';

/** The task Focus shows: the chosen one, else the running timer's, else the first open task today. */
export const focusTask = (open: Task[], chosen: string | null, running: string | null): Task | null =>
  open.find((task) => task.id === chosen) ?? open.find((task) => task.id === running) ?? open[0] ?? null;

/** Sunsama's Focus mode: one task, its timer, subtasks and notes; ↑/↓ switch, completing moves on. */
export const FocusView = ({ onExit }: { onExit: () => void }) => {
  const { client } = usePlanner();
  const view = useView();
  const { ui, setUi } = useUi();
  const today = tasksForDay(view.state, view.today);
  const open = today.filter((task) => !task.completedAt);
  const task = focusTask(open, ui.focusTaskId, view.state.timer?.taskId ?? null);
  const running = Boolean(task && view.state.timer?.taskId === task.id);
  const [pomodoro, setPomodoro] = useState<{ phase: 'focus' | 'break' | 'done'; endsAt: number; cycles: number } | null>(null);
  const now = useNow(running || (pomodoro !== null && pomodoro.phase !== 'done'));
  const { pomodoroMinutes, breakMinutes } = view.state.settings;

  // A phase that ran out: focus stops the timer and starts the break; the break ends and waits.
  useEffect(() => {
    if (!pomodoro || pomodoro.phase === 'done' || now < pomodoro.endsAt) return;
    if (pomodoro.phase === 'focus') {
      if (view.state.timer) void client.dispatch([{ type: 'timer.stopped' }]);
      setPomodoro({ phase: 'break', endsAt: Date.now() + breakMinutes * 60_000, cycles: pomodoro.cycles + 1 });
      client.notify(`Pomodoro done. Take a ${breakMinutes}-minute break.`);
    } else {
      setPomodoro({ ...pomodoro, phase: 'done' });
      client.notify('Break over. Start the next Pomodoro when you are ready.');
    }
  }, [now, pomodoro]);

  const startPomodoro = () => {
    if (!task) return;
    if (view.state.timer?.taskId !== task.id) void client.dispatch([{ type: 'timer.started', taskId: task.id }]);
    setPomodoro({ phase: 'focus', endsAt: Date.now() + pomodoroMinutes * 60_000, cycles: pomodoro?.cycles ?? 0 });
  };
  const stopPomodoro = () => {
    if (pomodoro?.phase === 'focus' && view.state.timer) void client.dispatch([{ type: 'timer.stopped' }]);
    setPomodoro(null);
  };
  const index = task ? open.findIndex((item) => item.id === task.id) : -1;

  const go = (delta: number) => {
    if (open.length === 0) return;
    const next = open[(index + delta + open.length) % open.length]!;
    setUi({ focusTaskId: next.id });
  };
  const complete = () => {
    if (!task) return;
    const next = open[index + 1] ?? open[index - 1] ?? null;
    void client.dispatch([{ type: 'task.completed', taskId: task.id, on: view.today }], { undo: 'Task completed' });
    setUi({ focusTaskId: next?.id ?? null });
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.key === 'ArrowDown') go(1);
      else if (event.key === 'ArrowUp') go(-1);
      else if (event.key === 'Escape') onExit();
      else if (event.key.toLowerCase() === 'c' && !event.metaKey && !event.ctrlKey) complete();
      else return;
      event.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const done = today.length - open.length;
  return (
    <section class="view focus-view">
      <header class="view-header">
        <h1>Focus</h1>
        <span class="view-sub">{weekdayName(view.today)}, {monthDay(view.today)} · {done}/{today.length} done</span>
        <div class="date-nav"><button onClick={onExit}>Exit focus</button></div>
      </header>
      {task ? (
        <div class="focus-body">
          <article class="focus-card" aria-label={`Focus: ${task.title}`}>
            <div class="focus-meta">
              {task.channelId && view.state.channels[task.channelId] && <span class="channel">#{view.state.channels[task.channelId]!.name}</span>}
              {task.plannedMinutes ? <span>Planned {formatMinutes(task.plannedMinutes)}</span> : null}
              <span>Task {index + 1} of {open.length}</span>
            </div>
            <div class="focus-title-row">
              <button class="check" aria-label="Mark complete" aria-pressed={false} onClick={complete}>
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 8.5l2.5 2.5L12 5.5" /></svg>
              </button>
              <h2>{task.title}</h2>
            </div>
            <div class={`focus-timer${running ? ' is-running' : ''}`}>
              <TimerButton task={task} large />
              <div>
                <div class="clock" aria-live="off">{formatClock(actualMinutes(view.state, task, now))}</div>
                <div class="hint">{running ? 'Timer running' : 'Start the timer to track actual time'}{task.plannedMinutes ? ` · planned ${formatMinutes(task.plannedMinutes)}` : ''}</div>
              </div>
            </div>
            <div class="pomodoro" aria-label="Pomodoro">
              {pomodoro && pomodoro.phase !== 'done' ? (
                <>
                  <span class={`pomodoro-phase is-${pomodoro.phase}`}>{pomodoro.phase === 'focus' ? 'Focus' : 'Break'} {formatClock(Math.max(0, pomodoro.endsAt - now) / 60_000)}</span>
                  <button class="link" onClick={stopPomodoro}>Stop Pomodoro</button>
                </>
              ) : (
                <button class="link" onClick={startPomodoro}>{pomodoro?.phase === 'done' ? 'Start the next Pomodoro' : `Start a ${pomodoroMinutes}-minute Pomodoro`}</button>
              )}
              {pomodoro?.cycles ? <span class="muted">{pomodoro.cycles} done</span> : null}
            </div>
            <Subtasks task={task} />
            {/* Over the notes as they are: one left as it was writes nothing, one changed elsewhere too is asked. */}
            <NotesField task={task} className="detail-notes focus-notes" key={`focus-notes-${task.id}`} />
            <div class="focus-nav">
              <button onClick={() => go(-1)} disabled={open.length < 2}>↑ Previous</button>
              <button onClick={() => go(1)} disabled={open.length < 2}>Next ↓</button>
            </div>
          </article>
          <aside class="side-panel" aria-label="Up next">
            <h2>Up next</h2>
            <ol class="up-next">
              {open.map((item) => (
                <li key={item.id}>
                  <button class={item.id === task.id ? 'is-current' : ''} onClick={() => setUi({ focusTaskId: item.id })}>
                    <span>{item.title}</span>
                    {item.plannedMinutes ? <span class="muted">{formatMinutes(item.plannedMinutes)}</span> : null}
                  </button>
                </li>
              ))}
            </ol>
          </aside>
        </div>
      ) : (
        <div class="done-for-day">
          <h2>{today.length ? 'Done for the day' : 'Nothing planned for today'}</h2>
          <p>{today.length ? `You finished all ${today.length} tasks you planned.` : 'Add tasks to today to focus on them one at a time.'}</p>
        </div>
      )}
    </section>
  );
};
