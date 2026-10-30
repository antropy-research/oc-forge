// The bar above a list, as in Linear: filters on the left, then how many
// issues and the Display options on the right.
import { useLinear, useView } from '../../lib/context.ts';
import { displayOf, type ListId } from '../../lib/linear.ts';
import { DisplayMenu, ProjectDisplayMenu } from './DisplayMenu.tsx';
import { FilterBar } from './FilterBar.tsx';

export interface MenuState {
  filterOpen: boolean;
  setFilterOpen: (open: boolean) => void;
  displayOpen: boolean;
  setDisplayOpen: (open: boolean) => void;
}

/** "320 issues", or "300+ issues" while Linear has more pages. */
export const countText = (count: number, more: boolean, noun = 'issue'): string => `${count}${more ? '+' : ''} ${noun}${count === 1 && !more ? '' : 's'}`;

export const ListToolbar = ({ listId, menus }: { listId: ListId; menus: MenuState }) => {
  const lv = useLinear();
  const view = useView();
  const list = lv.lists[listId];
  const more = Object.keys(list.more).length > 0;
  const projects = Boolean(list.projectDisplay);
  const display = displayOf(list, view.state.settings, listId);
  return (
    <div class="lin-bar">
      {!projects && <FilterBar listId={listId} open={menus.filterOpen} onOpenChange={menus.setFilterOpen} />}
      <span class="grow" />
      {!list.loading && <span class="lin-count" aria-live="polite">{projects ? countText(list.projects?.length ?? 0, more, 'project') : countText(list.issues.length, more)}</span>}
      <span class="lin-anchor">
        <button
          type="button"
          class="lin-button"
          aria-haspopup="dialog"
          aria-expanded={menus.displayOpen}
          title="Display options (Shift V)"
          onClick={() => menus.setDisplayOpen(!menus.displayOpen)}
        >
          <span aria-hidden="true">{display.layout === 'board' && !projects ? '▥' : '☰'}</span> Display
        </button>
        {menus.displayOpen && (projects ? <ProjectDisplayMenu listId={listId} onClose={() => menus.setDisplayOpen(false)} /> : <DisplayMenu listId={listId} onClose={() => menus.setDisplayOpen(false)} />)}
      </span>
    </div>
  );
};
