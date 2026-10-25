import { useEffect, useRef, useState } from 'preact/hooks';
import { HostRequestError } from '@openchamber/sdk';
import { BACKLOG_BUCKETS, type Placement } from '../../src/domain/types.ts';
import { addDays, formatMinutes } from '../../src/domain/dates.ts';
import { braindumpSystem, parseBraindump, readBraindumpAnswer, type DumpItem } from '../../src/domain/braindump.ts';
import { parseDuration } from '../../src/domain/quickAdd.ts';
import { liveChannels } from '../../src/domain/selectors.ts';
import { usePlanner, useView } from '../lib/context.ts';
import { createManyTaskCommands } from '../lib/commands.ts';

type Row = DumpItem & { keep: boolean };

const placementValue = (placement: Placement): string => (placement.kind === 'day' ? `day:${placement.date}` : `bucket:${placement.bucket}`);

/** Sunsama's Braindump: write everything down, then add it as tasks. */
export const BraindumpModal = ({ onClose, folderId }: { onClose: () => void; folderId: string | null }) => {
  const { client, host } = usePlanner();
  const view = useView();
  const area = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const fallback: Placement = { kind: 'backlog', bucket: 'next-weeks' };
  const channels = liveChannels(view.state).map((channel) => channel.name);
  useEffect(() => area.current?.focus(), []);

  const organize = async (withModel: boolean) => {
    setBusy(true);
    let items: DumpItem[] | null = null;
    if (withModel) {
      try {
        const { text: answer } = await host.generate({ system: braindumpSystem(channels), prompt: text.slice(0, 60_000), maxOutputTokens: 2000 });
        items = readBraindumpAnswer(answer, view.today, fallback, channels);
        setNote(items ? 'Organized with AI. Check the list before adding.' : 'The AI answer was not usable, so each line became a task.');
      } catch (error) {
        const code = error instanceof HostRequestError ? error.code : '';
        setNote(code === 'NO_MODEL' || code === 'MODEL_FAILED' ? 'No model is set up for AI, so each line became a task.' : `AI failed (${error instanceof Error ? error.message : String(error)}), so each line became a task.`);
      }
    } else setNote('Each line became a task; ~30m, @tomorrow, #channel and !high work as in Add task.');
    items ??= parseBraindump(text, view.today, view.state.settings.weekStartsOn, fallback);
    setRows(items.map((item) => ({ ...item, keep: true })));
    setBusy(false);
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
            <p class="hint">Get everything out of your head, one thing per line or in sentences. Nothing is added until you confirm.</p>
            <textarea ref={area} rows={10} aria-label="Brain dump" value={text} onInput={(event) => setText(event.currentTarget.value)} placeholder={'Call the bank about the card\nRenew passport before December\nFix the flaky login test ~1h #work'} />
            <div class="row">
              <div class="nav-spacer" />
              <button disabled={busy || !text.trim()} onClick={() => void organize(false)}>One task per line</button>
              <button class="primary" disabled={busy || !text.trim()} onClick={() => void organize(true)}>{busy ? 'Organizing…' : 'Organize with AI'}</button>
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
