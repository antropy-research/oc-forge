// A Google task's color and Drive attachments, as Google Calendar's task form
// has them: a color menu beside its list (its list's color, or one of Google
// Calendar's), and "Add a Google Drive attachment", which finds files in the
// account's Drive (asking Google for Drive first, the way the Planner asks
// for Calendar and Tasks), inserts the ones chosen, and lists them to open or
// remove. Both are kept in the Planner: Google Tasks' API has neither.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { TaskAttachment } from '../../src/domain/types.ts';
import { ATTACHMENTS_MAX } from '../../src/domain/events.ts';
import { TASK_COLORS, colorName, driveKind, withAttachments, type DriveFile } from '../../src/domain/gtaskAdvanced.ts';
import { shortDay } from '../../src/domain/gcalendar.ts';
import { useGoogle, usePlanner } from '../lib/context.ts';
import { Icon } from './calendar/Icon.tsx';
import { SignInPending } from './Settings.tsx';

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Google Calendar's color menu for a task: its list's color, or one of Google's colors. */
export const TaskColorMenu = ({ color, listColor, disabled, note, onChange }: { color: string | null; listColor: string; disabled?: boolean; note?: string; onChange: (color: string | null) => void }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => !ref.current?.contains(event.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const shown = color ?? listColor;
  const name = color ? colorName(color) : 'List color';
  return (
    <div class="menu-anchor gt-color" ref={ref}>
      <button
        class="gt-color-button"
        aria-label={`Task color: ${name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        title={note ?? 'Its color on the calendar'}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => event.key === 'Escape' && open && (event.stopPropagation(), setOpen(false))}
      >
        <span class="gt-color-dot" style={{ background: shown }} />
        <Icon name="down" size={16} />
      </button>
      {open && (
        <div class="menu gt-color-menu" role="menu" aria-label="Task color">
          <div class="cal-palette" role="group" aria-label="Colors">
            {TASK_COLORS.map((choice) => (
              <button key={choice.color} role="menuitemradio" class="cal-swatch" aria-label={choice.name} title={choice.name} aria-checked={choice.color === color} aria-pressed={choice.color === color} style={{ background: choice.color }} onClick={() => { setOpen(false); onChange(choice.color); }} />
            ))}
          </div>
          <button role="menuitemradio" aria-checked={color === null} class="gt-color-list" onClick={() => { setOpen(false); onChange(null); }}>
            <span class="gt-color-dot" style={{ background: listColor }} /> List color
          </button>
        </div>
      )}
    </div>
  );
};

/** A task's Drive attachments: each opens in Drive or is removed; "Add a Google Drive attachment" finds more. */
export const TaskAttachments = ({ account, files, note, onChange }: { account: string | null; files: TaskAttachment[]; note: string | null; onChange: (files: TaskAttachment[]) => void }) => {
  const { host } = usePlanner();
  const [picking, setPicking] = useState(false);
  const full = files.length >= ATTACHMENTS_MAX;
  return (
    <div class="gt-form-row gt-attachments" role="group" aria-label="Attachments">
      <Icon name="attach" size={16} />
      <div class="gt-attach-main">
        {files.length > 0 && (
          <ul class="gt-attach-list" aria-label="Attached files">
            {files.map((file) => (
              <li key={file.id} class="gt-attach">
                <span class="gt-attach-icon" style={{ color: driveKind(file.mimeType).color }} title={driveKind(file.mimeType).label}><Icon name="file" size={16} /></span>
                <button class="link gt-attach-title" aria-label={`Open ${file.title}`} title="Open in Google Drive" onClick={() => void host.openUrl(file.url)}>{file.title}</button>
                {!note && (
                  <button class="icon-button gt-attach-remove" aria-label={`Remove attachment ${file.title}`} title="Remove attachment" onClick={() => onChange(files.filter((other) => other.id !== file.id))}>
                    <Icon name="close" size={14} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {!note && (
          <button class="link" disabled={!account || full} title={full ? `A task has at most ${ATTACHMENTS_MAX} attachments` : !account ? 'Choose its list first' : undefined} onClick={() => setPicking(true)}>
            Add a Google Drive attachment
          </button>
        )}
        {note && <span class="gt-form-note">{note}</span>}
      </div>
      {picking && account && (
        <DrivePicker
          account={account}
          have={files}
          onClose={() => setPicking(false)}
          onInsert={(added) => {
            const next = withAttachments(files, added, ATTACHMENTS_MAX);
            if (next) onChange(next);
            setPicking(false);
          }}
        />
      )}
    </div>
  );
};

/**
 * Google Drive's picker for a task's attachments: the account's latest files,
 * or the ones whose name has what is typed; check some, then Insert. An
 * account that has not allowed Drive is asked first, as Google asks for one
 * more permission (it keeps the ones given before).
 */
const DrivePicker = ({ account, have, onClose, onInsert }: { account: string; have: TaskAttachment[]; onClose: () => void; onInsert: (files: DriveFile[]) => void }) => {
  const { google } = usePlanner();
  const gv = useGoogle();
  const allowed = google.allows(account, 'drive');
  const [text, setText] = useState('');
  const [files, setFiles] = useState<DriveFile[] | null>(null);
  const [chosen, setChosen] = useState<DriveFile[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!allowed) return;
    let live = true;
    const timer = setTimeout(() => {
      google
        .searchDrive(account, text)
        .then((found) => {
          if (!live) return;
          setFiles(found);
          setProblem(null);
        })
        .catch((error) => live && setProblem(messageOf(error)));
    }, text ? 300 : 0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [allowed, text]);
  useEffect(() => {
    if (allowed) searchRef.current?.focus();
  }, [allowed]);
  const room = ATTACHMENTS_MAX - have.length;
  const signingIn = gv.signIn && gv.signIn.result.status !== 'connected';
  return (
    <div
      class="modal-backdrop is-top drive-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
      onKeyDown={(event) => {
        // Its own Escape: the task's form under it stays open.
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        onClose();
      }}
    >
      <div class="modal drive-picker" role="dialog" aria-modal="true" aria-label="Add a Google Drive attachment">
        <div class="gt-editor-bar">
          <h2>Google Drive</h2>
          <button class="icon-button" aria-label="Close" title="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        {!allowed ? (
          <div class="drive-allow">
            <p>
              To attach files, the Planner needs to see your Google Drive's file names for {account}: Google is asked for read-only access to them (their names, types and links, never
              their contents), as it was asked for Calendar and Tasks. What {account} allowed before stays allowed.
            </p>
            {signingIn ? (
              <SignInPending />
            ) : (
              <button class="primary" onClick={() => google.allow(account, 'drive').catch((error) => setProblem(messageOf(error)))}>
                Allow Google Drive
              </button>
            )}
            {problem && <p class="danger" role="alert">{problem}</p>}
          </div>
        ) : (
          <>
            <div class="drive-search">
              <Icon name="search" size={18} />
              <input ref={searchRef} type="search" aria-label="Search in Drive" placeholder="Search in Drive" value={text} onInput={(event) => setText(event.currentTarget.value)} />
            </div>
            {problem && <p class="danger" role="alert">{problem}</p>}
            {files === null && !problem && <p class="hint">Reading your Drive…</p>}
            {files !== null && files.length === 0 && <p class="hint">{text.trim() ? `No file's name has "${text.trim()}".` : 'No files in this Drive.'}</p>}
            {files !== null && files.length > 0 && (
              <ul class="drive-files" aria-label={text.trim() ? 'Files found' : 'Recent files'}>
                {files.map((file) => {
                  const on = chosen.some((other) => other.id === file.id);
                  const attached = have.some((other) => other.id === file.id);
                  const kind = driveKind(file.mimeType);
                  return (
                    <li key={file.id}>
                      <label class={`drive-file${on ? ' is-on' : ''}${attached ? ' is-attached' : ''}`}>
                        <input type="checkbox" aria-label={file.title} checked={on || attached} disabled={attached} onChange={(event) => setChosen(event.currentTarget.checked ? [...chosen, file] : chosen.filter((other) => other.id !== file.id))} />
                        <span class="drive-file-icon" style={{ color: kind.color }}><Icon name="file" size={20} /></span>
                        <span class="drive-file-name">{file.title}</span>
                        <span class="muted drive-file-meta">{kind.label}{file.modifiedTime ? ` · ${shortDay(file.modifiedTime.slice(0, 10))}` : ''}{attached ? ' · attached' : ''}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
            <div class="row drive-actions">
              <span class="muted">{chosen.length > room ? `A task has at most ${ATTACHMENTS_MAX} attachments: ${Math.max(0, room)} more fit` : `${chosen.length} selected`}</span>
              <span class="nav-spacer" />
              <button class="link" onClick={onClose}>Cancel</button>
              <button class="primary" disabled={!chosen.length || chosen.length > room} onClick={() => onInsert(chosen)}>Insert</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
