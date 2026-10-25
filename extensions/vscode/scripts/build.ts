#!/usr/bin/env bun
// Build the panel and the file editor. Extension frames are sandboxed and load
// no ESM, so both are browser IIFEs. The editor is Monaco's editor features
// without Monaco's own languages (VS Code's grammars color instead), with its
// CSS and codicon font beside it, its helper worker inlined as source, and
// vscode-oniguruma's WASM for the grammars' regular expressions.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { BunPlugin } from 'bun';

const root = join(import.meta.dir, '..');
const fail = (what: string, logs: { message: string }[]): never => {
  console.error(`${what} did not build:\n${logs.map((log) => log.message).join('\n')}`);
  process.exit(1);
};

// Monaco's entry imports every feature and every language; keep the features.
const monacoEditor = dirname(Bun.resolveSync('monaco-editor/editor/editor.api.js', root));
const features = readFileSync(join(monacoEditor, 'editor.main.js'), 'utf8')
  .split('\n')
  .filter((line) => /^import '/.test(line) && !line.includes('/languages/definitions/'))
  .map((line) => line.replace(/^import '(\.[^']+)';/, (_match, path: string) => `import ${JSON.stringify(resolve(monacoEditor, path))};`))
  .join('\n');
const featuresPlugin: BunPlugin = {
  name: 'monaco-features',
  setup(build) {
    build.onResolve({ filter: /^virtual:monaco-features$/ }, () => ({ path: 'monaco-features', namespace: 'monaco-features' }));
    build.onLoad({ filter: /.*/, namespace: 'monaco-features' }, () => ({ contents: features, loader: 'js' }));
  },
};

/**
 * A classic script cannot say `import.meta`; Monaco uses it only to locate its
 * worker module, which this build supplies itself (MonacoEnvironment.getWorker).
 */
const classic = (code: string): string => code.replaceAll('import.meta.url', 'self.location.href');

const worker = await Bun.build({ entrypoints: [join(root, 'editor/worker.ts')], format: 'iife', target: 'browser', minify: true });
if (!worker.success) fail('The editor worker', worker.logs);
const workerSource = classic(await worker.outputs[0]!.text());

const editorOut = join(root, 'editor/build');
rmSync(editorOut, { recursive: true, force: true });
mkdirSync(editorOut, { recursive: true });
const editor = await Bun.build({
  entrypoints: [join(root, 'editor/main.ts')],
  outdir: editorOut,
  format: 'iife',
  target: 'browser',
  minify: true,
  naming: { entry: '[name].[ext]', asset: '[name].[ext]', chunk: '[name].[ext]' },
  // OpenChamber serves an extension's files by type and has none for .wasm, so the WASM rides in the script.
  define: { __WORKER_SOURCE__: JSON.stringify(workerSource), __ONIG_WASM__: JSON.stringify(readFileSync(Bun.resolveSync('vscode-oniguruma/release/onig.wasm', root)).toString('base64')) },
  plugins: [featuresPlugin],
});
if (!editor.success) fail('The editor', editor.logs);
for (const output of editor.outputs) if (output.path.endsWith('.js')) writeFileSync(output.path, classic(readFileSync(output.path, 'utf8')));
// Fonts from a sandboxed page need CORS headers OpenChamber does not send for them; the codicon font goes into the CSS.
for (const output of editor.outputs.filter((item) => item.path.endsWith('.css'))) {
  const css = readFileSync(output.path, 'utf8').replace(/url\(\.\/([\w.-]+\.ttf)\)/g, (_match, name: string) => `url(data:font/ttf;base64,${readFileSync(join(editorOut, name)).toString('base64')})`);
  writeFileSync(output.path, css);
}
for (const output of editor.outputs.filter((item) => item.path.endsWith('.ttf'))) rmSync(output.path);
if (editor.outputs.some((output) => output.path.endsWith('.js') && readFileSync(output.path, 'utf8').includes('import.meta'))) fail('The editor', [{ message: 'import.meta is left in a classic script' }]);

const panel = await Bun.build({ entrypoints: [join(root, 'panel/main.ts')], format: 'iife', target: 'browser', minify: true });
if (!panel.success) fail('The panel', panel.logs);
writeFileSync(join(root, 'panel/main.js'), await panel.outputs[0]!.text());

const size = (path: string) => `${(statSync(path).size / 1e6).toFixed(2)} MB`;
console.log(`panel/main.js ${size(join(root, 'panel/main.js'))}`);
for (const output of editor.outputs.filter((item) => !item.path.endsWith('.ttf'))) console.log(`editor/build/${output.path.split('/').pop()} ${size(output.path)}`);
console.log(`inlined: the worker ${(workerSource.length / 1e6).toFixed(2)} MB, vscode-oniguruma's WASM`);
