// The task detail's merged items (Sunsama's Merge tasks): subtasks merged in from a task or an integration panel keep
// their link, which opens them where they live; Convert to task gives one back as a task, with its notes, planned time
// and link (renamed elsewhere since, it asks, as the subtasks do). Their item's state and title follow it, as a linked
// task's do (src/domain/merge.ts).
import { SOURCE_NAMES, type Task } from '../../src/domain/types.ts';
import { formatMinutes } from '../../src/domain/dates.ts';
import { sourceUrl } from '../../src/domain/gmail.ts';
import { convertSubtaskCommands } from '../../src/domain/merge.ts';
import { newId } from '../../src/domain/ids.ts';
import { usePlanner, useView } from '../lib/context.ts';
import { hoveredSource, setHoveredSource } from '../lib/hover.ts';
import { useEffect, useState } from 'preact/hooks';
import { ExternalLink } from './ExternalLink.tsx';
import { SourceIcon } from './SourceIcons.tsx';
import { ConflictBanner, quoted } from './Conflicts.tsx';

const typing = (target: EventTarget | null) => target instanceof HTMLElement && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable);

export const MergedSection = ({ task }: { task: Task }) => {
  const { client, host } = usePlanner();
  const view = useView();
  const merged = task.subtasks.filter((subtask) => subtask.source);
  const settings = view.state.settings;
  const [problem, setProblem] = useState<{ line: string; subtaskId: string } | null>(null);
  /** Convert to task, as the plan has the subtask now; renamed elsewhere since, asked (Save mine: converted as it is now). */
  const convert = (subtaskId: string, title: string) =>
    void client.dispatch(convertSubtaskCommands(client.getView().state, task.id, subtaskId, newId), {
      undo: 'Converted to a task',
      onConflict: (conflict) => conflict.now && setProblem({ line: `${quoted(title)} was renamed ${quoted(conflict.now.title)} elsewhere (yours: converted to a task)`, subtaskId }),
    });
  // G over a merged item opens it in its tool (Sunsama's subtask shortcut); the board's keys rest while a task is open.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const source = hoveredSource();
      if (!source || event.key.toLowerCase() !== 'g' || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented || typing(event.target)) return;
      event.preventDefault();
      void host.openUrl(sourceUrl(source, settings)).catch((error: unknown) => client.notify(`Could not open the link: ${error instanceof Error ? error.message : String(error)}`));
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      setHoveredSource(null);
    };
  }, [settings.emailClient]);
  if (!merged.length && !problem) return null;
  return (
    <section class="detail-section merged-section" aria-label="Merged in">
      <h3>Merged in</h3>
      <ul class="merged-list">
        {merged.map((subtask) => {
          const source = subtask.source!;
          const tool = source.kind === 'email' && view.state.settings.emailClient === 'superhuman' ? 'Superhuman' : SOURCE_NAMES[source.kind];
          return (
            <li key={subtask.id} class={subtask.done ? 'is-done' : ''} onMouseEnter={() => setHoveredSource(source)} onMouseLeave={() => setHoveredSource(null)}>
              <span class="merged-icon"><SourceIcon kind={source.kind} /></span>
              <span class="grow">
                {subtask.title}
                <span class="muted"> · {source.key}{source.status ? ` · ${source.status.name}` : ''}{subtask.plannedMinutes ? ` · ${formatMinutes(subtask.plannedMinutes)}` : ''}</span>
              </span>
              <ExternalLink className="link" href={sourceUrl(source, view.state.settings)} label={`Open ${source.key} in ${tool}`}>Open</ExternalLink>
              <button class="link" aria-label={`Convert ${subtask.title} to a task`} onClick={() => convert(subtask.id, subtask.title)}>
                Convert to task
              </button>
            </li>
          );
        })}
      </ul>
      {problem && (
        <ConflictBanner
          lines={[problem.line]}
          onTheirs={() => setProblem(null)}
          onMine={() => {
            setProblem(null);
            const now = client.getView().state.tasks[task.id]?.subtasks.find((subtask) => subtask.id === problem.subtaskId);
            if (now) convert(now.id, now.title);
          }}
        />
      )}
    </section>
  );
};
