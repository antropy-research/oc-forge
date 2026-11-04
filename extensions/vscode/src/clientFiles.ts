// Which files of a VS Code Server install the browser loads, and the names they
// get in the extension's cache. OpenChamber serves an extension's files by type
// and knows only .html, .js, .css, .svg, .json and .png, so other files the
// workbench fetches as bytes (WebAssembly) are stored with `.json` appended and
// the workbench is pointed at that name (`patch.ts`). Pure.

/** Node modules the web workbench imports or fetches at run time (`importAMDNodeModule` / `resolveAmdNodeModulePath`). */
export const WEB_NODE_MODULES = [
  '@microsoft/1ds-core-js',
  '@microsoft/1ds-post-js',
  '@vscode/iconv-lite-umd',
  '@vscode/tree-sitter-wasm',
  '@vscode/vscode-languagedetection',
  '@xterm/addon-clipboard',
  '@xterm/addon-image',
  '@xterm/addon-ligatures',
  '@xterm/addon-progress',
  '@xterm/addon-search',
  '@xterm/addon-serialize',
  '@xterm/addon-unicode11',
  '@xterm/addon-webgl',
  '@xterm/xterm',
  'jschardet',
  'katex',
  'tas-client',
  'vscode-oniguruma',
  'vscode-regexp-languagedetection',
  'vscode-textmate',
] as const;

const SERVED = new Set(['.html', '.js', '.css', '.svg', '.json', '.png']);
const AS_JSON = new Set(['.wasm']);

const extension = (path: string): string => {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
};

/** Files under `out/` that only the server runs, or that the browser never loads. */
const serverOnly = (path: string): boolean => (
  /(^|\/)(node|electron-main|electron-utility|electron-browser)(\/|$)/.test(path)
  || /^(server-main|server-cli|bootstrap-fork|bootstrap-server|main|cli)\.js$/.test(path)
  || /^nls\.(keys|metadata|messages)\.json$/.test(path)
  || path === 'vs/code/browser/workbench/workbench.html'
  || path === 'vs/code/browser/workbench/callback.html'
);

/**
 * The cache name of a file of the install, relative to the install root
 * (`out/...`, `node_modules/...`), or null when the browser has no use for it.
 */
export const clientFileName = (relativePath: string): string | null => {
  const path = relativePath.replace(/^\.?\/+/, '');
  if (path.includes('..') || path.includes('\0')) return null;
  const ext = extension(path);
  if (path.startsWith('out/')) {
    const inner = path.slice('out/'.length);
    if (serverOnly(inner)) return null;
    // Maps for debugging and VS Code's sounds (no media type OpenChamber serves) stay out.
    if (!SERVED.has(ext)) return null;
    return path;
  }
  if (path.startsWith('node_modules/')) {
    const inner = path.slice('node_modules/'.length);
    const module = WEB_NODE_MODULES.find((name) => inner === name || inner.startsWith(`${name}/`));
    if (!module) return null;
    // Their own node_modules, tests and type declarations are not loaded in the browser.
    const rest = inner.slice(module.length + 1);
    if (/(^|\/)(node_modules|test|tests|typings)\//.test(rest) || rest.endsWith('.d.ts') || ext === '.map') return null;
    if (AS_JSON.has(ext)) return `${path}.json`;
    if (!SERVED.has(ext)) return null;
    return path;
  }
  return null;
};

/** Files of the install every workbench needs (the font is inlined into the CSS, not copied). */
export const REQUIRED_SOURCE_FILES = [
  'out/vs/code/browser/workbench/workbench.js',
  'out/vs/code/browser/workbench/workbench.css',
  'out/nls.messages.js',
  'out/media/codicon.ttf',
] as const;
