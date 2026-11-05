// Google Tasks' Starred in the Tasks view: the starred open tasks of every list, in one column.
import { useEffect, useState } from 'preact/hooks';
import type { GoogleTaskList } from '../../../../src/domain/google/google.ts';
import { keptFor, starredKept } from '../../../../src/domain/google/taskKept.ts';
import { printedList } from '../../../../src/domain/google/taskPrint.ts';
import { useGoogle, usePlanner, useView } from '../../../lib/core/context.ts';
import { completeWithUndo } from '../../../lib/google/store.ts';
import { listKey, REPEATING_STAYS } from '../../../lib/google/types.ts';
import { Icon } from '../../calendar/Icon.tsx';
import { addFromForm, inGoogle, repeatBlock, useTaskSave } from './actions.ts';
import { placeMenu, placed, useOutside, type MenuPlace } from './menu.ts';
import { usePrintable } from './PrintSheet.tsx';
import { KeptHint, TaskForm } from './TaskForm.tsx';
import { StarButton, TaskBody } from './TaskRow.tsx';

/**
 * Google Tasks' Starred: the starred open tasks of every list, the newest star first or by date; each edits in
 * place, its primary list too; a starred task is added from here to the list chosen.
 */
export const StarredColumn = ({ lists }: { lists: GoogleTaskList[] }) => {
  const { google, client } = usePlanner();
  const gv = useGoogle();
  const view = useView();
  const saveTask = useTaskSave();
  const [editing, setEditing] = useState<string | null>(null);
  const [order, setOrder] = useState<'starred' | 'date'>('starred');
  const [menu, setMenu] = useState(false);
  const [menuAt, setMenuAt] = useState<MenuPlace | null>(null);
  const menuRef = useOutside(menu, () => setMenu(false));
  const [adding, setAdding] = useState(false);
  const [addTo, setAddTo] = useState<string>(() => {
    const first = lists.find((list) => list.isDefault) ?? lists[0];
    return first ? listKey(first.account, first.id) : '';
  });
  const starred = starredKept(view.state);
  const keys = [...new Set(starred.map((kept) => listKey(kept.account, kept.listId)))];
  // Their lists are read, as each list's own column reads it.
  useEffect(() => {
    for (const key of keys) {
      const [account, listId] = key.split('\n');
      if (account && listId && !gv.board[key]) void google.loadBoard(account, listId);
    }
  }, [keys.join('|')]);
  const several = new Set(lists.map((list) => list.account)).size > 1;
  const found = starred.flatMap((kept) => {
    const item = gv.board[listKey(kept.account, kept.listId)]?.items.find((other) => other.id === kept.taskId);
    const list = lists.find((other) => other.account === kept.account && other.id === kept.listId);
    return item && !item.completed ? [{ item, kept, list: list ? `${list.title}${several ? ` · ${list.account}` : ''}` : '' }] : [];
  });
  // Google Tasks' Starred sorts by "Recently starred" or by "Date" (its date, then the ones without one).
  const rows = order === 'date' ? [...found].sort((a, b) => (a.item.due ?? '9999').localeCompare(b.item.due ?? '9999') || (a.kept.time ?? -1) - (b.kept.time ?? -1)) : found;
  const loading = keys.some((key) => gv.board[key]?.loading);
  // Ctrl/⌘+P here prints Starred as it shows, each task with its list.
  usePrintable(true, () =>
    printedList({ title: 'Starred', account: null, items: rows.map((row) => row.item), kept: (item) => keptFor(view.state, item), sort: 'shown', today: view.today, zone: view.state.settings.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, showCompleted: false, complete: true, listOf: (item) => rows.find((row) => row.item.id === item.id)?.list ?? '' }),
  );
  const target = lists.find((list) => listKey(list.account, list.id) === addTo) ?? lists[0];
  return (
    <section class="gt-list" aria-label="Starred">
      <header class="gt-list-head">
        <h2>Starred</h2>
        <div class="menu-anchor" ref={menuRef}>
          <button class="more is-visible" aria-label="Starred options" aria-haspopup="menu" onClick={(click) => { setMenuAt(placeMenu(click.currentTarget)); setMenu(!menu); }}>
            <Icon name="more" size={18} />
          </button>
          {menu && (
            <div class="menu" role="menu" aria-label="Starred options" style={placed(menuAt)}>
              <div class="menu-label">Sort by</div>
              {([['date', 'Date'], ['starred', 'Recently starred']] as const).map(([id, label]) => (
                <button key={id} role="menuitemradio" aria-checked={order === id} onClick={() => { setMenu(false); setOrder(id); }}>
                  <span class="menu-check">{order === id ? '✓' : ''}</span>{label}
                </button>
              ))}
            </div>
          )}
        </div>
      </header>
      <button class="gt-add" onClick={() => setAdding(true)}>
        <Icon name="task" size={20} />
        <span>Add a starred task</span>
      </button>
      {adding && target && (
        <div class="gt-starred-add">
          <label class="gt-form-row gt-starred-list">
            <Icon name="task" size={16} />
            <span class="gt-form-label">Its list</span>
            <select aria-label="List for the starred task" value={listKey(target.account, target.id)} onChange={(event) => setAddTo(event.currentTarget.value)}>
              {lists.map((list) => <option key={listKey(list.account, list.id)} value={listKey(list.account, list.id)}>{list.title}{several ? ` · ${list.account}` : ''}</option>)}
            </select>
          </label>
          <TaskForm
            key={listKey(target.account, target.id)}
            item={{ account: target.account, listId: target.id }}
            kept={null}
            depth={0}
            canRepeat
            keepOpen
            star={false}
            onCancel={() => setAdding(false)}
            // Starred from the start, in the list chosen (its primary list), as Google Tasks adds one from Starred.
            onSave={(fields) => addFromForm(google, target.account, target.id, fields, true)}
          />
        </div>
      )}
      <KeptHint />
      <ul class="gt-rows" aria-label="Starred tasks">
        {rows.map(({ item, kept, list }) =>
          editing === item.id ? (
            <li key={item.id} class="gt-row depth-0 is-editing">
              <TaskForm
                item={item}
                kept={kept}
                depth={0}
                canRepeat={Boolean(kept.repeat) || !repeatBlock(item, gv.board[listKey(item.account, item.listId)]?.items ?? [])}
                repeatNote={repeatBlock(item, gv.board[listKey(item.account, item.listId)]?.items ?? [])}
                // Its primary list, as Google Tasks' Starred changes it (a repeating task stays in its own).
                lists={{ lists: lists.filter((other) => other.account === item.account), locked: kept.repeat ? REPEATING_STAYS : null }}
                onCancel={() => setEditing(null)}
                onSave={(fields, star, listId) => saveTask(item, fields, star, undefined, listId).then((saved) => saved && setEditing(null))}
              />
            </li>
          ) : (
            <li key={item.id} class="gt-row depth-0 is-starred-row" aria-label={item.title}>
              <span class="gt-handle" aria-hidden="true" />
              <button class="gt-check" role="checkbox" aria-checked="false" aria-label={`Mark ${item.title} complete`} onClick={() => void inGoogle(client.notify, () => completeWithUndo(google, client.notify, item))}>
                <Icon name="circle" size={20} />
                <span class="gt-check-hover"><Icon name="check" size={14} /></span>
              </button>
              <TaskBody item={item} kept={kept} list={list} onEdit={() => setEditing(item.id)} />
              <StarButton item={item} kept={kept} />
            </li>
          ),
        )}
      </ul>
      {!rows.length && <p class="gt-empty">{loading ? 'Loading…' : 'No starred tasks. Star a task to see it here, from every list.'}</p>}
    </section>
  );
};
