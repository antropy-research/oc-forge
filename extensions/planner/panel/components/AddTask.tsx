import { useEffect, useRef, useState } from 'preact/hooks';
import { BACKLOG_BUCKETS, type Placement } from '../../src/domain/types.ts';
import { formatMinutes, monthDay } from '../../src/domain/dates.ts';
import { parseQuickAdd, type QuickAdd } from '../../src/domain/quickAdd.ts';
import { suggestFor } from '../../src/domain/suggest.ts';
import { usePlanner, useView } from '../lib/context.ts';
import { addParsedTask, urlHint } from '../lib/addTask.ts';

const placementLabel = (placement: Placement): string =>
  placement.kind === 'day' ? monthDay(placement.date) : BACKLOG_BUCKETS.find((bucket) => bucket.id === placement.bucket)!.label;

const Chips = ({ parsed }: { parsed: QuickAdd }) => (
  <div class="chips" aria-live="polite">
    {parsed.plannedMinutes !== null && <span class="chip">~{formatMinutes(parsed.plannedMinutes)}</span>}
    {parsed.placement && <span class="chip">@{placementLabel(parsed.placement)}</span>}
    {parsed.channel && <span class="chip">#{parsed.channel}</span>}
    {parsed.priority && <span class="chip">!{parsed.priority}</span>}
    {parsed.objective && <span class="chip">◎ {parsed.objective}</span>}
  </div>
);

/** What history would fill in for the fields left empty (when that setting is on). */
const SuggestionChips = ({ parsed }: { parsed: QuickAdd }) => {
  const view = useView();
  if (!view.state.settings.suggestFromHistory || (parsed.plannedMinutes !== null && parsed.channel)) return null;
  const suggestion = parsed.title.trim().length >= 3 ? suggestFor(view.state, parsed.title) : null;
  if (!suggestion) return null;
  const channel = !parsed.channel && suggestion.channelId ? view.state.channels[suggestion.channelId] : null;
  const minutes = parsed.plannedMinutes === null ? suggestion.minutes : null;
  if (!channel && minutes === null) return null;
  return (
    <div class="chips suggested" title={`From ${suggestion.basis} similar task${suggestion.basis === 1 ? '' : 's'}`}>
      {minutes !== null && <span class="chip">≈{formatMinutes(minutes)}</span>}
      {channel && <span class="chip">#{channel.name}</span>}
      <span class="chip-note">suggested</span>
    </div>
  );
};

/** Sunsama's inline Add task: `~30m` planned time, `@tomorrow` / `@backlog` start, `#channel`, `!high`. */
export const AddTask = ({ placement, edge = 'bottom', folderId = null }: { placement: Placement; edge?: 'top' | 'bottom'; folderId?: string | null }) => {
  const { client, linear, github, google } = usePlanner();
  const view = useView();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const parsed = text.trim() ? parseQuickAdd(text, view.today, view.state.settings.weekStartsOn) : null;

  // The `autofocus` attribute is blocked in a cross-origin frame; focusing after the click is not.
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  const submit = () => {
    if (!parsed || !parsed.title.trim()) return;
    void addParsedTask({ client, linear, github, google }, parsed, placement, edge, view.today, folderId);
    setText('');
  };

  if (!open) {
    return (
      <button class="add-task" onClick={() => setOpen(true)}>
        <span aria-hidden="true">+</span> Add task
      </button>
    );
  }
  return (
    <div class="add-task-form">
      <input
        ref={input}
        value={text}
        placeholder="Task name  ~30m  @tomorrow  #channel"
        aria-label="New task"
        onInput={(event) => setText(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') submit();
          if (event.key === 'Escape') {
            setText('');
            setOpen(false);
          }
        }}
        onBlur={() => {
          if (!text.trim()) setOpen(false);
        }}
      />
      {parsed && <Chips parsed={parsed} />}
      {parsed && urlHint(parsed.title) && <p class="hint url-hint" role="status">{urlHint(parsed.title)}</p>}
      {parsed && <SuggestionChips parsed={parsed} />}
    </div>
  );
};
