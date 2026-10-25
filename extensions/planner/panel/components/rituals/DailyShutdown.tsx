import { useState } from 'preact/hooks';
import type { DateKey, Task } from '../../../src/domain/types.ts';
import { addDays, formatMinutes, monthDay, weekdayName } from '../../../src/domain/dates.ts';
import { actualIsFromPlan, actualMinutes, tasksForDay } from '../../../src/domain/selectors.ts';
import { completedOnDay, ritualRecord, timeByChannel } from '../../../src/domain/rituals.ts';
import { usePlanner, useView } from '../../lib/context.ts';
import { moveTo } from '../../lib/commands.ts';
import { useUi } from '../../lib/ui.ts';
import { Wizard } from './Wizard.tsx';

const STEPS = ['Review today', 'Unfinished work', 'Reflect'];

/** Bars of actual time per channel, Sunsama's time breakdown. */
export const ChannelBreakdown = ({ tasks }: { tasks: readonly Task[] }) => {
  const view = useView();
  const rows = timeByChannel(view.state, tasks);
  const total = rows.reduce((sum, row) => sum + row.minutes, 0);
  if (total === 0) return <p class="hint">No time recorded yet.</p>;
  return (
    <ul class="breakdown">
      {rows.map((row) => {
        const channel = row.channelId ? view.state.channels[row.channelId] : null;
        return (
          <li key={row.channelId ?? 'none'}>
            <span class="breakdown-label">{channel ? `#${channel.name}` : 'No channel'}</span>
            <span class="breakdown-bar"><span style={{ width: `${(row.minutes / total) * 100}%`, background: channel?.color ?? 'var(--oc-muted)' }} /></span>
            <span class="breakdown-time">{formatMinutes(row.minutes)}</span>
          </li>
        );
      })}
    </ul>
  );
};

/** Planned against actual for a set of tasks. */
export const TimeSummary = ({ tasks }: { tasks: readonly Task[] }) => {
  const view = useView();
  const planned = tasks.reduce((sum, task) => sum + (task.plannedMinutes ?? 0), 0);
  const actual = tasks.reduce((sum, task) => sum + actualMinutes(view.state, task), 0);
  return (
    <div class="time-summary">
      <div><span class="label">Planned</span><strong>{formatMinutes(planned)}</strong></div>
      <div><span class="label">Actual</span><strong>{formatMinutes(actual)}</strong></div>
      <div><span class="label">Tasks</span><strong>{tasks.length}</strong></div>
    </div>
  );
};

/** Sunsama's daily shutdown: review the day, place unfinished work, reflect, close the day. */
export const DailyShutdown = ({ onDone }: { onDone: () => void }) => {
  const { client } = usePlanner();
  const view = useView();
  const { setUi } = useUi();
  const [step, setStep] = useState(0);
  const date: DateKey = view.today;
  const record = ritualRecord(view.state, 'shutdown', date);
  const done = completedOnDay(view.state, date);
  const unfinished = tasksForDay(view.state, date).filter((task) => !task.completedAt);
  return (
    <Wizard
      title="Daily shutdown"
      subtitle={`${weekdayName(date)}, ${monthDay(date)}${record.completedAt ? ' · done for the day' : ''}`}
      steps={STEPS}
      step={step}
      onStep={setStep}
      finish={
        <button
          class="primary"
          onClick={() => {
            const bodies: Parameters<typeof client.dispatch>[0] = [];
            if (view.state.timer) bodies.push({ type: 'timer.stopped' });
            bodies.push({ type: 'ritual.saved', ritual: 'shutdown', date, fields: { completedAt: new Date().toISOString() } });
            void client.dispatch(bodies);
            onDone();
          }}
        >
          Done for the day
        </button>
      }
      aside={
        <>
          <h2>Time today</h2>
          <TimeSummary tasks={done} />
          <ChannelBreakdown tasks={done} />
        </>
      }
    >
      {step === 0 && (
        <div class="ritual-section">
          <h2>Completed today</h2>
          <ul class="review-list">
            {done.map((task) => (
              <li key={task.id}>
                <button class="link" onClick={() => setUi({ openTaskId: task.id })}>{task.title}</button>
                <span class="muted">
                  {formatMinutes(actualMinutes(view.state, task)) || '0:00'}
                  {actualIsFromPlan(view.state, task) ? ' (planned)' : ''}
                  {task.plannedMinutes ? ` / ${formatMinutes(task.plannedMinutes)}` : ''}
                </span>
              </li>
            ))}
            {done.length === 0 && <li class="empty">Nothing completed today.</li>}
          </ul>
          <p class="hint">Open a task to correct its actual time.</p>
        </div>
      )}
      {step === 1 && (
        <div class="ritual-section">
          <h2>Still open</h2>
          <p class="hint">Unfinished tasks roll over to tomorrow on their own. Move the ones that belong elsewhere.</p>
          <ul class="triage">
            {unfinished.map((task) => (
              <li key={task.id} class="triage-row">
                <span class="task-title">{task.title}</span>
                <span class="triage-actions">
                  <button onClick={() => void client.dispatch([moveTo(view.state, task.id, { kind: 'day', date: addDays(date, 1) }, 'top')], { undo: 'Moved to tomorrow' })}>Tomorrow</button>
                  <button onClick={() => void client.dispatch([moveTo(view.state, task.id, { kind: 'backlog', bucket: 'next-weeks' }, 'top')], { undo: 'Moved to backlog' })}>Backlog</button>
                  <button onClick={() => void client.dispatch([{ type: 'task.archived', taskId: task.id }], { undo: 'Task archived' })}>Archive</button>
                </span>
              </li>
            ))}
            {unfinished.length === 0 && <li class="empty">Everything planned for today is done.</li>}
          </ul>
        </div>
      )}
      {step === 2 && (
        <div class="ritual-section">
          <label class="stacked">
            How did today go?
            <textarea
              rows={6}
              aria-label="Reflection"
              key={`shutdown-${date}`}
              defaultValue={record.reflection ?? ''}
              placeholder="What went well, what got in the way, what to change tomorrow"
              onBlur={(event) => event.currentTarget.value !== (record.reflection ?? '') && void client.dispatch([{ type: 'ritual.saved', ritual: 'shutdown', date, fields: { reflection: event.currentTarget.value } }])}
            />
          </label>
        </div>
      )}
    </Wizard>
  );
};
