import { useState } from 'preact/hooks';
import type { DateKey, Objective } from '../../../src/domain/types.ts';
import { addDays, formatMinutes, monthDay, weekdayName } from '../../../src/domain/dates.ts';
import { actualMinutes } from '../../../src/domain/selectors.ts';
import { completedOnDay, objectivesForWeek, planningWeek, ritualRecord, tasksForObjective, weekDates, weekStartOf } from '../../../src/domain/rituals.ts';
import { newId } from '../../../src/domain/ids.ts';
import { usePlanner, useView } from '../../lib/context.ts';
import { ChannelBreakdown, TimeSummary } from './DailyShutdown.tsx';
import { Wizard } from './Wizard.tsx';

const weekLabel = (start: DateKey) => `${monthDay(start)} – ${monthDay(addDays(start, 6))}`;

const WeekNav = ({ week, setWeek }: { week: DateKey; setWeek: (week: DateKey) => void }) => (
  <div class="date-nav">
    <button aria-label="Previous week" onClick={() => setWeek(addDays(week, -7))}>‹</button>
    <button aria-label="Next week" onClick={() => setWeek(addDays(week, 7))}>›</button>
  </div>
);

/** One objective with its aligned tasks' progress. */
const ObjectiveRow = ({ objective, editable }: { objective: Objective; editable: boolean }) => {
  const { client } = usePlanner();
  const view = useView();
  const tasks = tasksForObjective(view.state, objective.id);
  const done = tasks.filter((task) => task.completedAt).length;
  const minutes = tasks.reduce((sum, task) => sum + actualMinutes(view.state, task), 0);
  return (
    <li class={`objective${objective.completedAt ? ' is-done' : ''}`}>
      <input
        type="checkbox"
        checked={Boolean(objective.completedAt)}
        aria-label={`Objective ${objective.title} complete`}
        onChange={(event) => void client.dispatch([{ type: 'objective.updated', objectiveId: objective.id, patch: { completed: event.currentTarget.checked } }])}
      />
      {editable ? (
        <input
          class="objective-title"
          aria-label="Objective"
          key={`${objective.id}-${objective.title}`}
          defaultValue={objective.title}
          onBlur={(event) => {
            const title = event.currentTarget.value.trim();
            if (title && title !== objective.title) void client.dispatch([{ type: 'objective.updated', objectiveId: objective.id, patch: { title } }]);
          }}
        />
      ) : (
        <span class="objective-title">◎ {objective.title}</span>
      )}
      <span class="muted">{tasks.length ? `${done}/${tasks.length} tasks` : 'no tasks yet'}{minutes ? ` · ${formatMinutes(minutes)}` : ''}</span>
      {editable && <button class="link danger" aria-label={`Delete objective ${objective.title}`} onClick={() => void client.dispatch([{ type: 'objective.deleted', objectiveId: objective.id }], { undo: 'Objective deleted' })}>×</button>}
    </li>
  );
};

/** Sunsama's weekly planning: carry over last week's objectives, set this week's, write the intention. */
export const WeeklyPlanning = ({ onDone }: { onDone: () => void }) => {
  const { client } = usePlanner();
  const view = useView();
  const [week, setWeek] = useState(() => planningWeek(view.state, view.today));
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState('');
  const last = objectivesForWeek(view.state, addDays(week, -7));
  const current = objectivesForWeek(view.state, week);
  const continued = new Set(current.map((objective) => objective.carriedFrom).filter(Boolean));
  const record = ritualRecord(view.state, 'weeklyPlanning', week);
  const add = () => {
    if (!draft.trim()) return;
    void client.dispatch([{ type: 'objective.created', objective: { id: newId(), weekStart: week, title: draft.trim(), carriedFrom: null } }]);
    setDraft('');
  };
  return (
    <Wizard
      title="Weekly planning"
      subtitle={`Week of ${weekLabel(week)}${record.completedAt ? ' · planned' : ''}`}
      steps={['Last week', 'Objectives', 'Intention']}
      step={step}
      onStep={setStep}
      finish={
        <button
          class="primary"
          onClick={() => {
            void client.dispatch([{ type: 'ritual.saved', ritual: 'weeklyPlanning', date: week, fields: { completedAt: new Date().toISOString() } }]);
            onDone();
          }}
        >
          Finish planning
        </button>
      }
    >
      <WeekNav week={week} setWeek={setWeek} />
      {step === 0 && (
        <div class="ritual-section">
          <h2>Last week's objectives</h2>
          <p class="hint">Continue what still matters into this week; check off what is done.</p>
          <ul class="objectives">
            {last.map((objective) => (
              <li key={objective.id} class={`objective${objective.completedAt ? ' is-done' : ''}`}>
                <input type="checkbox" checked={Boolean(objective.completedAt)} aria-label={`Objective ${objective.title} complete`} onChange={(event) => void client.dispatch([{ type: 'objective.updated', objectiveId: objective.id, patch: { completed: event.currentTarget.checked } }])} />
                <span class="objective-title">◎ {objective.title}</span>
                <button
                  disabled={continued.has(objective.id) || Boolean(objective.completedAt)}
                  onClick={() => void client.dispatch([{ type: 'objective.created', objective: { id: newId(), weekStart: week, title: objective.title, carriedFrom: objective.id } }])}
                >
                  {continued.has(objective.id) ? 'Continued' : 'Continue'}
                </button>
              </li>
            ))}
            {last.length === 0 && <li class="empty">No objectives last week.</li>}
          </ul>
        </div>
      )}
      {step === 1 && (
        <div class="ritual-section">
          <h2>This week's objectives</h2>
          <p class="hint">A few outcomes for the week, not a task list; daily planning turns them into tasks.</p>
          <ul class="objectives">
            {current.map((objective) => <ObjectiveRow key={objective.id} objective={objective} editable />)}
          </ul>
          <input class="subtask-add" value={draft} placeholder="Add an objective" aria-label="Add objective" onInput={(event) => setDraft(event.currentTarget.value)} onKeyDown={(event) => event.key === 'Enter' && add()} />
        </div>
      )}
      {step === 2 && (
        <div class="ritual-section">
          <label class="stacked">
            What do you want this week to be about?
            <textarea rows={6} aria-label="Weekly intention" key={`wp-${week}`} defaultValue={record.journal ?? ''} onBlur={(event) => event.currentTarget.value !== (record.journal ?? '') && void client.dispatch([{ type: 'ritual.saved', ritual: 'weeklyPlanning', date: week, fields: { journal: event.currentTarget.value } }])} />
          </label>
        </div>
      )}
    </Wizard>
  );
};

/** Sunsama's weekly review: objectives, the body of work by day, where the time went, a journal. */
export const WeeklyReview = () => {
  const { client } = usePlanner();
  const view = useView();
  const [week, setWeek] = useState(() => weekStartOf(view.state, view.today));
  const objectives = objectivesForWeek(view.state, week);
  const days = weekDates(week);
  const done = days.flatMap((date) => completedOnDay(view.state, date));
  const record = ritualRecord(view.state, 'weeklyReview', week);
  return (
    <section class="view ritual">
      <header class="view-header">
        <h1>Weekly review</h1>
        <span class="view-sub">Week of {weekLabel(week)}{record.completedAt ? ' · wrapped up' : ''}</span>
        <WeekNav week={week} setWeek={setWeek} />
      </header>
      <div class="ritual-layout has-aside">
        <div class="ritual-body">
          <div class="ritual-section">
            <h2>Objectives</h2>
            <ul class="objectives">
              {objectives.map((objective) => <ObjectiveRow key={objective.id} objective={objective} editable={false} />)}
              {objectives.length === 0 && <li class="empty">No objectives this week.</li>}
            </ul>
          </div>
          <div class="ritual-section">
            <h2>Body of work</h2>
            <div class="week-days">
              {days.map((date) => {
                const tasks = completedOnDay(view.state, date);
                const minutes = tasks.reduce((sum, task) => sum + actualMinutes(view.state, task), 0);
                return (
                  <div key={date} class="week-day">
                    <div class="week-day-head"><strong>{weekdayName(date).slice(0, 3)}</strong> <span class="muted">{monthDay(date)} · {formatMinutes(minutes) || '0:00'}</span></div>
                    <ul>{tasks.map((task) => <li key={task.id}>{task.title}</li>)}</ul>
                  </div>
                );
              })}
            </div>
          </div>
          <div class="ritual-section">
            <label class="stacked">
              How did the week go?
              <textarea rows={5} aria-label="Weekly journal" key={`wr-${week}`} defaultValue={record.journal ?? ''} onBlur={(event) => event.currentTarget.value !== (record.journal ?? '') && void client.dispatch([{ type: 'ritual.saved', ritual: 'weeklyReview', date: week, fields: { journal: event.currentTarget.value } }])} />
            </label>
          </div>
          <div class="row">
            <button class="primary" onClick={() => void client.dispatch([{ type: 'ritual.saved', ritual: 'weeklyReview', date: week, fields: { completedAt: new Date().toISOString() } }])}>{record.completedAt ? 'Wrapped up' : 'Wrap up the week'}</button>
          </div>
        </div>
        <aside class="side-panel ritual-aside">
          <h2>Time this week</h2>
          <TimeSummary tasks={done} />
          <ChannelBreakdown tasks={done} />
        </aside>
      </div>
    </section>
  );
};
