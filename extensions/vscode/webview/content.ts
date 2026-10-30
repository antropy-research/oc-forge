// A webview's HTML made ready for an opaque-origin frame. VS Code's own
// webview host loads a webview's files (`asWebviewUri` URLs) through a
// service worker and writes the HTML into a same-origin frame; an extension
// frame can have neither. Here the files are read through the workbench
// (its `load-resource` channel) and put inline: scripts and styles as text,
// images, fonts and media as data: URLs. Pure apart from the DOM it is given.

export interface ResourceRequest {
  scheme: string;
  authority: string;
  path: string;
  query: string;
}

/**
 * What a webview resource URL asks the workbench for, as VS Code's service
 * worker reads it: `https://<scheme>+<authority>.<base>/<path>?<query>`, or a
 * URL on the remote authority. Null for anything else.
 */
export const resourceRequestOf = (url: string, resourceBase: string | null, remoteAuthority: string | null): ResourceRequest | null => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const query = parsed.search.replace(/^\?/, '');
  if (resourceBase && parsed.protocol === 'https:' && parsed.hostname.endsWith(`.${resourceBase}`)) {
    const head = parsed.hostname.slice(0, parsed.hostname.length - resourceBase.length - 1);
    const scheme = head.split('+', 1)[0] ?? '';
    return { scheme, authority: head.slice(scheme.length + 1), path: parsed.pathname, query };
  }
  if (remoteAuthority && parsed.host === remoteAuthority && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
    return { scheme: parsed.protocol.slice(0, -1), authority: parsed.host, path: parsed.pathname, query };
  }
  return null;
};

const NONCE = /'nonce-([^']+)'/;

/** The directives of a CSP, in order, by name. */
const parseCsp = (policy: string): [string, string[]][] => policy
  .split(';')
  .map((part) => part.trim().split(/\s+/).filter(Boolean))
  .filter((tokens) => tokens.length > 0)
  .map((tokens) => [tokens[0]!.toLowerCase(), tokens.slice(1)] as [string, string[]]);

/** The nonce scripts (or styles) need under this policy, if it names one. */
export const cspNonce = (policy: string | null, kind: 'script' | 'style'): string | null => {
  if (!policy) return null;
  const directives = new Map(parseCsp(policy));
  const sources = directives.get(`${kind}-src`) ?? directives.get('default-src') ?? [];
  for (const source of sources) {
    const match = NONCE.exec(source);
    if (match) return match[1]!;
  }
  return null;
};

/**
 * The webview's own CSP, with room for what this host puts inline: data: and
 * blob: for images, fonts and media, inline scripts and styles where the
 * policy has no nonce or hash to give them, and the agent's nonce where it
 * allows no scripts at all (the webview's own scripts are removed then).
 * Directives that are 'none' otherwise stay 'none'.
 */
export const relaxCsp = (policy: string, agentNonce: string, blobScripts = false): string => {
  const directives = parseCsp(policy);
  const names = new Set(directives.map(([name]) => name));
  const fallback = directives.find(([name]) => name === 'default-src')?.[1] ?? [];
  // Directives that inherit default-src get their own copy, so widening them leaves default-src alone.
  for (const name of ['script-src', 'style-src', 'img-src', 'font-src', 'media-src']) {
    if (!names.has(name) && names.has('default-src')) directives.push([name, [...fallback]]);
  }
  for (const directive of directives) {
    const [name, sources] = directive;
    const add = (source: string) => {
      if (!sources.includes(source)) sources.push(source);
    };
    const none = sources.length === 1 && sources[0] === "'none'";
    const keyed = sources.some((source) => NONCE.test(source) || /^'sha(256|384|512)-/.test(source));
    if (name === 'script-src') {
      // Modules the agent maps to blob: URLs; injected HTML cannot make a blob: URL, only a running script can.
      if (blobScripts && !none) add('blob:');
      if (none) directive[1] = [`'nonce-${agentNonce}'`];
      else if (!keyed) add("'unsafe-inline'");
      else if (!sources.some((source) => NONCE.test(source))) add(`'nonce-${agentNonce}'`);
    } else if (none) {
      continue;
    } else if (name === 'style-src') {
      if (!keyed) add("'unsafe-inline'");
      else if (!sources.some((source) => NONCE.test(source))) add(`'nonce-${agentNonce}'`);
    } else if (name === 'img-src' || name === 'font-src' || name === 'media-src') {
      add('data:');
      add('blob:');
    }
  }
  return directives.map(([name, sources]) => [name, ...sources].join(' ')).join('; ');
};

const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
};

export const dataUrl = (mime: string, bytes: Uint8Array): string => `data:${mime || 'application/octet-stream'};base64,${toBase64(bytes)}`;

export interface Loaded {
  mime: string;
  bytes: Uint8Array;
}

export interface ContentOptions {
  allowScripts?: boolean;
  allowForms?: boolean;
  allowMultipleAPIAcquire?: boolean;
}

export interface PrepareInput {
  contents: string;
  options: ContentOptions;
  state?: string;
  cspSource?: string;
  /** VS Code's default webview styles (`@layer vscode-default`). */
  defaultStyles: string;
  /** The agent that runs first in the content (`agent.ts`), as script text. */
  agent: string;
  /** The theme variables and classes the agent applies before anything paints. */
  styles: unknown;
  resourceBase: string | null;
  remoteAuthority: string | null;
  /** Reads a webview resource; null when the URL is not one or it cannot be read. */
  load: (url: string) => Promise<Loaded | null>;
  /** Whether a URL is a webview resource. */
  isResource: (url: string) => boolean;
  DOMParser: { new (): { parseFromString(text: string, type: 'text/html'): Document } };
}

const decoder = new TextDecoder();

/**
 * Text that goes inside <script> or <style> in serialized HTML must not close
 * the element: `</script` becomes `<\/script`, the same in JS strings, regular
 * expressions and CSS.
 */
export const closeSafe = (text: string, tag: 'script' | 'style'): string => text.replace(new RegExp(`</(${tag})`, 'gi'), '<\\/$1');

/** Relative module specifiers: `from"./x.js"`, `import"./x.js"`, `import("./x.js")`. */
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])(\.{1,2}\/[^"']+)\2/g;

/** A module's relative imports made absolute (its own URL as the base), and the URLs they name. */
export const absoluteImports = (text: string, url: string): { text: string; urls: string[] } => {
  const urls: string[] = [];
  const rewritten = text.replace(SPECIFIER, (whole, lead: string, quote: string, specifier: string) => {
    try {
      const absolute = new URL(specifier, url).toString();
      urls.push(absolute);
      return `${lead}${quote}${absolute}${quote}`;
    } catch {
      return whole;
    }
  });
  return { text: rewritten, urls };
};

/** The modules a module imports, transitively, fetched and with absolute specifiers. */
const moduleGraph = async (urls: string[], input: PrepareInput, into: Record<string, string>, budget: { count: number; bytes: number }): Promise<void> => {
  for (const url of urls) {
    if (url in into || budget.count >= 300 || budget.bytes > 20_000_000 || !input.isResource(url)) continue;
    into[url] = '';
    const loaded = await input.load(url);
    if (!loaded) continue;
    budget.count += 1;
    budget.bytes += loaded.bytes.byteLength;
    const { text, urls: next } = absoluteImports(decoder.decode(loaded.bytes), url);
    into[url] = text;
    await moduleGraph(next, input, into, budget);
  }
};

/** `url(...)` inside CSS, resolved against the stylesheet's own URL and put inline. */
const inlineCssUrls = async (css: string, base: string, input: PrepareInput): Promise<string> => {
  const pattern = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
  const found = new Map<string, string>();
  for (const match of css.matchAll(pattern)) {
    const raw = match[2]!;
    if (raw.startsWith('data:') || raw.startsWith('#')) continue;
    let absolute: string;
    try {
      absolute = new URL(raw, base).toString();
    } catch {
      continue;
    }
    if (!input.isResource(absolute) || found.has(raw)) continue;
    const loaded = await input.load(absolute);
    if (loaded) found.set(raw, dataUrl(loaded.mime, loaded.bytes));
  }
  return css.replace(pattern, (whole, quote: string, raw: string) => (found.has(raw) ? `url(${quote}${found.get(raw)}${quote})` : whole));
};

/** The webview's HTML as one self-contained document for a srcdoc frame. */
export const prepareContent = async (input: PrepareInput): Promise<string> => {
  const doc = new input.DOMParser().parseFromString(input.contents, 'text/html');
  const base = doc.querySelector('base')?.getAttribute('href') ?? null;
  const resolve = (value: string | null): string | null => {
    if (!value) return null;
    try {
      return new URL(value, base ?? undefined).toString();
    } catch {
      return null;
    }
  };

  // As VS Code's host does: link titles, a document role, only the http-equiv tags it supports.
  for (const anchor of doc.querySelectorAll('a')) {
    const href = anchor.getAttribute('href');
    if (!anchor.getAttribute('title') && typeof href === 'string') anchor.setAttribute('title', href);
  }
  if (!doc.body.hasAttribute('role')) doc.body.setAttribute('role', 'document');
  for (const meta of [...doc.querySelectorAll('meta')]) {
    const httpEquiv = meta.getAttribute('http-equiv');
    if (httpEquiv && !/^(content-security-policy|default-style|content-type)$/i.test(httpEquiv)) meta.remove();
  }
  const cspMeta = [...doc.querySelectorAll('meta')].find((meta) => /^content-security-policy$/i.test(meta.getAttribute('http-equiv') ?? '')) ?? null;
  let policy = cspMeta?.getAttribute('content') ?? null;
  if (policy && input.cspSource) policy = policy.replace(/(vscode-webview-resource|vscode-resource):(?=(\s|;|$))/g, input.cspSource);
  const scriptNonce = cspNonce(policy, 'script');
  const styleNonce = cspNonce(policy, 'style');
  // The agent runs under the webview's own nonce, or one of its own where the policy has none to give.
  const agentNonce = scriptNonce ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');

  // Scripts: put inline (keeping their nonce), or gone when the webview may not run scripts.
  // A module's imports come along and are mapped to blob: URLs by the agent (an import map).
  const modules: Record<string, string> = {};
  const budget = { count: 0, bytes: 0 };
  for (const script of [...doc.querySelectorAll('script')]) {
    if (!input.options.allowScripts) {
      script.remove();
      continue;
    }
    const src = resolve(script.getAttribute('src'));
    if (src && input.isResource(src)) {
      const loaded = await input.load(src);
      script.removeAttribute('src');
      script.removeAttribute('async');
      script.removeAttribute('defer');
      let text = loaded ? decoder.decode(loaded.bytes) : `console.error(${JSON.stringify(`Could not load ${src}`)});`;
      if (loaded && script.getAttribute('type') === 'module') {
        const absolute = absoluteImports(text, src);
        text = absolute.text;
        await moduleGraph(absolute.urls, input, modules, budget);
      }
      script.textContent = closeSafe(text, 'script');
      if (!script.getAttribute('nonce')) script.setAttribute('nonce', scriptNonce ?? agentNonce);
    }
  }
  if (!input.options.allowScripts) {
    for (const element of doc.querySelectorAll('*')) {
      for (const attribute of [...element.attributes]) if (/^on/i.test(attribute.name)) element.removeAttribute(attribute.name);
    }
  }

  // Stylesheets become <style>, with their own url()s inline.
  for (const link of [...doc.querySelectorAll('link')]) {
    const rel = (link.getAttribute('rel') ?? '').toLowerCase().split(/\s+/);
    const href = resolve(link.getAttribute('href'));
    if (!href || !input.isResource(href)) continue;
    if (rel.includes('stylesheet')) {
      const loaded = await input.load(href);
      const style = doc.createElement('style');
      for (const name of ['media', 'id', 'class', 'title']) {
        const value = link.getAttribute(name);
        if (value !== null) style.setAttribute(name, value);
      }
      style.setAttribute('nonce', link.getAttribute('nonce') ?? styleNonce ?? agentNonce);
      style.textContent = closeSafe(loaded ? await inlineCssUrls(decoder.decode(loaded.bytes), href, input) : '', 'style');
      link.replaceWith(style);
    } else {
      const loaded = await input.load(href);
      if (loaded) link.setAttribute('href', dataUrl(loaded.mime, loaded.bytes));
    }
  }
  for (const style of doc.querySelectorAll('style')) {
    if (style.textContent && /url\(/.test(style.textContent)) style.textContent = await inlineCssUrls(style.textContent, base ?? 'about:blank', input);
  }

  // Images, media, and inline style attributes.
  for (const [selector, attribute] of [['img[src]', 'src'], ['source[src]', 'src'], ['video[src]', 'src'], ['audio[src]', 'src'], ['video[poster]', 'poster'], ['image[href]', 'href'], ['input[type=image][src]', 'src']] as const) {
    for (const element of doc.querySelectorAll(selector)) {
      const url = resolve(element.getAttribute(attribute));
      if (!url || !input.isResource(url)) continue;
      const loaded = await input.load(url);
      if (loaded) element.setAttribute(attribute, dataUrl(loaded.mime, loaded.bytes));
    }
  }
  for (const element of doc.querySelectorAll('[style*="url("]')) {
    element.setAttribute('style', await inlineCssUrls(element.getAttribute('style') ?? '', base ?? 'about:blank', input));
  }

  const hasModules = Object.values(modules).some(Boolean);
  if (cspMeta && policy) cspMeta.setAttribute('content', relaxCsp(policy, agentNonce, hasModules));

  // First in <head>: the content's settings, the agent, then VS Code's default styles.
  const config = doc.createElement('script');
  config.setAttribute('type', 'application/json');
  config.id = '_ocWebviewConfig';
  config.textContent = JSON.stringify({ resourceBase: input.resourceBase, remoteAuthority: input.remoteAuthority, allowScripts: Boolean(input.options.allowScripts), allowMultipleAPIAcquire: Boolean(input.options.allowMultipleAPIAcquire), state: input.state ?? null, styles: input.styles, modules: Object.fromEntries(Object.entries(modules).filter(([, text]) => text)) }).replace(/</g, '\\u003c');
  const agent = doc.createElement('script');
  agent.id = '_ocWebviewAgent';
  agent.setAttribute('nonce', agentNonce);
  agent.textContent = closeSafe(input.agent, 'script');
  const defaults = doc.createElement('style');
  defaults.id = '_defaultStyles';
  defaults.setAttribute('nonce', styleNonce ?? agentNonce);
  defaults.textContent = input.defaultStyles;
  // After the CSP meta, which must stay ahead of anything it governs.
  const anchor = cspMeta && cspMeta.parentElement === doc.head ? cspMeta.nextSibling : doc.head.firstChild;
  doc.head.insertBefore(defaults, anchor);
  doc.head.insertBefore(agent, defaults);
  doc.head.insertBefore(config, agent);
  return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
};
