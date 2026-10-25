import { useEffect, useRef, useState } from 'preact/hooks';
import { addDays, isDateKey } from '../../src/domain/dates.ts';
import {
  PRIORITY_LABELS,
  commentThreads,
  githubMirrors,
  linkedTask,
  parseLinearUrl,
  type IssueInput,
  type IssueText,
  type LinearComment,
  type LinearIssueDetail,
  type TeamOptions,
} from '../../src/domain/linear.ts';
import { usePlanner, useLinear, useView } from '../lib/context.ts';
import { useUi } from '../lib/ui.ts';
import { toggleTask } from '../lib/markdown.ts';
import type { IssueRef } from '../lib/linear.ts';
import { Markdown, MarkdownEditor } from './Markdown.tsx';

const PRIORITY_CHOICES = [0, 1, 2, 3, 4];

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const textOf = (issue: LinearIssueDetail): IssueText => ({ title: issue.title, description: issue.description ?? '' });

const when = (instant: string): string => new Date(instant).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

const authorOf = (comment: LinearComment): string => comment.user?.name ?? comment.botActor?.name ?? 'Linear';

/** Plan the issue from the editor, or open the task that already plans it. */
const PlanActions = ({ issue }: { issue: LinearIssueDetail }) => {
  const { linear } = usePlanner();
  const view = useView();
  const { setUi } = useUi();
  const task = linkedTask(view.state, issue.id, githubMirrors(issue));
  if (task && !task.completedAt) return <button class="link" onClick={() => setUi({ openIssue: null, openTaskId: task.id })}>Open the task</button>;
  return (
    <span class="issue-actions is-visible">
      <button onClick={() => void linear.plan(issue, { kind: 'day', date: view.today })} aria-label={`Plan ${issue.identifier} today`}>Today</button>
      <button onClick={() => void linear.plan(issue, { kind: 'day', date: addDays(view.today, 1) })} aria-label={`Plan ${issue.identifier} tomorrow`}>Tmrw</button>
      <button onClick={() => void linear.plan(issue, { kind: 'backlog', bucket: 'next-weeks' })} aria-label={`Put ${issue.identifier} in the backlog`}>Later</button>
    </span>
  );
};

/**
 * Status, priority, assignee, due date and labels. Each change goes to Linear at
 * once; the field shows the new value while it is on its way.
 */
const IssueFields = ({ issue, options, busy, update }: { issue: LinearIssueDetail; options: TeamOptions | null; busy: string | null; update: (field: string, input: IssueInput) => Promise<void> }) => {
  const { linear } = usePlanner();
  const [pending, setPending] = useState<Record<string, string>>({});
  const picker = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    // The label list floats over the issue; a click anywhere else closes it.
    const onDown = (event: MouseEvent) => {
      const element = picker.current;
      if (element?.open && !element.contains(event.target as Node)) element.open = false;
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);
  const me = linear.viewerId(issue.workspaceId ?? null);
  const states = options?.states.length ? options.states : [issue.state];
  const members = options?.members ?? [];
  const assignees = issue.assignee && !members.some((member) => member.id === issue.assignee!.id) ? [{ id: issue.assignee.id, name: issue.assignee.name }, ...members] : members;
  const labelIds = new Set(issue.labels.nodes.map((label) => label.id));
  const shown = (field: string, actual: string): string => pending[field] ?? actual;
  const change = (field: string, value: string, input: IssueInput) => {
    setPending((current) => ({ ...current, [field]: value }));
    void update(field, input).finally(() =>
      setPending((current) => {
        const next = { ...current };
        delete next[field];
        return next;
      }),
    );
  };
  return (
    <div class="detail-fields">
      <label class="field">
        <span>Status</span>
        <select aria-label="Status" value={shown('state', issue.state.id)} disabled={busy === 'state'} onChange={(event) => change('state', event.currentTarget.value, { stateId: event.currentTarget.value })}>
          {states.map((state) => <option key={state.id} value={state.id}>{state.name}</option>)}
        </select>
      </label>
      <label class="field">
        <span>Priority</span>
        <select aria-label="Issue priority" value={shown('priority', String(issue.priority))} disabled={busy === 'priority'} onChange={(event) => change('priority', event.currentTarget.value, { priority: Number(event.currentTarget.value) })}>
          {PRIORITY_CHOICES.map((priority) => <option key={priority} value={String(priority)}>{PRIORITY_LABELS[priority]}</option>)}
        </select>
      </label>
      <label class="field">
        <span>Assignee</span>
        <select aria-label="Assignee" value={shown('assignee', issue.assignee?.id ?? '')} disabled={busy === 'assignee' || !options} onChange={(event) => change('assignee', event.currentTarget.value, { assigneeId: event.currentTarget.value || null })}>
          <option value="">Unassigned</option>
          {assignees.map((member) => <option key={member.id} value={member.id}>{member.name}{member.id === me ? ' (me)' : ''}</option>)}
        </select>
      </label>
      <label class="field">
        <span>Due</span>
        <input
          type="date"
          aria-label="Issue due date"
          value={shown('due', issue.dueDate ?? '')}
          disabled={busy === 'due'}
          onChange={(event) => change('due', event.currentTarget.value, { dueDate: isDateKey(event.currentTarget.value) ? event.currentTarget.value : null })}
        />
      </label>
      <div class="field">
        <span>Labels</span>
        <details class="label-picker" ref={picker}>
          <summary aria-label="Edit labels">{issue.labels.nodes.length ? issue.labels.nodes.map((label) => label.name).join(', ') : 'None'}</summary>
          <ul role="group" aria-label="Labels">
            {(options?.labels ?? issue.labels.nodes).map((label) => (
              <li key={label.id}>
                <label class="inline">
                  <input
                    type="checkbox"
                    checked={pending[`label:${label.id}`] !== undefined ? pending[`label:${label.id}`] === 'on' : labelIds.has(label.id)}
                    disabled={Boolean(busy?.startsWith('label:')) || !options}
                    onChange={(event) => {
                      const on = event.currentTarget.checked;
                      change(`label:${label.id}`, on ? 'on' : 'off', on ? { addedLabelIds: [label.id] } : { removedLabelIds: [label.id] });
                    }}
                  />
                  <span class="label-dot" style={{ '--item-color': label.color }} aria-hidden="true" />
                  {label.name}
                </label>
              </li>
            ))}
            {options && options.labels.length === 0 && <li class="hint">This team has no labels.</li>}
          </ul>
        </details>
      </div>
    </div>
  );
};

interface Draft extends IssueText {
  /** The text the edit started from, to tell a teammate's change from mine. */
  base: IssueText;
}

/**
 * A Linear issue in the Planner: its fields, its Markdown description (read,
 * tick checklist items, or edit) and its comments. Edits go to Linear in the
 * issue's own workspace; a linked task follows like any change from Linear.
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
  const [leaving, setLeaving] = useState(false);

  const dirty = Boolean((draft && (draft.title !== draft.base.title || draft.description !== draft.base.description)) || comment.trim());
  const close = () => {
    if (dirty && !leaving) setLeaving(true);
    else setUi({ openIssue: null });
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    // Escape closes this dialog only, not a task detail under it.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      event.preventDefault();
      // An open label list closes first.
      const labels = dialog.current?.querySelector<HTMLDetailsElement>('details.label-picker[open]');
      if (labels) labels.open = false;
      else closeRef.current();
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

  const ref: IssueRef = { id: issue?.id ?? issueRef.id, workspaceId: issue?.workspaceId ?? issueRef.workspaceId };
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

  const update = (field: string, input: IssueInput): Promise<void> => {
    if (!issue) return Promise.resolve();
    setBusy(field);
    return linear
      .updateIssue(ref, input)
      .then((updated) => setIssue(updated))
      .catch((reason) => client.notify(`Couldn't update ${issue.identifier}: ${messageOf(reason)}`))
      .finally(() => setBusy(null));
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
        setLeaving(false);
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
        setLeaving(false);
      })
      .catch((reason) => client.notify(`Couldn't comment on ${issue.identifier}: ${messageOf(reason)}`))
      .finally(() => setBusy(null));
  };

  const threads = issue ? commentThreads(issue.comments.nodes) : [];
  return (
    <div class="modal-backdrop is-top" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <div class="modal issue-editor" role="dialog" aria-modal="true" aria-label={`Linear issue ${issue?.identifier ?? ''}`.trim()} tabIndex={-1} ref={dialog}>
        <header class="detail-bar">
          {issue ? <IssueFields issue={issue} options={options} busy={busy} update={update} /> : <div class="detail-fields" />}
          <div class="detail-actions">
            {issue && <button class="link" onClick={() => void host.openUrl(issue.url)}>Open in Linear</button>}
            <button class="close" aria-label="Close" onClick={close}>×</button>
          </div>
        </header>
        {leaving && (
          <div class="banner" role="alertdialog" aria-label="Unsaved changes">
            <span>You have changes that are not saved.</span>
            <button class="link danger" onClick={() => setUi({ openIssue: null })}>Discard them</button>
            <button class="link" onClick={() => setLeaving(false)}>Keep editing</button>
          </div>
        )}
        {error && <p class="danger" role="alert">{error}</p>}
        {!issue && !error && <p class="hint">Loading the issue…</p>}
        {optionsError && <p class="hint">Couldn't load the team's states, people and labels: {optionsError}</p>}
        {issue && (
          <>
            <div class="issue-head">
              <span class="source-chip" style={{ '--item-color': issue.state.color }}><span class="dot" aria-hidden="true" />{issue.identifier}</span>
              {workspace && <span class="ws-badge">{workspace}</span>}
              <span class="muted">{issue.team.name}{issue.project ? ` · ${issue.project.name}` : ''}</span>
              <span class="grow" />
              <PlanActions issue={issue} />
            </div>
            {draft ? (
              <input class="issue-title-input" aria-label="Issue title" value={draft.title} onInput={(event) => setDraft({ ...draft, title: event.currentTarget.value })} />
            ) : (
              <h2 class="issue-title-view">{issue.title}</h2>
            )}
            <section class="issue-description" aria-label="Description">
              {draft ? (
                <MarkdownEditor value={draft.description} onInput={(description) => setDraft({ ...draft, description })} label="Issue description" onLink={onLink} onSubmit={() => save()} rows={12} />
              ) : issue.description?.trim() ? (
                <Markdown text={issue.description} onLink={onLink} onToggleTask={busy ? undefined : toggle} />
              ) : (
                <p class="hint">No description.</p>
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
            <section class="detail-section issue-comments" aria-label="Comments">
              <h3>Comments <span class="count">{threads.length}</span></h3>
              {threads.length > 0 && (
                <ul class="comment-list">
                  {threads.map(({ comment: item, reply }) => (
                    <li key={item.id} class={reply ? 'is-reply' : undefined}>
                      <div class="comment-meta">
                        <strong>{authorOf(item)}</strong>
                        <span class="muted">{when(item.createdAt)}{item.editedAt ? ' · edited' : ''}</span>
                      </div>
                      <Markdown text={item.body} onLink={onLink} />
                    </li>
                  ))}
                </ul>
              )}
              <MarkdownEditor value={comment} onInput={setComment} label="New comment" placeholder="Write a comment in Markdown" onLink={onLink} onSubmit={postComment} rows={4} />
              <div class="row">
                <button class="primary" disabled={!comment.trim() || busy === 'comment'} onClick={postComment}>{busy === 'comment' ? 'Posting…' : 'Comment'}</button>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
};
