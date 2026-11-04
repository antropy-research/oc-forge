import { describe, expect, test } from 'bun:test';
import { clientFileName } from '../src/clientFiles.ts';

describe('the files a browser loads', () => {
  test('the workbench, its workers, styles and images are kept under their own names', () => {
    for (const path of [
      'out/vs/code/browser/workbench/workbench.js',
      'out/vs/code/browser/workbench/workbench.css',
      'out/nls.messages.js',
      'out/vs/editor/common/services/editorWebWorkerMain.js',
      'out/vs/workbench/services/extensions/worker/webWorkerExtensionHostIframe.html',
      'out/media/letterpress-dark.svg',
      'node_modules/@xterm/xterm/lib/xterm.js',
      'node_modules/vscode-oniguruma/release/main.js',
    ]) expect(clientFileName(path)).toBe(path);
  });

  test("WebAssembly goes in as .json, a type OpenChamber serves", () => {
    expect(clientFileName('node_modules/vscode-oniguruma/release/onig.wasm')).toBe('node_modules/vscode-oniguruma/release/onig.wasm.json');
    expect(clientFileName('node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter.wasm')).toBe('node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter.wasm.json');
  });

  test("the server's own code, sounds, maps, other modules and odd paths stay out", () => {
    for (const path of [
      'out/server-main.js',
      'out/vs/platform/terminal/node/ptyHostMain.js',
      'out/vs/workbench/api/node/extensionHostProcess.js',
      'out/nls.keys.json',
      'out/vs/code/browser/workbench/workbench.html',
      'out/vs/platform/accessibilitySignal/browser/media/clear.mp3',
      'out/media/codicon.ttf',
      'node_modules/node-pty/lib/index.js',
      'node_modules/@xterm/xterm/lib/xterm.js.map',
      'node_modules/@xterm/xterm/typings/xterm.d.ts',
      'node_modules/katex/node_modules/x/index.js',
      'extensions/theme-seti/icons/seti.woff',
      'out/../product.json',
    ]) expect(clientFileName(path)).toBeNull();
  });
});
