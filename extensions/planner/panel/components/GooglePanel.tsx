import { useEffect, useState } from 'preact/hooks';
import type { Task } from '../../src/domain/types.ts';
import { addDays, clockLabel, monthDay, zonedDateMinutes } from '../../src/domain/dates.ts';
import { taskForGoogleTask, taskForMail, type GoogleTaskItem, type MailItem } from '../../src/domain/google.ts';
import { GOOGLE_DRAG_TYPE, useGoogle, usePlanner, useView } from '../lib/context.ts';
import { useUi } from '../lib/ui.ts';
import { MAIL_SEARCHES, type GoogleDrag } from '../lib/google.ts';
import { plannedLabel } from './GitHubPanel.tsx';
import { PlanActions } from './PlanActions.tsx';
import { TasksView } from './TasksView.tsx';

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const dragStart = (event: DragEvent, drag: GoogleDrag) => {
  event.dataTransfer?.setData(GOOGLE_DRAG_TYPE, JSON.stringify(drag));
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copyMove';
};

const NotConnected = ({ what }: { what: string }) => <p class="hint">Connect a Google account with {what} in Settings → Google.</p>;

const dueLabel = (due: string | null, today: string): string | null => {
  if (!due) return null;
  if (due < today) return `Overdue, ${monthDay(due)}`;
  if (due === today) return 'Due today';
  if (due === addDays(today, 1)) return 'Due tomorrow';
  return `Due ${monthDay(due)}`;
};

const TaskRow = ({ item }: { item: GoogleTaskItem }) => {
  const { google } = usePlanner();
  const view = useView();
  const { setUi } = useUi();
  const linked = taskForGoogleTask(view.state, item);
  const due = dueLabel(item.due, view.today);
  return (
    <li class={`issue-row${item.parent ? ' is-subtask' : ''}`} draggable aria-label={item.title} onDragStart={(event) => dragStart(event, { kind: 'gtask', item })}>
      <span class="gtask-mark" aria-hidden="true">○</span>
      <span class="issue-main">
        <span class="issue-title">{item.title}</span>
        {(due || item.notes) && (
          <span class="issue-meta">
            {due && <span class={item.due && item.due < view.today ? 'danger' : undefined}>{due}</span>}
            {item.notes && <span class="item-snippet">{item.notes.split('\n')[0]}</span>}
          </span>
        )}
      </span>
      {linked ? (
        <button class="link issue-planned" onClick={() => setUi({ openTaskId: linked.id })} aria-label={`Open the task for ${item.title} (${plannedLabel(linked, view.today)})`}>{plannedLabel(linked, view.today)}</button>
      ) : (
        <PlanActions label={item.title} onPlan={(placement) => void google.planTask(item, placement)}>
          {item.due && item.due > addDays(view.today, 1) && <button onClick={() => void google.planTask(item, { kind: 'day', date: item.due! })} aria-label={`Plan ${item.title} on its due date`}>{monthDay(item.due)}</button>}
        </PlanActions>
      )}
    </li>
  );
};

/** Google Tasks to plan: a list's open tasks, as in Sunsama's Google Tasks panel. */
export const GoogleTasksItems = () => {
  const { google } = usePlanner();
  const gv = useGoogle();
  if (!gv.status) return <p class="hint">Checking Google…</p>;
  if (!google.accountsWith('tasks').length) return <NotConnected what="Tasks" />;
  const several = new Set(gv.lists.map((list) => list.account)).size > 1;
  const selected = gv.lists.findIndex((list) => list.account === gv.list?.account && list.id === gv.list?.id);
  return (
    <div class="linear-issues">
      <div class="linear-toolbar">
        <select aria-label="Google task list" value={String(selected)} onChange={(event) => { const list = gv.lists[Number(event.currentTarget.value)]; if (list) google.selectList(list.account, list.id); }}>
          {gv.lists.map((list, index) => <option key={`${list.account}:${list.id}`} value={String(index)}>{several ? `${list.title} · ${list.account}` : list.title}</option>)}
        </select>
        <button class="icon-button" aria-label="Refresh Google Tasks" onClick={() => void google.loadLists()}>↻</button>
      </div>
      {gv.tasksError && <p class="feed-errors" role="alert">{gv.tasksError}</p>}
      {gv.tasksLoading && gv.tasks.length === 0 && <p class="hint">Loading…</p>}
      {!gv.tasksLoading && gv.list && gv.tasks.length === 0 && !gv.tasksError && <p class="hint">No open tasks in this list.</p>}
      <ul class="issue-list">{gv.tasks.map((item) => <TaskRow key={item.id} item={item} />)}</ul>
    </div>
  );
};

const senderName = (from: string): string => /^\s*"?([^"<]+?)"?\s*</.exec(from)?.[1]?.trim() || from.replace(/[<>]/g, '').trim();

const MailRow = ({ item }: { item: MailItem }) => {
  const { google, host } = usePlanner();
  const view = useView();
  const { setUi } = useUi();
  const linked = taskForMail(view.state, item);
  const zone = view.state.settings.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const when = item.date ? zonedDateMinutes(item.date, zone) : null;
  return (
    <li class={`issue-row mail-row${item.unread ? ' is-unread' : ''}`} draggable aria-label={item.subject} onDragStart={(event) => dragStart(event, { kind: 'mail', item })}>
      <span class="issue-main">
        <span class="issue-title">{item.subject}</span>
        <span class="issue-meta">
          <span>{senderName(item.from)}</span>
          {when && <span>{when.date === view.today ? clockLabel(when.minutes) : monthDay(when.date)}</span>}
          <button class="link" onClick={() => void host.openUrl(item.url)} aria-label={`Open "${item.subject}" in Gmail`}>Open</button>
        </span>
        {item.snippet && <span class="item-snippet">{item.snippet}</span>}
      </span>
      {linked ? (
        <button class="link issue-planned" onClick={() => setUi({ openTaskId: linked.id })} aria-label={`Open the task for ${item.subject} (${plannedLabel(linked, view.today)})`}>{plannedLabel(linked, view.today)}</button>
      ) : (
        <PlanActions label={item.subject} onPlan={(placement) => void google.planMail(item, placement)} />
      )}
    </li>
  );
};

/** Gmail messages to turn into tasks, as Sunsama does with email. */
export const GmailItems = () => {
  const { google } = usePlanner();
  const gv = useGoogle();
  const [term, setTerm] = useState('');
  const accounts = gv.status ? google.accountsWith('mail') : [];
  useEffect(() => {
    if (gv.mailAccount && gv.mail.length === 0 && !gv.mailLoading && !gv.mailError) void google.searchMail();
  }, [gv.mailAccount]);
  if (!gv.status) return <p class="hint">Checking Google…</p>;
  if (!accounts.length) return <NotConnected what="Gmail" />;
  const preset = MAIL_SEARCHES.find((item) => item.query === gv.mailQuery);
  return (
    <div class="linear-issues">
      <div class="linear-toolbar">
        {accounts.length > 1 && (
          <select aria-label="Gmail account" value={gv.mailAccount ?? ''} onChange={(event) => google.setMailAccount(event.currentTarget.value)}>
            {accounts.map((account) => <option key={account.email} value={account.email}>{account.email}</option>)}
          </select>
        )}
        <select aria-label="Messages to show" value={preset ? preset.query : ''} onChange={(event) => { setTerm(''); void google.searchMail(event.currentTarget.value); }}>
          {MAIL_SEARCHES.map((item) => <option key={item.query} value={item.query}>{item.label}</option>)}
          {!preset && <option value="">Search results</option>}
        </select>
        <button class="icon-button" aria-label="Refresh Gmail" onClick={() => void google.searchMail()}>↻</button>
      </div>
      <input
        class="linear-search"
        type="search"
        aria-label="Search Gmail"
        placeholder="Search mail, as in Gmail (from:ann has:attachment)"
        value={term}
        onInput={(event) => setTerm(event.currentTarget.value)}
        onKeyDown={(event) => event.key === 'Enter' && term.trim() && void google.searchMail(term.trim())}
      />
      {gv.mailError && <p class="feed-errors" role="alert">{gv.mailError}</p>}
      {gv.mailLoading && gv.mail.length === 0 && <p class="hint">Loading…</p>}
      {!gv.mailLoading && gv.mail.length === 0 && !gv.mailError && <p class="hint">No messages here.</p>}
      <ul class="issue-list">{gv.mail.map((item) => <MailRow key={item.id} item={item} />)}</ul>
      {gv.mailNext && (
        <button class="link load-more" disabled={gv.mailLoading} onClick={() => void google.searchMail(gv.mailQuery, true)}>
          {gv.mailLoading ? 'Loading…' : 'Load more messages'}
        </button>
      )}
    </div>
  );
};

export const GooglePage = () => {
  const { google } = usePlanner();
  const gv = useGoogle();
  const [tab, setTab] = useState<'tasks' | 'mail'>('tasks');
  const accounts = gv.status?.accounts ?? [];
  const tabs = (
    <div class="tabs linear-modes" role="tablist" aria-label="Google">
      <button role="tab" aria-selected={tab === 'tasks'} onClick={() => setTab('tasks')}>Google Tasks</button>
      <button role="tab" aria-selected={tab === 'mail'} onClick={() => { setTab('mail'); if (google.accountsWith('mail').length && !gv.mail.length) void google.searchMail(); }}>Gmail</button>
    </div>
  );
  return (
    <section class="view">
      <header class="view-header">
        <h1>Google</h1>
        <span class="view-sub">{accounts.length ? accounts.map((account) => account.email).join(', ') : 'Connect an account in Settings → Google'}</span>
      </header>
      {tab === 'tasks' ? (
        <>
          {tabs}
          <TasksView />
        </>
      ) : (
        <div class="view-scroll linear-page">
          {tabs}
          <GmailItems />
        </div>
      )}
    </section>
  );
};

const AddToGoogleTasks = ({ task }: { task: Task }) => {
  const { google, client } = usePlanner();
  const gv = useGoogle();
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const several = new Set(gv.lists.map((list) => list.account)).size > 1;
  const list = gv.lists[index] ?? gv.lists[0];
  return (
    <section class="detail-section" aria-label="Google Tasks">
      <h3>Google Tasks</h3>
      <div class="row">
        <select aria-label="Google task list for this task" value={String(index)} onChange={(event) => setIndex(Number(event.currentTarget.value))}>
          {gv.lists.map((item, at) => <option key={`${item.account}:${item.id}`} value={String(at)}>{several ? `${item.title} · ${item.account}` : item.title}</option>)}
        </select>
        <button
          class="link"
          disabled={busy || !list}
          onClick={() => {
            if (!list) return;
            setBusy(true);
            google
              .createTask(task, list.account, list.id)
              .catch((error) => client.notify(`Could not add it to Google Tasks: ${messageOf(error)}`))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? 'Adding…' : 'Add to Google Tasks'}
        </button>
      </div>
      <p class="hint">Google Calendar then shows it on its day, and completing it here completes it there.</p>
    </section>
  );
};

/** The task detail's Google section: the linked Google task or message, or a way to add the task to Google Tasks. */
export const GoogleTaskSection = ({ task }: { task: Task }) => {
  const { client, host, google } = usePlanner();
  const gv = useGoogle();
  const source = task.source;
  const unlink = () => void client.dispatch([{ type: 'task.updated', taskId: task.id, patch: { source: null } }], { undo: 'Link removed' });
  if (source?.kind === 'gtask') {
    const done = source.status?.type === 'completed';
    return (
      <section class="detail-section" aria-label="Google Tasks">
        <h3>
          Google Tasks
          <span class="source-chip" style={{ '--item-color': source.status?.color ?? '#1a73e8' }}><span class="dot" aria-hidden="true" />{source.status?.name ?? 'Open'}</span>
          {source.account && <span class="ws-badge">{source.account}</span>}
        </h3>
        <div class="row">
          <button class="link" onClick={() => void host.openUrl(source.url)}>Open in Google Tasks</button>
          {done ? <button class="link" onClick={() => void google.writeTask(task, { completed: false })}>Reopen in Google Tasks</button> : <button class="link" onClick={() => void google.writeTask(task, { completed: true })}>Complete in Google Tasks</button>}
          <button class="link danger" onClick={unlink}>Unlink</button>
        </div>
      </section>
    );
  }
  if (source?.kind === 'email') {
    return (
      <section class="detail-section" aria-label="Gmail">
        <h3>
          Gmail
          {source.account && <span class="ws-badge">{source.account}</span>}
        </h3>
        <div class="row">
          <button class="link" onClick={() => void host.openUrl(source.url)}>Open in Gmail</button>
          <button class="link danger" onClick={unlink}>Unlink</button>
        </div>
      </section>
    );
  }
  if (source || !gv.lists.length || task.completedAt) return null;
  return <AddToGoogleTasks task={task} />;
};

/** The question after completing a task linked to a Google task, when the settings say to ask. */
export const GooglePromptBar = () => {
  const { google } = usePlanner();
  const gv = useGoogle();
  const prompt = gv.prompt;
  useEffect(() => {
    if (!prompt) return;
    const timer = setTimeout(() => google.answerPrompt('no'), 20_000);
    return () => clearTimeout(timer);
  }, [prompt, google]);
  if (!prompt) return null;
  return (
    <div class="linear-prompt is-google" role="alertdialog" aria-label="Complete in Google Tasks">
      <span>Complete <strong>{prompt.title}</strong> in Google Tasks too?</span>
      <button class="primary" onClick={() => google.answerPrompt('yes')}>Complete</button>
      <button onClick={() => google.answerPrompt('always')}>Always</button>
      <button class="link" onClick={() => google.answerPrompt('no')}>Not now</button>
    </div>
  );
};
