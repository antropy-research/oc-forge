import { Fragment } from 'preact';
import { useRef, useState } from 'preact/hooks';
import type { Placement, Task } from '../../src/domain/types.ts';
import type { PlaylistEntry } from '../../src/domain/schedule.ts';
import { positionAt } from '../../src/domain/selectors.ts';
import { DRAG_TYPE, GITHUB_DRAG_TYPE, LINEAR_DRAG_TYPE, usePlanner, useView } from '../lib/context.ts';
import { isGitHubItem } from '../../src/domain/github.ts';
import { isLinearIssue } from '../../src/domain/linear.ts';
import { TaskCard } from './TaskCard.tsx';

interface TaskListProps {
  placement: Placement;
  tasks: Task[];
  empty?: string;
  /** Projected playlist times by task id. */
  times?: ReadonlyMap<string, PlaylistEntry>;
}

/** A droppable list: cards dragged onto it land at the indicated slot. */
export const TaskList = ({ placement, tasks, empty, times }: TaskListProps) => {
  const { client, linear, github } = usePlanner();
  const view = useView();
  const ref = useRef<HTMLUListElement>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const indexFor = (clientY: number): number => {
    const cards = Array.from(ref.current?.querySelectorAll<HTMLElement>(':scope > li[data-task]') ?? []);
    const index = cards.findIndex((card) => {
      const box = card.getBoundingClientRect();
      return clientY < box.top + box.height / 2;
    });
    return index === -1 ? cards.length : index;
  };

  return (
    <ul
      ref={ref}
      class={`task-list${dropIndex !== null ? ' is-drop-target' : ''}`}
      onDragOver={(event) => {
        const types = event.dataTransfer?.types ?? [];
        const issue = types.includes(LINEAR_DRAG_TYPE) || types.includes(GITHUB_DRAG_TYPE);
        if (!types.includes(DRAG_TYPE) && !issue) return;
        event.preventDefault();
        event.dataTransfer!.dropEffect = issue ? 'copy' : 'move';
        setDropIndex(indexFor(event.clientY));
      }}
      onDragLeave={(event) => {
        if (!ref.current?.contains(event.relatedTarget as Node | null)) setDropIndex(null);
      }}
      onDrop={(event) => {
        event.preventDefault();
        const index = dropIndex ?? tasks.length;
        setDropIndex(null);
        const issueData = event.dataTransfer?.getData(LINEAR_DRAG_TYPE);
        if (issueData) {
          let issue: unknown = null;
          try {
            issue = JSON.parse(issueData);
          } catch {
            return;
          }
          if (!isLinearIssue(issue)) return;
          const { bodies } = linear.importCommands(issue, placement, positionAt(view.state, placement, index));
          void client.dispatch(bodies, { undo: `Planned ${issue.identifier}` });
          return;
        }
        const githubData = event.dataTransfer?.getData(GITHUB_DRAG_TYPE);
        if (githubData) {
          let item: unknown = null;
          try {
            item = JSON.parse(githubData);
          } catch {
            return;
          }
          if (!isGitHubItem(item)) return;
          const { bodies } = github.importCommands(item, placement, positionAt(view.state, placement, index));
          void client.dispatch(bodies, { undo: `Planned ${item.key}` });
          return;
        }
        const taskId = event.dataTransfer?.getData(DRAG_TYPE);
        if (!taskId || !view.state.tasks[taskId]) return;
        void client.dispatch([{ type: 'task.moved', taskId, placement, position: positionAt(view.state, placement, index, taskId) }]);
      }}
    >
      {tasks.map((task, index) => (
        <Fragment key={task.id}>
          {dropIndex === index && <li class="drop-line" aria-hidden="true" />}
          <TaskCard task={task} playlist={times?.get(task.id)} />
        </Fragment>
      ))}
      {dropIndex === tasks.length && <li class="drop-line" aria-hidden="true" />}
      {tasks.length === 0 && empty && dropIndex === null && <li class="empty">{empty}</li>}
    </ul>
  );
};
