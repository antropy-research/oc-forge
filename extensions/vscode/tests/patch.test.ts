import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { patchExtensionHostIframe, patchScript, patchStylesheet, patchWorkbench, PatchError, SURFACE_PATCH_NAMES } from '../src/patch.ts';

// The shapes the patches look for, as VS Code 1.140's compiled workbench has them (1.143.1's are the same).
const surfaceLines = [
  'var Pz;(function(s){s.serviceIds=new Map})(Pz||(Pz={}));var H=ue("instantiationService");function ue(s){if(Pz.serviceIds.has(s))return Pz.serviceIds.get(s);let o=function(e,t,i){};return o.toString=()=>s,Pz.serviceIds.set(s,o),o}',
  'var Ji={clipboard:{},keyboard:Ws||J6()?0:navigator.keyboard||Pf?1:2,touch:"ontouchstart"in dt};',
  'setEditorHidden(e){this.workbenchGrid.setViewVisible(this.editorPartView,!e),e&&!this.isVisible("workbench.parts.panel")&&!this.isAuxiliaryBarMaximized()&&this.setPanelHidden(!1,!0)}',
  'this.getRuntimeValue(qo.PANEL_HIDDEN)&&this.getRuntimeValue(qo.EDITOR_HIDDEN)&&!this.getRuntimeValue(qo.AUXILIARYBAR_WAS_LAST_MAXIMIZED)&&this.setRuntimeValue(qo.EDITOR_HIDDEN,!1),this.isNew[1]&&z();',
  'async open(){let[e]=await Promise.all([this.initServices()]),t=this.createWorkbench(this.domElement,e.serviceCollection,e.logService);this.registerListeners(t);let i=t.startup();return this._register(i.createInstance(fze)),e.logService.trace("workbench#open"),i.invokeFunction(n=>n)}',
];
const workbench = [
  'var dt=window;function axo(s,o){let e;return new sEi(s,o).open().then(t=>{e=t,hz.complete(t)}),Y(()=>{e?e.shutdown():hz.p.then(t=>t.shutdown())})}',
  'var qxi=class{async sign(o){try{return await this.signValue(o)}catch{}return o}};',
  'kLe=class extends qxi{getValidator(){return this.vsda().then(e=>{let t=new e.validator;return t})}signValue(e){return this.vsda().then(t=>t.sign(e))}};',
  'let n=`${o}/release/onig.wasm`;fetch(nj("vscode-oniguruma","release/onig.wasm"));',
  'async function HOt(s,o){if(!crypto.subtle)throw new Error("\'crypto.subtle\' is not available so webviews will not work. This is likely because...");let e=JSON.stringify({parentOrigin:s,salt:o}),i=new TextEncoder().encode(e);return i}',
  '_registerMessageHandler(e){let t=this._register(q(e,"message",i=>{if(!(!this._encodedWebviewOrigin||i?.data?.target!==this.id)){if(i.origin!==this._webviewContentOrigin(this._encodedWebviewOrigin)){console.log("skipped");return}}}))}',
  ...surfaceLines,
  '(function(){let s=dt.document.getElementById("vscode-workbench-web-configuration"),e=JSON.parse(s.getAttribute("data-settings"));axo(dt.document.body,{...e,windowIndicator:e.windowIndicator,workspaceProvider:uxo.create(e)})})();export{lxo as LocalStorageSecretStorageProvider};',
  '//# sourceMappingURL=https://main.vscode-cdn.net/sourcemaps/07f8/core/vs/code/browser/workbench/workbench.js.map',
].join('\n');

describe('the workbench bundle', () => {
  test('routes the embedder options through the frame, hands over the workbench, signs with the token', () => {
    const patched = patchWorkbench(workbench);
    expect(patched).toContain('axo(dt.document.body,globalThis.__ocVSCode.options({...e,windowIndicator:');
    expect(patched).toContain('}))})();export{lxo as LocalStorageSecretStorageProvider};');
    expect(patched).toContain('.open().then(t=>{e=t,hz.complete(t),globalThis.__ocVSCode.workbench?.(t)})');
    expect(patched).toContain('return globalThis.__ocVSCode.connectionToken??o}');
    expect(patched).toContain('signValue(e){return Promise.reject(new Error("vsda is not loaded inside OpenChamber"))}');
    expect(patched).toContain('getValidator(){return Promise.reject(new Error("vsda is not loaded inside OpenChamber")).then(');
    expect(patched).toContain('/release/onig.wasm.json`');
    expect(patched).toContain('"release/onig.wasm.json"');
    expect(patched).not.toContain('sourceMappingURL');
    expect(patched).toContain('if(i.origin!==this._webviewContentOrigin(this._encodedWebviewOrigin)&&!(i.origin==="null"&&i.source===this.element?.contentWindow))');
    expect(patched).toContain('if(!crypto.subtle)return globalThis.__ocVSCode.originHash(s,o);let e=JSON.stringify({parentOrigin:s,salt:o})');
  });

  test('the patched embedder really calls the frame', () => {
    // Run the patched IIFE with a stand-in create() and see what it receives.
    const iife = patchWorkbench(workbench).split('\n').find((line) => line.startsWith('(function(){'))!.replace(/export\{[^}]*\};$/, '');
    let received: Record<string, unknown> | null = null;
    const frame = { options: (options: Record<string, unknown>) => ({ ...options, fromFrame: true }) };
    const dt = { document: { body: 'body', getElementById: () => ({ getAttribute: () => JSON.stringify({ remoteAuthority: 'vscode:8000' }) }) } };
    new Function('globalThis', 'dt', 'axo', 'uxo', iife)({ __ocVSCode: frame }, dt, (_body: unknown, options: Record<string, unknown>) => {
      received = options;
    }, { create: () => 'provider' });
    expect(received!).toEqual({ remoteAuthority: 'vscode:8000', windowIndicator: undefined, workspaceProvider: 'provider', fromFrame: true });
  });

  test('a release that moved the code it changes stops with a clear error', () => {
    expect(() => patchWorkbench(workbench.replace('windowIndicator:', 'windowIndicatorX:'))).toThrow(PatchError);
    expect(() => patchWorkbench(workbench.replace('getValidator(){return this.vsda()', 'getValidator(){return this.other()'))).toThrow(/vsda validator/);
    expect(() => patchWorkbench(`${workbench}\n${workbench.split('\n')[1]}`)).toThrow(/expected one match.*found 2/);
    expect(() => patchWorkbench(workbench.replaceAll('onig.wasm', 'onig.bin'))).toThrow(/onig\.wasm/);
  });

  test('the surface patches hand the frame the services and keep the dropped keys and a bare layout', () => {
    const missing: string[] = [];
    const patched = patchWorkbench(workbench, missing);
    expect(missing).toEqual([]);
    expect(patched).toContain('let i=t.startup();globalThis.__ocVSCode?.services?.(i);return this._register(i.createInstance(fze))');
    expect(patched).toContain('function ue(s){globalThis.__ocVSCode&&(globalThis.__ocVSCode.serviceIds=Pz.serviceIds);if(Pz.serviceIds.has(s))');
    expect(patched).toContain('keyboard:Ws||J6()||globalThis.__ocVSCode?.keyboard===!0?0:navigator.keyboard||Pf?1:2,');
    expect(patched).toContain('&&!this.isAuxiliaryBarMaximized()&&!globalThis.__ocVSCode?.bare&&this.setPanelHidden(!1,!0)');
    expect(patched).toContain('&&!this.getRuntimeValue(qo.AUXILIARYBAR_WAS_LAST_MAXIMIZED)&&!globalThis.__ocVSCode?.bare&&this.setRuntimeValue(qo.EDITOR_HIDDEN,!1)');
  });

  test('the patched service identifiers and keyboard support behave', () => {
    const lines = patchWorkbench(workbench).split('\n');
    const decorators = lines.find((line) => line.startsWith('var Pz;'))!;
    const frame: Record<string, unknown> = {};
    const ids = new Function('globalThis', `${decorators};return Pz.serviceIds;`)({ __ocVSCode: frame }) as Map<string, unknown>;
    expect(frame.serviceIds).toBe(ids);
    expect([...ids.keys()]).toEqual(['instantiationService']);
    const keyboard = (hook: Record<string, unknown> | undefined, standalone: boolean) => (new Function('globalThis', 'navigator', 'Ws', 'J6', 'Pf', 'dt', `${lines.find((line) => line.startsWith('var Ji='))!};return Ji.keyboard;`) as (...args: unknown[]) => number)(
      { __ocVSCode: hook }, { keyboard: {} }, false, () => standalone, false, {},
    );
    expect(keyboard({ keyboard: true }, false)).toBe(0);
    expect(keyboard({}, false)).toBe(1);
    expect(keyboard(undefined, true)).toBe(0);
  });

  test('a release without the surface patches\' code still runs, and says which are missing', () => {
    const older = workbench.replace(surfaceLines[0]!, 'var H=ue("instantiationService");').replace(surfaceLines[2]!, '');
    const missing: string[] = [];
    expect(() => patchWorkbench(older, missing)).not.toThrow();
    expect(missing).toEqual(['the service identifiers', 'the editor area\'s hiding']);
    expect(SURFACE_PATCH_NAMES).toHaveLength(5);
  });

  test('other scripts lose their source map line only', () => {
    expect(patchScript('let a=1;\n//# sourceMappingURL=https://x/y.js.map')).toBe('let a=1;\n');
  });
});

describe('the stylesheet', () => {
  test('carries the codicon font inside it', () => {
    const css = '.a{}@font-face{font-family:codicon;font-display:block;src:url("../../../../media/codicon.ttf") format("truetype")}\n/*# sourceMappingURL=x.css.map*/';
    const patched = patchStylesheet(css, 'AAAA');
    expect(patched).toContain('src:url(data:font/ttf;base64,AAAA) format("truetype")');
    expect(patched).not.toContain('sourceMappingURL');
    expect(() => patchStylesheet('.a{}', 'AAAA')).toThrow(/codicon/);
  });
});

describe('the extension host page', () => {
  const page = [
    '<html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\' \'sha256-x\';"/>',
    '</head><body><script>',
    "const blob = new Blob([[",
    '`globalThis._VSCODE_FILE_ROOT = ${JSON.stringify(fileRoot)};`,',
    '`await import(${JSON.stringify(workerUrl)});`',
    "].join('')], { type: 'application/javascript' });",
    "const worker = new Worker(URL.createObjectURL(blob), { name, type: 'module' });",
    'window.parent.postMessage({',
    '  vscodeWebWorkerExtHostId,',
    '  data',
    '}, parentOrigin, [data]);',
    '</script></body></html>',
  ].join('\n');

  test('starts its worker from a data: URL and answers an opaque parent', () => {
    const patched = patchExtensionHostIframe(page);
    expect(patched).not.toContain('Content-Security-Policy');
    expect(patched).toContain("const workerSource = [[");
    expect(patched).toContain("].join('')][0];");
    expect(patched).toContain("new Worker('data:text/javascript;charset=utf-8,' + encodeURIComponent(workerSource), { name, type: 'module' })");
    expect(patched).toContain("}, parentOrigin === 'null' ? '*' : parentOrigin, [data]);");
  });
});

// The real compiled VS Code, when a VS Code Server for the web is at hand:
// VSCODE_SERVER_DIR=/path/to/vscode-server bun test tests/patch.test.ts
const install = process.env.VSCODE_SERVER_DIR;
describe.skipIf(!install || !existsSync(join(install ?? '', 'out')))('a real VS Code Server install', () => {
  test('every patch applies once, the surface patches too', () => {
    const dir = install!;
    const missing: string[] = [];
    expect(() => patchWorkbench(readFileSync(join(dir, 'out/vs/code/browser/workbench/workbench.js'), 'utf8'), missing)).not.toThrow();
    expect(missing).toEqual([]);
    expect(() => patchStylesheet(readFileSync(join(dir, 'out/vs/code/browser/workbench/workbench.css'), 'utf8'), 'AAAA')).not.toThrow();
    expect(() => patchExtensionHostIframe(readFileSync(join(dir, 'out/vs/workbench/services/extensions/worker/webWorkerExtensionHostIframe.html'), 'utf8'))).not.toThrow();
  });
});
