// A popover placed against its anchor in the window, so a scrolling list it
// opens from (a day column, the sources panel) does not cut it off.
import { useLayoutEffect, useState } from 'preact/hooks';

export interface Place {
  top: number;
  left: number;
  /** Set when the popover fits on neither side: it gets the larger side and scrolls. */
  maxHeight: number | null;
}

const MARGIN = 8;
const GAP = 4;

/**
 * Where a `width` × `height` popover goes for an anchor box, inside the window:
 * below it, else above it, else on the roomier side at that side's height. It
 * never covers its anchor.
 */
export const placeBeside = (anchor: { top: number; bottom: number; left: number; right: number }, width: number, height: number, view: { width: number; height: number }, align: 'left' | 'right'): Place => {
  const left = Math.max(MARGIN, Math.min(align === 'left' ? anchor.left : anchor.right - width, view.width - width - MARGIN));
  const below = view.height - anchor.bottom - GAP - MARGIN;
  const above = anchor.top - GAP - MARGIN;
  if (height <= below) return { left, top: anchor.bottom + GAP, maxHeight: null };
  if (height <= above) return { left, top: anchor.top - GAP - height, maxHeight: null };
  return below >= above ? { left, top: anchor.bottom + GAP, maxHeight: Math.max(120, below) } : { left, top: Math.max(MARGIN, anchor.top - GAP - above), maxHeight: Math.max(120, above) };
};

/**
 * Fixed-position style for the popover in `ref`, beside its parent element,
 * kept there while anything scrolls or the window resizes. Hidden until placed.
 */
export const useFixedPlace = (ref: { current: HTMLElement | null }, align: 'left' | 'right', remeasure: unknown = null): Record<string, string> => {
  const [place, setPlace] = useState<Place | null>(null);
  useLayoutEffect(() => {
    const update = () => {
      const element = ref.current;
      const anchor = element?.parentElement;
      if (!element || !anchor) return;
      // Its natural height, not the one a previous placement capped.
      const capped = element.style.maxHeight;
      element.style.maxHeight = '';
      const height = element.offsetHeight;
      element.style.maxHeight = capped;
      const next = placeBeside(anchor.getBoundingClientRect(), element.offsetWidth, height, { width: window.innerWidth, height: window.innerHeight }, align);
      setPlace((current) => (current && current.top === next.top && current.left === next.left && current.maxHeight === next.maxHeight ? current : next));
    };
    update();
    window.addEventListener('resize', update);
    document.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      document.removeEventListener('scroll', update, true);
    };
  }, [align, remeasure]);
  if (!place) return { position: 'fixed', visibility: 'hidden', top: '0px', left: '0px' };
  return { position: 'fixed', top: `${place.top}px`, left: `${place.left}px`, right: 'auto', bottom: 'auto', ...(place.maxHeight !== null ? { maxHeight: `${place.maxHeight}px` } : {}) };
};
