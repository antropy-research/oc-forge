import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { WorkbenchAssets, type AssetState } from '../service/assets.ts';
import type { ServerPage, VscodeServer } from '../service/server.ts';

const commit = 'c'.repeat(40);
const workbench = [
  'function axo(s,o){let e;return new sEi(s,o).open().then(t=>{e=t,hz.complete(t)}),1}',
  'var qxi=class{async sign(o){try{return await this.signValue(o)}catch{}return o}};',
  'kLe=class extends qxi{getValidator(){return this.vsda().then(e=>e)}signValue(e){return this.vsda().then(t=>t.sign(e))}};',
  'fetch(nj("vscode-oniguruma","release/onig.wasm"));',
  'async function HOt(s,o){if(!crypto.subtle)throw new Error("\'crypto.subtle\' is not available so webviews will not work. This is likely because...");let e=JSON.stringify({parentOrigin:s,salt:o}),i=new TextEncoder().encode(e);return i}',
  '_registerMessageHandler(e){let t=this._register(q(e,"message",i=>{if(!(!this._encodedWebviewOrigin||i?.data?.target!==this.id)){if(i.origin!==this._webviewContentOrigin(this._encodedWebviewOrigin)){console.log("skipped");return}}}))}',
  '(function(){axo(dt.document.body,{...e,windowIndicator:1})})();export{lxo as L};',
].join('\n');
// What the surface patches look for (tests/patch.test.ts has them in full).
const surfaces = [
  'function ue(s){if(Pz.serviceIds.has(s))return Pz.serviceIds.get(s);return s}',
  'var Ji={keyboard:Ws||J6()?0:navigator.keyboard||Pf?1:2,touch:1};',
  'e&&!this.isVisible("workbench.parts.panel")&&!this.isAuxiliaryBarMaximized()&&this.setPanelHidden(!1,!0);',
  'this.getRuntimeValue(qo.PANEL_HIDDEN)&&this.getRuntimeValue(qo.EDITOR_HIDDEN)&&!this.getRuntimeValue(qo.AUXILIARYBAR_WAS_LAST_MAXIMIZED)&&this.setRuntimeValue(qo.EDITOR_HIDDEN,!1);',
  'let i=t.startup();return this._register(i.createInstance(fze)),1;',
].join('\n');
const iframe = [
  '<meta http-equiv="Content-Security-Policy" content="x"/>',
  "const blob = new Blob([[`a`].join('')], { type: 'application/javascript' });",
  "const worker = new Worker(URL.createObjectURL(blob), { name, type: 'module' });",
  '}, parentOrigin, [data]);',
].join('\n');

/** A VS Code Server install with just enough of each kind of file. */
const fakeInstall = (withSurfaces = true): string => {
  const dir = mkdtempSync(join(tmpdir(), 'vscode-install-'));
  const files: Record<string, string | Buffer> = {
    'product.json': JSON.stringify({ commit }),
    'out/vs/code/browser/workbench/workbench.js': withSurfaces ? `${workbench}\n${surfaces}` : workbench,
    'out/vs/code/browser/workbench/workbench.css': '@font-face{src:url("../../../../media/codicon.ttf") format("truetype")}',
    'out/nls.messages.js': 'globalThis._VSCODE_NLS_MESSAGES=[];',
    'out/media/codicon.ttf': Buffer.from([0, 1, 2, 3]),
    'out/media/loading.svg': '<svg/>',
    'out/vs/editor/common/services/editorWebWorkerMain.js': 'self.x=1;\n//# sourceMappingURL=https://cdn/x.js.map',
    'out/vs/workbench/services/extensions/worker/webWorkerExtensionHostIframe.html': iframe,
    'out/server-main.js': 'server only',
    'out/vs/platform/terminal/node/ptyHostMain.js': 'server only',
    'node_modules/vscode-oniguruma/release/onig.wasm': Buffer.from([0, 97, 115, 109]),
    'node_modules/vscode-oniguruma/release/main.js': 'module.exports={}',
    'node_modules/node-pty/lib/index.js': 'server only',
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
};

const page: ServerPage = { commit, base: `/stable-${commit}/static`, config: { remoteAuthority: 'vscode:8000' } };

const settle = async (assets: WorkbenchAssets): Promise<AssetState> => {
  for (let attempt = 0; attempt < 200; attempt++) {
    const state = assets.status(commit);
    if (state.state === 'ready' || state.state === 'failed') return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return assets.status(commit);
};

const expectPrepared = (cache: string) => {
  const root = join(cache, commit);
  expect(readFileSync(join(root, 'out/vs/code/browser/workbench/workbench.js'), 'utf8')).toContain('globalThis.__ocVSCode.options(');
  expect(readFileSync(join(root, 'out/vs/code/browser/workbench/workbench.css'), 'utf8')).toContain('url(data:font/ttf;base64,AAECAw==)');
  expect(readFileSync(join(root, 'out/vs/workbench/services/extensions/worker/webWorkerExtensionHostIframe.html'), 'utf8')).toContain("new Worker('data:text/javascript");
  expect(readFileSync(join(root, 'out/vs/editor/common/services/editorWebWorkerMain.js'), 'utf8')).not.toContain('sourceMappingURL');
  expect([...readFileSync(join(root, 'node_modules/vscode-oniguruma/release/onig.wasm.json'))]).toEqual([0, 97, 115, 109]);
  expect(existsSync(join(root, 'out/media/loading.svg'))).toBe(true);
  for (const absent of ['out/server-main.js', 'out/vs/platform/terminal/node/ptyHostMain.js', 'out/media/codicon.ttf', 'node_modules/node-pty/lib/index.js', 'node_modules/vscode-oniguruma/release/onig.wasm']) {
    expect(existsSync(join(root, absent))).toBe(false);
  }
};

describe('preparing the workbench of a VS Code Server', () => {
  test('from an install of the same commit on this machine', async () => {
    const install = fakeInstall();
    const cache = mkdtempSync(join(tmpdir(), 'vscode-cache-'));
    const assets = new WorkbenchAssets(cache, () => [], () => {}, () => [join(install, 'missing'), install]);
    const server = { staticFile: async () => null } as unknown as VscodeServer;
    expect(assets.prepare(server, page).state).toBe('preparing');
    const done = await settle(assets);
    expect(done).toMatchObject({ state: 'ready', path: `vscode-web/${commit}`, source: 'local', surfaces: true });
    expectPrepared(cache);
    expect(JSON.parse(readFileSync(join(cache, commit, 'ready.json'), 'utf8')).missing).toEqual([]);
    // Once ready it is not prepared again.
    expect(assets.prepare(server, page).state).toBe('ready');
    expect(new WorkbenchAssets(cache, () => [], () => {}).status(commit).state).toBe('ready');
  });

  test('a newer webview host replaces the one a prepared workbench carries, without preparing it again', async () => {
    const install = fakeInstall();
    const cache = mkdtempSync(join(tmpdir(), 'vscode-cache-'));
    const webview = mkdtempSync(join(tmpdir(), 'vscode-webview-'));
    writeFileSync(join(webview, 'index.html'), '<script src="./host.js"></script>');
    writeFileSync(join(webview, 'host.js'), 'old();');
    const assets = new WorkbenchAssets(cache, () => [], () => {}, () => [install], webview);
    assets.prepare({ staticFile: async () => null } as unknown as VscodeServer, page);
    expect(await settle(assets)).toMatchObject({ state: 'ready' });
    const host = join(cache, commit, 'out/vs/workbench/contrib/webview/browser/pre/host.js');
    expect(readFileSync(host, 'utf8')).toBe('old();');
    writeFileSync(join(webview, 'host.js'), 'handshake(mountId, keyEventToken);');
    const marker = readFileSync(join(cache, commit, 'ready.json'), 'utf8');
    expect(new WorkbenchAssets(cache, () => [], () => {}, () => [], webview).status(commit).state).toBe('ready');
    expect(readFileSync(host, 'utf8')).toBe('handshake(mountId, keyEventToken);');
    expect(readFileSync(join(cache, commit, 'ready.json'), 'utf8')).toBe(marker);
  });

  test("over HTTP from the server's static files, by the shipped list", async () => {
    // A release that moved the surface patches' code: ready all the same, as the whole workbench per frame.
    const install = fakeInstall(false);
    const cache = mkdtempSync(join(tmpdir(), 'vscode-cache-'));
    const requested: string[] = [];
    const server = {
      staticFile: async (base: string, path: string) => {
        requested.push(`${base}/${path}`);
        return existsSync(join(install, path)) ? readFileSync(join(install, path)) : null;
      },
    } as unknown as VscodeServer;
    const list = ['out/vs/code/browser/workbench/workbench.js', 'out/vs/code/browser/workbench/workbench.css', 'out/nls.messages.js', 'out/media/codicon.ttf', 'out/media/loading.svg', 'out/vs/editor/common/services/editorWebWorkerMain.js', 'out/vs/workbench/services/extensions/worker/webWorkerExtensionHostIframe.html', 'node_modules/vscode-oniguruma/release/onig.wasm', 'node_modules/vscode-oniguruma/release/main.js', 'out/gone.js'];
    const assets = new WorkbenchAssets(cache, () => list, () => {}, () => []);
    assets.prepare(server, page);
    expect(await settle(assets)).toMatchObject({ state: 'ready', source: 'download', surfaces: false });
    expectPrepared(cache);
    expect(requested.every((path) => path.startsWith(`/stable-${commit}/static/`))).toBe(true);
  });

  test('a cache made over HTTP from an older list is prepared again and gains the files added since; one from an install here stays', async () => {
    const install = fakeInstall();
    const server = { staticFile: async (_base: string, path: string) => (existsSync(join(install, path)) ? readFileSync(join(install, path)) : null) } as unknown as VscodeServer;
    const older = ['out/vs/code/browser/workbench/workbench.js', 'out/vs/code/browser/workbench/workbench.css', 'out/nls.messages.js', 'out/media/codicon.ttf'];
    const cache = mkdtempSync(join(tmpdir(), 'vscode-cache-'));
    const first = new WorkbenchAssets(cache, () => older, () => {}, () => []);
    first.prepare(server, page);
    expect(await settle(first)).toMatchObject({ state: 'ready', source: 'download' });
    expect(existsSync(join(cache, commit, 'out/media/loading.svg'))).toBe(false);
    // The same list: ready as it is.
    expect(new WorkbenchAssets(cache, () => [...older], () => {}, () => []).status(commit).state).toBe('ready');
    // The list refreshed for a new release: prepared again, with the added file.
    const refreshed = new WorkbenchAssets(cache, () => [...older, 'out/media/loading.svg'], () => {}, () => []);
    expect(refreshed.status(commit).state).toBe('idle');
    refreshed.prepare(server, page);
    expect(await settle(refreshed)).toMatchObject({ state: 'ready', source: 'download' });
    expect(existsSync(join(cache, commit, 'out/media/loading.svg'))).toBe(true);
    // Made from an install on this machine, it has every file whatever the list says.
    const local = mkdtempSync(join(tmpdir(), 'vscode-cache-'));
    const fromInstall = new WorkbenchAssets(local, () => older, () => {}, () => [install]);
    fromInstall.prepare(server, page);
    expect(await settle(fromInstall)).toMatchObject({ state: 'ready', source: 'local' });
    expect(new WorkbenchAssets(local, () => [...older, 'out/other.js'], () => {}, () => []).status(commit).state).toBe('ready');
  });

  test('a release whose workbench the patches do not fit fails with the reason', async () => {
    const install = fakeInstall();
    writeFileSync(join(install, 'out/vs/code/browser/workbench/workbench.js'), 'nothing to patch here; release/onig.wasm');
    const cache = mkdtempSync(join(tmpdir(), 'vscode-cache-'));
    const assets = new WorkbenchAssets(cache, () => [], () => {}, () => [install]);
    assets.prepare({} as VscodeServer, page);
    const done = await settle(assets);
    expect(done.state).toBe('failed');
    expect(done.state === 'failed' && done.error).toMatch(/cannot run inside OpenChamber yet: the embedder's create\(\) call/);
    expect(existsSync(join(cache, commit))).toBe(false);
  });
});
