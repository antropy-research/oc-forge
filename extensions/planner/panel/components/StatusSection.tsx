import { useEffect, useRef } from 'preact/hooks';
import type { HostClient } from '@openchamber/sdk';
import { formatMinutes } from '../../src/domain/dates.ts';
import { actualMinutes, tasksForDay } from '../../src/domain/selectors.ts';
import { useAgents, usePlanner, useView } from '../lib/context.ts';
import { RUN_STATUS_LABEL, needsYou, runStatus } from '../../src/domain/runs.ts';
import { formatClock, useNow } from '../lib/time.ts';
import { focusTask } from './FocusView.tsx';
import { TimerButton } from './TimerButton.tsx';

const STATUS_SHORT: Record<string, string> = { question: 'Question', permission: 'Permission', review: 'Review', failed: 'Failed' };

/** The Planner section in the chat's Work Status panel: what to work on now, with its timer. */
export const StatusSection = ({ host }: { host: HostClient }) => {
  const { client, agents } = usePlanner();
  const view = useView();
  const av = useAgents();
  const root = useRef<HTMLDivElement>(null);
  const waiting = Object.values(view.state.runs)
    .map((run) => ({ run, status: runStatus(run, av.sessions.get(run.sessionId)), task: view.state.tasks[run.taskId] }))
    .filter((row) => row.task && !row.task.deletedAt && needsYou(row.status));
  const today = tasksForDay(view.state, view.today);
  const open = today.filter((task) => !task.completedAt);
  const task = focusTask(open, null, view.state.timer?.taskId ?? null);
  const running = Boolean(task && view.state.timer?.taskId === task.id);
  const now = useNow(running);
  const next = open.find((item) => item.id !== task?.id);

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const report = () => void host.setHeight(Math.ceil(element.getBoundingClientRect().height) + 2).catch(() => {});
    report();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => observer.disconnect();
  }, [host]);

  return (
    <div class="status-section" ref={root}>
      {task ? (
        <div class="status-row">
          <button class="check" aria-label={`Complete ${task.title}`} onClick={() => void client.dispatch([{ type: 'task.completed', taskId: task.id, on: view.today }])}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 8.5l2.5 2.5L12 5.5" /></svg>
          </button>
          <span class="status-title" title={task.title}>{task.title}</span>
          <span class="status-time">{running ? formatClock(actualMinutes(view.state, task, now)) : task.plannedMinutes ? formatMinutes(task.plannedMinutes) : ''}</span>
          <TimerButton task={task} />
        </div>
      ) : (
        <div class="status-row muted">{today.length ? 'Done for the day' : 'Nothing planned today'}</div>
      )}
      {waiting.length > 0 && (
        <div class="status-agents">
          <span class={`agent-chip status-${waiting[0]!.status}`} title={RUN_STATUS_LABEL[waiting[0]!.status]}><span class="agent-dot" aria-hidden="true" />{STATUS_SHORT[waiting[0]!.status]}</span>
          <span class="status-title" title={waiting[0]!.task!.title}>{waiting[0]!.task!.title}</span>
          <button class="link" onClick={() => void agents.openSession(waiting[0]!.run.sessionId).catch(() => {})}>Open chat</button>
          {waiting.length > 1 && <span class="muted">+{waiting.length - 1}</span>}
        </div>
      )}
      <div class="status-sub">
        {today.length - open.length}/{today.length} done today{next ? ` · next: ${next.title}` : ''}
      </div>
    </div>
  );
};
