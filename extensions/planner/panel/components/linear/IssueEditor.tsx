import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { commentThreads, historyText, issueDetailMore, parseLinearUrl, type IssueInput, type IssueText, type LinearComment, type LinearIssueDetail, type TeamOptions } from '../../../src/domain/linear/linear.ts';
import { messageOf } from '../../../src/domain/core/values.ts';
import { usePlanner, useLinear } from '../../lib/core/context.ts';
import { useUi } from '../../lib/core/ui.ts';
import { toggleTask } from '../../lib/core/markdown.ts';
import type { IssueRef } from '../../lib/linear/types.ts';
import { Markdown, MarkdownEditor } from '../common/Markdown.tsx';
import { when } from './common.tsx';
import { Avatar, PriorityIcon, StatusIcon } from './icons.tsx';
import { IssueProperties, type Field, type Pending } from './IssueProperties.tsx';

const textOf = (issue: LinearIssueDetail): IssueText => ({ title: issue.title, description: issue.description ?? '' });

const authorOf = (comment: LinearComment): string => comment.user?.name ?? comment.botActor?.name ?? 'Linear';

interface Draft extends IssueText {
  /** The text the edit started from, to tell a teammate's change from mine. */
  base: IssueText;
}

type Activity = { kind: 'event'; at: string; id: string; actor: string; text: string } | { kind: 'thread'; at: string; id: string; items: { comment: LinearComment; reply: boolean }[] };

/**
 * A Linear issue in the Planner, laid out as Linear lays it out: the title,
 * its Markdown description (read, tick checklist items, or edit with Write and
 * Preview), sub-issues, and the activity with comments; on the right, its
 * properties, each a searchable picker (S status, P priority, A assignee,
 * L labels, Shift D due date), links, and planning. J and K move to the next
 * and previous issue of the list it was opened from. Edits go to Linear in
 * the issue's own workspace; a linked task follows like any change from Linear.
 */
export const IssueEditor = ({ issueRef }: { issueRef: IssueRef }) => {
  const { linear, host, client } = usePlanner();
  const lv = useLinear();
  const { setUi } = useUi();
  const dialog = useRef<HTMLDivElement>(null);
  const [issue, setIssue] = useState<LinearIssueDetail | null>(null);
  const [options, setOptions] = useState<TeamOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [conflict, setConflict] = useState<LinearIssueDetail | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  /** Where to go once unsaved changes are discarded: null closes the issue. */
  const [leaving, setLeaving] = useState<{ to: IssueRef | null } | null>(null);
  const [picker, setPicker] = useState<Field | null>(null);
  const [pending, setPending] = useState<Pending>({});

  const dirty = Boolean((draft && (draft.title !== draft.base.title || draft.description !== draft.base.description)) || comment.trim());
  const ref: IssueRef = { id: issue?.id ?? issueRef.id, workspaceId: issue?.workspaceId ?? issueRef.workspaceId };
  const go = (to: IssueRef | null) => {
    if (dirty) setLeaving({ to });
    else setUi({ openIssue: to });
  };
  const previous = linear.neighbor(issueRef, -1);
  const next = linear.neighbor(issueRef, 1);
  const place = linear.position(issueRef);

  // Keys while the issue is open; a menu inside it handles its own.
  const keys = useRef({ go, previous, next, picker, setPicker, ready: false });
  keys.current = { go, previous, next, picker, setPicker, ready: Boolean(issue && options) };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.('.lin-popover')) return;
      const current = keys.current;
      if (event.key === 'Escape') {
        // Escape closes this issue only, not a task detail under it.
        event.stopPropagation();
        event.preventDefault();
        if (current.picker) current.setPicker(null);
        else current.go(null);
        return;
      }
      const typing = Boolean(target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable));
      // While a menu is open, letters are its search, never shortcuts.
      if (typing || current.picker || event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      const open = (field: Field) => {
        event.preventDefault();
        event.stopPropagation();
        if (current.ready) current.setPicker(field);
      };
      if (key === 'd' && event.shiftKey) return open('due');
      if (event.shiftKey) return;
      if (key === 's') return open('status');
      if (key === 'p') return open('priority');
      if (key === 'a') return open('assignee');
      if (key === 'l') return open('labels');
      if (key === 'j' || key === 'k') {
        event.preventDefault();
        event.stopPropagation();
        const to = key === 'j' ? current.next : current.previous;
        if (to) current.go(to);
      }
    };
    document.addEventListener('keydown', onKey, true);
    dialog.current?.focus();
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  useEffect(() => {
    let live = true;
    linear
      .issueDetail(issueRef)
      .then((found) => {
        if (!live) return;
        setIssue(found);
        linear
          .teamOptions(found.workspaceId!, found.team.id)
          .then((loaded) => live && setOptions(loaded))
          .catch((reason) => live && setOptionsError(messageOf(reason)));
      })
      .catch((reason) => live && setError(messageOf(reason)));
    return () => {
      live = false;
    };
  }, [linear, issueRef.id, issueRef.workspaceId]);

  // After a picker closes, keys go to the issue again.
  useEffect(() => {
    if (!picker) dialog.current?.focus({ preventScroll: true });
  }, [picker]);

  const workspace = issue && lv.workspaces.length > 1 ? linear.workspace(issue.workspaceId)?.name ?? null : null;

  /** Links to an issue of a connected workspace open here; anything else opens in the browser. */
  const onLink = (href: string) => {
    const target = parseLinearUrl(href);
    if (target && !dirty && lv.workspaces.some((item) => item.urlKey.toLowerCase() === target.urlKey)) {
      linear
        .issue(target.key, target.urlKey)
        .then((found) => (found ? setUi({ openIssue: { id: found.id, workspaceId: found.workspaceId ?? null } }) : host.openUrl(href)))
        .catch(() => void host.openUrl(href));
      return;
    }
    void host.openUrl(href);
  };

  /** Send a property change at once; it shows right away and settles with Linear's answer. */
  const update = (field: Field, input: IssueInput, shown: Pending) => {
    if (!issue) return;
    setPending((current) => ({ ...current, ...shown }));
    setBusy(field);
    linear
      .updateIssue(ref, input)
      .then((updated) => setIssue(updated))
      .catch((reason) => client.notify(`Couldn't update ${issue.identifier}: ${messageOf(reason)}`))
      .finally(() => {
        setBusy(null);
        setPending((current) => {
          const rest = { ...current };
          for (const key of Object.keys(shown)) delete rest[key as keyof Pending];
          return rest;
        });
      });
  };

  const save = (force = false) => {
    if (!issue || !draft || busy === 'text') return;
    const title = draft.title.replace(/\s+/g, ' ').trim();
    if (!title) return;
    setBusy('text');
    linear
      .saveIssueText(ref, draft.base, { title, description: draft.description }, force)
      .then((result) => {
        if ('conflict' in result) {
          setConflict(result.conflict);
          return;
        }
        setIssue(result.saved);
        setDraft(null);
        setConflict(null);
        setLeaving(null);
      })
      .catch((reason) => client.notify(`Couldn't save ${issue.identifier}: ${messageOf(reason)}`))
      .finally(() => setBusy(null));
  };

  /** Tick a checklist item in the shown description; it is saved at once, as in Linear. */
  const toggle = (index: number) => {
    if (!issue || draft || busy) return;
    const current = textOf(issue);
    const description = toggleTask(current.description, index);
    if (description === null) return;
    setBusy('text');
    linear
      .saveIssueText(ref, current, { ...current, description })
      .then((result) => {
        if ('conflict' in result) {
          setIssue(result.conflict);
          client.notify(`${issue.identifier} changed in Linear meanwhile; this is its new description.`);
        } else setIssue(result.saved);
      })
      .catch((reason) => client.notify(`Couldn't update ${issue.identifier}: ${messageOf(reason)}`))
      .finally(() => setBusy(null));
  };

  const postComment = () => {
    const body = comment.trim();
    if (!issue || !body || busy === 'comment') return;
    setBusy('comment');
    linear
      .addComment(ref, body)
      .then((posted) => {
        setIssue((current) => (current ? { ...current, comments: { nodes: [...current.comments.nodes, posted] } } : current));
        setComment('');
        setLeaving(null);
      })
      .catch((reason) => client.notify(`Couldn't comment on ${issue.identifier}: ${messageOf(reason)}`))
      .finally(() => setBusy(null));
  };

  const activity = useMemo((): Activity[] => {
    if (!issue) return [];
    const items: Activity[] = [];
    if (issue.createdAt) items.push({ kind: 'event', at: issue.createdAt, id: 'created', actor: issue.creator?.name ?? 'Someone', text: 'created the issue' });
    for (const entry of issue.history?.nodes ?? []) {
      const text = historyText(entry);
      if (text) items.push({ kind: 'event', at: entry.createdAt, id: entry.id, actor: entry.actor?.name ?? entry.botActor?.name ?? 'Linear', text });
    }
    const threads = commentThreads(issue.comments.nodes);
    let thread: { comment: LinearComment; reply: boolean }[] = [];
    for (const item of threads) {
      if (!item.reply && thread.length) {
        items.push({ kind: 'thread', at: thread[0]!.comment.createdAt, id: thread[0]!.comment.id, items: thread });
        thread = [];
      }
      thread.push(item);
    }
    if (thread.length) items.push({ kind: 'thread', at: thread[0]!.comment.createdAt, id: thread[0]!.comment.id, items: thread });
    return items.sort((a, b) => a.at.localeCompare(b.at));
  }, [issue]);

  return (
    <div class="modal-backdrop is-top" onMouseDown={(event) => event.target === event.currentTarget && go(null)}>
      <div class="modal issue-editor issue-view" role="dialog" aria-modal="true" aria-label={`Linear issue ${issue?.identifier ?? ''}`.trim()} tabIndex={-1} ref={dialog}>
        <header class="iv-bar">
          <nav class="iv-crumbs" aria-label="Issue">
            {issue ? (
              <>
                <span class="lin-crumb">{issue.team.name}</span>
                {workspace && <span class="ws-badge">{workspace}</span>}
                {issue.parent && (
                  <>
                    <span class="lin-crumb-sep" aria-hidden="true">›</span>
                    <button type="button" class="link lin-crumb" title={issue.parent.title} onClick={() => go({ id: issue.parent!.id, workspaceId: issue.workspaceId ?? null })}>{issue.parent.identifier}</button>
                  </>
                )}
                <span class="lin-crumb-sep" aria-hidden="true">›</span>
                <span class="source-chip iv-key" style={{ '--item-color': issue.state.color }}><span class="dot" aria-hidden="true" />{issue.identifier}</span>
              </>
            ) : (
              <span class="muted">Linear</span>
            )}
          </nav>
          <span class="grow" />
          {place && (
            <span class="iv-nav" role="group" aria-label="Issues in this list">
              <button type="button" class="lin-icon-button" disabled={!previous} aria-label="Previous issue" title="Previous issue (K)" onClick={() => previous && go(previous)}>↑</button>
              <button type="button" class="lin-icon-button" disabled={!next} aria-label="Next issue" title="Next issue (J)" onClick={() => next && go(next)}>↓</button>
              <span class="muted">{place.index + 1} / {place.total}</span>
            </span>
          )}
          {issue && <button type="button" class="lin-button" onClick={() => void host.openUrl(issue.url)}>Open in Linear ↗</button>}
          {issue && <button type="button" class="lin-icon-button" aria-label="Copy the issue's link" title="Copy link" onClick={() => void host.writeClipboard(issue.url).then(() => client.notify(`Copied the link to ${issue.identifier}`)).catch(() => {})}>⧉</button>}
          <button type="button" class="close" aria-label="Close" title="Close (Esc)" onClick={() => go(null)}>×</button>
        </header>
        {leaving && (
          <div class="banner" role="alertdialog" aria-label="Unsaved changes">
            <span>You have changes that are not saved.</span>
            <button class="link danger" onClick={() => setUi({ openIssue: leaving.to })}>Discard them</button>
            <button class="link" onClick={() => setLeaving(null)}>Keep editing</button>
          </div>
        )}
        {error && <p class="danger" role="alert">{error}</p>}
        {!issue && !error && <p class="hint">Loading the issue…</p>}
        {issue && (
          <div class="iv-body">
            <main class="iv-main">
              {draft ? (
                <input class="issue-title-input" aria-label="Issue title" value={draft.title} onInput={(event) => setDraft({ ...draft, title: event.currentTarget.value })} />
              ) : (
                <h2 class="issue-title-view" title="Click to edit" onClick={() => setDraft({ ...textOf(issue), base: textOf(issue) })}>{issue.title}</h2>
              )}
              <section class="issue-description" aria-label="Description">
                {draft ? (
                  <MarkdownEditor value={draft.description} onInput={(description) => setDraft({ ...draft, description })} label="Issue description" onLink={onLink} onSubmit={() => save()} rows={12} />
                ) : issue.description?.trim() ? (
                  <Markdown text={issue.description} onLink={onLink} onToggleTask={busy ? undefined : toggle} />
                ) : (
                  <p class="hint iv-placeholder" onClick={() => setDraft({ ...textOf(issue), base: textOf(issue) })}>Add a description…</p>
                )}
                {conflict && (
                  <div class="banner is-warning" role="alert">
                    <span>Someone changed this issue in Linear while you were editing.</span>
                    <button class="link" onClick={() => save(true)}>Replace it with mine</button>
                    <button
                      class="link"
                      onClick={() => {
                        setIssue(conflict);
                        setDraft(null);
                        setConflict(null);
                      }}
                    >
                      Discard mine
                    </button>
                  </div>
                )}
                <div class="row">
                  {draft ? (
                    <>
                      <button class="primary" disabled={busy === 'text' || !draft.title.trim()} onClick={() => save()}>{busy === 'text' ? 'Saving…' : 'Save'}</button>
                      <button class="link" onClick={() => { setDraft(null); setConflict(null); }}>Cancel</button>
                      <span class="hint">Markdown; Ctrl+Enter saves</span>
                    </>
                  ) : (
                    <button class="link" aria-label="Edit title and description" onClick={() => setDraft({ ...textOf(issue), base: textOf(issue) })}>Edit</button>
                  )}
                </div>
              </section>
              {issueDetailMore(issue).length > 0 && (
                <p class="hint iv-more" role="note">
                  Linear has more {issueDetailMore(issue).join(', ')} than shown here: <button class="link" onClick={() => void host.openUrl(issue.url)}>Open in Linear ↗</button>
                </p>
              )}
              {(issue.children?.nodes.length ?? 0) > 0 && (
                <section class="iv-section" aria-label="Sub-issues">
                  <h3>Sub-issues <span class="count">{issue.children!.nodes.filter((child) => child.state.type === 'completed').length}/{issue.children!.nodes.length}</span></h3>
                  <ul class="lin-rows iv-children">
                    {issue.children!.nodes.map((child) => (
                      <li key={child.id} class="lin-row" tabIndex={0} aria-label={`${child.identifier} ${child.title}`} onClick={() => go({ id: child.id, workspaceId: issue.workspaceId ?? null })} onKeyDown={(event) => event.key === 'Enter' && go({ id: child.id, workspaceId: issue.workspaceId ?? null })}>
                        <PriorityIcon priority={child.priority} />
                        <span class="lin-row-id">{child.identifier}</span>
                        <StatusIcon type={child.state.type} color={child.state.color} title={child.state.name} />
                        <span class="lin-row-title"><span class="lin-title-text">{child.title}</span></span>
                        <span class="lin-props"><Avatar name={child.assignee?.name} /></span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              <section class="iv-section issue-comments" aria-label="Activity">
                <h3>Activity</h3>
                <ol class="iv-activity">
                  {activity.map((item) =>
                    item.kind === 'event' ? (
                      <li key={item.id} class="iv-event">
                        <Avatar name={item.actor} size={16} />
                        <span><strong>{item.actor}</strong> {item.text}</span>
                        <span class="muted">· {when(item.at)}</span>
                      </li>
                    ) : (
                      <li key={item.id} class="iv-thread">
                        <ul class="comment-list">
                          {item.items.map(({ comment: entry, reply }) => (
                            <li key={entry.id} class={reply ? 'is-reply' : undefined}>
                              <div class="comment-meta">
                                <Avatar name={authorOf(entry)} size={18} />
                                <strong>{authorOf(entry)}</strong>
                                <span class="muted">{when(entry.createdAt)}{entry.editedAt ? ' · edited' : ''}</span>
                              </div>
                              <Markdown text={entry.body} onLink={onLink} />
                            </li>
                          ))}
                        </ul>
                      </li>
                    ),
                  )}
                </ol>
                <div class="iv-composer">
                  <MarkdownEditor value={comment} onInput={setComment} label="New comment" placeholder="Leave a comment… (Markdown)" onLink={onLink} onSubmit={postComment} rows={3} />
                  <div class="row">
                    <span class="grow" />
                    <button class="primary" disabled={!comment.trim() || busy === 'comment'} onClick={postComment}>{busy === 'comment' ? 'Posting…' : 'Comment'}</button>
                  </div>
                </div>
              </section>
            </main>
            <IssueProperties issue={issue} options={options} optionsError={optionsError} pending={pending} busy={busy} picker={picker} setPicker={setPicker} update={update} />
          </div>
        )}
      </div>
    </div>
  );
};
