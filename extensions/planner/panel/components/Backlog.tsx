import { BACKLOG_BUCKETS } from '../../src/domain/types.ts';
import { backlogTasks } from '../../src/domain/selectors.ts';
import { useView } from '../lib/context.ts';
import { AddTask } from './AddTask.tsx';
import { TaskList } from './TaskList.tsx';

/** Every backlog bucket with its tasks; `compact` renders the side-panel version. */
export const BacklogBuckets = ({ compact = false }: { compact?: boolean }) => {
  const view = useView();
  return (
    <div class={`buckets${compact ? ' is-compact' : ''}`}>
      {BACKLOG_BUCKETS.map((bucket) => {
        const tasks = backlogTasks(view.state, bucket.id);
        if (compact && tasks.length === 0 && bucket.id !== 'next-weeks') return null;
        return (
          <section class="bucket" key={bucket.id} aria-label={bucket.label}>
            <h3>
              {bucket.label}
              {tasks.length > 0 && <span class="count">{tasks.length}</span>}
            </h3>
            {!compact && <AddTask placement={{ kind: 'backlog', bucket: bucket.id }} />}
            <TaskList placement={{ kind: 'backlog', bucket: bucket.id }} tasks={tasks} empty={compact ? undefined : 'Drop tasks here'} />
          </section>
        );
      })}
    </div>
  );
};

export const Backlog = () => (
  <section class="view">
    <header class="view-header">
      <h1>Backlog</h1>
      <span class="view-sub">Work you will get to, without a day yet</span>
    </header>
    <div class="view-scroll">
      <BacklogBuckets />
    </div>
  </section>
);
