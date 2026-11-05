// Google Tasks' keyboard shortcuts, listed as its help lists them (Ctrl/⌘ + / in the Tasks view).
import { useForge } from '../../../lib/openchamber/forge.ts';
import { PRINT_NEEDS_HOST, canPrint } from '../../../lib/openchamber/print.ts';
import { Icon } from '../../calendar/Icon.tsx';

/** Google Tasks' keyboard shortcuts, as its help lists them ("⌘" on a Mac, "Ctrl" elsewhere), with what each does here. */
const TASK_SHORTCUTS: readonly { keys: string; action: string; note?: string }[] = [
  { keys: 'Enter', action: "Create a task; in a task's title, Add below; on a selected task, open it" },
  { keys: 'Space', action: 'Mark a task as complete' },
  { keys: 'Ctrl/⌘ + ]', action: 'Indent task' },
  { keys: 'Ctrl/⌘ + [', action: 'Remove indent' },
  { keys: 'Ctrl/⌘ + Alt/Opt + Enter', action: 'Add sub-item' },
  { keys: 'Esc or Enter', action: 'Finish editing' },
  { keys: '. or v', action: 'More actions, Move to list' },
  { keys: 'Ctrl/⌘ + Up / Down', action: 'Move up / Move down' },
  { keys: 'Ctrl/⌘ + Shift + Up / Down', action: 'Move to top / Move to bottom' },
  { keys: 's, + or =', action: 'Add to starred (s again: Remove from starred)' },
  { keys: '-', action: 'Remove from starred' },
  { keys: 'Up / Down', action: 'Select the previous / next task' },
  { keys: 'Home / End (Opt + Up / Down)', action: 'Select first / Select last' },
  { keys: 'Ctrl/⌘ + /', action: 'Show the list of shortcuts' },
  { keys: 'Ctrl/⌘ + z', action: 'Undo (a deletion)' },
  { keys: 'Ctrl/⌘ + p', action: 'Print the list: the one with the focus, else the one shown (List options → Print list)' },
  { keys: '!', action: 'Report spam', note: "Shared tasks are reported in the Doc or Chat space they come from: Google's Tasks API has no spam report" },
];

/** The list of Google Tasks' shortcuts (Ctrl/⌘ + /); Print says why it is unavailable where the host can't print. */
export const ShortcutsDialog = ({ onClose }: { onClose: () => void }) => {
  const printing = canPrint(useForge());
  return (
    <div class="modal-backdrop is-top" onMouseDown={(event) => event.target === event.currentTarget && onClose()} onKeyDown={(event) => event.key === 'Escape' && onClose()}>
      <div class="modal gt-shortcuts" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
        <div class="gt-editor-bar">
          <h2>Keyboard shortcuts</h2>
          <button class="icon-button" aria-label="Close" title="Close" ref={(element) => element?.focus()} onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <table class="gt-shortcut-table">
          <tbody>
            {TASK_SHORTCUTS.map((shortcut) => {
              const note = shortcut.note ?? (shortcut.keys === 'Ctrl/⌘ + p' && !printing ? PRINT_NEEDS_HOST : undefined);
              return (
                <tr key={shortcut.keys} class={note ? 'is-unavailable' : ''}>
                  <td><kbd>{shortcut.keys}</kbd></td>
                  <td>
                    {shortcut.action}
                    {note && <div class="gt-form-note">{note}</div>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
