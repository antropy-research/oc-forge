import { useEffect, useRef, useState } from 'preact/hooks';
import { BACKLOG_BUCKETS, type Placement } from '../../../src/domain/core/types.ts';
import { addDays, formatMinutes } from '../../../src/domain/core/dates.ts';
import { parseBraindump, type DumpItem } from '../../../src/domain/assistant/braindump.ts';
import { parseDuration } from '../../../src/domain/plan/quickAdd.ts';
import { liveChannels } from '../../../src/domain/core/selectors.ts';
import { messageOf } from '../../../src/domain/core/values.ts';
import { usePlanner, useView } from '../../lib/core/context.ts';
import { NOTES_MAX, braindumpRequest, startAsk } from '../../lib/assistant/ask.ts';
import { createManyTaskCommands } from '../../../src/domain/plan/commands.ts';

type Row = DumpItem & { keep: boolean };

const placementValue = (placement: Placement): string => (placement.kind === 'day' ? `day:${placement.date}` : `bucket:${placement.bucket}`);

/**
 * Sunsama's Braindump: write everything down, then add it as tasks, one per line (checked here before anything is
 * added), or handed to the agent you chat with, which turns the notes into tasks in a new chat beside the Planner.
 */
export const BraindumpModal = ({ onClose, folderId }: { onClose: () => void; folderId: string | null }) => {
  const { client, host } = usePlanner();
  const view = useView();
  const area = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState('');
  const fallback: Placement = { kind: 'backlog', bucket: 'next-weeks' };
  const channels = liveChannels(view.state).map((channel) => channel.name);
  useEffect(() => area.current?.focus(), []);

  /** One task per line, as Add task reads a line, to check before adding. */
  const perLine = () => {
    setNote('Each line became a task; ~30m, @tomorrow, #channel and !high work as in Add task.');
    setRows(parseBraindump(text, view.today, view.state.settings.weekStartsOn, fallback).map((item) => ({ ...item, keep: true })));
  };

  /** The notes to the agent you chat with, in a new chat; it adds the tasks (Ask Planner can take them back). */
  const withAgent = async () => {
    setBusy(true);
    setProblem('');
    try {
      const folder = folderId ? view.state.folders[folderId]?.name ?? null : null;
      const first = text.trim().split('\n')[0]!.trim();
      const { sent } = await startAsk(host, client, braindumpRequest(text, folder), { label: `Braindump: ${first}` });
      if (sent === 'no-model') client.notify('The chat was created, but no model is set up to answer it. Open the chat to pick one.');
      else if (sent === 'failed') client.notify('The chat was created, but the notes did not send. Open the chat to send them again.');
      if (text.trim().length > NOTES_MAX) client.notify(`The agent got the first ${NOTES_MAX.toLocaleString('en-US')} characters of your notes.`);
      onClose();
    } catch (error) {
      setProblem(`The agent could not start: ${messageOf(error)}`);
      setBusy(false);
    }
  };

  const update = (index: number, patch: Partial<Row>) => setRows((current) => current && current.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  const kept = rows?.filter((row) => row.keep && row.title.trim()) ?? [];
  const add = () => {
    const inputs = kept.map((row) => ({ title: row.title.trim(), plannedMinutes: row.plannedMinutes, placement: row.placement, channel: row.channel, priority: row.priority, objective: null }));
    void client.dispatch(createManyTaskCommands(view.state, inputs, fallback, { today: view.today, folderId }), { undo: `Added ${inputs.length} tasks` });
    onClose();
  };

  return (
    <div class="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div class="modal braindump" role="dialog" aria-modal="true" aria-label="Braindump">
        <header class="braindump-head">
          <h2>Braindump</h2>
          <button class="close" aria-label="Close" onClick={onClose}>×</button>
        </header>
        {!rows ? (
          <>
            <p class="hint">Get everything out of your head, one thing per line or in sentences. One task per line shows the list to check before anything is added; the agent you chat with turns your notes into tasks in a new chat, and Ask Planner can take them back.</p>
            {problem && <p class="danger" role="alert">{problem}</p>}
            <textarea ref={area} rows={10} aria-label="Brain dump" value={text} onInput={(event) => setText(event.currentTarget.value)} placeholder={'Call the bank about the card\nRenew passport before December\nFix the flaky login test ~1h #work'} />
            <div class="row">
              <div class="nav-spacer" />
              <button disabled={busy || !text.trim()} onClick={perLine}>One task per line</button>
              <button class="primary" disabled={busy || !text.trim()} onClick={() => void withAgent()}>{busy ? 'Starting…' : 'Organize with the agent'}</button>
            </div>
          </>
        ) : (
          <>
            {note && <p class="hint">{note}</p>}
            <ul class="dump-list">
              {rows.map((row, index) => (
                <li key={index} class={row.keep ? '' : 'is-dropped'}>
                  <input type="checkbox" checked={row.keep} aria-label={`Keep ${row.title}`} onChange={(event) => update(index, { keep: event.currentTarget.checked })} />
                  <input class="dump-title" value={row.title} aria-label="Task" onInput={(event) => update(index, { title: event.currentTarget.value })} />
                  <select aria-label="When" value={placementValue(row.placement)} onChange={(event) => {
                    const value = event.currentTarget.value;
                    update(index, { placement: value.startsWith('day:') ? { kind: 'day', date: value.slice(4) } : { kind: 'backlog', bucket: value.slice(7) as never } });
                  }}>
                    <option value={`day:${view.today}`}>Today</option>
                    <option value={`day:${addDays(view.today, 1)}`}>Tomorrow</option>
                    {row.placement.kind === 'day' && row.placement.date !== view.today && row.placement.date !== addDays(view.today, 1) && <option value={placementValue(row.placement)}>{row.placement.date}</option>}
                    {BACKLOG_BUCKETS.map((bucket) => <option key={bucket.id} value={`bucket:${bucket.id}`}>{bucket.label}</option>)}
                  </select>
                  <input class="dump-time" aria-label="Planned time" placeholder="–:––" value={formatMinutes(row.plannedMinutes)} onChange={(event) => update(index, { plannedMinutes: event.currentTarget.value.trim() ? parseDuration(event.currentTarget.value) : null })} />
                  <select aria-label="Channel" value={row.channel ?? ''} onChange={(event) => update(index, { channel: event.currentTarget.value || null })}>
                    <option value="">No channel</option>
                    {[...new Set([...channels, ...(row.channel ? [row.channel] : [])])].map((name) => <option key={name} value={name}>#{name}</option>)}
                  </select>
                </li>
              ))}
            </ul>
            <div class="row">
              <button class="link" onClick={() => setRows(null)}>Back to the text</button>
              <div class="nav-spacer" />
              <button class="primary" disabled={kept.length === 0} onClick={add}>Add {kept.length} task{kept.length === 1 ? '' : 's'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
