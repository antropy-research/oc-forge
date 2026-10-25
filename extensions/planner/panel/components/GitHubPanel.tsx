import type { Task } from '../../src/domain/types.ts';
import { addDays, monthDay } from '../../src/domain/dates.ts';
import { shortKey, type GitHubItem } from '../../src/domain/github.ts';
import { GITHUB_DRAG_TYPE, useGitHub, usePlanner, useView } from '../lib/context.ts';
import { useUi } from '../lib/ui.ts';
import type { GitHubListKind } from '../lib/github.ts';

const KINDS: { id: GitHubListKind; label: string }[] = [
  { id: 'assigned', label: 'Issues assigned to me' },
  { id: 'review', label: 'Review requests' },
  { id: 'mine', label: 'My open pull requests' },
];

const plannedLabel = (task: Task, today: string): string => {
  if (task.completedAt) return 'Done';
  if (task.placement.kind === 'backlog') return 'In backlog';
  if (task.placement.date === today) return 'Today';
  if (task.placement.date === addDays(today, 1)) return 'Tomorrow';
  return monthDay(task.placement.date);
};

const ItemRow = ({ item }: { item: GitHubItem }) => {
  const { github } = usePlanner();
  const view = useView();
  const { setUi } = useUi();
  const linked = Object.values(view.state.tasks).find((task) => task.source?.kind === 'github' && task.source.id === item.id && !task.deletedAt && !task.archivedAt);
  return (
    <li
      class="issue-row"
      draggable
      aria-label={`${item.key} ${item.title}`}
      onDragStart={(event) => {
        event.dataTransfer?.setData(GITHUB_DRAG_TYPE, JSON.stringify(item));
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copyMove';
      }}
    >
      <span class={`gh-kind is-${item.kind}`} aria-hidden="true">{item.kind === 'pull' ? '⇄' : '◯'}</span>
      <span class="issue-main">
        <span class="issue-title">{item.title}</span>
        <span class="issue-meta">
          <span class="issue-key">{shortKey(item.key)}</span>
          {item.draft && <span>Draft</span>}
          <span>{item.repo.split('/')[0]}</span>
        </span>
      </span>
      {linked ? (
        <button class="link issue-planned" onClick={() => setUi({ openTaskId: linked.id })} aria-label={`Open the task for ${item.key} (${plannedLabel(linked, view.today)})`}>{plannedLabel(linked, view.today)}</button>
      ) : (
        <span class="issue-actions">
          <button onClick={() => void github.plan(item, { kind: 'day', date: view.today })} aria-label={`Plan ${item.key} today`}>Today</button>
          <button onClick={() => void github.plan(item, { kind: 'day', date: addDays(view.today, 1) })} aria-label={`Plan ${item.key} tomorrow`}>Tmrw</button>
          <button onClick={() => void github.plan(item, { kind: 'backlog', bucket: 'next-weeks' })} aria-label={`Put ${item.key} in the backlog`}>Later</button>
        </span>
      )}
    </li>
  );
};

/** GitHub issues and pull requests to plan, through the machine's gh CLI. */
export const GitHubItems = () => {
  const { github } = usePlanner();
  const gv = useGitHub();
  if (!gv.status) return <p class="hint">Checking GitHub…</p>;
  if (!gv.status.available) {
    return (
      <div class="connect-linear" role="status">
        <p>{gv.status.message ?? 'GitHub is not available.'}</p>
        <p class="hint">Planner reads GitHub through the GitHub CLI of the machine running OpenChamber, read-only, the way Sunsama does.</p>
        <button onClick={() => void github.checkStatus()}>Check again</button>
      </div>
    );
  }
  return (
    <div class="linear-issues">
      <div class="linear-toolbar">
        <select aria-label="GitHub items to show" value={gv.kind} onChange={(event) => github.setKind(event.currentTarget.value as GitHubListKind)}>
          {KINDS.map((kind) => <option key={kind.id} value={kind.id}>{kind.label}</option>)}
        </select>
        <button class="icon-button" aria-label="Refresh GitHub" onClick={() => void github.refresh()}>↻</button>
      </div>
      {gv.error && <p class="feed-errors" role="alert">{gv.error}</p>}
      {gv.loading && gv.items.length === 0 && <p class="hint">Loading…</p>}
      {!gv.loading && gv.items.length === 0 && !gv.error && <p class="hint">Nothing here right now.</p>}
      <ul class="issue-list">{gv.items.map((item) => <ItemRow key={item.id} item={item} />)}</ul>
    </div>
  );
};

export const GitHubPage = () => {
  const gv = useGitHub();
  return (
    <section class="view">
      <header class="view-header">
        <h1>GitHub</h1>
        <span class="view-sub">{gv.status?.available ? `Signed in as ${gv.status.login ?? 'you'} (gh)` : 'Read-only, through the GitHub CLI'}</span>
      </header>
      <div class="view-scroll linear-page">
        <GitHubItems />
      </div>
    </section>
  );
};

/** The task detail's GitHub section. */
export const GitHubTaskSection = ({ task }: { task: Task }) => {
  const { client, host } = usePlanner();
  const source = task.source;
  if (source?.kind !== 'github') return null;
  return (
    <section class="detail-section" aria-label="GitHub">
      <h3>
        GitHub
        <span class="source-chip" style={{ '--item-color': source.status?.color ?? '#6e7781' }}><span class="dot" aria-hidden="true" />{source.key}</span>
        {source.status && <span class="count">{source.status.name}</span>}
      </h3>
      <div class="row">
        <button class="link" onClick={() => void host.openUrl(source.url)}>Open on GitHub</button>
        <button class="link danger" onClick={() => void client.dispatch([{ type: 'task.updated', taskId: task.id, patch: { source: null } }], { undo: 'Link removed' })}>Unlink</button>
      </div>
    </section>
  );
};
