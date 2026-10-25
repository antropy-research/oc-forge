import { useEffect, useState } from 'preact/hooks';
import type { Task } from '../../src/domain/types.ts';
import { addDays, monthDay } from '../../src/domain/dates.ts';
import { isClosedType, linkedTask, type LinearIssue } from '../../src/domain/linear.ts';
import { LINEAR_DRAG_TYPE, usePlanner, useLinear, useView } from '../lib/context.ts';
import { useUi } from '../lib/ui.ts';
import type { LinearTeam } from '../lib/linear.ts';

const GROUPS: { type: string; label: string }[] = [
  { type: 'started', label: 'In progress' },
  { type: 'unstarted', label: 'Todo' },
  { type: 'backlog', label: 'Backlog' },
  { type: 'triage', label: 'Triage' },
];

const PRIORITY_MARK: Record<number, string> = { 1: '!!!', 2: '!!', 3: '!', 4: '·' };

const plannedLabel = (task: Task, today: string): string => {
  if (task.completedAt) return 'Done';
  if (task.placement.kind === 'backlog') return 'In backlog';
  if (task.placement.date === today) return 'Today';
  if (task.placement.date === addDays(today, 1)) return 'Tomorrow';
  return monthDay(task.placement.date);
};

export const ConnectLinear = () => {
  const { linear, client } = usePlanner();
  return (
    <div class="connect-linear">
      <p>Connect Linear to plan your issues here. Planner uses OpenChamber's own Linear connection; nothing is stored in the extension.</p>
      <button class="primary" onClick={() => void linear.connect().catch((error) => client.notify(`Could not start the Linear connection: ${error instanceof Error ? error.message : String(error)}`))}>Connect Linear</button>
    </div>
  );
};

const IssueRow = ({ issue }: { issue: LinearIssue }) => {
  const { linear } = usePlanner();
  const view = useView();
  const { setUi } = useUi();
  const linked = linkedTask(view.state, issue.id);
  return (
    <li
      class="issue-row"
      draggable
      onDragStart={(event) => {
        event.dataTransfer?.setData(LINEAR_DRAG_TYPE, JSON.stringify(issue));
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copyMove';
      }}
      aria-label={`${issue.identifier} ${issue.title}`}
    >
      <span class="issue-state" style={{ '--item-color': issue.state.color }} title={issue.state.name} aria-hidden="true" />
      <span class="issue-main">
        <span class="issue-title">{issue.title}</span>
        <span class="issue-meta">
          <span class="issue-key">{issue.identifier}</span>
          {PRIORITY_MARK[issue.priority] && <span class={`issue-priority p${issue.priority}`} title="Priority">{PRIORITY_MARK[issue.priority]}</span>}
          {issue.project && <span>{issue.project.name}</span>}
          {issue.cycle && <span>Cycle {issue.cycle.number}</span>}
          {issue.dueDate && <span class={issue.dueDate < view.today ? 'due is-overdue' : 'due'}>Due {monthDay(issue.dueDate)}</span>}
        </span>
      </span>
      {linked ? (
        <button class="link issue-planned" onClick={() => setUi({ openTaskId: linked.id })} title="Open the task" aria-label={`Open the task for ${issue.identifier} (${plannedLabel(linked, view.today)})`}>
          {plannedLabel(linked, view.today)}
        </button>
      ) : (
        <span class="issue-actions">
          <button onClick={() => void linear.plan(issue, { kind: 'day', date: view.today })} aria-label={`Plan ${issue.identifier} today`}>Today</button>
          <button onClick={() => void linear.plan(issue, { kind: 'day', date: addDays(view.today, 1) })} aria-label={`Plan ${issue.identifier} tomorrow`}>Tmrw</button>
          <button onClick={() => void linear.plan(issue, { kind: 'backlog', bucket: 'next-weeks' })} aria-label={`Put ${issue.identifier} in the backlog`}>Later</button>
        </span>
      )}
    </li>
  );
};

/** Sunsama's Linear panel: My issues or a custom view, grouped by state, ready to drag or plan. */
export const LinearIssues = () => {
  const { linear } = usePlanner();
  const lv = useLinear();
  const [term, setTerm] = useState('');
  if (lv.connected === false) return <ConnectLinear />;
  const sourceValue = lv.source.kind === 'view' ? `view:${lv.source.id}` : lv.source.kind;
  const visible = lv.issues.filter((issue) => !isClosedType(issue.state.type));
  const grouped = GROUPS.map((group) => ({ ...group, issues: visible.filter((issue) => issue.state.type === group.type) })).filter((group) => group.issues.length > 0);
  return (
    <div class="linear-issues">
      <div class="linear-toolbar">
        <select
          aria-label="Linear issues to show"
          value={sourceValue}
          onChange={(event) => {
            const value = event.currentTarget.value;
            linear.setSource(value.startsWith('view:') ? { kind: 'view', id: value.slice(5) } : { kind: 'assigned' });
          }}
        >
          <option value="assigned">My issues</option>
          {lv.source.kind === 'search' && <option value="search">Search results</option>}
          {lv.views.map((item) => <option key={item.id} value={`view:${item.id}`}>{item.name}</option>)}
        </select>
        <button class="icon-button" aria-label="Refresh Linear" title={lv.syncedAt ? `Synced ${new Date(lv.syncedAt).toLocaleTimeString()}` : 'Refresh'} onClick={() => void linear.refresh()}>↻</button>
      </div>
      <input
        class="linear-search"
        value={term}
        placeholder="Search Linear issues"
        aria-label="Search Linear issues"
        onInput={(event) => setTerm(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          const query = term.trim();
          linear.setSource(query ? { kind: 'search', term: query } : { kind: 'assigned' });
        }}
      />
      {lv.error && <p class="feed-errors" role="alert">{lv.error}</p>}
      {lv.loading && lv.issues.length === 0 && <p class="hint">Loading issues…</p>}
      {!lv.loading && visible.length === 0 && !lv.error && <p class="hint">No open issues here.</p>}
      {grouped.map((group) => (
        <section key={group.type} class="issue-group" aria-label={group.label}>
          <h3>{group.label} <span class="count">{group.issues.length}</span></h3>
          <ul class="issue-list">{group.issues.map((issue) => <IssueRow key={issue.id} issue={issue} />)}</ul>
        </section>
      ))}
    </div>
  );
};

/** Linear as a full page. */
export const LinearPage = () => {
  const lv = useLinear();
  return (
    <section class="view">
      <header class="view-header">
        <h1>Linear</h1>
        <span class="view-sub">{lv.connected ? (lv.account ? `Connected as ${lv.account}` : 'Connected') : lv.connected === false ? 'Not connected' : 'Checking the connection…'}</span>
      </header>
      <div class="view-scroll linear-page">
        <p class="hint">Plan an issue for today, tomorrow or later, or drag it onto a day or the calendar. Planned issues become tasks linked to Linear.</p>
        <LinearIssues />
      </div>
    </section>
  );
};

/** The question Sunsama asks after completing or planning a linked task. */
export const LinearPromptBar = () => {
  const { linear } = usePlanner();
  const lv = useLinear();
  const prompt = lv.prompt;
  useEffect(() => {
    if (!prompt) return;
    // An unanswered question goes away on its own; the task detail can still move the issue.
    const timer = setTimeout(() => linear.answerPrompt('no'), 20_000);
    return () => clearTimeout(timer);
  }, [prompt, linear]);
  if (!prompt) return null;
  const target = prompt.kind === 'complete' ? 'Done' : 'In Progress';
  return (
    <div class="linear-prompt" role="alertdialog" aria-label={`Update ${prompt.key} in Linear`}>
      <span>Move <strong>{prompt.key}</strong> to {target} in Linear?</span>
      <button class="primary" onClick={() => linear.answerPrompt('yes')}>Move</button>
      <button onClick={() => linear.answerPrompt('always')}>Always</button>
      <button class="link" onClick={() => linear.answerPrompt('no')}>Not now</button>
    </div>
  );
};

const CreateIssue = ({ task }: { task: Task }) => {
  const { linear, client } = usePlanner();
  const [teams, setTeams] = useState<LinearTeam[] | null>(null);
  const [teamId, setTeamId] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    linear
      .teams()
      .then((list) => {
        if (!live) return;
        setTeams(list);
        setTeamId(list[0]?.id ?? '');
      })
      .catch(() => live && setTeams([]));
    return () => {
      live = false;
    };
  }, [linear]);
  if (!teams) return <p class="hint">Loading teams…</p>;
  if (teams.length === 0) return <p class="hint">No Linear teams available.</p>;
  return (
    <div class="row">
      <select aria-label="Linear team" value={teamId} onChange={(event) => setTeamId(event.currentTarget.value)}>
        {teams.map((team) => <option key={team.id} value={team.id}>{team.key} · {team.name}</option>)}
      </select>
      <button
        class="link"
        disabled={busy || !teamId}
        onClick={() => {
          setBusy(true);
          linear
            .createIssue(task, teamId)
            .catch((error) => client.notify(`Could not create the issue: ${error instanceof Error ? error.message : String(error)}`))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? 'Creating…' : 'Create Linear issue'}
      </button>
    </div>
  );
};

/** The task detail's Linear section: the linked issue, or a way to create one. */
export const LinearTaskSection = ({ task }: { task: Task }) => {
  const { client, host, linear } = usePlanner();
  const lv = useLinear();
  const source = task.source;
  if (source?.kind === 'linear') {
    const live = lv.linked[source.id];
    const status = live ? { name: live.state.name, type: live.state.type, color: live.state.color } : source.status;
    const closed = isClosedType(status?.type);
    return (
      <section class="detail-section" aria-label="Linear">
        <h3>
          Linear
          <span class="source-chip" style={{ '--item-color': status?.color ?? '#5e6ad2' }}><span class="dot" aria-hidden="true" />{source.key}</span>
          {status && <span class="count">{status.name}</span>}
        </h3>
        <div class="row">
          <button class="link" onClick={() => void host.openUrl(source.url)}>Open in Linear</button>
          {!closed && lv.connected !== false && <button class="link" onClick={() => void linear.moveIssue(task, 'completed')}>Mark done in Linear</button>}
          {['backlog', 'unstarted', 'triage'].includes(status?.type ?? '') && lv.connected !== false && <button class="link" onClick={() => void linear.moveIssue(task, 'started')}>Start in Linear</button>}
          <button class="link danger" onClick={() => void client.dispatch([{ type: 'task.updated', taskId: task.id, patch: { source: null } }], { undo: 'Link removed' })}>Unlink</button>
        </div>
      </section>
    );
  }
  if (source) return null;
  return (
    <section class="detail-section" aria-label="Linear">
      <h3>Linear</h3>
      {lv.connected === false ? <button class="link" onClick={() => void linear.connect()}>Connect Linear to create an issue from this task</button> : <CreateIssue task={task} />}
    </section>
  );
};
