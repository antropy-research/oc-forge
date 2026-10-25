import { Fragment } from 'preact';
import { useRef, useState } from 'preact/hooks';
import type { Placement, Task } from '../../src/domain/types.ts';
import { positionAt } from '../../src/domain/selectors.ts';
import { DRAG_TYPE, usePlanner, useView } from '../lib/context.ts';
import { TaskCard } from './TaskCard.tsx';

interface TaskListProps {
  placement: Placement;
  tasks: Task[];
  empty?: string;
}

/** A droppable list: cards dragged onto it land at the indicated slot. */
export const TaskList = ({ placement, tasks, empty }: TaskListProps) => {
  const { client } = usePlanner();
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
        if (!event.dataTransfer?.types.includes(DRAG_TYPE)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setDropIndex(indexFor(event.clientY));
      }}
      onDragLeave={(event) => {
        if (!ref.current?.contains(event.relatedTarget as Node | null)) setDropIndex(null);
      }}
      onDrop={(event) => {
        event.preventDefault();
        const taskId = event.dataTransfer?.getData(DRAG_TYPE);
        const index = dropIndex ?? tasks.length;
        setDropIndex(null);
        if (!taskId || !view.state.tasks[taskId]) return;
        void client.dispatch([{ type: 'task.moved', taskId, placement, position: positionAt(view.state, placement, index, taskId) }]);
      }}
    >
      {tasks.map((task, index) => (
        <Fragment key={task.id}>
          {dropIndex === index && <li class="drop-line" aria-hidden="true" />}
          <TaskCard task={task} />
        </Fragment>
      ))}
      {dropIndex === tasks.length && <li class="drop-line" aria-hidden="true" />}
      {tasks.length === 0 && empty && dropIndex === null && <li class="empty">{empty}</li>}
    </ul>
  );
};
