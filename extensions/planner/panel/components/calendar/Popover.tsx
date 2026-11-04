import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Anchor } from '../../lib/gcal.ts';

const MARGIN = 8;

/**
 * A card beside what was clicked, like Google Calendar's: to its right when
 * there is room, else to its left, else over it, always inside the window.
 * Escape and a click elsewhere close it.
 */
export const Popover = ({ anchor, label, onClose, width = 400, className = '', children }: { anchor: Anchor; label: string; onClose: () => void; width?: number; className?: string; children: ComponentChildren }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number; width: number } | null>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const w = Math.min(width, viewportWidth - 2 * MARGIN);
      const height = element.offsetHeight;
      let left = anchor.x + anchor.width + MARGIN;
      if (left + w > viewportWidth - MARGIN) left = anchor.x - MARGIN - w;
      if (left < MARGIN) left = Math.max(MARGIN, Math.min(viewportWidth - w - MARGIN, anchor.x + anchor.width / 2 - w / 2));
      const top = Math.max(MARGIN, Math.min(anchor.y, viewportHeight - height - MARGIN));
      setPlace((current) => (current && current.left === left && current.top === top && current.width === w ? current : { left, top, width: w }));
    };
    measure();
    // Details arrive after the popover opens: keep it inside the window as it grows.
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [anchor.x, anchor.y, anchor.width, anchor.height, width]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    const onDown = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (!ref.current || ref.current.contains(target) || target?.closest?.('.gcal-question, .gcal-popover')) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);

  useEffect(() => {
    // Focus the card, so keys reach it and a reader announces it.
    ref.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div
      class={`gcal-popover ${className}`}
      ref={ref}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      style={{ width: `${place?.width ?? Math.min(width, window.innerWidth - 2 * MARGIN)}px`, left: `${place?.left ?? -9999}px`, top: `${place?.top ?? 0}px`, visibility: place ? 'visible' : 'hidden' }}
    >
      {children}
    </div>
  );
};
