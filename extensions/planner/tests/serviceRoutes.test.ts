// The service as the host runs it: a process on a loopback port with a bearer
// token, here with its data in a temporary folder. Google is never called: no
// account is connected, and the sign-in's redirect is played by the test.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const token = 'service-test-token';
const auth = { Authorization: `Bearer ${token}` };
let child: ChildProcess;
let base = '';
let root = '';

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });

const call = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${base}${path}`, { method, headers: { ...auth, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'planner-service-'));
  const port = await freePort();
  child = spawn(process.execPath, [join(import.meta.dir, '../service/main.ts')], {
    env: { ...process.env, OPENCHAMBER_SERVICE_PORT: String(port), OPENCHAMBER_SERVICE_TOKEN: token, PLANNER_DATA_DIR: join(root, 'data') },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      if ((await fetch(`${base}/health`, { headers: auth })).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the service did not start');
});

afterAll(async () => {
  // Let it finish its last commit before its folder goes.
  const exited = new Promise((resolve) => child?.once('exit', resolve));
  child?.kill('SIGTERM');
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
  rmSync(root, { recursive: true, force: true });
});

const CLIENT_ID = `${'1234567'.repeat(2)}-${'abcdefghij'.repeat(3)}.apps.googleusercontent.com`;

describe('Google routes', () => {
  test('nothing without the bearer token', async () => {
    expect((await fetch(`${base}/google/status`)).status).toBe(401);
  });

  test('the OAuth client: refused when it is not one, kept without its secret showing', async () => {
    expect((await call('GET', '/google/status')).body).toEqual({ client: null, accounts: [], timeboxError: null });
    const bad = await call('PUT', '/google/client', { id: 'nope', secret: 'x'.repeat(20) });
    expect(bad.status).toBe(400);
    expect(String(bad.body.error)).toContain('OAuth client ID');
    const saved = await call('PUT', '/google/client', { id: CLIENT_ID, secret: `GOCSPX-${'s'.repeat(28)}` });
    expect(saved).toEqual({ status: 200, body: { client: { id: CLIENT_ID }, accounts: [] } });
  });

  test('a sign-in waits on a loopback port and takes only its own redirect', async () => {
    expect((await call('POST', '/google/connect', { features: [] })).status).toBe(400);
    const started = await call('POST', '/google/connect', { features: ['calendar', 'tasks', 'bogus'] });
    expect(started.status).toBe(200);
    const authUrl = new URL(String(started.body.authUrl));
    const redirect = String(started.body.redirectUri);
    expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(authUrl.searchParams.get('redirect_uri')).toBe(redirect);
    expect(authUrl.searchParams.get('scope')).toContain('https://www.googleapis.com/auth/tasks');
    expect(authUrl.searchParams.get('scope')).not.toContain('gmail');
    const id = String(started.body.id);
    expect((await call('GET', `/google/connect/${id}`)).body).toEqual({ status: 'pending' });
    // Someone else's redirect changes nothing; a pasted address must be this sign-in's.
    expect(await (await fetch(`${redirect}?state=forged&code=x`)).text()).toContain('does not belong');
    expect((await call('POST', `/google/connect/${id}/finish`, { url: 'http://127.0.0.1:9/?state=x&code=y' })).status).toBe(400);
    // Google's answer when access is refused ends the sign-in.
    const page = await (await fetch(`${redirect}?state=${authUrl.searchParams.get('state')}&error=access_denied`)).text();
    expect(page).toContain('Not connected');
    expect((await call('GET', `/google/connect/${id}`)).body).toEqual({ status: 'failed', message: 'Access was not allowed' });
    expect((await call('GET', '/google/connect/unknownsignin1')).body).toMatchObject({ status: 'failed' });
  });

  test('a Google calendar of an account that is not connected says so, and the rest still shows', async () => {
    const added = await call('POST', '/commands', {
      commands: [{ cmd: 'gcal00000001', type: 'calendar.added', calendar: { id: 'gcal1', name: 'Work', url: 'https://calendar.google.com/calendar/r', color: '#4285f4', google: { account: 'me@example.com', calendarId: 'primary' } } }],
    });
    expect(added.status).toBe(200);
    const calendar = await call('GET', '/calendar?from=2026-10-26&to=2026-11-01');
    expect(calendar.status).toBe(200);
    expect(calendar.body.events).toEqual([]);
    expect(calendar.body.errors).toEqual([{ calendarId: 'gcal1', message: 'me@example.com is not connected' }]);
  });

  test('Google requests check what they are given', async () => {
    expect((await call('GET', '/google/tasks')).status).toBe(400);
    expect((await call('GET', '/google/mail?account=not-an-email')).status).toBe(400);
    expect((await call('PATCH', '/google/tasks', { account: 'me@example.com', listId: 'L1', id: 'T1', due: 'tomorrow' })).status).toBe(400);
    expect((await call('PATCH', '/google/tasks', { account: 'me@example.com', listId: 'L1', id: 'T1', completed: true })).body).toEqual({ error: 'me@example.com is not connected' });
    expect((await call('GET', '/google/calendars')).body).toEqual({ calendars: [], errors: [] });
  });

  test('removing the client forgets it', async () => {
    expect((await call('DELETE', '/google/client')).body).toEqual({ client: null, accounts: [] });
  });
});
