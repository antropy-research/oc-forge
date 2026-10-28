// oc-forge's OpenChamber host APIs (adapters/openchamber; contract in its README):
// deep links, so a Cmd/Ctrl+click or a middle click opens the Planner's page (a
// task, a Linear issue) or a chat in a new browser tab, and OpenChamber's own
// tab shortcuts while the Planner has focus. On a stock OpenChamber
// connectOcForge() resolves null and the Planner works as it always has.
import { useEffect, useState } from 'preact/hooks';
import { connectOcForge, type OcForgeClient } from '../../../../adapters/openchamber/client/index.ts';
import { isNewTabClick, routeOf, type PlannerPlace } from './deepLink.ts';

let resolved: OcForgeClient | null = null;
let pending: Promise<OcForgeClient | null> | null = null;

/** The host's oc-forge client, once; null on a stock OpenChamber. */
export const forgeClient = (): Promise<OcForgeClient | null> =>
  (pending ??= connectOcForge()
    .then((client) => (resolved = client))
    .catch(() => null));

/** The client as soon as it has answered (re-renders then), else null. */
export const useForge = (): OcForgeClient | null => {
  const [forge, setForge] = useState<OcForgeClient | null>(resolved);
  useEffect(() => {
    let live = true;
    void forgeClient().then((client) => live && setForge(client));
    return () => {
      live = false;
    };
  }, []);
  return forge;
};

/** The Planner's page on a place, as an absolute URL; null where the host has no deep links. */
export const placeUrl = (place: PlannerPlace): string | null => resolved?.links.pageUrl(routeOf(place)) ?? null;

/** A chat's URL; null where the host has no deep links. */
export const chatUrl = (sessionId: string): string | null => resolved?.links.sessionUrl(sessionId) ?? null;

// The click being handled right now, when it asks for a new tab. Set in the
// capture phase before any handler runs and cleared when the dispatch is over,
// so whatever a handler opens synchronously (a task, an issue, a page, a chat)
// can go to a new tab instead.
let newTabClick: MouseEvent | null = null;

/** Whether the click being handled asks for a new tab (Cmd/Ctrl, or the middle button). */
export const wantsNewTab = (): boolean => newTabClick !== null;

/**
 * Watch clicks for the new-tab intent, once per document. A real link (`a[href]`)
 * is left to the browser, which opens it in a new tab itself. A middle click on
 * anything else is turned into a click, so the element's own handler runs.
 */
export const watchNewTabClicks = (doc: Document = document): (() => void) => {
  const onClick = (event: MouseEvent) => {
    if (!resolved || !isNewTabClick(event)) return;
    if ((event.target as Element | null)?.closest?.('a[href]')) return;
    newTabClick = event;
    setTimeout(() => {
      if (newTabClick === event) newTabClick = null;
    }, 0);
  };
  const onAuxClick = (event: MouseEvent) => {
    if (!resolved || event.button !== 1) return;
    const target = (event.target as Element | null)?.closest?.('button, [role="button"], [role="menuitem"], [role="option"], [role="link"], li[onclick], .task-card');
    if (!target || target.closest('a[href]')) return;
    event.preventDefault();
    newTabClick = event;
    try {
      (target as HTMLElement).click();
    } finally {
      newTabClick = null;
    }
  };
  // The middle button's own default (autoscroll) would start before auxclick.
  const onMouseDown = (event: MouseEvent) => {
    if (resolved && event.button === 1) event.preventDefault();
  };
  doc.addEventListener('click', onClick, true);
  doc.addEventListener('auxclick', onAuxClick, true);
  doc.addEventListener('mousedown', onMouseDown, true);
  return () => {
    doc.removeEventListener('click', onClick, true);
    doc.removeEventListener('auxclick', onAuxClick, true);
    doc.removeEventListener('mousedown', onMouseDown, true);
  };
};

/**
 * Open a URL in a new browser tab when the click being handled asks for one;
 * true when it did (the caller then stays where it is). `openUrl` is the SDK
 * host's, which opens a new tab within the click's user activation.
 */
export const openInNewTab = (url: string | null, openUrl: (url: string) => Promise<unknown>): boolean => {
  if (!url || !wantsNewTab()) return false;
  newTabClick = null;
  void openUrl(url).catch(() => {});
  return true;
};

/**
 * The keys the Planner keeps while it has focus; everything else bound to an
 * OpenChamber navigation action (switching tabs, surfaces or chats, closing a
 * tab, the sidebar, its command palette) goes to OpenChamber, not to Chrome.
 * Kept: anything typed into a field (Cmd/Ctrl+B is bold in the notes editor),
 * the Planner page's own command palette (Cmd/Ctrl+K), and the Linear page's
 * Cmd/Ctrl+B (list or board).
 */
export const plannerKeeps = (event: KeyboardEvent, where: { surface: string; page: string }): boolean => {
  const target = event.target as HTMLElement | null;
  if (target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)) return true;
  const mod = event.metaKey || event.ctrlKey;
  const key = event.key.toLowerCase();
  if (where.surface === 'page' && mod && key === 'k') return true;
  if (where.surface === 'page' && where.page === 'linear' && mod && key === 'b') return true;
  return false;
};
