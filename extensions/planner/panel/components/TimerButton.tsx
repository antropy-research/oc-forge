import type { Task } from '../../src/domain/types.ts';
import { usePlanner, useView } from '../lib/context.ts';

/** Start or stop the task timer; starting another task stops the running one. */
export const TimerButton = ({ task, large = false }: { task: Task; large?: boolean }) => {
  const { client } = usePlanner();
  const view = useView();
  const running = view.state.timer?.taskId === task.id;
  if (task.completedAt && !running) return null;
  return (
    <button
      class={`timer-btn${running ? ' is-running' : ''}${large ? ' is-large' : ''}`}
      aria-label={running ? `Stop timer for ${task.title}` : `Start timer for ${task.title}`}
      aria-pressed={running}
      onClick={(event) => {
        event.stopPropagation();
        void client.dispatch([running ? { type: 'timer.stopped' } : { type: 'timer.started', taskId: task.id }]);
      }}
    >
      {running ? (
        <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="3.5" width="3" height="9" rx="1" /><rect x="9" y="3.5" width="3" height="9" rx="1" /></svg>
      ) : (
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5v9l7.5-4.5z" /></svg>
      )}
    </button>
  );
};
