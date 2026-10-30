import { useEffect, useState } from 'preact/hooks';
import type { Task } from '../../src/domain/types.ts';
import { addDays, monthDay } from '../../src/domain/dates.ts';
import { shortKey, taskForGitHub, type GitHubItem } from '../../src/domain/github.ts';
import { GITHUB_DRAG_TYPE, useGitHub, usePlanner, useView } from '../lib/context.ts';
import { useUi } from '../lib/ui.ts';
import type { GitHubListKind } from '../lib/github.ts';
import { useDayTargets } from '../lib/dayTargets.ts';
import { PlanActions } from './PlanActions.tsx';
import { AssignButton } from './AssigneePicker.tsx';

const KINDS: { id: GitHubListKind; label: string }[] = [
  { id: 'assigned', label: 'Issues assigned to me' },
  { id: 'review', label: 'Review requests' },
  { id: 'mine', label: 'My open pull requests' },
];

export const plannedLabel = (task: Task, today: string): string => {
  if (task.completedAt) return 'Done';
  if (task.placement.kind === 'backlog') return 'In backlog';
  if (task.placement.date === today) return 'Today';
  if (task.placement.date === addDays(today, 1)) return 'Tomorrow';
  return monthDay(task.placement.date);
};

const ItemRow = ({ item }: { item: GitHubItem }) => {
  const { github, client } = usePlanner();
  const view = useView();
  const { setUi } = useUi();
  const targets = useDayTargets();
  const linked = taskForGitHub(view.state, item);
  /** Plan the issue on the first day shown: the task its assignee works on. */
  const assign = async () => {
    const { bodies, taskId } = github.importCommands(item, { kind: 'day', date: targets.primary });
    await client.dispatch(bodies, { undo: `Planned ${item.key}` });
    return taskId;
  };
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
        <PlanActions label={item.key} onPlan={(placement) => void github.plan(item, placement)}>
          {item.kind === 'issue' && <AssignButton taskId={null} prepare={assign} label={`Assign ${item.key} to an agent`}>Agent</AssignButton>}
        </PlanActions>
      )}
    </li>
  );
};

/** What to do when gh is missing or signed out: where to run `gh auth login`, to copy. */
export const GitHubSignIn = () => {
  const { github, host, client } = usePlanner();
  const gv = useGitHub();
  const status = gv.status!;
  const command = status.container ? `docker exec -it ${status.container} gh auth login` : 'gh auth login';
  const title = status.reason === 'missing' ? 'Install the GitHub CLI' : status.reason === 'signed-out' ? 'Sign in to GitHub' : 'GitHub is out of reach';
  return (
    <div class="connect-linear gh-signin" role="status" aria-label="GitHub sign-in">
      <p><strong>{title}</strong></p>
      <p>{status.message ?? 'GitHub is not available.'}</p>
      {status.reason && (
        <ol>
          {status.reason === 'missing' && <li>Install <code>gh</code> where OpenChamber runs (cli.github.com).</li>}
          <li>
            {status.container ? 'OpenChamber runs in a container; on its host, run ' : 'Where OpenChamber runs, run '}
            <code>{command}</code>{' '}
            <button class="link" onClick={() => void host.writeClipboard(command).then(() => client.notify('Copied')).catch(() => client.notify('Could not copy'))}>Copy</button>
          </li>
          <li>Then check again here.</li>
        </ol>
      )}
      <p class="hint">The Planner reads GitHub through that GitHub CLI, read-only, the way Sunsama does; assigned agents open their pull requests with it too.</p>
      <button onClick={() => void github.checkStatus()}>Check again</button>
    </div>
  );
};

/** GitHub's search returns at most this many results of one search (service/github.ts `SEARCH_MAX`). */
const SEARCH_MAX = 1000;

/**
 * GitHub issues and pull requests to plan, through the machine's gh CLI: a page at a time, every match reachable
 * (Load more, and words to narrow the list); Refresh reads again as many as are shown.
 */
export const GitHubItems = () => {
  const { github } = usePlanner();
  const gv = useGitHub();
  const [text, setText] = useState(gv.text);
  // The list follows the words once typing stops.
  useEffect(() => {
    const timer = setTimeout(() => github.setText(text), 400);
    return () => clearTimeout(timer);
  }, [text]);
  if (!gv.status) return <p class="hint">Checking GitHub…</p>;
  if (!gv.status.available) return <GitHubSignIn />;
  const kindLabel = KINDS.find((kind) => kind.id === gv.kind)?.label ?? 'GitHub';
  return (
    <div class="linear-issues">
      <div class="linear-toolbar">
        <select aria-label="GitHub items to show" value={gv.kind} onChange={(event) => github.setKind(event.currentTarget.value as GitHubListKind)}>
          {KINDS.map((kind) => <option key={kind.id} value={kind.id}>{kind.label}</option>)}
        </select>
        <button class="icon-button" aria-label="Refresh GitHub" title="Refresh: reads again as many as are shown" onClick={() => void github.refresh()}>↻</button>
      </div>
      <input
        class="gh-search"
        type="search"
        aria-label="Search GitHub items"
        placeholder="Search: words, repo:owner/name, label:bug"
        value={text}
        onInput={(event) => setText(event.currentTarget.value)}
        onKeyDown={(event) => event.key === 'Enter' && github.setText(event.currentTarget.value)}
      />
      {gv.error && <p class="feed-errors" role="alert">{gv.error}</p>}
      {gv.loading && gv.items.length === 0 && <p class="hint">Loading…</p>}
      {!gv.loading && gv.items.length === 0 && !gv.error && <p class="hint">{gv.text.trim() ? 'Nothing matches.' : 'Nothing here right now.'}</p>}
      <ul class="issue-list" aria-label={kindLabel}>{gv.items.map((item) => <ItemRow key={item.id} item={item} />)}</ul>
      {gv.items.length > 0 && (
        <div class="gh-more" role="status" aria-label="GitHub items shown">
          <span class="hint">{gv.next ? `Showing ${gv.items.length} of ${gv.total}` : `All ${gv.items.length} shown`}</span>
          {gv.next && (
            <button class="link" disabled={gv.loadingMore} onClick={() => void github.loadMore()}>
              {gv.loadingMore ? 'Loading…' : 'Load more'}
            </button>
          )}
          {gv.total > SEARCH_MAX && <p class="hint">GitHub's search gives the first {SEARCH_MAX.toLocaleString('en-US')} of {gv.total.toLocaleString('en-US')}: narrow it with words or repo:owner/name.</p>}
        </div>
      )}
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
