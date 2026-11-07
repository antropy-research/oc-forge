// The dev container's defaults, applied once OpenChamber answers (the image starts this beside `openchamber serve`):
// Cloak Browser is installed from /extensions/cloak-browser with its service approved, then it is the Browser provider
// (Settings → General → OpenChamber Tools), so the agent's browser actions run on CloakBrowser from the first start.
// The order matters: OpenChamber puts the provider back to builtin when the extension it names is not installed and
// approved. Every start checks again and changes only what is not so already; a change made in Settings lasts until
// the next start. OC_DEV_BROWSER_PROVIDER (compose.yaml) names the provider: `builtin` is OpenChamber's own browser.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const base = 'http://127.0.0.1:3000';
const provider = (process.env.OC_DEV_BROWSER_PROVIDER ?? 'oc-forge-cloak-browser').trim() || 'builtin';
/** Where the extensions this container knows are mounted (compose.yaml mounts the repository's extensions/). */
const folders = { 'oc-forge-cloak-browser': '/extensions/cloak-browser' };

const log = (message) => console.log(`[dev-defaults] ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let cookie = '';
const call = async (method, path, body) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // not JSON
  }
  return { status: res.status, ok: res.ok, json, text };
};

/** OpenChamber answering its health check, within ten minutes of the start. */
const answers = async () => {
  for (const end = Date.now() + 10 * 60_000; Date.now() < end; await sleep(2000)) {
    try {
      if ((await call('GET', '/health')).ok) return true;
    } catch {
      // not listening yet
    }
  }
  return false;
};

/** The UI password's session, when the container has one (secrets.env). */
const login = async () => {
  const password = process.env.OPENCHAMBER_UI_PASSWORD;
  if (!password) return;
  const res = await fetch(`${base}/auth/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status !== 200) throw new Error(`the UI password was refused (HTTP ${res.status})`);
  cookie = (res.headers.getSetCookie?.() ?? []).map((value) => value.split(';')[0]).join('; ');
};

const catalogRow = async (id) => {
  const { json } = await call('GET', '/api/guests');
  return (Array.isArray(json) ? json : json?.guests ?? []).find((guest) => guest.id === id) ?? null;
};

/** The extension installed, enabled and approved: what OpenChamber needs before it accepts it as the provider. */
const usable = async (id) => {
  let row = await catalogRow(id);
  const folder = folders[id];
  if (!row && folder && existsSync(join(folder, 'package.json'))) {
    const added = await call('POST', '/api/guests', { path: folder });
    log(added.status === 201 ? `installed ${id} from ${folder}` : `could not install ${folder}: HTTP ${added.status} ${added.text.slice(0, 160)}`);
    row = await catalogRow(id);
  }
  if (!row) {
    log(`${id} is not installed`);
    return false;
  }
  if (row.enabled === false) {
    log(`${id} is turned off in Settings → Extensions`);
    return false;
  }
  const requested = row.capabilities?.requested ?? [];
  const granted = row.capabilities?.granted ?? [];
  if (!requested.every((capability) => granted.includes(capability))) {
    const approved = await call('PUT', `/api/guests/${encodeURIComponent(id)}/capabilities`, { granted: requested });
    if (!approved.ok) {
      log(`could not approve ${id}: HTTP ${approved.status} ${approved.text.slice(0, 160)}`);
      return false;
    }
    log(`approved ${id}: ${requested.join(', ')}`);
  }
  return true;
};

const main = async () => {
  if (!(await answers())) {
    log('OpenChamber did not answer within 10 minutes: nothing set');
    return;
  }
  await login();
  if (provider !== 'builtin' && !(await usable(provider))) {
    log('the Browser provider stays as it is');
    return;
  }
  const current = (await call('GET', '/api/config/settings')).json?.browserProvider ?? 'builtin';
  if (current === provider) {
    log(`Browser provider: ${provider}`);
    return;
  }
  const saved = await call('PUT', '/api/config/settings', { browserProvider: provider });
  log(saved.ok ? `Browser provider: ${current} → ${provider}` : `could not set the Browser provider: HTTP ${saved.status} ${saved.text.slice(0, 160)}`);
};

await main().catch((error) => log(`failed: ${error instanceof Error ? error.message : String(error)}`));
