// The changes the compiled VS Code workbench needs to run in an OpenChamber
// extension frame: a sandboxed, opaque-origin document whose only way out is the
// extension's service. Each patch names the exact compiled code it changes and
// fails when that code is missing or ambiguous, so a VS Code release that moved
// it stops with a clear message instead of starting a half-working workbench.
// Pure: text in, text out.
//
// The frame provides `globalThis.__ocVSCode` before the workbench loads:
//   options(options)   adds OpenChamber's options to the ones VS Code's own embedder builds
//   workbench(handle)  receives the workbench API (commands, window, env) once it runs
//   connectionToken    sent where VS Code would send a vsda signature (see `sign` below)

export class PatchError extends Error {}

const IDENT = '[A-Za-z_$][\\w$]*';

const replaceOnce = (text: string, pattern: RegExp, replacement: string, what: string): string => {
  const matches = [...text.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))];
  if (matches.length !== 1) throw new PatchError(`${what}: expected one match in the compiled workbench, found ${matches.length}`);
  return text.replace(pattern, replacement);
};

const withoutSourceMap = (text: string): string => text.replace(/\n?\/\/# sourceMappingURL=\S+\s*$/u, '\n');

/** The workbench bundle (`out/vs/code/browser/workbench/workbench.js`). */
export const patchWorkbench = (source: string): string => {
  let text = withoutSourceMap(source);
  // VS Code's own embedder ends by calling create(document.body, {...config, ...}).
  // Route that options object through the frame, which adds the tunnel, the
  // folder, the workspace provider and the rest of OpenChamber's options.
  text = replaceOnce(
    text,
    new RegExp(`(${IDENT})\\((${IDENT})\\.document\\.body,\\{\\.\\.\\.(${IDENT}),windowIndicator:`),
    '$1($2.document.body,globalThis.__ocVSCode.options({...$3,windowIndicator:',
    'the embedder\'s create() call',
  );
  text = replaceOnce(text, /\}\)\}\)\(\);export\{/, '}))})();export{', 'the end of the embedder');
  // Hand the workbench API (commands, window, env) to the frame once it runs.
  text = replaceOnce(
    text,
    new RegExp(`\\.open\\(\\)\\.then\\((${IDENT})=>\\{(${IDENT})=\\1,(${IDENT})\\.complete\\(\\1\\)\\}\\)`),
    '.open().then($1=>{$2=$1,$3.complete($1),globalThis.__ocVSCode.workbench?.($1)})',
    'the workbench promise',
  );
  // The remote handshake signs a challenge with vsda, whose WebAssembly needs
  // crypto.subtle, which a page served over plain HTTP does not have. The VS
  // Code Server also accepts its connection token in place of the signature,
  // so the frame never loads vsda and answers with the token.
  text = replaceOnce(
    text,
    new RegExp(`signValue\\((${IDENT})\\)\\{return this\\.vsda\\(\\)\\.then\\((${IDENT})=>\\2\\.sign\\(\\1\\)\\)\\}`),
    'signValue($1){return Promise.reject(new Error("vsda is not loaded inside OpenChamber"))}',
    'the vsda signer',
  );
  text = replaceOnce(
    text,
    /getValidator\(\)\{return this\.vsda\(\)\.then\(/,
    'getValidator(){return Promise.reject(new Error("vsda is not loaded inside OpenChamber")).then(',
    'the vsda validator',
  );
  text = replaceOnce(
    text,
    new RegExp(`async sign\\((${IDENT})\\)\\{try\\{return await this\\.signValue\\(\\1\\)\\}catch\\{\\}return \\1\\}`),
    'async sign($1){try{return await this.signValue($1)}catch{}return globalThis.__ocVSCode.connectionToken??$1}',
    'the handshake signature',
  );
  return renameWasm(text, 'the workbench');
};

/** WebAssembly the workbench fetches as bytes, under the name the cache stores it by. */
const renameWasm = (text: string, what: string): string => {
  if (!text.includes('release/onig.wasm')) throw new PatchError(`${what}: vscode-oniguruma's onig.wasm is not referenced`);
  return text.replace(/release\/onig\.wasm(?!\.json)/g, 'release/onig.wasm.json');
};

/** Any other script of the workbench (workers, keyboard layouts). */
export const patchScript = (source: string): string => withoutSourceMap(source);

/** The workbench stylesheet, with VS Code's icon font inside it (OpenChamber serves no fonts to a sandboxed frame). */
export const patchStylesheet = (source: string, codiconBase64: string): string => {
  const text = replaceOnce(
    source,
    /url\((["']?)\.\.\/\.\.\/\.\.\/\.\.\/media\/codicon\.ttf\1\)/,
    `url(data:font/ttf;base64,${codiconBase64})`,
    'the codicon font',
  );
  return text.replace(/\n?\/\*# sourceMappingURL=\S+\s*\*\/\s*$/u, '\n');
};

/**
 * The page that hosts the web worker extension host. In an opaque-origin frame
 * a module worker cannot start from a blob: URL, but can from a data: URL; and
 * `postMessage` cannot target the origin "null". Its inline script changes, so
 * its own CSP (a hash of that script) goes; OpenChamber's CSP still applies.
 */
export const patchExtensionHostIframe = (source: string): string => {
  let text = replaceOnce(source, /<meta http-equiv="Content-Security-Policy"[\s\S]*?\/>\s*/, '', 'the extension host page\'s CSP');
  text = replaceOnce(text, /const blob = new Blob\(\[\[/, 'const workerSource = [[', 'the worker source');
  text = replaceOnce(text, /\]\.join\(''\)\], \{ type: 'application\/javascript' \}\);/, "].join('')][0];", 'the worker blob');
  text = replaceOnce(
    text,
    /new Worker\(URL\.createObjectURL\(blob\), \{ name, type: 'module' \}\)/,
    "new Worker('data:text/javascript;charset=utf-8,' + encodeURIComponent(workerSource), { name, type: 'module' })",
    'the worker',
  );
  text = replaceOnce(text, /\}, parentOrigin, \[data\]\);/, "}, parentOrigin === 'null' ? '*' : parentOrigin, [data]);", 'the reply to the workbench');
  return text;
};
