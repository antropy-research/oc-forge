import { useEffect, useRef, useState } from 'preact/hooks';
import { HostRequestError } from '@openchamber/sdk';
import type { EventBody } from '../../src/domain/events.ts';
import { ASSISTANT_SYSTEM, assistantContext, describeOp, readAssistantAnswer, whenToPlacement, type AssistantOp } from '../../src/domain/assistant.ts';
import { channelByName } from '../../src/domain/selectors.ts';
import type { DateKey, PlannerState } from '../../src/domain/types.ts';
import { usePlanner, useView } from '../lib/context.ts';
import { createManyTaskCommands, moveTo } from '../lib/commands.ts';

/** Planner commands for confirmed assistant operations. */
export const assistantCommands = (state: PlannerState, ops: readonly AssistantOp[], today: DateKey): EventBody[] => {
  const creates = ops.flatMap((op) => (op.op === 'create' ? [{ title: op.title, plannedMinutes: op.minutes, placement: whenToPlacement(op.when, today), channel: op.channel, priority: null, objective: null }] : []));
  const bodies = createManyTaskCommands(state, creates, { kind: 'day', date: today }, { today });
  for (const op of ops) {
    if (op.op === 'create') continue;
    const task = state.tasks[op.taskId];
    if (!task) continue;
    if (op.op === 'move') {
      const placement = whenToPlacement(op.when, today);
      if (placement) bodies.push(moveTo(state, task.id, placement));
    } else if (op.op === 'complete' && !task.completedAt) bodies.push({ type: 'task.completed', taskId: task.id, on: today });
    else if (op.op === 'reopen' && task.completedAt) bodies.push({ type: 'task.reopened', taskId: task.id });
    else if (op.op === 'archive' && !task.archivedAt) bodies.push({ type: 'task.archived', taskId: task.id });
    else if (op.op === 'estimate') bodies.push({ type: 'task.updated', taskId: task.id, patch: { plannedMinutes: op.minutes } });
    else if (op.op === 'channel') {
      const channel = channelByName(state, op.channel);
      if (channel) bodies.push({ type: 'task.updated', taskId: task.id, patch: { channelId: channel.id } });
    }
  }
  return bodies;
};

/** Ask Planner: say what to change; review what the model proposes; apply it (undoable). */
export const AssistantModal = ({ initial, onClose }: { initial: string; onClose: () => void }) => {
  const { client, host } = usePlanner();
  const view = useView();
  const box = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(initial);
  const [answer, setAnswer] = useState<{ reply: string; ops: AssistantOp[] } | null>(null);
  const [keep, setKeep] = useState<boolean[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => box.current?.focus(), []);

  const ask = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setProblem(null);
    setAnswer(null);
    try {
      const { text: reply } = await host.generate({ system: ASSISTANT_SYSTEM, prompt: `${assistantContext(view.state, view.today)}\n\nRequest: ${text.trim()}`.slice(0, 60_000), maxOutputTokens: 1500 });
      const parsed = readAssistantAnswer(reply, view.state, view.today);
      if (!parsed) setProblem('The answer could not be read. Try saying it another way.');
      else {
        setAnswer(parsed);
        setKeep(parsed.ops.map(() => true));
      }
    } catch (error) {
      const code = error instanceof HostRequestError ? error.code : '';
      setProblem(code === 'NO_MODEL' || code === 'MODEL_FAILED' ? 'No model is set up for the assistant. Add a provider key, or choose a Small Model in OpenChamber settings.' : `The assistant failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const chosen = answer ? answer.ops.filter((_, index) => keep[index]) : [];
  const apply = () => {
    void client.dispatch(assistantCommands(view.state, chosen, view.today), { undo: `Assistant made ${chosen.length} change${chosen.length === 1 ? '' : 's'}` });
    onClose();
  };

  return (
    <div class="modal-backdrop palette-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div class="palette assistant" role="dialog" aria-modal="true" aria-label="Ask Planner">
        <textarea
          ref={box}
          rows={3}
          aria-label="Ask Planner"
          placeholder="e.g. Move everything I can't finish today to tomorrow, and add 15 minutes for email"
          value={text}
          onInput={(event) => setText(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onClose();
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void ask();
          }}
        />
        <div class="row assistant-row">
          <span class="hint">The plan and your request go to OpenChamber's Small Model. Nothing changes until you apply.</span>
          <button class="primary" disabled={busy || !text.trim()} onClick={() => void ask()}>{busy ? 'Thinking…' : 'Ask'}</button>
        </div>
        {problem && <p class="danger assistant-note" role="alert">{problem}</p>}
        {answer && (
          <div class="assistant-answer">
            <p class="assistant-reply">{answer.reply}</p>
            {answer.ops.length > 0 && (
              <>
                <ul class="assistant-ops">
                  {answer.ops.map((op, index) => (
                    <li key={index}>
                      <label class="inline">
                        <input type="checkbox" checked={keep[index]} onChange={(event) => setKeep(keep.map((value, at) => (at === index ? event.currentTarget.checked : value)))} />
                        {describeOp(view.state, op, view.today)}
                      </label>
                    </li>
                  ))}
                </ul>
                <div class="row assistant-row">
                  <div class="nav-spacer" />
                  <button class="link" onClick={onClose}>Cancel</button>
                  <button class="primary" disabled={chosen.length === 0} onClick={apply}>Apply {chosen.length} change{chosen.length === 1 ? '' : 's'}</button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
