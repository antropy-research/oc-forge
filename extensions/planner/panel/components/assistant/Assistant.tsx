import { useEffect, useRef, useState } from 'preact/hooks';
import { messageOf } from '../../../src/domain/core/values.ts';
import { askRuns, startAsk, undoAsk, type AskRunView } from '../../lib/assistant/ask.ts';
import { useAgents, usePlanner } from '../../lib/core/context.ts';

/** How often the open dialog reads the recent asks again, while their agents work. */
const RUNS_POLL_MS = 4000;
const RUNS_SHOWN = 3;
const CHANGES_SHOWN = 6;

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

/**
 * Ask Planner: the request goes to the agent the chat composer has selected, in a new chat beside the Planner, and
 * that agent reads and changes the plan with the Planner's command line. The recent asks list what each chat's agent
 * changed, to open the chat or take the changes back.
 */
export const AssistantModal = ({ initial, onClose }: { initial: string; onClose: () => void }) => {
  const { client, host, agents } = usePlanner();
  const live = useAgents().sessions;
  const box = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [runs, setRuns] = useState<AskRunView[]>([]);
  const [undoing, setUndoing] = useState<string | null>(null);

  useEffect(() => {
    box.current?.focus();
    let open = true;
    const load = () =>
      void askRuns(client)
        .then((answer) => {
          if (!open) return;
          setRuns(answer.runs);
          if (answer.problem) setProblem(answer.problem);
        })
        .catch(() => {});
    load();
    const timer = setInterval(load, RUNS_POLL_MS);
    return () => {
      open = false;
      clearInterval(timer);
    };
  }, [client]);

  const ask = async () => {
    const request = text.trim();
    if (!request || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const { sent } = await startAsk(host, client, request);
      if (sent === 'no-model') client.notify('The chat was created, but no model is set up to answer it. Open the chat to pick one.');
      else if (sent === 'failed') client.notify('The chat was created, but the request did not send. Open the chat to send it again.');
      onClose();
    } catch (error) {
      setProblem(`Ask Planner could not start the chat: ${messageOf(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const undo = async (run: AskRunView) => {
    setUndoing(run.id);
    try {
      const answer = await undoAsk(client, run.id);
      setRuns((current) => current.map((entry) => (entry.id === run.id ? answer.run : entry)));
      const kept = answer.kept.length ? ` Kept ${answer.kept.map((entry) => `"${entry.label}" (${entry.why.toLowerCase()})`).join(', ')}.` : '';
      client.notify(`Took back ${plural(answer.undone, 'change')}.${kept}`);
    } catch (error) {
      client.notify(`Could not take the changes back: ${messageOf(error)}`);
    } finally {
      setUndoing(null);
    }
  };

  const status = (run: AskRunView): string => {
    const activity = run.sessionId ? live.get(run.sessionId)?.activity : undefined;
    if (activity === 'running' || activity === 'retrying') return 'Working…';
    if (activity === 'waiting-question' || activity === 'waiting-permission') return 'Needs you in the chat';
    const made = run.changes.filter((change) => change.undone !== 'undone').length;
    return made ? plural(made, 'change') : 'No changes';
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
          <span class="hint">Goes to the agent you chat with, in a new chat beside the Planner. It reads and changes your plan as it works; you can take its changes back here.</span>
          <button class="primary" disabled={busy || !text.trim()} onClick={() => void ask()}>{busy ? 'Starting…' : 'Ask'}</button>
        </div>
        {problem && <p class="danger assistant-note" role="alert">{problem}</p>}
        {runs.length > 0 && (
          <section class="assistant-runs" aria-label="Recent asks">
            <h3>Recent</h3>
            <ul>
              {runs.slice(0, RUNS_SHOWN).map((run) => {
                const undoable = run.changes.filter((change) => change.undoable);
                return (
                  <li key={run.id} class="assistant-run">
                    <div class="assistant-run-head">
                      <span class="assistant-run-request" title={run.request ?? undefined}>{run.request ?? 'A chat that changed the plan'}</span>
                      <span class="assistant-run-status">{status(run)}</span>
                      {run.sessionId && (
                        <button class="link" onClick={() => void agents.openSession(run.sessionId!).then(onClose).catch((error) => client.notify(`Could not open the chat: ${messageOf(error)}`))}>
                          Open chat
                        </button>
                      )}
                      {undoable.length > 0 && (
                        <button class="link" disabled={undoing === run.id} onClick={() => void undo(run)}>
                          {undoing === run.id ? 'Taking back…' : `Undo ${undoable.length === 1 ? 'its change' : `its ${undoable.length} changes`}`}
                        </button>
                      )}
                    </div>
                    {run.changes.length > 0 && (
                      <ul class="assistant-changes">
                        {run.changes.slice(-CHANGES_SHOWN).map((change) => (
                          <li key={change.id} class={change.undone === 'undone' ? 'undone' : undefined}>
                            {change.label}
                            {change.undone === 'kept' ? ' · kept, changed since' : ''}
                          </li>
                        ))}
                        {run.changes.length > CHANGES_SHOWN && <li>and {plural(run.changes.length - CHANGES_SHOWN, 'earlier change')}</li>}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
};
