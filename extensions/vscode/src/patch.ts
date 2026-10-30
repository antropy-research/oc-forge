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
// and, for OpenChamber's own surfaces (the surface patches below):
//   services(instantiationService)  as the workbench starts, before it restores its editors and views
//   serviceIds         set by the workbench: VS Code's service identifiers by name
//   keyboard           true: keep the keybindings VS Code for the web drops in a browser tab
//   bare               true: the editor area and the panel may both be hidden (a view container alone)

export class PatchError extends Error {}

const IDENT = '[A-Za-z_$][\\w$]*';

const matchCount = (text: string, pattern: RegExp): number => [...text.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))].length;

const replaceOnce = (text: string, pattern: RegExp, replacement: string, what: string): string => {
  const matches = matchCount(text, pattern);
  if (matches !== 1) throw new PatchError(`${what}: expected one match in the compiled workbench, found ${matches}`);
  return text.replace(pattern, replacement);
};

const withoutSourceMap = (text: string): string => text.replace(/\n?\/\/# sourceMappingURL=\S+\s*$/u, '\n');

/**
 * The patches that let the frame show VS Code's parts in OpenChamber's own
 * surfaces (rail views, header tabs, the bottom terminal; `workbench/surfaces.ts`).
 * Unlike the others they may be missing: a release that moved one still runs,
 * as the whole workbench in each frame.
 */
const SURFACE_PATCHES: { what: string; pattern: RegExp; replacement: string }[] = [
  {
    // The instantiation service as the workbench starts: the frame reaches VS Code's services through it.
    what: 'the workbench startup',
    pattern: new RegExp(`let (${IDENT})=(${IDENT})\\.startup\\(\\);return this\\._register\\(\\1\\.createInstance\\(`),
    replacement: 'let $1=$2.startup();globalThis.__ocVSCode?.services?.($1);return this._register($1.createInstance(',
  },
  {
    // createDecorator(): the identifiers of VS Code's services by name.
    what: 'the service identifiers',
    pattern: new RegExp(`function (${IDENT})\\((${IDENT})\\)\\{if\\((${IDENT})\\.serviceIds\\.has\\(\\2\\)\\)return \\3\\.serviceIds\\.get\\(\\2\\);`),
    replacement: 'function $1($2){globalThis.__ocVSCode&&(globalThis.__ocVSCode.serviceIds=$3.serviceIds);if($3.serviceIds.has($2))return $3.serviceIds.get($2);',
  },
  {
    // BrowserFeatures.keyboard: VS Code for the web drops its Cmd/Ctrl+0–9 and Cmd/Ctrl+Alt+←/→
    // bindings in a browser tab. Inside OpenChamber VS Code keeps its keys while it has focus.
    what: 'the browser keyboard support',
    pattern: new RegExp(`keyboard:(${IDENT})\\|\\|(${IDENT})\\(\\)\\?0:navigator\\.keyboard\\|\\|(${IDENT})\\?1:2,`),
    replacement: 'keyboard:$1||$2()||globalThis.__ocVSCode?.keyboard===!0?0:navigator.keyboard||$3?1:2,',
  },
  {
    // "The editor and panel cannot be hidden at the same time": a rail view shows its view container alone.
    what: 'the editor area\'s hiding',
    pattern: new RegExp(`(${IDENT})&&!this\\.isVisible\\("workbench\\.parts\\.panel"\\)&&!this\\.isAuxiliaryBarMaximized\\(\\)&&this\\.setPanelHidden\\(!1,!0\\)`),
    replacement: '$1&&!this.isVisible("workbench.parts.panel")&&!this.isAuxiliaryBarMaximized()&&!globalThis.__ocVSCode?.bare&&this.setPanelHidden(!1,!0)',
  },
  {
    // The same rule as the layout is restored.
    what: 'the restored editor area',
    pattern: new RegExp(`(this\\.getRuntimeValue\\((${IDENT})\\.PANEL_HIDDEN\\)&&this\\.getRuntimeValue\\(\\2\\.EDITOR_HIDDEN\\)&&!this\\.getRuntimeValue\\(\\2\\.AUXILIARYBAR_WAS_LAST_MAXIMIZED\\)&&)(this\\.setRuntimeValue\\(\\2\\.EDITOR_HIDDEN,!1\\))`),
    replacement: '$1!globalThis.__ocVSCode?.bare&&$3',
  },
];

/** The surface patches by name, for reports. */
export const SURFACE_PATCH_NAMES = SURFACE_PATCHES.map((patch) => patch.what);

/**
 * The workbench bundle (`out/vs/code/browser/workbench/workbench.js`). The
 * surface patches that did not apply are added to `missing`.
 */
export const patchWorkbench = (source: string, missing: string[] = []): string => {
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
  // Webviews name their origin with a SHA-256 of the parent origin, which needs crypto.subtle
  // (absent over plain HTTP); with this extension's webview host the name is only an identifier.
  text = replaceOnce(
    text,
    new RegExp(`if\\(!crypto\\.subtle\\)throw new Error\\("'crypto\\.subtle' is not available so webviews will not work\\.[^"]*"\\);let (${IDENT})=JSON\\.stringify\\(\\{parentOrigin:(${IDENT}),salt:(${IDENT})\\}\\)`),
    'if(!crypto.subtle)return globalThis.__ocVSCode.originHash($2,$3);let $1=JSON.stringify({parentOrigin:$2,salt:$3})',
    'the webview origin hash',
  );
  // A webview frame inside this frame has an opaque origin too ("null"), not its URL's:
  // its messages are accepted when they come from that very frame.
  text = replaceOnce(
    text,
    new RegExp(`if\\((${IDENT})\\.origin!==this\\._webviewContentOrigin\\(this\\._encodedWebviewOrigin\\)\\)`),
    'if($1.origin!==this._webviewContentOrigin(this._encodedWebviewOrigin)&&!($1.origin==="null"&&$1.source===this.element?.contentWindow))',
    "the webview origin check",
  );
  for (const patch of SURFACE_PATCHES) {
    if (matchCount(text, patch.pattern) === 1) text = text.replace(patch.pattern, patch.replacement);
    else missing.push(patch.what);
  }
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
