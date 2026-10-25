import { useState } from 'preact/hooks';
import { BACKLOG_BUCKETS, type Task } from '../../src/domain/types.ts';
import { backlogTasks } from '../../src/domain/selectors.ts';
import { usePlanner, useView } from '../lib/context.ts';
import { matchesFilter, useUi } from '../lib/ui.ts';
import { AddTask } from './AddTask.tsx';
import { BraindumpModal } from './Braindump.tsx';
import { ChannelFilter } from './ChannelFilter.tsx';
import { TaskList } from './TaskList.tsx';

export interface BacklogFilter {
  search: string;
  /** A folder id, 'none' for tasks outside folders, or null for every task. */
  folderId: string | null;
}

const matchesBacklog = (task: Task, filter: BacklogFilter | undefined): boolean => {
  if (!filter) return true;
  if (filter.folderId === 'none' ? task.folderId !== null : filter.folderId !== null && task.folderId !== filter.folderId) return false;
  const query = filter.search.trim().toLowerCase();
  return !query || task.title.toLowerCase().includes(query) || task.notes.toLowerCase().includes(query);
};

/** Every backlog bucket with its tasks; `compact` renders the side-panel version. */
export const BacklogBuckets = ({ compact = false, filter }: { compact?: boolean; filter?: BacklogFilter }) => {
  const view = useView();
  const { ui } = useUi();
  const folderId = filter?.folderId && filter.folderId !== 'none' ? filter.folderId : null;
  return (
    <div class={`buckets${compact ? ' is-compact' : ''}`}>
      {BACKLOG_BUCKETS.map((bucket) => {
        const tasks = backlogTasks(view.state, bucket.id).filter((task) => matchesFilter(task, ui.channelFilter, view.state.channels) && matchesBacklog(task, filter));
        if (compact && tasks.length === 0 && bucket.id !== 'next-weeks') return null;
        return (
          <section class="bucket" key={bucket.id} aria-label={bucket.label}>
            <h3>
              {bucket.label}
              {tasks.length > 0 && <span class="count">{tasks.length}</span>}
            </h3>
            {!compact && <AddTask placement={{ kind: 'backlog', bucket: bucket.id }} folderId={folderId} />}
            <TaskList placement={{ kind: 'backlog', bucket: bucket.id }} tasks={tasks} empty={compact ? undefined : 'Drop tasks here'} />
          </section>
        );
      })}
    </div>
  );
};

/** The backlog page: buckets, search, channel and folder filters, Braindump. */
export const Backlog = () => {
  const { client } = usePlanner();
  const view = useView();
  const { ui, setUi } = useUi();
  const [search, setSearch] = useState('');
  const [dumping, setDumping] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const folders = Object.values(view.state.folders).filter((folder) => !folder.deletedAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const folder = ui.folderFilter && ui.folderFilter !== 'none' ? view.state.folders[ui.folderFilter] : null;
  return (
    <section class="view">
      <header class="view-header">
        <h1>{folder ? folder.name : 'Backlog'}</h1>
        <span class="view-sub">{folder ? 'Backlog folder' : 'Work you will get to, without a day yet'}</span>
        <div class="date-nav">
          <input class="filter backlog-search" value={search} placeholder="Search backlog" aria-label="Search backlog" onInput={(event) => setSearch(event.currentTarget.value)} />
          <ChannelFilter />
          <select class="filter" aria-label="Folder" value={ui.folderFilter ?? ''} onChange={(event) => setUi({ folderFilter: event.currentTarget.value || null })}>
            <option value="">All folders</option>
            {folders.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            <option value="none">Not in a folder</option>
          </select>
          <button onClick={() => setDumping(true)}>Braindump</button>
        </div>
      </header>
      {folder && (
        <div class="folder-bar">
          {renaming ? (
            <input
              class="filter"
              aria-label="Folder name"
              defaultValue={folder.name}
              ref={(element) => element?.focus()}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setRenaming(false);
                if (event.key !== 'Enter') return;
                const name = event.currentTarget.value.trim();
                if (name && name !== folder.name) void client.dispatch([{ type: 'folder.renamed', folderId: folder.id, name: name.slice(0, 60) }]);
                setRenaming(false);
              }}
              onBlur={() => setRenaming(false)}
            />
          ) : (
            <button class="link" onClick={() => setRenaming(true)}>Rename</button>
          )}
          <button class="link danger" onClick={() => { void client.dispatch([{ type: 'folder.deleted', folderId: folder.id }]); setUi({ folderFilter: null }); }}>Delete folder (keeps its tasks)</button>
        </div>
      )}
      <div class="view-scroll">
        <BacklogBuckets filter={{ search, folderId: ui.folderFilter }} />
      </div>
      {dumping && <BraindumpModal folderId={folder?.id ?? null} onClose={() => setDumping(false)} />}
    </section>
  );
};
