// service/main.ts
import http from "node:http";
import { readFileSync as readFileSync2 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { dirname as dirname3, join as join4, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// src/settings.ts
var parseServerUrl = (raw) => {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:" || url.username || url.password)
      return null;
    if (url.search || url.hash)
      return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
};
var isConnectionToken = (value) => typeof value === "string" && /^[A-Za-z0-9._~-]{1,256}$/.test(value);

// src/workbench.ts
var EXTERNAL_HOST_SUFFIXES = [
  "marketplace.visualstudio.com",
  ".vsassets.io",
  ".gallerycdn.vsassets.io",
  ".vscode-cdn.net",
  ".vscode-unpkg.net",
  "open-vsx.org",
  ".open-vsx.org"
];
var isExternalAllowed = (url) => {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port)
    return false;
  const host = parsed.hostname.toLowerCase();
  return EXTERNAL_HOST_SUFFIXES.some((suffix) => suffix.startsWith(".") ? host.endsWith(suffix) : host === suffix);
};
var readServerPage = (html) => {
  const attribute = (id) => {
    const match = new RegExp(`id="${id}"\\s+data-settings="([^"]*)"`).exec(html);
    if (!match)
      return null;
    return match[1].replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
  };
  const settings = attribute("vscode-workbench-web-configuration");
  const base = attribute("vscode-workbench-web-base-url");
  if (!settings || base === null)
    return null;
  try {
    const config = JSON.parse(settings);
    if (typeof config !== "object" || config === null)
      return null;
    return { config, base };
  } catch {
    return null;
  }
};
var commitOfBase = (base) => /\/(?:stable|insider|exploration)-([0-9a-f]{40})\/static\/?$/.exec(base)?.[1] ?? null;

// service/assets.ts
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";

// src/clientFiles.ts
var WEB_NODE_MODULES = [
  "@microsoft/1ds-core-js",
  "@microsoft/1ds-post-js",
  "@vscode/iconv-lite-umd",
  "@vscode/tree-sitter-wasm",
  "@vscode/vscode-languagedetection",
  "@xterm/addon-clipboard",
  "@xterm/addon-image",
  "@xterm/addon-ligatures",
  "@xterm/addon-progress",
  "@xterm/addon-search",
  "@xterm/addon-serialize",
  "@xterm/addon-unicode11",
  "@xterm/addon-webgl",
  "@xterm/xterm",
  "jschardet",
  "katex",
  "tas-client",
  "vscode-oniguruma",
  "vscode-regexp-languagedetection",
  "vscode-textmate"
];
var SERVED = new Set([".html", ".js", ".css", ".svg", ".json", ".png"]);
var AS_JSON = new Set([".wasm"]);
var extension = (path) => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
};
var serverOnly = (path) => /(^|\/)(node|electron-main|electron-utility|electron-browser)(\/|$)/.test(path) || /^(server-main|server-cli|bootstrap-fork|bootstrap-server|main|cli)\.js$/.test(path) || /^nls\.(keys|metadata|messages)\.json$/.test(path) || path === "vs/code/browser/workbench/workbench.html" || path === "vs/code/browser/workbench/callback.html";
var clientFileName = (relativePath) => {
  const path = relativePath.replace(/^\.?\/+/, "");
  if (path.includes("..") || path.includes("\x00"))
    return null;
  const ext = extension(path);
  if (path.startsWith("out/")) {
    const inner = path.slice("out/".length);
    if (serverOnly(inner))
      return null;
    if (!SERVED.has(ext))
      return null;
    return path;
  }
  if (path.startsWith("node_modules/")) {
    const inner = path.slice("node_modules/".length);
    const module = WEB_NODE_MODULES.find((name) => inner === name || inner.startsWith(`${name}/`));
    if (!module)
      return null;
    const rest = inner.slice(module.length + 1);
    if (/(^|\/)(node_modules|test|tests|typings)\//.test(rest) || rest.endsWith(".d.ts") || ext === ".map")
      return null;
    if (AS_JSON.has(ext))
      return `${path}.json`;
    if (!SERVED.has(ext))
      return null;
    return path;
  }
  return null;
};
var REQUIRED_SOURCE_FILES = [
  "out/vs/code/browser/workbench/workbench.js",
  "out/vs/code/browser/workbench/workbench.css",
  "out/nls.messages.js",
  "out/media/codicon.ttf"
];

// src/patch.ts
class PatchError extends Error {
}
var IDENT = "[A-Za-z_$][\\w$]*";
var matchCount = (text, pattern) => [...text.matchAll(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`))].length;
var replaceOnce = (text, pattern, replacement, what) => {
  const matches = matchCount(text, pattern);
  if (matches !== 1)
    throw new PatchError(`${what}: expected one match in the compiled workbench, found ${matches}`);
  return text.replace(pattern, replacement);
};
var withoutSourceMap = (text) => text.replace(/\n?\/\/# sourceMappingURL=\S+\s*$/u, `
`);
var SURFACE_PATCHES = [
  {
    what: "the workbench startup",
    pattern: new RegExp(`let (${IDENT})=(${IDENT})\\.startup\\(\\);return this\\._register\\(\\1\\.createInstance\\(`),
    replacement: "let $1=$2.startup();globalThis.__ocVSCode?.services?.($1);return this._register($1.createInstance("
  },
  {
    what: "the service identifiers",
    pattern: new RegExp(`function (${IDENT})\\((${IDENT})\\)\\{if\\((${IDENT})\\.serviceIds\\.has\\(\\2\\)\\)return \\3\\.serviceIds\\.get\\(\\2\\);`),
    replacement: "function $1($2){globalThis.__ocVSCode&&(globalThis.__ocVSCode.serviceIds=$3.serviceIds);if($3.serviceIds.has($2))return $3.serviceIds.get($2);"
  },
  {
    what: "the browser keyboard support",
    pattern: new RegExp(`keyboard:(${IDENT})\\|\\|(${IDENT})\\(\\)\\?0:navigator\\.keyboard\\|\\|(${IDENT})\\?1:2,`),
    replacement: "keyboard:$1||$2()||globalThis.__ocVSCode?.keyboard===!0?0:navigator.keyboard||$3?1:2,"
  },
  {
    what: "the editor area's hiding",
    pattern: new RegExp(`(${IDENT})&&!this\\.isVisible\\("workbench\\.parts\\.panel"\\)&&!this\\.isAuxiliaryBarMaximized\\(\\)&&this\\.setPanelHidden\\(!1,!0\\)`),
    replacement: '$1&&!this.isVisible("workbench.parts.panel")&&!this.isAuxiliaryBarMaximized()&&!globalThis.__ocVSCode?.bare&&this.setPanelHidden(!1,!0)'
  },
  {
    what: "the restored editor area",
    pattern: new RegExp(`(this\\.getRuntimeValue\\((${IDENT})\\.PANEL_HIDDEN\\)&&this\\.getRuntimeValue\\(\\2\\.EDITOR_HIDDEN\\)&&!this\\.getRuntimeValue\\(\\2\\.AUXILIARYBAR_WAS_LAST_MAXIMIZED\\)&&)(this\\.setRuntimeValue\\(\\2\\.EDITOR_HIDDEN,!1\\))`),
    replacement: "$1!globalThis.__ocVSCode?.bare&&$3"
  }
];
var SURFACE_PATCH_NAMES = SURFACE_PATCHES.map((patch) => patch.what);
var patchWorkbench = (source, missing = []) => {
  let text = withoutSourceMap(source);
  text = replaceOnce(text, new RegExp(`(${IDENT})\\((${IDENT})\\.document\\.body,\\{\\.\\.\\.(${IDENT}),windowIndicator:`), "$1($2.document.body,globalThis.__ocVSCode.options({...$3,windowIndicator:", "the embedder's create() call");
  text = replaceOnce(text, /\}\)\}\)\(\);export\{/, "}))})();export{", "the end of the embedder");
  text = replaceOnce(text, new RegExp(`\\.open\\(\\)\\.then\\((${IDENT})=>\\{(${IDENT})=\\1,(${IDENT})\\.complete\\(\\1\\)\\}\\)`), ".open().then($1=>{$2=$1,$3.complete($1),globalThis.__ocVSCode.workbench?.($1)})", "the workbench promise");
  text = replaceOnce(text, new RegExp(`signValue\\((${IDENT})\\)\\{return this\\.vsda\\(\\)\\.then\\((${IDENT})=>\\2\\.sign\\(\\1\\)\\)\\}`), 'signValue($1){return Promise.reject(new Error("vsda is not loaded inside OpenChamber"))}', "the vsda signer");
  text = replaceOnce(text, /getValidator\(\)\{return this\.vsda\(\)\.then\(/, 'getValidator(){return Promise.reject(new Error("vsda is not loaded inside OpenChamber")).then(', "the vsda validator");
  text = replaceOnce(text, new RegExp(`async sign\\((${IDENT})\\)\\{try\\{return await this\\.signValue\\(\\1\\)\\}catch\\{\\}return \\1\\}`), "async sign($1){try{return await this.signValue($1)}catch{}return globalThis.__ocVSCode.connectionToken??$1}", "the handshake signature");
  text = replaceOnce(text, new RegExp(`if\\(!crypto\\.subtle\\)throw new Error\\("'crypto\\.subtle' is not available so webviews will not work\\.[^"]*"\\);let (${IDENT})=JSON\\.stringify\\(\\{parentOrigin:(${IDENT}),salt:(${IDENT})\\}\\)`), "if(!crypto.subtle)return globalThis.__ocVSCode.originHash($2,$3);let $1=JSON.stringify({parentOrigin:$2,salt:$3})", "the webview origin hash");
  text = replaceOnce(text, new RegExp(`if\\((${IDENT})\\.origin!==this\\._webviewContentOrigin\\(this\\._encodedWebviewOrigin\\)\\)`), 'if($1.origin!==this._webviewContentOrigin(this._encodedWebviewOrigin)&&!($1.origin==="null"&&$1.source===this.element?.contentWindow))', "the webview origin check");
  for (const patch of SURFACE_PATCHES) {
    if (matchCount(text, patch.pattern) === 1)
      text = text.replace(patch.pattern, patch.replacement);
    else
      missing.push(patch.what);
  }
  return renameWasm(text, "the workbench");
};
var renameWasm = (text, what) => {
  if (!text.includes("release/onig.wasm"))
    throw new PatchError(`${what}: vscode-oniguruma's onig.wasm is not referenced`);
  return text.replace(/release\/onig\.wasm(?!\.json)/g, "release/onig.wasm.json");
};
var patchScript = (source) => withoutSourceMap(source);
var patchStylesheet = (source, codiconBase64) => {
  const text = replaceOnce(source, /url\((["']?)\.\.\/\.\.\/\.\.\/\.\.\/media\/codicon\.ttf\1\)/, `url(data:font/ttf;base64,${codiconBase64})`, "the codicon font");
  return text.replace(/\n?\/\*# sourceMappingURL=\S+\s*\*\/\s*$/u, `
`);
};
var patchExtensionHostIframe = (source) => {
  let text = replaceOnce(source, /<meta http-equiv="Content-Security-Policy"[\s\S]*?\/>\s*/, "", "the extension host page's CSP");
  text = replaceOnce(text, /const blob = new Blob\(\[\[/, "const workerSource = [[", "the worker source");
  text = replaceOnce(text, /\]\.join\(''\)\], \{ type: 'application\/javascript' \}\);/, "].join('')][0];", "the worker blob");
  text = replaceOnce(text, /new Worker\(URL\.createObjectURL\(blob\), \{ name, type: 'module' \}\)/, "new Worker('data:text/javascript;charset=utf-8,' + encodeURIComponent(workerSource), { name, type: 'module' })", "the worker");
  text = replaceOnce(text, /\}, parentOrigin, \[data\]\);/, "}, parentOrigin === 'null' ? '*' : parentOrigin, [data]);", "the reply to the workbench");
  return text;
};

// service/assets.ts
var CACHE_FORMAT = 3;
var MARKER = "ready.json";
var KEEP = 2;
var DOWNLOADS_AT_ONCE = 8;
var WEBVIEW_PRE = "out/vs/workbench/contrib/webview/browser/pre";
var WEBVIEW_FILES = ["index.html", "host.js"];
var localInstallCandidates = (commit, home = homedir()) => [
  "/opt/vscode-server",
  join(home, ".vscode-server", "cli", "servers", `Stable-${commit}`, "server"),
  join(home, ".vscode-server", "bin", commit),
  join(home, ".vscode", "cli", "serve-web", commit),
  join(home, ".vscode-cli", "serve-web", commit),
  join(home, ".vscode-server", "cli", "serve-web", commit)
];
var walk = async (root, dir, out) => {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory())
      await walk(root, path, out);
    else if (entry.isFile())
      out.push(relative(root, path));
  }
};

class WorkbenchAssets {
  cacheRoot;
  downloadList;
  log;
  candidates;
  webviewHost;
  jobs = new Map;
  stamp = null;
  constructor(cacheRoot, downloadList, log, candidates = localInstallCandidates, webviewHost = null) {
    this.cacheRoot = cacheRoot;
    this.downloadList = downloadList;
    this.log = log;
    this.candidates = candidates;
    this.webviewHost = webviewHost;
  }
  static folder(commit) {
    return `vscode-web/${commit}`;
  }
  listStamp() {
    this.stamp ??= createHash("sha256").update(JSON.stringify(this.downloadList())).digest("hex").slice(0, 16);
    return this.stamp;
  }
  status(commit) {
    const job = this.jobs.get(commit);
    if (job && job.state !== "ready")
      return job;
    const marker = join(this.cacheRoot, commit, MARKER);
    if (existsSync(marker)) {
      try {
        const ready = JSON.parse(readFileSync(marker, "utf8"));
        if (ready.format === CACHE_FORMAT && (ready.source !== "download" || ready.list === this.listStamp())) {
          this.refreshWebviewHost(commit);
          const surfaces = Array.isArray(ready.missing) && ready.missing.length === 0;
          return { state: "ready", path: WorkbenchAssets.folder(commit), files: ready.files ?? 0, source: ready.source ?? "local", surfaces };
        }
      } catch {}
    }
    return { state: "idle" };
  }
  refreshWebviewHost(commit) {
    if (!this.webviewHost)
      return;
    const pre = join(this.cacheRoot, commit, WEBVIEW_PRE);
    for (const name of WEBVIEW_FILES) {
      try {
        const wanted = readFileSync(join(this.webviewHost, name));
        const target = join(pre, name);
        if (existsSync(target) && readFileSync(target).equals(wanted))
          continue;
        mkdirSync(pre, { recursive: true });
        writeFileSync(`${target}.tmp-${process.pid}`, wanted);
        renameSync(`${target}.tmp-${process.pid}`, target);
        this.log(`VS Code ${commit.slice(0, 8)}: webview host ${name} updated`);
      } catch (error) {
        this.log(`could not update the webview host's ${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  prepare(server, page) {
    const current = this.status(page.commit);
    if (current.state === "ready" || current.state === "preparing")
      return current;
    const job = { state: "preparing", source: "local", done: 0, total: 0 };
    this.jobs.set(page.commit, job);
    this.build(server, page, job).then((done) => this.jobs.set(page.commit, done), (error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`preparing VS Code ${page.commit.slice(0, 8)} failed: ${message}`);
      this.jobs.set(page.commit, { state: "failed", error: message });
    });
    return job;
  }
  async localInstall(commit) {
    for (const dir of this.candidates(commit)) {
      try {
        const product = JSON.parse(await readFile(join(dir, "product.json"), "utf8"));
        if (product.commit === commit && REQUIRED_SOURCE_FILES.every((file) => existsSync(join(dir, file))))
          return dir;
      } catch {}
    }
    return null;
  }
  async build(server, page, job) {
    const local = await this.localInstall(page.commit);
    job.source = local ? "local" : "download";
    let sources;
    if (local) {
      sources = [];
      await walk(local, join(local, "out"), sources);
      for (const module of WEB_NODE_MODULES)
        await walk(local, join(local, "node_modules", module), sources);
    } else {
      sources = this.downloadList();
    }
    const wanted = sources.filter((path) => clientFileName(path) !== null);
    const read = async (path) => local ? readFile(join(local, path)).catch(() => null) : server.staticFile(page.base, path);
    const codicon = await read("out/media/codicon.ttf");
    if (!codicon)
      throw new Error("the VS Code Server has no out/media/codicon.ttf");
    job.total = wanted.length;
    const tmp = join(this.cacheRoot, `${page.commit}.tmp-${process.pid}-${Date.now()}`);
    await mkdir(tmp, { recursive: true });
    try {
      let next = 0;
      let files = 0;
      const missing = [];
      const worker = async () => {
        while (next < wanted.length) {
          const path = wanted[next++];
          const body = await read(path);
          job.done += 1;
          if (!body)
            continue;
          const target = join(tmp, clientFileName(path));
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, transform(path, body, codicon, missing));
          files += 1;
        }
      };
      await Promise.all(Array.from({ length: local ? 1 : DOWNLOADS_AT_ONCE }, worker));
      if (this.webviewHost) {
        const pre = join(tmp, WEBVIEW_PRE);
        await mkdir(pre, { recursive: true });
        for (const name of WEBVIEW_FILES)
          await writeFile(join(pre, name), await readFile(join(this.webviewHost, name)));
      }
      for (const file of ["out/vs/code/browser/workbench/workbench.js", "out/vs/code/browser/workbench/workbench.css", "out/nls.messages.js"]) {
        if (!existsSync(join(tmp, file)))
          throw new Error(`${file} is missing from the VS Code Server`);
      }
      await writeFile(join(tmp, MARKER), JSON.stringify({ format: CACHE_FORMAT, commit: page.commit, files, source: job.source, missing, ...local ? {} : { list: this.listStamp() }, at: new Date().toISOString() }));
      const final = join(this.cacheRoot, page.commit);
      await rm(final, { recursive: true, force: true });
      await rename(tmp, final);
      await this.prune(page.commit);
      this.log(`VS Code ${page.commit.slice(0, 8)} ready from ${local ?? "the server"} (${files} files)`);
      if (missing.length > 0)
        this.log(`VS Code ${page.commit.slice(0, 8)}: not in OpenChamber's own surfaces; this release moved ${missing.join(", ")}`);
      return { state: "ready", path: WorkbenchAssets.folder(page.commit), files, source: job.source, surfaces: missing.length === 0 };
    } catch (error) {
      await rm(tmp, { recursive: true, force: true });
      throw error instanceof PatchError ? new Error(`This VS Code release cannot run inside OpenChamber yet: ${error.message}`) : error;
    }
  }
  async prune(keep) {
    let entries;
    try {
      entries = await readdir(this.cacheRoot);
    } catch {
      return;
    }
    const caches = [];
    for (const name of entries) {
      const path = join(this.cacheRoot, name);
      if (name.includes(".tmp-") && !name.endsWith(`.tmp-${process.pid}`)) {
        await rm(path, { recursive: true, force: true });
        continue;
      }
      if (name === keep || !/^[0-9a-f]{40}$/.test(name))
        continue;
      caches.push({ name, at: (await stat(path).catch(() => null))?.mtimeMs ?? 0 });
    }
    caches.sort((a, b) => b.at - a.at);
    for (const old of caches.slice(KEEP - 1))
      await rm(join(this.cacheRoot, old.name), { recursive: true, force: true });
  }
}
var transform = (path, body, codicon, missing = []) => {
  if (path === "out/vs/code/browser/workbench/workbench.js")
    return patchWorkbench(body.toString("utf8"), missing);
  if (path === "out/vs/code/browser/workbench/workbench.css")
    return patchStylesheet(body.toString("utf8"), codicon.toString("base64"));
  if (path === "out/vs/workbench/services/extensions/worker/webWorkerExtensionHostIframe.html")
    return patchExtensionHostIframe(body.toString("utf8"));
  if (path.endsWith(".js") && path.startsWith("out/"))
    return patchScript(body.toString("utf8"));
  return body;
};

// service/editors.ts
import { createHash as createHash2 } from "node:crypto";
import { mkdir as mkdir2, readFile as readFile2, rename as rename2, writeFile as writeFile2 } from "node:fs/promises";
import { join as join2 } from "node:path";
var REQUEST_TTL_MS = 60000;
var REQUESTS_MAX = 64;
var TABS_MAX = 64;

class EditorRequests {
  now;
  pending = new Map;
  constructor(now = Date.now) {
    this.now = now;
  }
  put(key, open) {
    this.prune();
    this.pending.delete(key);
    this.pending.set(key, { open, at: this.now() });
    while (this.pending.size > REQUESTS_MAX)
      this.pending.delete(this.pending.keys().next().value);
  }
  take(key) {
    this.prune();
    const request = this.pending.get(key);
    this.pending.delete(key);
    return request?.open ?? null;
  }
  prune() {
    const now = this.now();
    for (const [key, request] of this.pending)
      if (now - request.at > REQUEST_TTL_MS)
        this.pending.delete(key);
  }
}
var readTabs = (raw) => {
  if (!Array.isArray(raw))
    return [];
  const tabs = [];
  for (const item of raw.slice(0, TABS_MAX)) {
    const tab = item;
    if (typeof tab?.id !== "string" || !tab.id || tab.id.length > 1024)
      continue;
    if (typeof tab.title !== "string" || !tab.title.trim() || tab.title.length > 80)
      continue;
    const icon = typeof tab.icon === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tab.icon) ? tab.icon : undefined;
    tabs.push(icon ? { id: tab.id, title: tab.title, icon } : { id: tab.id, title: tab.title });
  }
  return tabs;
};

class SavedTabs {
  dir;
  log;
  tabs = new Map;
  constructor(dir, log) {
    this.dir = dir;
    this.log = log;
  }
  static keyOf(serverKey, folder) {
    const name = typeof folder === "string" && folder.startsWith("/") ? folder : "";
    return `${serverKey}.${createHash2("sha256").update(name).digest("hex").slice(0, 16)}`;
  }
  file(key) {
    return join2(this.dir, `${key}.tabs.json`);
  }
  async load(key) {
    const cached = this.tabs.get(key);
    if (cached)
      return cached;
    const tabs = await readFile2(this.file(key), "utf8").then((text) => readTabs(JSON.parse(text)), () => []);
    this.tabs.set(key, tabs);
    return tabs;
  }
  async save(key, tabs) {
    if (JSON.stringify(this.tabs.get(key)) === JSON.stringify(tabs))
      return;
    this.tabs.set(key, tabs);
    try {
      await mkdir2(this.dir, { recursive: true, mode: 448 });
      const tmp = `${this.file(key)}.tmp-${process.pid}`;
      await writeFile2(tmp, JSON.stringify(tabs), { mode: 384 });
      await rename2(tmp, this.file(key));
    } catch (error) {
      this.log(`could not keep the page's tabs: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

// service/rail.ts
import { mkdir as mkdir3, readFile as readFile3, rename as rename3, writeFile as writeFile3 } from "node:fs/promises";
import { dirname as dirname2 } from "node:path";

// src/rail.ts
var BUILT_IN_ENTRIES = [
  { id: "explorer", title: "Explorer", icon: "file-copy-2", order: 1, view: "workbench.view.explorer" },
  { id: "search", title: "Search", icon: "search", order: 2, view: "workbench.view.search" },
  { id: "scm", title: "Source Control", icon: "git-branch", order: 3, view: "workbench.view.scm" },
  { id: "debug", title: "Run and Debug", icon: "bug", order: 4, view: "workbench.view.debug" },
  { id: "extensions", title: "Extensions", icon: "puzzle", order: 5, view: "workbench.view.extensions" }
];
var TERMINAL_ENTRY = { id: "terminal", title: "Terminal", icon: "terminal-box", order: 1000, zone: "bottom" };
var ENTRY_ID_MAX = 48;
var TITLE_MAX = 80;
var SVG_MAX = 16384;
var ENTRIES_MAX = 100;
var MORE_ENTRY_ID = "additional-views";
var declaredContainers = (manifest, nls = {}) => {
  const list = manifest?.contributes?.viewsContainers?.activitybar;
  if (!Array.isArray(list))
    return [];
  const localized = (value) => {
    if (typeof value !== "string")
      return null;
    const key = /^%(.+)%$/.exec(value)?.[1];
    if (!key)
      return value;
    const found = nls[key];
    const text = typeof found === "string" ? found : typeof found?.message === "string" ? found.message : null;
    return text ?? key;
  };
  const containers = [];
  for (const item of list) {
    const entry = item;
    if (typeof entry?.id !== "string" || !/^[\w.-]{1,200}$/.test(entry.id))
      continue;
    const title = localized(entry.title)?.trim();
    if (!title)
      continue;
    containers.push({ id: entry.id, title, icon: typeof entry.icon === "string" ? entry.icon : "" });
  }
  return containers;
};
var entryIdOf = (containerId, taken) => {
  let id = containerId.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(id))
    id = `v-${id}`.replace(/-+$/, "");
  id = id.slice(0, ENTRY_ID_MAX - 3).replace(/-+$/, "");
  if (!taken.has(id))
    return id;
  for (let suffix = 2;; suffix++) {
    const candidate = `${id}-${suffix}`;
    if (!taken.has(candidate))
      return candidate;
  }
};
var railSvg = (text) => {
  let svg = text.replace(/^﻿/, "").replace(/<\?xml[\s\S]*?\?>/gi, "").replace(/<!DOCTYPE[\s\S]*?>/gi, "").replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|metadata|title|desc)\b[\s\S]*?<\/\1\s*>/gi, "").replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, "").replace(/>\s+</g, "><").trim();
  if (!/^<svg[\s>]/i.test(svg) || !/<\/svg\s*>$/i.test(svg))
    return null;
  if (!/^<svg[^>]*\sxmlns\s*=/i.test(svg))
    svg = svg.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  if (!/^<svg[^>]*\sviewBox\s*=/i.test(svg)) {
    const size = (name) => Number.parseFloat(new RegExp(`^<svg[^>]*\\s${name}\\s*=\\s*["']?([\\d.]+)`, "i").exec(svg)?.[1] ?? "");
    const [width, height] = [size("width"), size("height")];
    if (width > 0 && height > 0)
      svg = svg.replace(/^<svg/i, `<svg viewBox="0 0 ${width} ${height}"`);
  }
  return svg.length <= SVG_MAX ? svg : null;
};
var CODICONS = {
  account: "shield-user",
  beaker: "flask",
  book: "book",
  bookmark: "book-marked",
  bug: "bug",
  checklist: "list-check-2",
  cloud: "cloud",
  code: "code",
  copilot: "robot",
  database: "database-2",
  "debug-alt": "bug",
  extensions: "puzzle",
  file: "file",
  "file-code": "file-code",
  files: "file-copy-2",
  folder: "folder",
  "folder-opened": "folder-open",
  gear: "settings-3",
  "git-branch": "git-branch",
  "git-commit": "git-commit",
  "git-merge": "git-merge",
  "git-pull-request": "git-pull-request",
  github: "github",
  history: "history",
  inbox: "inbox-archive",
  inspect: "search-eye",
  layers: "stack",
  "list-flat": "list-unordered",
  "list-tree": "node-tree",
  "list-unordered": "list-unordered",
  package: "box-3",
  play: "play",
  plug: "plug",
  references: "node-tree",
  robot: "robot",
  "run-all": "play",
  search: "search",
  server: "server",
  "server-environment": "server",
  settings: "settings-3",
  "settings-gear": "settings-3",
  shield: "shield",
  "source-control": "git-branch",
  terminal: "terminal-box",
  tools: "tools",
  "type-hierarchy": "node-tree",
  window: "window"
};
var FALLBACK_ICON = "apps";
var codiconIcon = (icon) => {
  const name = /^\$\(([a-z0-9-]+)(?:~[a-z]+)?\)$/.exec(icon.trim())?.[1];
  return name ? CODICONS[name] ?? FALLBACK_ICON : null;
};
var railEntries = (installed, max = ENTRIES_MAX) => {
  const taken = new Set([...BUILT_IN_ENTRIES.map((entry) => entry.id), TERMINAL_ENTRY.id, MORE_ENTRY_ID]);
  const extensions = [];
  const views = new Set(BUILT_IN_ENTRIES.map((entry) => entry.view));
  for (const extension of installed) {
    for (const container of extension.containers) {
      const view = `workbench.view.extension.${container.id}`;
      if (views.has(view))
        continue;
      views.add(view);
      const id = entryIdOf(container.id, taken);
      taken.add(id);
      const title = container.title.length > TITLE_MAX ? `${container.title.slice(0, TITLE_MAX - 1)}…` : container.title;
      const icon = (container.svg ? railSvg(container.svg) : null) ?? codiconIcon(container.icon) ?? FALLBACK_ICON;
      extensions.push({ id, title, icon, order: 10 + extensions.length, view });
    }
  }
  const room = max - BUILT_IN_ENTRIES.length - 1;
  const shown = extensions.length <= room ? extensions : extensions.slice(0, room - 1);
  const hidden = extensions.slice(shown.length);
  const more = hidden.length === 0 ? [] : [{
    id: MORE_ENTRY_ID,
    title: `Additional Views (${hidden.length})`,
    icon: "more",
    order: 10 + shown.length,
    more: hidden.map((entry) => ({ view: entry.view, title: entry.title }))
  }];
  return [...BUILT_IN_ENTRIES, TERMINAL_ENTRY, ...more, ...shown].map((entry) => ({ ...entry }));
};

// service/rail.ts
var FRESH_MS = 1000;
var ICON_MAX = 64000;
var isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var installedFolders = (listing, obsolete, extensionsPath) => {
  if (!Array.isArray(listing))
    return [];
  const gone = new Set(isRecord(obsolete) ? Object.keys(obsolete).filter((key) => obsolete[key] === true).map((key) => key.toLowerCase()) : []);
  const folders = [];
  for (const item of listing) {
    if (!isRecord(item))
      continue;
    const id = isRecord(item.identifier) && typeof item.identifier.id === "string" ? item.identifier.id : null;
    const version = typeof item.version === "string" ? item.version : "";
    const relative = typeof item.relativeLocation === "string" && /^[^/\\]+$/.test(item.relativeLocation) && item.relativeLocation !== ".." ? item.relativeLocation : null;
    const location = isRecord(item.location) && typeof item.location.path === "string" ? item.location.path : typeof item.location === "string" ? item.location.replace(/^file:\/\//, "") : null;
    const folder = relative ? `${extensionsPath.replace(/\/+$/, "")}/${relative}` : location;
    if (!id || !folder || !folder.startsWith("/"))
      continue;
    if (gone.has(`${id}-${version}`.toLowerCase()) || relative && gone.has(relative.toLowerCase()))
      continue;
    folders.push({ key: `${id}@${version}:${folder}`, folder });
  }
  return folders;
};

class Rail {
  file;
  serverFor;
  log;
  now;
  source = null;
  loaded = null;
  extensions = new Map;
  last = railEntries([]);
  readAt = 0;
  reading = null;
  constructor(file, serverFor, log, now = Date.now) {
    this.file = file;
    this.serverFor = serverFor;
    this.log = log;
    this.now = now;
  }
  load() {
    this.loaded ??= readFile3(this.file, "utf8").then((text) => {
      const saved = JSON.parse(text);
      if (typeof saved.serverUrl === "string") {
        this.source ??= { serverUrl: saved.serverUrl, token: typeof saved.token === "string" ? saved.token : null, extensionsPath: typeof saved.extensionsPath === "string" ? saved.extensionsPath : null };
      }
    }).catch(() => {
      return;
    });
    return this.loaded;
  }
  async remember(serverUrl, token, extensionsPath) {
    await this.load();
    const same = this.source?.serverUrl === serverUrl;
    const next = { serverUrl, token, extensionsPath: extensionsPath ?? (same ? this.source.extensionsPath : null) };
    if (this.source && JSON.stringify(this.source) === JSON.stringify(next))
      return;
    if (!same)
      this.extensions.clear();
    this.source = next;
    this.readAt = 0;
    try {
      await mkdir3(dirname2(this.file), { recursive: true, mode: 448 });
      const tmp = `${this.file}.tmp-${process.pid}`;
      await writeFile3(tmp, JSON.stringify(next), { mode: 384 });
      await rename3(tmp, this.file);
    } catch (error) {
      this.log(`could not keep the rail's server: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async entries() {
    await this.load();
    if (this.now() - this.readAt < FRESH_MS)
      return this.last;
    this.reading ??= this.read().finally(() => {
      this.reading = null;
    });
    return this.reading;
  }
  async read() {
    const source = this.source;
    if (!source?.extensionsPath)
      return this.last;
    const server = this.serverFor(source.serverUrl, source.token);
    const file = async (path) => {
      const base = new URL(server.url).pathname.replace(/\/+$/, "");
      const answer = await server.get(`${base}/vscode-remote-resource?path=${encodeURIComponent(path)}`);
      return answer.status === 200 ? answer.body : null;
    };
    const json = async (path) => {
      const body = await file(path).catch(() => null);
      if (!body)
        return null;
      try {
        return JSON.parse(body.toString("utf8").replace(/^﻿/, ""));
      } catch {
        return null;
      }
    };
    try {
      const listing = await file(`${source.extensionsPath}/extensions.json`);
      if (!listing)
        throw new Error("no extensions.json");
      const obsolete = await json(`${source.extensionsPath}/.obsolete`);
      const folders = installedFolders(JSON.parse(listing.toString("utf8").replace(/^﻿/, "")), obsolete, source.extensionsPath);
      const installed = [];
      for (const { key, folder } of folders) {
        let extension = this.extensions.get(key);
        if (!extension) {
          const manifest = await json(`${folder}/package.json`);
          const needsNls = JSON.stringify(manifest?.contributes?.viewsContainers ?? "").includes("%");
          const nls = needsNls ? await json(`${folder}/package.nls.json`) : null;
          const containers = declaredContainers(manifest, isRecord(nls) ? nls : {});
          const withIcons = [];
          for (const container of containers) {
            const relative = container.icon.replace(/^\.?\//, "");
            const svg = /\.svg$/i.test(relative) && !relative.split("/").includes("..") ? await file(`${folder}/${relative}`).catch(() => null) : null;
            withIcons.push({ ...container, svg: svg && svg.byteLength <= ICON_MAX ? svg.toString("utf8") : null });
          }
          extension = { extension: key, containers: withIcons };
          if (manifest)
            this.extensions.set(key, extension);
        }
        installed.push(extension);
      }
      for (const key of [...this.extensions.keys()])
        if (!folders.some((folder) => folder.key === key))
          this.extensions.delete(key);
      this.last = railEntries(installed);
      this.readAt = this.now();
    } catch (error) {
      if (this.readAt !== -1)
        this.log(`could not read the VS Code Server's extensions: ${error instanceof Error ? error.message : String(error)}`);
      this.readAt = -1;
    }
    return this.last;
  }
}

// service/server.ts
var PAGE_TIMEOUT_MS = 8000;
var FILE_TIMEOUT_MS = 15000;
var RESOURCE_MAX = 5500000;

class ServerError extends Error {
  status;
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

class VscodeServer {
  url;
  token;
  origin;
  constructor(url, token) {
    this.url = url;
    this.token = token;
    this.origin = new URL(url).origin;
  }
  headers() {
    return this.token ? { cookie: `vscode-tkn=${this.token}` } : {};
  }
  async page() {
    let response;
    try {
      response = await fetch(`${this.url}/`, { headers: this.headers(), redirect: "manual", signal: AbortSignal.timeout(PAGE_TIMEOUT_MS) });
    } catch (error) {
      throw new ServerError(`The VS Code Server at ${this.url} did not answer (${error instanceof Error ? error.message : String(error)}).`, 502);
    }
    if (response.status === 403 || response.status === 401)
      throw new ServerError("The VS Code Server refused the connection token.", 403);
    if (response.status >= 300 && response.status < 400)
      throw new ServerError("The VS Code Server redirected; set the token, or the address it serves the workbench on.", 403);
    if (!response.ok)
      throw new ServerError(`The VS Code Server answered ${response.status}.`, 502);
    const page = readServerPage(await response.text());
    if (!page)
      throw new ServerError(`${this.url} does not look like a VS Code Server for the web.`, 502);
    const commit = commitOfBase(page.base);
    if (!commit)
      throw new ServerError(`The VS Code Server's base URL (${page.base}) names no commit.`, 502);
    return { ...page, commit };
  }
  async staticFile(base, path) {
    const response = await fetch(`${this.origin}${base}/${path.split("/").map(encodeURIComponent).join("/")}`, { headers: this.headers(), signal: AbortSignal.timeout(FILE_TIMEOUT_MS) });
    if (response.status === 404)
      return null;
    if (!response.ok)
      throw new ServerError(`${path}: the VS Code Server answered ${response.status}.`, 502);
    return Buffer.from(await response.arrayBuffer());
  }
  async version(base) {
    try {
      const body = await this.staticFile(base, "package.json");
      const version = body ? JSON.parse(body.toString("utf8")).version : null;
      return typeof version === "string" ? version : null;
    } catch {
      return null;
    }
  }
  async get(pathAndQuery) {
    const target = new URL(pathAndQuery, this.origin);
    if (target.origin !== this.origin || !target.pathname.startsWith(new URL(this.url).pathname.replace(/\/?$/, "/"))) {
      throw new ServerError("That path is not on the VS Code Server.", 400);
    }
    if (this.token && target.pathname.endsWith("/vscode-remote-resource") && !target.searchParams.has("tkn"))
      target.searchParams.set("tkn", this.token);
    const response = await fetch(target, { headers: this.headers(), redirect: "manual", signal: AbortSignal.timeout(FILE_TIMEOUT_MS) });
    const body = Buffer.from(await response.arrayBuffer());
    if (body.byteLength > RESOURCE_MAX)
      throw new ServerError(`${target.pathname}: larger than ${RESOURCE_MAX} bytes.`, 413);
    return { status: response.status, contentType: response.headers.get("content-type") ?? "application/octet-stream", body };
  }
  socketUrl(pathAndQuery) {
    const target = new URL(pathAndQuery, this.origin);
    if (target.origin !== this.origin)
      throw new ServerError("That socket is not on the VS Code Server.", 400);
    if (this.token && !target.searchParams.has("tkn"))
      target.searchParams.set("tkn", this.token);
    target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
    return target.toString();
  }
  socketHeaders() {
    return this.headers();
  }
}

// service/state.ts
import { createHash as createHash3 } from "node:crypto";
import { mkdir as mkdir4, readFile as readFile4, rename as rename4, stat as stat2, writeFile as writeFile4 } from "node:fs/promises";
import { join as join3 } from "node:path";
var LOAD_MAX = 7000000;
var NAME = /^[\w.:@ -]{1,200}$/;
var isValue = (value) => {
  if (typeof value !== "object" || value === null)
    return false;
  const keys = Object.keys(value);
  if (keys.length !== 1)
    return false;
  const record = value;
  return keys[0] === "s" && typeof record.s === "string" || keys[0] === "b" && typeof record.b === "string" || keys[0] === "j";
};
var readOps = (raw) => {
  if (!Array.isArray(raw))
    return [];
  const ops = [];
  for (const item of raw.slice(0, 2000)) {
    const op = item;
    if (typeof op?.db !== "string" || !NAME.test(op.db))
      continue;
    if (op.op === "db" && typeof op.version === "number" && Array.isArray(op.stores) && op.stores.every((s) => typeof s === "string" && NAME.test(s))) {
      ops.push({ op: "db", db: op.db, version: op.version, stores: op.stores });
    } else if (op.op === "drop") {
      ops.push({ op: "drop", db: op.db });
    } else if (typeof op.store === "string" && NAME.test(op.store)) {
      if (op.op === "clear")
        ops.push({ op: "clear", db: op.db, store: op.store });
      else if (typeof op.key === "string" && op.key.length <= 2000) {
        if (op.op === "delete")
          ops.push({ op: "delete", db: op.db, store: op.store, key: op.key });
        else if (op.op === "put" && isValue(op.value)) {
          const part = op.part;
          const validPart = part && typeof part.id === "string" && Number.isInteger(part.index) && Number.isInteger(part.count) && part.count > 0 && part.count <= 1000;
          ops.push({ op: "put", db: op.db, store: op.store, key: op.key, value: op.value, ...validPart ? { part: { id: part.id, index: part.index, count: part.count } } : {} });
        }
      }
    }
  }
  return ops;
};
var applyOps = (snapshot, ops, parts) => {
  for (const op of ops) {
    if (op.op === "drop") {
      delete snapshot.dbs[op.db];
      continue;
    }
    if (op.op === "db") {
      const db = snapshot.dbs[op.db] ??= { version: op.version, stores: {} };
      db.version = op.version;
      for (const store of op.stores)
        db.stores[store] ??= {};
      continue;
    }
    const db = snapshot.dbs[op.db] ??= { version: 1, stores: {} };
    const store = db.stores[op.store] ??= {};
    if (op.op === "clear") {
      db.stores[op.store] = {};
    } else if (op.op === "delete") {
      delete store[op.key];
    } else if (!op.part) {
      store[op.key] = op.value;
    } else {
      const entry = parts.get(op.part.id) ?? { pieces: Array.from({ length: op.part.count }, () => ""), seen: Array.from({ length: op.part.count }, () => false) };
      if (op.part.index >= 0 && op.part.index < entry.pieces.length) {
        entry.pieces[op.part.index] = "s" in op.value ? op.value.s : ("b" in op.value) ? op.value.b : "";
        entry.seen[op.part.index] = true;
      }
      parts.set(op.part.id, entry);
      if (entry.seen.every(Boolean)) {
        const joined = entry.pieces.join("");
        store[op.key] = "s" in op.value ? { s: joined } : { b: joined };
        parts.delete(op.part.id);
      }
    }
  }
};
var STATE_ROLES = ["view", "editor", "terminal"];
var isStateRole = (value) => STATE_ROLES.includes(value);
var isRoleDb = (db) => db.startsWith("vscode-web-state-db");

class WorkbenchState {
  dir;
  log;
  snapshots = new Map;
  parts = new Map;
  timers = new Map;
  constructor(dir, log) {
    this.dir = dir;
    this.log = log;
  }
  static keyOf(serverUrl, folder) {
    return createHash3("sha256").update(serverUrl).digest("hex").slice(0, 32);
  }
  static roleKeyOf(key, role) {
    return `${key}.${role}`;
  }
  async loadRole(key, role) {
    const shared = await this.get(key);
    const roleKey = WorkbenchState.roleKeyOf(key, role);
    const own = await this.get(roleKey);
    if (role === "editor" && Object.keys(own.dbs).length === 0 && !await this.exists(roleKey)) {
      for (const [name, db] of Object.entries(shared.dbs))
        if (isRoleDb(name))
          own.dbs[name] = structuredClone(db);
      this.schedule(roleKey);
    }
    const merged = { format: 1, dbs: {} };
    for (const [name, db] of Object.entries(shared.dbs))
      if (!isRoleDb(name))
        merged.dbs[name] = db;
    for (const [name, db] of Object.entries(own.dbs))
      if (isRoleDb(name))
        merged.dbs[name] = db;
    return this.fit(merged, `${roleKey}`);
  }
  async applyRole(key, role, ops) {
    const own = ops.filter((op) => isRoleDb(op.db));
    const shared = ops.filter((op) => !isRoleDb(op.db));
    if (own.length > 0)
      await this.apply(WorkbenchState.roleKeyOf(key, role), own);
    if (shared.length > 0)
      await this.apply(key, shared);
  }
  async exists(key) {
    return stat2(this.file(key)).then(() => true, () => false);
  }
  file(key) {
    return join3(this.dir, `${key}.json`);
  }
  async get(key) {
    const cached = this.snapshots.get(key);
    if (cached)
      return cached;
    let snapshot = { format: 1, dbs: {} };
    try {
      const parsed = JSON.parse(await readFile4(this.file(key), "utf8"));
      if (parsed?.format === 1 && typeof parsed.dbs === "object")
        snapshot = parsed;
    } catch {}
    this.snapshots.set(key, snapshot);
    return snapshot;
  }
  async load(key) {
    return this.fit(await this.get(key), key);
  }
  fit(snapshot, key) {
    const text = JSON.stringify(snapshot);
    if (text.length <= LOAD_MAX)
      return snapshot;
    this.log(`workbench state ${key} is ${text.length} bytes; loading the user data only`);
    const trimmed = { format: 1, dbs: {} };
    for (const [name, db] of Object.entries(snapshot.dbs))
      if (!isRoleDb(name))
        trimmed.dbs[name] = db;
    return trimmed;
  }
  async apply(key, ops) {
    applyOps(await this.get(key), ops, this.parts);
    this.schedule(key);
  }
  schedule(key) {
    clearTimeout(this.timers.get(key));
    this.timers.set(key, setTimeout(() => void this.write(key), 400));
  }
  async write(key) {
    this.timers.delete(key);
    const snapshot = this.snapshots.get(key);
    if (!snapshot)
      return;
    try {
      await mkdir4(this.dir, { recursive: true, mode: 448 });
      const tmp = `${this.file(key)}.tmp-${process.pid}`;
      await writeFile4(tmp, JSON.stringify(snapshot), { mode: 384 });
      await rename4(tmp, this.file(key));
    } catch (error) {
      this.log(`could not save the workbench state: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async flush() {
    await Promise.all([...this.timers.keys()].map((key) => this.write(key)));
  }
}

// service/tunnel.ts
import { randomBytes } from "node:crypto";
import net from "node:net";
import tls from "node:tls";
var POLL_BYTES = 4000000;
var POLL_WAIT_MS = 12000;
var ABANDONED_MS = 45000;
var MAX_TUNNELS = 128;
var HEADER_MAX = 16384;

class ServerSocket {
  binaryType = "arraybuffer";
  socket;
  listeners = new Map;
  early = [];
  header = Buffer.alloc(0);
  ended = false;
  constructor(url, headers) {
    const target = new URL(url);
    target.searchParams.set("skipWebSocketFrames", "true");
    const secure = target.protocol === "wss:" || target.protocol === "https:";
    const host = target.hostname.replace(/^\[(.*)\]$/, "$1");
    const port = Number(target.port) || (secure ? 443 : 80);
    const lines = [
      `GET ${target.pathname}${target.search} HTTP/1.1`,
      `Host: ${target.host}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
      "Sec-WebSocket-Version: 13",
      `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
      ...Object.entries(headers).filter(([name, value]) => !/[\r\n:]/.test(name) && !/[\r\n]/.test(value)).map(([name, value]) => `${name}: ${value}`)
    ];
    const request = `${lines.join(`\r
`)}\r
\r
`;
    this.socket = secure ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host }, () => this.socket.write(request)) : net.connect({ host, port }, () => this.socket.write(request));
    this.socket.setNoDelay(true);
    this.socket.on("data", (data) => this.accept(data));
    this.socket.on("error", (error) => this.emit("error", { message: error.message }));
    this.socket.on("close", () => this.end(1006, ""));
  }
  addEventListener(type, listener) {
    this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]);
  }
  send(data) {
    if (this.ended)
      return;
    if (this.header)
      this.early.push(Buffer.from(data));
    else
      this.socket.write(data);
  }
  close() {
    if (this.ended)
      return;
    this.socket.destroy();
    this.end(1000, "", true);
  }
  accept(data) {
    if (this.ended)
      return;
    if (!this.header) {
      this.emit("message", { data });
      return;
    }
    const header = Buffer.concat([this.header, data]);
    const end = header.indexOf(`\r
\r
`);
    if (end < 0) {
      if (header.length > HEADER_MAX)
        this.fail("The VS Code Server sent no upgrade answer.");
      else
        this.header = header;
      return;
    }
    this.header = null;
    const status = /^HTTP\/1\.[01] (\d{3})/.exec(header.subarray(0, end).toString("latin1"))?.[1] ?? "no status";
    if (status !== "101") {
      this.fail(`The VS Code Server refused the connection (HTTP ${status}).`);
      return;
    }
    this.emit("open", {});
    for (const chunk of this.early.splice(0))
      this.socket.write(chunk);
    const rest = header.subarray(end + 4);
    if (rest.length > 0)
      this.emit("message", { data: rest });
  }
  fail(message) {
    this.emit("error", { message });
    this.socket.destroy();
    this.end(1006, message);
  }
  end(code, reason, wasClean = false) {
    if (this.ended)
      return;
    this.ended = true;
    this.emit("close", { code, reason, wasClean });
  }
  emit(type, event) {
    for (const listener of this.listeners.get(type) ?? [])
      listener(event);
  }
}
var defaultFactory = (url, headers) => new ServerSocket(url, headers);
var GONE = { code: 1006, reason: "tunnel gone", wasClean: false };

class Tunnels {
  factory;
  now;
  tunnels = new Map;
  pollWaiters = new Map;
  live = new Set;
  next = 1;
  sweeper;
  constructor(factory = defaultFactory, now = Date.now) {
    this.factory = factory;
    this.now = now;
    this.sweeper = setInterval(() => this.sweep(), 1e4);
    this.sweeper.unref?.();
  }
  open(url, headers, poller = null) {
    if (this.tunnels.size >= MAX_TUNNELS)
      this.sweep(true);
    const id = `t${this.next++}-${Math.random().toString(36).slice(2, 8)}`;
    const socket = this.factory(url, headers);
    socket.binaryType = "arraybuffer";
    const tunnel = { socket, queue: [], queued: 0, closed: null, waiters: [], polledAt: this.now(), poller };
    const wake = () => {
      for (const waiter of tunnel.waiters.splice(0))
        waiter();
      if (poller)
        for (const waiter of this.pollWaiters.get(poller)?.splice(0) ?? [])
          waiter();
    };
    const push = (event) => {
      tunnel.queue.push(event);
      tunnel.queued += event.type === "data" ? event.data.length : 0;
      wake();
    };
    socket.addEventListener("open", () => push({ type: "open" }));
    socket.addEventListener("message", (event) => {
      const data = event.data;
      const bytes = data instanceof ArrayBuffer ? Buffer.from(data) : ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : Buffer.from(String(data));
      push({ type: "data", data: bytes.toString("base64") });
    });
    socket.addEventListener("error", (event) => push({ type: "error", message: event.message ?? "socket error" }));
    socket.addEventListener("close", (event) => {
      this.live.delete(socket);
      tunnel.closed = { code: event.code ?? 1006, reason: event.reason ?? "", wasClean: event.wasClean ?? false };
      wake();
    });
    this.live.add(socket);
    this.tunnels.set(id, tunnel);
    return id;
  }
  has(id) {
    return this.tunnels.has(id);
  }
  send(id, chunks) {
    const tunnel = this.tunnels.get(id);
    if (!tunnel)
      throw new Error("no such tunnel");
    if (tunnel.closed)
      return;
    for (const chunk of chunks)
      tunnel.socket.send(Buffer.from(chunk, "base64"));
  }
  async receive(id, waitMs = POLL_WAIT_MS) {
    const tunnel = this.tunnels.get(id);
    if (!tunnel)
      return { events: [], closed: GONE };
    tunnel.polledAt = this.now();
    if (tunnel.queue.length === 0 && !tunnel.closed) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, waitMs);
        tunnel.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    tunnel.polledAt = this.now();
    const { events, closed } = this.take(id, tunnel, 0);
    return { events, closed };
  }
  async receiveFor(poller, ids, waitMs = POLL_WAIT_MS) {
    const answers = {};
    for (const id of ids)
      if (!this.tunnels.has(id))
        answers[id] = { events: [], closed: GONE };
    const mine = () => [...this.tunnels].filter(([, tunnel]) => tunnel.poller === poller);
    for (const [, tunnel] of mine())
      tunnel.polledAt = this.now();
    const ready = () => mine().some(([, tunnel]) => tunnel.queue.length > 0 || tunnel.closed);
    if (Object.keys(answers).length === 0 && mine().length > 0 && !ready()) {
      await new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          const waiters = (this.pollWaiters.get(poller) ?? []).filter((waiter) => waiter !== done);
          if (waiters.length > 0)
            this.pollWaiters.set(poller, waiters);
          else
            this.pollWaiters.delete(poller);
          resolve();
        };
        const timer = setTimeout(done, waitMs);
        this.pollWaiters.set(poller, [...this.pollWaiters.get(poller) ?? [], done]);
      });
    }
    let used = 0;
    for (const [id, tunnel] of mine()) {
      tunnel.polledAt = this.now();
      if (tunnel.queue.length === 0 && !tunnel.closed)
        continue;
      const { events, closed, size } = this.take(id, tunnel, used);
      used += size;
      if (events.length > 0 || closed)
        answers[id] = { events, closed };
    }
    return answers;
  }
  take(id, tunnel, used) {
    const events = [];
    let size = 0;
    while (tunnel.queue.length > 0) {
      const event = tunnel.queue[0];
      const length = event.type === "data" ? event.data.length : 0;
      if ((events.length > 0 || used > 0) && used + size + length > POLL_BYTES)
        break;
      tunnel.queue.shift();
      tunnel.queued -= length;
      size += length;
      events.push(event);
    }
    const closed = tunnel.queue.length === 0 ? tunnel.closed : null;
    if (closed)
      this.tunnels.delete(id);
    return { events, closed, size };
  }
  close(id) {
    const tunnel = this.tunnels.get(id);
    if (!tunnel)
      return;
    this.tunnels.delete(id);
    try {
      tunnel.socket.close();
    } catch {}
    for (const waiter of tunnel.waiters.splice(0))
      waiter();
    if (tunnel.poller)
      for (const waiter of this.pollWaiters.get(tunnel.poller)?.splice(0) ?? [])
        waiter();
  }
  sweep(oldest = false) {
    const now = this.now();
    for (const [id, tunnel] of this.tunnels)
      if (now - tunnel.polledAt > ABANDONED_MS)
        this.close(id);
    if (oldest && this.tunnels.size >= MAX_TUNNELS) {
      const [id] = [...this.tunnels.entries()].sort((a, b) => a[1].polledAt - b[1].polledAt)[0] ?? [];
      if (id)
        this.close(id);
    }
  }
  size() {
    return this.tunnels.size;
  }
  sockets() {
    return this.live.size;
  }
  dispose() {
    clearInterval(this.sweeper);
    for (const id of [...this.tunnels.keys()])
      this.close(id);
    for (const socket of [...this.live])
      socket.close();
  }
}

// service/main.ts
var port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
var token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";
if (!port || !token) {
  console.error("OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required");
  process.exit(1);
}
var BODY_LIMIT = 200000;
var packageRoot = resolve(dirname3(fileURLToPath(import.meta.url)), "..");
var log = (message) => console.error(`[vscode] ${message}`);
var assets = new WorkbenchAssets(join4(packageRoot, "vscode-web"), () => JSON.parse(readFileSync2(join4(packageRoot, "service", "web-files.json"), "utf8")), log, undefined, join4(packageRoot, "webview"));
var tunnels = new Tunnels;
var stateDir = process.env.OPENCHAMBER_VSCODE_DATA_DIR || join4(homedir2(), ".local", "share", "openchamber-vscode", "state");
var state = new WorkbenchState(stateDir, log);
var rail = new Rail(join4(stateDir, "rail.json"), (url, token) => new VscodeServer(url, token), log);
var editorRequests = new EditorRequests;
var savedTabs = new SavedTabs(stateDir, log);
var json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
var readJson = (req) => new Promise((resolve, reject) => {
  let size = 0;
  const chunks = [];
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > BODY_LIMIT) {
      reject(new Error("request body too large"));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    try {
      const text = Buffer.concat(chunks).toString("utf8");
      const value = text ? JSON.parse(text) : {};
      resolve(typeof value === "object" && value !== null ? value : {});
    } catch {
      reject(new Error("request body is not JSON"));
    }
  });
  req.on("error", reject);
});
var serverOf = (body) => {
  const url = typeof body.serverUrl === "string" ? parseServerUrl(body.serverUrl) : null;
  if (!url)
    throw new ServerError("Set the VS Code Server address first.", 400);
  if (body.token !== undefined && body.token !== null && !isConnectionToken(body.token))
    throw new ServerError("That connection token is not valid.", 400);
  return new VscodeServer(url, body.token ?? null);
};
var routes = {
  "/connect": async (body) => {
    const server = serverOf(body);
    const page = await server.page();
    await rail.remember(server.url, body.token ?? null);
    return { commit: page.commit, base: page.base, version: await server.version(page.base), config: page.config, assets: assets.status(page.commit) };
  },
  "/rail/source": async (body) => {
    const server = serverOf(body);
    const path = typeof body.extensionsPath === "string" && body.extensionsPath.startsWith("/") && body.extensionsPath.length <= 4096 && !body.extensionsPath.includes("\x00") ? body.extensionsPath : null;
    if (!path)
      throw new ServerError("extensionsPath is required", 400);
    await rail.remember(server.url, body.token ?? null, path);
    return { ok: true };
  },
  "/editors/request": async (body) => {
    if (typeof body.key !== "string" || !body.key || body.key.length > 1024 || typeof body.open !== "object" || body.open === null)
      throw new ServerError("key and open are required", 400);
    editorRequests.put(body.key, body.open);
    return { ok: true };
  },
  "/editors/take": async (body) => {
    if (typeof body.key !== "string")
      throw new ServerError("key is required", 400);
    return { open: editorRequests.take(body.key) };
  },
  "/tabs/save": async (body) => {
    const server = serverOf(body);
    await savedTabs.save(SavedTabs.keyOf(WorkbenchState.keyOf(server.url, null), body.folder), readTabs(body.tabs));
    return { ok: true };
  },
  "/tabs/load": async (body) => {
    const server = serverOf(body);
    return { tabs: await savedTabs.load(SavedTabs.keyOf(WorkbenchState.keyOf(server.url, null), body.folder)) };
  },
  "/assets/prepare": async (body) => {
    const server = serverOf(body);
    const page = await server.page();
    return { commit: page.commit, assets: assets.prepare(server, page) };
  },
  "/tunnel/open": async (body) => {
    const server = serverOf(body);
    if (typeof body.path !== "string" || !body.path.startsWith("/") || body.path.length > 4096)
      throw new ServerError("path is required", 400);
    const poller = typeof body.poller === "string" && body.poller.length > 0 && body.poller.length <= 64 ? body.poller : null;
    return { id: tunnels.open(server.socketUrl(body.path), server.socketHeaders(), poller) };
  },
  "/tunnel/send": async (body) => {
    if (typeof body.id !== "string" || !Array.isArray(body.chunks) || !body.chunks.every((chunk) => typeof chunk === "string"))
      throw new ServerError("id and chunks are required", 400);
    if (!tunnels.has(body.id))
      return { closed: true };
    tunnels.send(body.id, body.chunks);
    return { ok: true };
  },
  "/tunnel/recv": async (body) => {
    if (typeof body.poller === "string") {
      const ids = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === "string").slice(0, 16) : [];
      return { tunnels: await tunnels.receiveFor(body.poller, ids) };
    }
    if (typeof body.id !== "string")
      throw new ServerError("id or poller is required", 400);
    return tunnels.receive(body.id);
  },
  "/tunnel/close": async (body) => {
    if (typeof body.id === "string")
      tunnels.close(body.id);
    return { ok: true };
  },
  "/remote/get": async (body) => {
    const server = serverOf(body);
    if (typeof body.path !== "string" || !body.path.startsWith("/") || body.path.length > 8192)
      throw new ServerError("path is required", 400);
    const answer = await server.get(body.path);
    return { status: answer.status, contentType: answer.contentType, data: answer.body.toString("base64") };
  },
  "/external/fetch": async (body) => {
    const url = typeof body.url === "string" ? body.url : "";
    if (!isExternalAllowed(url))
      throw new ServerError("That address is not one the VS Code view may reach.", 403);
    const method = body.method === "POST" ? "POST" : "GET";
    const headers = {};
    if (body.headers && typeof body.headers === "object") {
      for (const [name, value] of Object.entries(body.headers)) {
        if (typeof value === "string" && /^(accept|accept-language|content-type|x-market-client-id|x-market-user-id|vscode-sessionid|x-client-name|x-client-version)$/i.test(name))
          headers[name] = value;
      }
    }
    const payload = method === "POST" && typeof body.body === "string" ? Buffer.from(body.body, "base64") : undefined;
    const response = await fetch(url, { method, headers, body: payload, redirect: "follow", signal: AbortSignal.timeout(15000) });
    const data = Buffer.from(await response.arrayBuffer());
    if (data.byteLength > RESOURCE_MAX)
      throw new ServerError("The answer is too large.", 413);
    return { status: response.status, contentType: response.headers.get("content-type") ?? "application/octet-stream", data: data.toString("base64") };
  },
  "/state/load": async (body) => {
    const server = serverOf(body);
    const key = WorkbenchState.keyOf(server.url, null);
    return isStateRole(body.role) ? state.loadRole(key, body.role) : state.load(key);
  },
  "/state/apply": async (body) => {
    const server = serverOf(body);
    const key = WorkbenchState.keyOf(server.url, null);
    if (isStateRole(body.role))
      await state.applyRole(key, body.role, readOps(body.ops));
    else
      await state.apply(key, readOps(body.ops));
    return { ok: true };
  }
};
var server = http.createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) {
    json(res, 401, { error: "unauthorized" });
    return;
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  try {
    if (url.pathname === "/health" && req.method === "GET") {
      json(res, 200, { ok: true, tunnels: tunnels.size(), sockets: tunnels.sockets() });
      return;
    }
    if (url.pathname === "/rail" && req.method === "GET") {
      json(res, 200, { entries: await rail.entries() });
      return;
    }
    const route = req.method === "POST" ? routes[url.pathname] : undefined;
    if (!route) {
      json(res, 404, { error: "not found" });
      return;
    }
    json(res, 200, await route(await readJson(req)));
  } catch (error) {
    const status = error instanceof ServerError ? error.status : 500;
    json(res, status, { error: error instanceof Error ? error.message : String(error) });
  }
});
var shutdown = async () => {
  server.close();
  tunnels.dispose();
  await state.flush();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
server.listen(port, "127.0.0.1");
