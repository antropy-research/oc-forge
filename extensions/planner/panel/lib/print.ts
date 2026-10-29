// Printing from the Planner's frame. What prints is a sheet of its own,
// mounted beside the app (`.print-root`, a child of the body), which print CSS
// shows alone: OpenChamber's UI is outside the frame, and the rest of the
// frame is hidden. A view keeps the sheet of what it would print up to date
// (`setPrintable`: the Tasks view's list), so print media always finds it; Print
// list and Ctrl/⌘+P put theirs in and open the browser's print dialog for the
// frame (`printNow`). That needs oc-forge's host: OpenChamber gives an
// extension's frames `sandbox="allow-scripts"`, where Chrome ignores `print()`
// ("Ignored call to 'print()'"); oc-forge's adds `allow-modals` for an
// extension that asks (`"ocForge": { "modals": true }`), and says so (`modals`).
import { render, type VNode } from 'preact';
import type { OcForgeClient } from '../../../../adapters/openchamber/client/index.ts';

/** Why Print is unavailable on a stock OpenChamber, or a host without `allow-modals`. */
export const PRINT_NEEDS_HOST = "Printing needs OpenChamber with oc-forge's host";

/** The host lets this frame open the print dialog (its frames have `allow-modals`). */
export const canPrint = (forge: OcForgeClient | null): boolean => Boolean(forge?.has('modals'));

let root: HTMLElement | null = null;
/** The sheet of what the view shown would print, by the view that keeps it. */
let printable: { owner: object; sheet: VNode } | null = null;
/** The sheet being printed now (Print list, Ctrl/⌘+P), until the dialog is closed. */
let printing: VNode | null = null;

const draw = (): void => {
  if (!root) {
    root = document.createElement('div');
    root.className = 'print-root';
    document.body.appendChild(root);
    window.addEventListener('afterprint', () => {
      printing = null;
      draw();
    });
  }
  render(printing ?? printable?.sheet ?? null, root);
};

/** What the view shown would print now; `owner` is the view keeping it. */
export const setPrintable = (owner: object, sheet: VNode): void => {
  printable = { owner, sheet };
  if (!printing) draw();
};

/** The view `owner` no longer has anything to print (it was closed). */
export const clearPrintable = (owner: object): void => {
  if (printable?.owner !== owner) return;
  printable = null;
  if (!printing) draw();
};

/**
 * Print `sheet` now: it goes in the print sheet at once (Preact's top-level render is synchronous, so the print
 * dialog finds it), then the browser's print dialog opens for this frame. Chrome's `print()` returns once the
 * dialog is closed; the view's own sheet comes back then.
 */
export const printNow = (sheet: VNode): void => {
  printing = sheet;
  draw();
  try {
    window.print();
  } finally {
    printing = null;
    draw();
  }
};

/** Print what the view shown keeps in the print sheet (Ctrl/⌘+P outside a list); false when it keeps nothing. */
export const printShown = (): boolean => {
  if (!printable) return false;
  printNow(printable.sheet);
  return true;
};
