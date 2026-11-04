// Round 12: a Gmail message's address pasted into a new task, through the service against the fake Google
// (PLANNER_GOOGLE_API_BASE): /google/mail/resolve finds a thread's latest message, or a message by its own id, in
// the account the address names first and then in each with Gmail; anything else is 404, a malformed id 400.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { todayIn } from '../src/domain/dates.ts';
import { gmailUrl } from '../src/domain/google.ts';
import { parseGmailUrl } from '../src/domain/pastedUrl.ts';
import { defaultFakeWorld, startFakeGoogle, type FakeGoogle } from './e2e/fakeGoogle.mjs';

const token = 'mail-resolve-test-token';
const ZONE = 'America/Los_Angeles';
const ME = 'harness@example.com';
let child: ChildProcess;
let fake: FakeGoogle;
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
  const response = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
};

beforeAll(async () => {
  const world = defaultFakeWorld({ account: ME, today: todayIn(ZONE), zone: ZONE });
  world.mail = [
    { id: '18b2f3c4d5e6f701', threadId: '18b2f3c4d5e6f700', subject: 'Quarterly numbers', from: 'Ann <ann@example.com>', date: '2026-10-28T09:00:00.000Z', snippet: 'First draft' },
    { id: '18b2f3c4d5e6f702', threadId: '18b2f3c4d5e6f700', subject: 'Re: Quarterly numbers', from: 'Bo <bo@example.com>', date: '2026-10-29T10:00:00.000Z', snippet: 'Looks good', unread: true },
  ];
  fake = await startFakeGoogle(world);
  root = mkdtempSync(join(tmpdir(), 'planner-mail-resolve-'));
  writeFileSync(join(root, 'google-accounts.json'), fake.accountsFile(), { mode: 0o600 });
  const port = await freePort();
  child = spawn(process.execPath, [join(import.meta.dir, '../service/main.ts')], {
    env: { ...process.env, OPENCHAMBER_SERVICE_PORT: String(port), OPENCHAMBER_SERVICE_TOKEN: token, PLANNER_DATA_DIR: join(root, 'data'), PLANNER_GOOGLE_API_BASE: fake.base },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      if ((await fetch(`${base}/health`, { headers: { Authorization: `Bearer ${token}` } })).ok) break;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
});

afterAll(async () => {
  const exited = new Promise((resolve) => child?.once('exit', resolve));
  child?.kill('SIGTERM');
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
  await fake?.close();
  rmSync(root, { recursive: true, force: true });
});

describe("a pasted Gmail address, through the service's /google/mail/resolve", () => {
  test("a thread's address opens its latest message, read from Gmail with the subject, sender and snippet", async () => {
    // The address the Planner itself links a task to (its account in the path), as pasted back.
    const pasted = parseGmailUrl(gmailUrl(ME, '18b2f3c4d5e6f700'))!;
    expect([pasted.thread, pasted.account]).toEqual(['18b2f3c4d5e6f700', ME]);
    const { status, body } = await call('POST', '/google/mail/resolve', { thread: pasted.thread, message: pasted.message, account: pasted.account });
    expect(status).toBe(200);
    expect(body.item).toMatchObject({ account: ME, id: '18b2f3c4d5e6f702', threadId: '18b2f3c4d5e6f700', subject: 'Re: Quarterly numbers', from: 'Bo <bo@example.com>', snippet: 'Looks good', unread: true });
    expect(fake.requests.some((request) => request.path === '/gmail/v1/users/me/threads/18b2f3c4d5e6f700')).toBe(true);
  });

  test('a message by its own id (a printed message\'s msg-f:), in an account the address does not name', async () => {
    const { status, body } = await call('POST', '/google/mail/resolve', { thread: null, message: '18b2f3c4d5e6f701', account: 'someone-else@example.com' });
    expect([status, body.item?.subject]).toEqual([200, 'Quarterly numbers']);
  });

  test('a message in none of the accounts is 404 with the reason; an id that is no Gmail id is refused', async () => {
    const missing = await call('POST', '/google/mail/resolve', { thread: '18b2f3c4d5e6f7ff', message: null, account: null });
    expect([missing.status, missing.body.error]).toEqual([404, 'This message is in none of your Gmail accounts']);
    const malformed = await call('POST', '/google/mail/resolve', { thread: 'FMfcgzQgLjNPlfJCVRfnNkPGkLhWClCW', message: null });
    expect(malformed.status).toBe(400);
  });
});
