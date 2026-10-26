// Linear issues already in the plan, by when they are planned.
import { addDays, monthDay } from '../../../src/domain/dates.ts';
import { plannedLinearTasks } from '../../../src/domain/linear.ts';
import type { Task } from '../../../src/domain/types.ts';
import { useLinear, usePlanner, useView } from '../../lib/context.ts';
import { useUi } from '../../lib/ui.ts';
import { workspaceLabel } from './common.tsx';
import { StatusIcon } from './icons.tsx';

const plannedLabel = (task: Task, today: string): string => {
  if (task.completedAt) return 'Done';
  if (task.placement.kind === 'backlog') return 'In backlog';
  if (task.placement.date === today) return 'Today';
  if (task.placement.date === addDays(today, 1)) return 'Tomorrow';
  return monthDay(task.placement.date);
};

const PlannedRow = ({ task }: { task: Task }) => {
  const { linear } = usePlanner();
  const view = useView();
  const lv = useLinear();
  const { setUi } = useUi();
  const source = task.source!;
  const live = lv.linked[source.id];
  const status = live ? live.state : source.status;
  const workspace = workspaceLabel(lv, linear.workspaceOf(source));
  return (
    <li class="lin-row is-planned" aria-label={`${source.key} ${task.title}`} onClick={() => setUi({ openIssue: { id: source.id, workspaceId: linear.workspaceOf(source) } })}>
      <span class="lin-row-id">{source.key}</span>
      {status && <StatusIcon type={status.type} color={status.color} title={status.name} />}
      <span class="lin-row-title">
        <button class="issue-title is-openable lin-title-text" aria-label={`Edit ${source.key}`} title="Open the issue" onClick={(event) => { event.stopPropagation(); setUi({ openIssue: { id: source.id, workspaceId: linear.workspaceOf(source) } }); }}>{task.title}</button>
      </span>
      <span class="lin-props">
        {workspace && <span class="ws-badge">{workspace}</span>}
        {status && <span class="muted">{status.name}</span>}
      </span>
      <button class="lin-planned" onClick={(event) => { event.stopPropagation(); setUi({ openTaskId: task.id }); }} aria-label={`Open the task for ${source.key} (${plannedLabel(task, view.today)})`}>
        {plannedLabel(task, view.today)}
      </button>
    </li>
  );
};

export const PlannedPane = () => {
  const view = useView();
  const groups = plannedLinearTasks(view.state, view.today);
  return (
    <>
      <header class="lin-head">
        <div class="lin-crumbs"><span class="lin-crumb">Planner</span><span class="lin-crumb-sep" aria-hidden="true">›</span><h1>Planned</h1></div>
      </header>
      <div class="lin-content view-scroll">
        {groups.length === 0 && <p class="hint">No Linear issues in your plan yet. Plan one from an issue list or a project.</p>}
        <div class="lin-list">
          {groups.map((group) => (
            <section key={group.key} class="issue-group lin-group" aria-label={`Planned ${group.label}`}>
              <h3 class="lin-group-head"><span class="lin-group-name">{group.label}</span> <span class="count">{group.tasks.length}</span></h3>
              <ul class="lin-rows">{group.tasks.map((task) => <PlannedRow key={task.id} task={task} />)}</ul>
            </section>
          ))}
        </div>
      </div>
    </>
  );
};
