import { useEffect, useState } from 'preact/hooks';
import type { GuestWorktree } from '@openchamber/sdk';
import type { Task, TaskRun } from '../../src/domain/types.ts';
import { timeAgo } from '../../src/domain/activity.ts';
import { RUN_STATUS_LABEL, isActive, needsYou, runStatus, runsFor, taskPrompt, taskRunStatus, type RunStatus } from '../../src/domain/runs.ts';
import { useAgents, usePlanner, useView } from '../lib/context.ts';
import { useUi } from '../lib/ui.ts';
import { branchFor, type WorkspaceChoice } from '../lib/agents.ts';

const SHORT_LABEL: Record<RunStatus, string> = {
  running: 'Agent working',
  question: 'Question',
  permission: 'Permission',
  review: 'Review',
  failed: 'Agent failed',
  changes: 'Changes asked',
  accepted: 'Accepted',
  idle: 'Agent',
  archived: 'Agent',
};

/** The agent state of a task on its card. */
export const AgentChip = ({ taskId }: { taskId: string }) => {
  const view = useView();
  const agents = useAgents();
  const status = taskRunStatus(view.state, taskId, agents.sessions);
  if (!status) return null;
  return (
    <span class={`agent-chip status-${status}`} title={RUN_STATUS_LABEL[status]}>
      <span class="agent-dot" aria-hidden="true" />
      {SHORT_LABEL[status]}
    </span>
  );
};

const RunRow = ({ run }: { run: TaskRun }) => {
  const { client, agents } = usePlanner();
  const view = useView();
  const av = useAgents();
  const live = av.sessions.get(run.sessionId);
  const status = runStatus(run, live);
  const project = agents.projectOf(run);
  const branch = live?.worktree?.branch ?? run.worktree?.branch;
  const task = view.state.tasks[run.taskId];
  const review = (verdict: 'accepted' | 'changes', complete = false) =>
    void client.dispatch([
      { type: 'run.reviewed', runId: run.id, verdict },
      ...(complete && task && !task.completedAt ? [{ type: 'task.completed' as const, taskId: run.taskId, on: view.today }] : []),
    ]);
  return (
    <li class={`run-row status-${status}`}>
      <div class="run-main">
        <span class={`agent-chip status-${status}`}><span class="agent-dot" aria-hidden="true" />{RUN_STATUS_LABEL[status]}</span>
        <span class="run-title">{live?.title || run.title}</span>
        <span class="muted">
          {project?.name ?? run.directory ?? 'project'}
          {branch ? ` · ${branch}` : ''} · started {timeAgo(run.startedAt)}
        </span>
      </div>
      <div class="run-actions">
        <button class="link" onClick={() => void agents.openSession(run.sessionId).catch((error) => client.notify(`Could not open the chat: ${error instanceof Error ? error.message : String(error)}`))}>Open chat</button>
        {(status === 'review' || status === 'changes' || status === 'failed' || status === 'idle') && (
          <>
            <button class="link" onClick={() => review('accepted', true)}>Accept and complete</button>
            <button class="link" onClick={() => review('accepted')}>Accept</button>
          </>
        )}
        {status === 'review' && <button class="link" onClick={() => review('changes')}>Needs changes</button>}
        <button class="link danger" onClick={() => void client.dispatch([{ type: 'run.removed', runId: run.id }])}>Unlink</button>
      </div>
    </li>
  );
};

const DispatchForm = ({ task, onDone }: { task: Task; onDone: () => void }) => {
  const { agents, client } = usePlanner();
  const view = useView();
  const av = useAgents();
  const [projectId, setProjectId] = useState(() => agents.defaultProject(view.state, task.id)?.id ?? '');
  const [workspaceKind, setWorkspaceKind] = useState<'project' | 'new' | string>('project');
  // Linear's own branch name links the pull request back to the issue.
  const linearBranch = task.source?.kind === 'linear' ? task.source.branch ?? null : null;
  const [branch, setBranch] = useState(() => linearBranch ?? branchFor(task.title, task.id));
  const [worktrees, setWorktrees] = useState<GuestWorktree[]>([]);
  const [prompt, setPrompt] = useState(() => taskPrompt(view.state, task.id));
  const [open, setOpen] = useState(false);
  const busy = av.dispatching.has(task.id);

  useEffect(() => {
    if (!projectId && av.projects[0]) setProjectId(agents.defaultProject(view.state, task.id)?.id ?? av.projects[0].id);
  }, [av.projects.length]);
  useEffect(() => {
    let live = true;
    setWorktrees([]);
    if (projectId) agents.worktrees(projectId).then((list) => live && setWorktrees(list)).catch(() => {});
    return () => {
      live = false;
    };
  }, [projectId]);

  if (av.available === false) return <p class="hint">OpenChamber did not allow the Planner to see projects. Approve its access in Settings → Extensions.</p>;
  if (av.projects.length === 0) return <p class="hint">Add a project in OpenChamber first; agents work inside a project.</p>;
  const active = runsFor(view.state, task.id).some((run) => isActive(runStatus(run, av.sessions.get(run.sessionId))));
  const workspace: WorkspaceChoice = workspaceKind === 'project' ? { kind: 'project' } : workspaceKind === 'new' ? { kind: 'new', branch } : { kind: 'existing', directory: workspaceKind };
  return (
    <div class="dispatch-form">
      {active && <p class="warning">An agent is already working on this task; a new one runs alongside it.</p>}
      <label class="field-row">
        <span>Project</span>
        <select aria-label="Agent project" value={projectId} onChange={(event) => setProjectId(event.currentTarget.value)}>
          {av.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
      </label>
      <label class="field-row">
        <span>Work in</span>
        <select aria-label="Agent workspace" value={workspaceKind} onChange={(event) => setWorkspaceKind(event.currentTarget.value)}>
          <option value="project">The project folder</option>
          <option value="new">A new worktree</option>
          {worktrees.map((worktree) => <option key={worktree.directory} value={worktree.directory}>Worktree {worktree.branch || worktree.name}</option>)}
        </select>
      </label>
      {workspaceKind === 'new' && (
        <label class="field-row">
          <span>Branch</span>
          <input aria-label="Worktree branch" value={branch} onInput={(event) => setBranch(event.currentTarget.value)} />
        </label>
      )}
      {workspaceKind === 'new' && linearBranch && branch === linearBranch && <p class="hint">Linear's branch name for {task.source!.key}, so a pull request from it links back to the issue.</p>}
      <textarea class="dispatch-prompt" rows={6} aria-label="Agent prompt" value={prompt} onInput={(event) => setPrompt(event.currentTarget.value)} />
      <div class="row">
        <label class="inline">
          <input type="checkbox" checked={open} onChange={(event) => setOpen(event.currentTarget.checked)} />
          Open the chat
        </label>
        <div class="nav-spacer" />
        <button class="link" onClick={onDone}>Cancel</button>
        <button
          class="primary"
          disabled={busy || !projectId || !prompt.trim()}
          onClick={() => {
            void agents.dispatch(task.id, { projectId, workspace, prompt, open }).then((started) => started && onDone());
          }}
        >
          {busy ? (workspaceKind === 'new' ? 'Making the worktree…' : 'Starting…') : 'Start agent'}
        </button>
      </div>
      {busy && <p class="hint">A new worktree can take a minute to set up.</p>}
    </div>
  );
};

/** The task detail's Agent section: its runs, and a way to start one. */
export const AgentSection = ({ task }: { task: Task }) => {
  const view = useView();
  const av = useAgents();
  const [form, setForm] = useState(false);
  const runs = runsFor(view.state, task.id).slice().reverse();
  const active = runs.some((run) => isActive(runStatus(run, av.sessions.get(run.sessionId))));
  return (
    <section class="detail-section" aria-label="Agent">
      <h3>Agent {runs.length > 0 && <span class="count">{runs.length} run{runs.length === 1 ? '' : 's'}</span>}</h3>
      {runs.length > 0 && <ul class="runs">{runs.map((run) => <RunRow key={run.id} run={run} />)}</ul>}
      {form ? (
        <DispatchForm task={task} onDone={() => setForm(false)} />
      ) : (
        <button class="link" onClick={() => setForm(true)}>{active ? 'Start another agent' : runs.length ? 'Start an agent again' : 'Send to an agent'}</button>
      )}
    </section>
  );
};

const GROUPS: { label: string; statuses: RunStatus[] }[] = [
  { label: 'Needs you', statuses: ['question', 'permission', 'failed'] },
  { label: 'Ready for review', statuses: ['review'] },
  { label: 'Working', statuses: ['running'] },
  { label: 'Changes requested', statuses: ['changes'] },
  { label: 'Idle', statuses: ['idle'] },
  { label: 'Done', statuses: ['accepted', 'archived'] },
];

/** Every agent run across tasks and projects, grouped by what it needs. */
export const AgentsView = () => {
  const view = useView();
  const av = useAgents();
  const { setUi } = useUi();
  const rows = Object.values(view.state.runs)
    .map((run) => ({ run, task: view.state.tasks[run.taskId], status: runStatus(run, av.sessions.get(run.sessionId)) }))
    .filter((row) => row.task && !row.task.deletedAt)
    .sort((a, b) => b.run.startedAt.localeCompare(a.run.startedAt));
  return (
    <section class="view">
      <header class="view-header">
        <h1>Agents</h1>
        <span class="view-sub">{rows.filter((row) => needsYou(row.status)).length} need you · {rows.filter((row) => row.status === 'running').length} working</span>
      </header>
      <div class="view-scroll agents-view">
        {rows.length === 0 && <p class="hint">Open a task and choose "Send to an agent". Its chat runs in OpenChamber; the Planner keeps track of it here.</p>}
        {GROUPS.map((group) => {
          const items = rows.filter((row) => group.statuses.includes(row.status));
          if (items.length === 0) return null;
          return (
            <section key={group.label} class="agent-group" aria-label={group.label}>
              <h2>{group.label} <span class="count">{items.length}</span></h2>
              <ul class="runs">
                {items.map(({ run, task }) => (
                  <li key={run.id} class="agent-task">
                    <button class="link agent-task-title" onClick={() => setUi({ openTaskId: task!.id })}>{task!.title}</button>
                    <ul class="runs"><RunRow run={run} /></ul>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </section>
  );
};
