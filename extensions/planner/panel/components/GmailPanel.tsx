// Gmail as Sunsama's integration has it (help.sunsama.com/docs/integrations/gmail): the panel's labels (one at a time,
// more with Cmd/Ctrl, an email must have every one shown) and filters (archived, spam and trash, already imported) with
// a search; an email task's thread, its conversation to browse and collapse, and the actions on it (Open in Gmail, S;
// Archive; Move to trash; Mark as unread); the question the import and completion automations ask ("Show prompt").
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Task } from '../../src/domain/types.ts';
import { clockLabel, monthDay, zonedDateMinutes } from '../../src/domain/dates.ts';
import { taskForMail, type MailItem } from '../../src/domain/google.ts';
import { GMAIL_ACTION_LABELS, emailUrl, gmailActionKey, gmailActionText, pickLabel, type GmailLabel } from '../../src/domain/gmail.ts';
import type { GmailAction } from '../../src/domain/types.ts';
import { GOOGLE_DRAG_TYPE, useGmail, useGoogle, usePlanner, useView } from '../lib/context.ts';
import { mailOf, threadKey } from '../lib/gmail.ts';
import type { GoogleDrag } from '../lib/google.ts';
import { useUi } from '../lib/ui.ts';
import { plannedLabel } from './GitHubPanel.tsx';
import { PlanActions } from './PlanActions.tsx';
import { ExternalLink } from './ExternalLink.tsx';

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const dragStart = (event: DragEvent, drag: GoogleDrag) => {
  event.dataTransfer?.setData(GOOGLE_DRAG_TYPE, JSON.stringify(drag));
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copyMove';
};

export const senderName = (from: string): string => /^\s*"?([^"<]+?)"?\s*</.exec(from)?.[1]?.trim() || from.replace(/[<>]/g, '').trim();

/** Gmail's own labels, for an account whose labels can't be read. */
const FALLBACK_LABELS: GmailLabel[] = ['Inbox', 'Starred', 'Important', 'Unread'].map((name) => ({ id: name.toUpperCase(), name, type: 'system' }));

const MailRow = ({ item }: { item: MailItem }) => {
  const { google, client } = usePlanner();
  const view = useView();
  const { setUi } = useUi();
  const linked = taskForMail(view.state, item);
  const zone = view.state.settings.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const when = item.date ? zonedDateMinutes(item.date, zone) : null;
  const mailClient = view.state.settings.emailClient;
  return (
    <li class={`issue-row mail-row${item.unread ? ' is-unread' : ''}`} draggable aria-label={item.subject} onDragStart={(event) => dragStart(event, { kind: 'mail', item })}>
      <span class="issue-main">
        <span class="issue-title">{item.subject}</span>
        <span class="issue-meta">
          <span>{senderName(item.from)}</span>
          {when && <span>{when.date === view.today ? clockLabel(when.minutes) : monthDay(when.date)}</span>}
          <ExternalLink className="link" href={emailUrl({ url: item.url, account: item.account }, mailClient)} label={`Open "${item.subject}" in ${mailClient === 'superhuman' ? 'Superhuman' : 'Gmail'}`}>Open</ExternalLink>
        </span>
        {item.snippet && <span class="item-snippet">{item.snippet}</span>}
      </span>
      {linked ? (
        <button class="link issue-planned" onClick={() => setUi({ openTaskId: linked.id })} aria-label={`Open the task for ${item.subject} (${plannedLabel(linked, view.today)})`}>{plannedLabel(linked, view.today)}</button>
      ) : (
        <PlanActions label={item.subject} onPlan={(placement) => void google.planMail(item, placement)} />
      )}
      {google.allows(item.account, 'tasks') && (
        <button
          class="link mail-to-tasks"
          aria-label={`Add "${item.subject}" to Google Tasks`}
          title="Add to Tasks, as Gmail does: a task in your default list, with the email's link in its details"
          onClick={() =>
            void google
              .addMailToTasks(item)
              .then(() => client.notify(`Added to Google Tasks: ${item.subject}`))
              .catch((error) => client.notify(`Google Tasks did not take it: ${messageOf(error)}`))
          }
        >
          Add to Tasks
        </button>
      )}
    </li>
  );
};

/** Gmail messages to turn into tasks, as Sunsama does with email: by label (Cmd/Ctrl adds one), filtered, searched. */
export const GmailItems = () => {
  const { google, gmail, client } = usePlanner();
  const gv = useGoogle();
  const mv = useGmail();
  const view = useView();
  const filter = mv.filter;
  const [words, setWords] = useState(filter.words);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const accounts = gv.status ? google.accountsWith('mail') : [];
  const account = gv.mailAccount;
  const labels = (account && mv.labels[account]) || FALLBACK_LABELS;
  useEffect(() => {
    if (account) void gmail.labels(account).catch(() => {});
  }, [account]);
  useEffect(() => {
    if (account && gv.mail.length === 0 && !gv.mailLoading && !gv.mailError) void google.searchMail(gmail.query());
  }, [account]);
  if (!gv.status) return <p class="hint">Checking Google…</p>;
  if (!accounts.length) return <p class="hint">Connect a Google account with Gmail in Settings → Google.</p>;
  // Sunsama's "Already imported" filter: an email planned (or done) is left out unless shown.
  const shown = filter.imported ? gv.mail : gv.mail.filter((item) => !taskForMail(view.state, item));
  const hidden = gv.mail.length - shown.length;
  const isShown = (name: string) => filter.labels.some((label) => label.toLowerCase() === name.toLowerCase());
  return (
    <div class="linear-issues gmail-items">
      <div class="linear-toolbar">
        {accounts.length > 1 && (
          <select aria-label="Gmail account" value={account ?? ''} onChange={(event) => google.setMailAccount(event.currentTarget.value)}>
            {accounts.map((item) => <option key={item.email} value={item.email}>{item.email}</option>)}
          </select>
        )}
        <span class="grow" />
        <span class="menu-anchor">
          <button class="icon-button" aria-label="Gmail filters" aria-haspopup="menu" aria-expanded={filtersOpen} title="Filter" onClick={() => setFiltersOpen((open) => !open)}>⚲</button>
          {filtersOpen && (
            <div class="menu gmail-filters" role="menu" aria-label="Show">
              <label><input type="checkbox" checked={filter.archived} onChange={(event) => gmail.setFilter({ archived: event.currentTarget.checked })} /> Archived</label>
              <label><input type="checkbox" checked={filter.spamTrash} onChange={(event) => gmail.setFilter({ spamTrash: event.currentTarget.checked })} /> Spam and Trash</label>
              <label><input type="checkbox" checked={filter.imported} onChange={(event) => gmail.setFilter({ imported: event.currentTarget.checked })} /> Already imported</label>
            </div>
          )}
        </span>
        <button class="icon-button" aria-label="Refresh Gmail" onClick={() => void google.searchMail(gmail.query())}>↻</button>
      </div>
      <div class="gmail-labels" role="group" aria-label="Gmail labels">
        {labels.map((label) => (
          <button
            key={label.id}
            class="gmail-label"
            aria-pressed={isShown(label.name)}
            title="Show this label; Cmd/Ctrl+click adds it to the ones shown"
            onClick={(event) => gmail.setFilter({ labels: pickLabel(filter.labels, label.name, event.metaKey || event.ctrlKey) })}
          >
            {label.name}
          </button>
        ))}
      </div>
      <input
        class="linear-search"
        type="search"
        aria-label="Search Gmail"
        placeholder="Search mail, as in Gmail (from:ann has:attachment)"
        value={words}
        onInput={(event) => setWords(event.currentTarget.value)}
        onKeyDown={(event) => event.key === 'Enter' && gmail.setFilter({ words: event.currentTarget.value })}
      />
      {gv.mailError && <p class="feed-errors" role="alert">{gv.mailError}</p>}
      {gv.mailError && account && /connect it again/i.test(gv.mailError) && (
        // Sunsama's "Re-add Gmail Account" in the panel, when Google stopped accepting the access (a password changed…).
        <button class="link gmail-readd" onClick={() => void google.allow(account, 'mail').catch((error) => client.notify(messageOf(error)))}>Re-add Gmail account</button>
      )}
      {gv.mailLoading && gv.mail.length === 0 && <p class="hint">Loading…</p>}
      {!gv.mailLoading && shown.length === 0 && !gv.mailError && <p class="hint">No messages here.</p>}
      <ul class="issue-list">{shown.map((item) => <MailRow key={item.id} item={item} />)}</ul>
      {hidden > 0 && (
        <p class="hint" role="status">
          {hidden} already imported, not shown · <button class="link" onClick={() => gmail.setFilter({ imported: true })}>Show them</button>
        </p>
      )}
      {gv.mailNext && (
        <button class="link load-more" disabled={gv.mailLoading} onClick={() => void google.searchMail(gv.mailQuery, true)}>
          {gv.mailLoading ? 'Loading…' : 'Load more messages'}
        </button>
      )}
    </div>
  );
};

const typing = (target: EventTarget | null) => target instanceof HTMLElement && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable);

/**
 * The task detail's Gmail section, as Sunsama embeds an email in its task: the thread's conversation (the latest open,
 * the others a click away), what Gmail has it in, and the actions on it, each done in Gmail.
 */
export const GmailTaskSection = ({ task }: { task: Task }) => {
  const { client, google, gmail } = usePlanner();
  const mv = useGmail();
  const gv = useGoogle();
  const view = useView();
  const mail = mailOf(task);
  const source = task.source!;
  const key = mail ? threadKey(mail.account, mail.thread) : '';
  const state = key ? mv.threads[key] : undefined;
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [allowing, setAllowing] = useState(false);
  const zone = view.state.settings.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const href = emailUrl(source, view.state.settings.emailClient);
  const where = view.state.settings.emailClient === 'superhuman' ? 'Superhuman' : 'Gmail';
  const openRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (mail && google.allows(mail.account, 'mail')) void gmail.loadThread(mail.account, mail.thread);
  }, [key, gv.status]);
  // S opens it in Gmail, as Sunsama's shortcut does.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 's' || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented || typing(event.target)) return;
      event.preventDefault();
      openRef.current?.click();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const unlink = () => void client.dispatch([{ type: 'task.updated', taskId: task.id, patch: { source: null } }], { undo: 'Link removed' });
  const thread = state?.thread ?? null;
  const labelIds = thread?.labelIds ?? [];
  const busy = key ? mv.busy[key] : undefined;
  const allowed = mail ? gmail.allowed(mail.account) : false;
  const act = (actions: GmailAction[], label: string) => mail && void gmail.act(mail.account, mail.thread, actions, label).then((done) => done && client.notify(`${label}: ${mail.subject}`));
  const latest = thread?.messages.at(-1);
  const isOpen = (id: string) => open.has(id) || (id === latest?.id && !open.has(`closed:${id}`));
  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (id === latest?.id) next.has(`closed:${id}`) ? next.delete(`closed:${id}`) : next.add(`closed:${id}`);
      else next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  return (
    <section class="detail-section gmail-section" aria-label="Gmail">
      <h3>
        Gmail
        {source.account && <span class="ws-badge">{source.account}</span>}
        {thread && (
          <span class="muted gmail-where" aria-label="In Gmail">
            {labelIds.includes('TRASH') ? 'In the trash' : labelIds.includes('INBOX') ? 'In the Inbox' : 'Archived'}
            {labelIds.includes('UNREAD') ? ' · Unread' : ''}
            {labelIds.includes('STARRED') ? ' · Starred' : ''}
          </span>
        )}
      </h3>
      <div class="row gmail-actions">
        <ExternalLink className="link" href={href} label={`Open in ${where}`}>
          <span ref={openRef}>Open in {where}</span>
        </ExternalLink>
        {mail && allowed && (
          <>
            <button class="link" disabled={Boolean(busy) || labelIds.includes('TRASH') || (thread !== null && !labelIds.includes('INBOX'))} onClick={() => act([{ kind: 'archive' }], 'Archived')}>Archive</button>
            <button class="link" disabled={Boolean(busy) || labelIds.includes('TRASH')} onClick={() => act([{ kind: 'trash' }], 'Moved to trash')}>Move to trash</button>
            <button class="link" disabled={Boolean(busy) || labelIds.includes('UNREAD')} onClick={() => act([{ kind: 'markUnread' }], 'Marked as unread')}>Mark as unread</button>
          </>
        )}
        <button class="link danger" onClick={unlink}>Unlink</button>
        {busy && <span class="muted">{busy}…</span>}
      </div>
      {mail && !allowed && (
        <p class="hint gmail-allow">
          To archive, trash or mark it from here, the Planner needs Gmail's permission to change email for {mail.account} (never to delete it outright).{' '}
          <button class="link" disabled={allowing} onClick={() => { setAllowing(true); void google.allow(mail.account, 'mailActions').catch((error) => client.notify(messageOf(error))).finally(() => setAllowing(false)); }}>
            Allow Gmail actions
          </button>
        </p>
      )}
      {state?.error && <p class="feed-errors" role="alert">{state.error}</p>}
      {state?.loading && !thread && <p class="hint">Reading the email…</p>}
      {thread && (
        <ol class="gmail-thread" aria-label="The conversation">
          {thread.messages.map((message) => {
            const when = message.date ? zonedDateMinutes(message.date, zone) : null;
            const expanded = isOpen(message.id);
            return (
              <li key={message.id} class={`gmail-message${expanded ? ' is-open' : ''}${message.unread ? ' is-unread' : ''}`}>
                <button class="gmail-message-head" aria-expanded={expanded} onClick={() => toggle(message.id)}>
                  <strong>{senderName(message.from)}</strong>
                  <span class="muted">{when ? `${monthDay(when.date)}, ${clockLabel(when.minutes)}` : ''}</span>
                  {!expanded && <span class="muted gmail-snippet">{message.snippet}</span>}
                </button>
                {expanded && <p class="pre gmail-text">{message.text || message.snippet}</p>}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
};

/** The automations' question ("Show prompt"): which actions to do to this email in Gmail, ticked as the settings say. */
export const GmailPromptBar = () => {
  const { gmail } = usePlanner();
  const mv = useGmail();
  const prompt = mv.prompt;
  const [picked, setPicked] = useState<GmailAction[]>([]);
  useEffect(() => setPicked(prompt?.actions ?? []), [prompt]);
  if (!prompt) return null;
  // Sunsama's actions on an email, and the labels the settings name.
  const choices: GmailAction[] = [
    ...(['markRead', 'archive', 'markUnread', 'star', 'unstar', 'trash'] as const).map((kind) => ({ kind })),
    ...prompt.actions.filter((action) => action.label),
  ];
  const has = (action: GmailAction) => picked.some((item) => gmailActionKey(item) === gmailActionKey(action));
  return (
    <div class="linear-prompt is-gmail" role="alertdialog" aria-label={`Gmail: ${prompt.subject}`}>
      <span>{prompt.when === 'import' ? 'Imported' : 'Completed'} <strong>{prompt.subject}</strong>: in Gmail,</span>
      {choices.map((action) => (
        <label key={gmailActionKey(action)} class="gmail-choice">
          <input type="checkbox" checked={has(action)} onChange={() => setPicked((current) => (has(action) ? current.filter((item) => gmailActionKey(item) !== gmailActionKey(action)) : [...current, action]))} />
          {action.label ? gmailActionText(action) : GMAIL_ACTION_LABELS[action.kind]}
        </label>
      ))}
      <button class="primary" disabled={!picked.length} onClick={() => gmail.answerPrompt(picked)}>Do it</button>
      <button class="link" onClick={() => gmail.answerPrompt(null)}>Not now</button>
    </div>
  );
};
