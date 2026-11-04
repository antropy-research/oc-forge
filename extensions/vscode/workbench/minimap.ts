// The page's minimap, off while the page is narrow (pre-review row 11): beside the rail panel the page is about 340
// px wide at 1024, and the minimap took its share of that from the code. Back as the page widens, as the user has it.
//
// Per editor, in memory: VS Code merges a folder's settings with its memory layer into a cache that a memory change
// doesn't clear (`Configuration.updateValue` clears only the workspace's), so a global memory value set after a file
// of the folder opened never reached that file's editor; a value for the editor's resource is merged after that
// cache. A value removed reaches no editor either (VS Code tells editors of a change against the configuration
// without its memory layer, which had the user's value all along): a revision key changed with it does, and the
// editor reads all its options again (`editor.ocForgeRevision`, which no editor knows).
import { MINIMAP_MIN_WIDTH } from '../src/surfaces.ts';
import { MEMORY_TARGET, type ConfigurationService, type EditorService, type Uri, type VscodeServices } from './vscode.ts';

const MINIMAP = 'editor.minimap.enabled';
const REVISION = 'editor.ocForgeRevision';

export const fitMinimap = (services: VscodeServices, width: () => number): void => {
  const configuration = services.get<ConfigurationService>('configurationService');
  const editors = services.get<EditorService>('editorService');
  /** The resources whose editors have the minimap off, by their text. */
  const off = new Map<string, Uri>();
  let revision = 0;
  let running = false;
  let again = false;
  const sync = async (): Promise<void> => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      const narrow = width() < MINIMAP_MIN_WIDTH;
      if (narrow) {
        for (const { editor } of editors.getEditors(1)) {
          const resource = editor.resource;
          if (!resource || off.has(resource.toString())) continue;
          off.set(resource.toString(), resource);
          await configuration.updateValue(MINIMAP, false, { resource }, MEMORY_TARGET).catch(() => undefined);
        }
      } else {
        for (const [key, resource] of [...off]) {
          off.delete(key);
          await configuration.updateValue(MINIMAP, undefined, { resource }, MEMORY_TARGET).catch(() => undefined);
          await configuration.updateValue(REVISION, ++revision, { resource }, MEMORY_TARGET).catch(() => undefined);
        }
      }
    } finally {
      running = false;
      if (again) {
        again = false;
        void sync();
      }
    }
  };
  editors.onDidEditorsChange(() => void sync());
  let resized: ReturnType<typeof setTimeout> | null = null;
  window.addEventListener('resize', () => {
    if (resized) clearTimeout(resized);
    resized = setTimeout(() => void sync(), 200);
  });
  void sync();
};
