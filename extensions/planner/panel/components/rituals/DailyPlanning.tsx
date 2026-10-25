import { useState } from 'preact/hooks';
import type { DateKey, Task } from '../../../src/domain/types.ts';
import { addDays, formatMinutes, monthDay, weekdayName, zonedDateMinutes } from '../../../src/domain/dates.ts';
import { blocksFor, edgePosition, tasksForDay, workloadTotal, plannedTotal } from '../../../src/domain/selectors.ts';
import { completedOnDay } from '../../../src/domain/rituals.ts';
import { objectivesForWeek, planningDate, ritualRecord, weekStartOf } from '../../../src/domain/rituals.ts';
import { DayCalendar } from '../TimeGrid.tsx';
import { newId } from '../../../src/domain/ids.ts';
import { usePlanner, useView } from '../../lib/context.ts';
import { moveTo } from '../../lib/commands.ts';
import { autoTimebox } from '../../lib/autoSchedule.ts';
import { useCalendarEvents } from '../../lib/calendar.ts';
import { BacklogBuckets } from '../Backlog.tsx';
import { DayColumn } from '../DayColumn.tsx';
import { TaskList } from '../TaskList.tsx';
import { Wizard } from './Wizard.tsx';

const STEPS = ['Review yesterday', 'Add tasks', 'Estimate', 'Prioritize & timebox', 'Finalize'];

const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** One row with the usual "where should this go" choices. */
const TriageRow = ({ task, date }: { task: Task; date: DateKey }) => {
  const { client } = usePlanner();
  const view = useView();
  return (
    <li class="triage-row">
      <span class="task-title">{task.title}</span>
      {task.rolloverCount > 0 && <span class="rollover">↻ {task.rolloverCount}</span>}
      <span class="triage-actions">
        <button onClick={() => void client.dispatch([moveTo(view.state, task.id, { kind: 'day', date: addDays(date, 1) }, 'top')], { undo: 'Moved to the next day' })}>Next day</button>
        <button onClick={() => void client.dispatch([moveTo(view.state, task.id, { kind: 'backlog', bucket: 'next-weeks' }, 'top')], { undo: 'Moved to backlog' })}>Backlog</button>
        <button onClick={() => void client.dispatch([{ type: 'task.archived', taskId: task.id }], { undo: 'Task archived' })}>Archive</button>
      </span>
    </li>
  );
};

const Sources = ({ date }: { date: DateKey }) => {
  const { client } = usePlanner();
  const view = useView();
  const [tab, setTab] = useState<'backlog' | 'meetings' | 'objectives'>('backlog');
  const feed = useCalendarEvents(date, date);
  const objectives = objectivesForWeek(view.state, weekStartOf(view.state, date));
  const titles = new Set(tasksForDay(view.state, date).map((task) => task.title));
  const addTask = (title: string, extra: { plannedMinutes?: number | null; objectiveId?: string | null }) =>
    void client.dispatch([{ type: 'task.created', task: { id: newId(), title, placement: { kind: 'day', date }, position: edgePosition(view.state, { kind: 'day', date }, 'bottom'), plannedMinutes: extra.plannedMinutes ?? null, objectiveId: extra.objectiveId ?? null } }]);
  return (
    <>
      <div class="tabs side-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'backlog'} onClick={() => setTab('backlog')}>Backlog</button>
        <button role="tab" aria-selected={tab === 'meetings'} onClick={() => setTab('meetings')}>Meetings</button>
        <button role="tab" aria-selected={tab === 'objectives'} onClick={() => setTab('objectives')}>Objectives</button>
      </div>
      {tab === 'backlog' && (
        <>
          <p class="hint">Drag tasks into the day.</p>
          <BacklogBuckets compact />
        </>
      )}
      {tab === 'meetings' && (
        <ul class="source-list">
          {feed.events.filter((event) => !event.allDay).map((event) => {
            const start = zonedDateMinutes(event.start, view.state.settings.timezone ?? 'UTC').minutes;
            const minutes = Math.round((Date.parse(event.end) - Date.parse(event.start)) / 60_000);
            return (
              <li key={event.id}>
                <span>{event.title}</span>
                <span class="muted">{hhmm(Math.floor(start))} · {formatMinutes(minutes)}</span>
                <button disabled={titles.has(event.title)} onClick={() => addTask(event.title, { plannedMinutes: minutes })}>{titles.has(event.title) ? 'Added' : 'Add'}</button>
              </li>
            );
          })}
          {feed.events.length === 0 && <li class="empty">No meetings on this day. Subscribe to a calendar in Settings.</li>}
        </ul>
      )}
      {tab === 'objectives' && (
        <ul class="source-list">
          {objectives.map((objective) => (
            <li key={objective.id}>
              <span>◎ {objective.title}</span>
              <button onClick={() => addTask(objective.title, { objectiveId: objective.id })}>Add task</button>
            </li>
          ))}
          {objectives.length === 0 && <li class="empty">No objectives for this week yet. Set them in Weekly planning.</li>}
        </ul>
      )}
    </>
  );
};

/** Sunsama's daily planning: process yesterday, add, estimate, prioritize and timebox, finalize. */
export const DailyPlanning = ({ onDone }: { onDone: () => void }) => {
  const { client, host } = usePlanner();
  const view = useView();
  const zone = view.state.settings.timezone ?? 'UTC';
  const [date, setDate] = useState<DateKey>(() => planningDate(view.today, zonedDateMinutes(Date.now(), zone).minutes));
  const [step, setStep] = useState(0);
  const record = ritualRecord(view.state, 'planning', date);
  const tasks = tasksForDay(view.state, date);
  const open = tasks.filter((task) => !task.completedAt);
  const workload = workloadTotal(view.state, tasks);
  const threshold = view.state.settings.workloadMinutes;
  const previous = addDays(date, -1);
  const carried = date === view.today ? open.filter((task) => task.rolloverCount > 0) : tasksForDay(view.state, previous).filter((task) => !task.completedAt);
  const doneBefore = completedOnDay(view.state, previous);
  const shutdownReflection = ritualRecord(view.state, 'shutdown', previous).reflection;
  const planText = [`Plan for ${weekdayName(date)}, ${monthDay(date)}:`, ...open.map((task) => `- ${task.title}${task.plannedMinutes ? ` (${formatMinutes(task.plannedMinutes)})` : ''}`), record.obstacles ? `\nObstacles: ${record.obstacles}` : ''].join('\n').trim();

  const timeboxAll = async () => {
    for (const task of open) {
      if (blocksFor(view.state, task.id).some((block) => zonedDateMinutes(block.start, zone).date === date)) continue;
      const problem = await autoTimebox(client, client.getView().state, view.today, client.getView().state.tasks[task.id]!, date);
      if (problem) {
        client.notify(problem);
        break;
      }
    }
  };

  return (
    <Wizard
      title="Daily planning"
      subtitle={`${date === view.today ? 'Today' : date === addDays(view.today, 1) ? 'Tomorrow' : weekdayName(date)}, ${monthDay(date)}${record.completedAt ? ' · planned' : ''}`}
      steps={STEPS}
      step={step}
      onStep={setStep}
      finish={
        <button
          class="primary"
          onClick={() => {
            void client.dispatch([{ type: 'ritual.saved', ritual: 'planning', date, fields: { completedAt: new Date().toISOString() } }]);
            onDone();
          }}
        >
          Start my day
        </button>
      }
      aside={step === 1 ? <Sources date={date} /> : step === 3 ? <DayCalendar date={date} /> : undefined}
    >
      {step === 0 && (
        <div class="ritual-section">
          <div class="row ritual-target">
            <span>Planning for</span>
            <div class="tabs" role="tablist" aria-label="Planning day">
              <button role="tab" aria-selected={date === view.today} onClick={() => setDate(view.today)}>Today</button>
              <button role="tab" aria-selected={date === addDays(view.today, 1)} onClick={() => setDate(addDays(view.today, 1))}>Tomorrow</button>
            </div>
          </div>
          <h2>{date === view.today ? 'Carried over from earlier days' : 'Still open today'}</h2>
          <p class="hint">Decide what still belongs on {date === view.today ? 'today' : 'tomorrow'}. Anything you leave here stays planned.</p>
          <ul class="triage">
            {carried.map((task) => <TriageRow key={task.id} task={task} date={date === view.today ? date : previous} />)}
            {carried.length === 0 && <li class="empty">Nothing carried over.</li>}
          </ul>
          <h2>{date === view.today ? 'Yesterday' : 'Today so far'}</h2>
          <p class="hint">{doneBefore.length} tasks completed{shutdownReflection ? ' · reflection below' : ''}.</p>
          {shutdownReflection && <blockquote class="reflection">{shutdownReflection}</blockquote>}
        </div>
      )}
      {step === 1 && (
        <div class="ritual-section">
          <DayColumn date={date} wide />
        </div>
      )}
      {step === 2 && (
        <div class="ritual-section">
          <div class={`workload${workload > threshold ? ' is-over' : ''}`}>
            <div class="workload-numbers">
              <strong>{formatMinutes(workload)}</strong> of work planned · threshold {formatMinutes(threshold)}
              {plannedTotal(tasks) !== workload && <span class="muted"> · {formatMinutes(plannedTotal(tasks) - workload)} personal</span>}
            </div>
            <div class="load-bar"><div class={`load-fill${workload > threshold ? ' is-over' : ''}`} style={{ width: `${Math.min(100, (workload / threshold) * 100)}%` }} /></div>
            {workload > threshold && <p class="warning">This is more than you said you can do in a day. Move something to another day or the backlog.</p>}
            {open.some((task) => !task.plannedMinutes) && <p class="hint">Tasks without an estimate show –:––; click to set one.</p>}
          </div>
          <TaskList placement={{ kind: 'day', date }} tasks={tasks} />
        </div>
      )}
      {step === 3 && (
        <div class="ritual-section">
          <p class="hint">Drag to put the most important work first, then give tasks a time.</p>
          <div class="row">
            <button onClick={() => void timeboxAll()}>Timebox all</button>
            <label class="inline">
              Shut down at
              <input
                type="time"
                aria-label="Shutdown time"
                value={record.shutdownTime != null ? hhmm(record.shutdownTime) : hhmm(view.state.settings.workdayEnd)}
                onChange={(event) => {
                  const [h, m] = event.currentTarget.value.split(':').map(Number);
                  if (Number.isFinite(h) && Number.isFinite(m)) void client.dispatch([{ type: 'ritual.saved', ritual: 'planning', date, fields: { shutdownTime: h! * 60 + m! } }]);
                }}
              />
            </label>
          </div>
          <TaskList placement={{ kind: 'day', date }} tasks={tasks} />
        </div>
      )}
      {step === 4 && (
        <div class="ritual-section">
          <h2>Your plan</h2>
          <pre class="plan-text">{planText}</pre>
          <label class="stacked">
            What could get in the way?
            <textarea
              rows={3}
              aria-label="Obstacles"
              key={`obstacles-${date}`}
              defaultValue={record.obstacles ?? ''}
              onBlur={(event) => event.currentTarget.value !== (record.obstacles ?? '') && void client.dispatch([{ type: 'ritual.saved', ritual: 'planning', date, fields: { obstacles: event.currentTarget.value } }])}
            />
          </label>
          <button onClick={() => void host.writeClipboard(planText).then(() => client.notify('Plan copied')).catch(() => client.notify('Could not copy the plan'))}>Copy plan</button>
        </div>
      )}
    </Wizard>
  );
};
