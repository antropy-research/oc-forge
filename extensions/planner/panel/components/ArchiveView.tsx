import { useState } from 'preact/hooks';
import type { Task } from '../../src/domain/types.ts';
import { monthDay } from '../../src/domain/dates.ts';
import { archivedTasks, deletedTasks } from '../../src/domain/selectors.ts';
import { timeAgo } from '../../src/domain/activity.ts';
import { usePlanner, useView } from '../lib/context.ts';
import { moveTo } from '../lib/commands.ts';

const Row = ({ task, kind }: { task: Task; kind: 'archive' | 'trash' }) => {
  const { client } = usePlanner();
  const view = useView();
  const when = kind === 'archive' ? task.archivedAt : task.deletedAt;
  return (
    <li class="archive-row">
      <div class="archive-main">
        <div class="task-title">{task.title}</div>
        <div class="task-meta">
          {task.placement.kind === 'day' ? `Planned for ${monthDay(task.placement.date)}` : 'From the backlog'}
          {task.rolloverCount > 0 ? ` · rolled over ${task.rolloverCount} days` : ''}
          {when ? ` · ${kind === 'archive' ? 'archived' : 'deleted'} ${timeAgo(when)}` : ''}
        </div>
      </div>
      <div class="archive-actions">
        {kind === 'archive' ? (
          <>
            <button onClick={() => void client.dispatch([moveTo(view.state, task.id, { kind: 'day', date: view.today })], { undo: 'Moved to today' })}>Move to today</button>
            <button onClick={() => void client.dispatch([moveTo(view.state, task.id, { kind: 'backlog', bucket: 'next-weeks' }, 'top')], { undo: 'Moved to backlog' })}>Move to backlog</button>
            <button class="danger" onClick={() => void client.dispatch([{ type: 'task.deleted', taskId: task.id }], { undo: 'Task deleted' })}>Delete</button>
          </>
        ) : (
          <button onClick={() => void client.dispatch([{ type: 'task.restored', taskId: task.id }], { undo: 'Task restored' })}>Restore</button>
        )}
      </div>
    </li>
  );
};

/** Archive (long rollovers and archived tasks) and Trash (deleted tasks, restorable). */
export const ArchiveView = () => {
  const view = useView();
  const [tab, setTab] = useState<'archive' | 'trash'>('archive');
  const archived = archivedTasks(view.state);
  const trash = deletedTasks(view.state);
  const list = tab === 'archive' ? archived : trash;
  return (
    <section class="view">
      <header class="view-header">
        <h1>Archive</h1>
        <div class="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'archive'} onClick={() => setTab('archive')}>Archived {archived.length}</button>
          <button role="tab" aria-selected={tab === 'trash'} onClick={() => setTab('trash')}>Trash {trash.length}</button>
        </div>
      </header>
      <div class="view-scroll">
        {tab === 'archive' && <p class="hint">Tasks that kept rolling over move here; schedule the ones that still matter instead of carrying them every day.</p>}
        <ul class="archive-list">
          {list.map((task) => <Row key={task.id} task={task} kind={tab} />)}
          {list.length === 0 && <li class="empty">{tab === 'archive' ? 'Nothing archived' : 'Trash is empty'}</li>}
        </ul>
      </div>
    </section>
  );
};
