// The Tasks view's menus (a task's ⋮ menu, List options, Starred options): fixed under the button that opens them, so
// a list's scrolling does not cut them off, and closed by a click elsewhere or when what is under them moves.
import { useEffect, useRef } from 'preact/hooks';

/** Closes a menu on a click elsewhere, or when what is under it scrolls away. */
export const useOutside = (open: boolean, onClose: () => void) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => !ref.current?.contains(event.target as Node) && onClose();
    document.addEventListener('mousedown', close);
    document.addEventListener('scroll', close, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', onClose);
    };
  }, [open]);
  return ref;
};

export type MenuPlace = { top?: number; bottom?: number; right: number; maxHeight: number };

/** A menu fixed under its button (over it, near the bottom), so a list's scrolling does not cut it off. */
export const placeMenu = (button: Element): MenuPlace => {
  const box = button.getBoundingClientRect();
  const right = Math.max(8, window.innerWidth - box.right);
  const below = window.innerHeight - box.bottom - 12;
  const above = box.top - 12;
  return below >= 280 || below >= above ? { top: box.bottom + 4, right, maxHeight: below } : { bottom: window.innerHeight - box.top + 4, right, maxHeight: above };
};

/**
 * The menu's place as inline style. Lengths are strings with their unit: Preact 11 no longer
 * adds "px" to numbers, and the browser drops a bare number. The other edge is reset, so
 * `.menu`'s own `top` cannot stretch a menu placed above its button.
 */
export const placed = (place: MenuPlace | null) =>
  place
    ? {
        position: 'fixed',
        top: place.top === undefined ? 'auto' : `${place.top}px`,
        bottom: place.bottom === undefined ? 'auto' : `${place.bottom}px`,
        left: 'auto',
        right: `${place.right}px`,
        maxHeight: `${place.maxHeight}px`,
        overflowY: 'auto',
      }
    : undefined;
