// The Linear page's frame at any width, as Linear's: where the page is too
// narrow for its sidebar beside the list, the sidebar folds behind a toggle in
// the page header and opens over the list; "[" folds or opens it at any width.
// While the sidebar is folded, the header's search stands in for its search
// box, so "/" always lands in a search box on screen.
import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import { Kbd } from './icons.tsx';

export interface LinearChrome {
  /** The page is too narrow for the sidebar beside the list: it opens over the list. */
  narrow: boolean;
  /** The sidebar is on screen, beside the list or over it. */
  sidebarShown: boolean;
  toggleSidebar: () => void;
  toggleRef: { current: HTMLButtonElement | null };
  /** The header's search, while the sidebar's is folded away. */
  search: {
    term: string;
    setTerm: (term: string) => void;
    submit: () => void;
    open: boolean;
    setOpen: (open: boolean) => void;
    inputRef: { current: HTMLInputElement | null };
  };
}

export const LinearChromeContext = createContext<LinearChrome | null>(null);

const SidebarIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.3" />
    <path d="M6 2.5v11" stroke="currentColor" stroke-width="1.3" />
  </svg>
);

/** The header's button that brings the sidebar back while it is folded (or, on a narrow page, opens it over the list). */
export const SidebarToggle = () => {
  const chrome = useContext(LinearChromeContext);
  if (!chrome || chrome.sidebarShown) return null;
  return (
    <button type="button" ref={chrome.toggleRef} class="lin-icon-button lin-sidebar-toggle" aria-label="Show the sidebar" aria-expanded="false" title="Sidebar ( [ )" onClick={chrome.toggleSidebar}>
      <SidebarIcon />
    </button>
  );
};

/** The header's search while the sidebar is folded: a button that opens into a field (as "/" does). */
export const HeadSearch = () => {
  const chrome = useContext(LinearChromeContext);
  if (!chrome || chrome.sidebarShown) return null;
  const { search } = chrome;
  if (!search.open) {
    return (
      <button type="button" class="lin-icon-button" aria-label="Search issues" title="Search ( / )" onClick={() => search.setOpen(true)}>
        <span aria-hidden="true">⌕</span>
      </button>
    );
  }
  return (
    <form
      class="lin-search lin-head-search"
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        search.submit();
      }}
    >
      <span class="lin-head-search-icon" aria-hidden="true">⌕</span>
      <input
        ref={search.inputRef}
        type="search"
        value={search.term}
        placeholder="Search issues…"
        aria-label="Search Linear issues"
        onInput={(event) => search.setTerm(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          search.setOpen(false);
        }}
        onBlur={() => {
          if (!search.term.trim()) search.setOpen(false);
        }}
      />
      <Kbd>/</Kbd>
    </form>
  );
};
