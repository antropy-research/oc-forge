import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUTH_URL, FEATURE_SCOPES, GoogleAccounts, GoogleError, TOKEN_URL, emailFromIdToken, featuresOf, type Fetcher, type Listen } from '../service/google.ts';

// Made-up credentials, built at run time so nothing here looks like a real secret.
const CLIENT_ID = `${'1234567'.repeat(2)}-${'abcdefghij'.repeat(3)}.apps.googleusercontent.com`;
const SECRET = `GOCSPX-${'x'.repeat(28)}`;
const idToken = (email: string) => ['e30', Buffer.from(JSON.stringify({ email })).toString('base64url'), 'sig'].join('.');

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

const setup = (answer: (call: Call) => { status: number; body: unknown }) => {
  const calls: Call[] = [];
  const fetcher: Fetcher = async (url, init) => {
    const call = { url, method: init.method, headers: init.headers, ...(init.body ? { body: init.body } : {}) };
    calls.push(call);
    const { status, body } = answer(call);
    return { status, text: async () => (body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)) };
  };
  let onRequest: ((url: URL) => Promise<string>) | null = null;
  let closed = 0;
  const listen: Listen = async (handler) => {
    onRequest = handler;
    return { port: 49152, close: () => closed++ };
  };
  const file = join(mkdtempSync(join(tmpdir(), 'planner-google-')), 'google-accounts.json');
  const accounts = new GoogleAccounts(file, fetcher, listen);
  return { accounts, calls, file, redirect: (query: Record<string, string>) => onRequest!(new URL(`http://127.0.0.1:49152/?${new URLSearchParams(query)}`)), closed: () => closed };
};

const form = (call: Call) => Object.fromEntries(new URLSearchParams(call.body ?? ''));
const allScopes = ['openid', 'https://www.googleapis.com/auth/userinfo.email', ...FEATURE_SCOPES.calendar, ...FEATURE_SCOPES.tasks];
const exchangeOk = (email = 'Me@Example.com', scope = allScopes.join(' ')) => ({ status: 200, body: { access_token: 'at-1', expires_in: 3600, refresh_token: 'rt-1', scope, id_token: idToken(email) } });

describe('Google client and sign-in', () => {
  test('the client must look like a desktop OAuth client; its secret never comes back', async () => {
    const { accounts } = setup(() => ({ status: 500, body: '' }));
    await expect(accounts.setClient('not-a-client', SECRET)).rejects.toThrow('OAuth client ID');
    await expect(accounts.setClient(CLIENT_ID, 'short')).rejects.toThrow('client secret');
    const status = await accounts.setClient(` ${CLIENT_ID} `, SECRET);
    expect(status).toEqual({ client: { id: CLIENT_ID }, accounts: [] });
    expect(JSON.stringify(status)).not.toContain(SECRET);
  });

  test('a sign-in asks for the chosen features with PKCE, offline access and consent', async () => {
    const { accounts } = setup(() => ({ status: 500, body: '' }));
    await expect(accounts.startSignIn(['calendar'])).rejects.toThrow('OAuth client first');
    await accounts.setClient(CLIENT_ID, SECRET);
    await expect(accounts.startSignIn([])).rejects.toThrow('at least one');
    const started = await accounts.startSignIn(['calendar', 'tasks']);
    expect(started.redirectUri).toBe('http://127.0.0.1:49152/');
    const url = new URL(started.authUrl);
    expect(`${url.origin}${url.pathname}`).toBe(AUTH_URL);
    const query = Object.fromEntries(url.searchParams);
    expect(query).toMatchObject({ client_id: CLIENT_ID, redirect_uri: started.redirectUri, response_type: 'code', code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent' });
    expect(query.scope!.split(' ')).toEqual(['openid', 'email', ...FEATURE_SCOPES.calendar, ...FEATURE_SCOPES.tasks]);
    expect(query.state!.length).toBeGreaterThan(20);
    expect(query.code_challenge!.length).toBe(43);
    expect(accounts.signIn(started.id)).toEqual({ status: 'pending' });
  });

  test("Google's redirect finishes it: code for tokens, the account kept on this machine only", async () => {
    const { accounts, calls, file, redirect, closed } = setup((call) => (call.url === TOKEN_URL ? exchangeOk() : { status: 500, body: '' }));
    await accounts.setClient(CLIENT_ID, SECRET);
    const started = await accounts.startSignIn(['calendar', 'tasks']);
    const state = new URL(started.authUrl).searchParams.get('state')!;
    // Someone else's redirect is not this sign-in's answer.
    expect(await redirect({ state: 'forged', code: 'c' })).toContain('does not belong');
    expect(accounts.signIn(started.id)).toEqual({ status: 'pending' });
    expect(await redirect({ state, code: 'the-code' })).toContain('me@example.com');
    expect(accounts.signIn(started.id)).toEqual({ status: 'connected', email: 'me@example.com', features: ['calendar', 'tasks'] });
    expect(closed()).toBe(1);
    const exchange = form(calls[0]!);
    expect(exchange).toMatchObject({ grant_type: 'authorization_code', code: 'the-code', redirect_uri: started.redirectUri, client_id: CLIENT_ID, client_secret: SECRET });
    expect(exchange.code_verifier!.length).toBeGreaterThan(40);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toContain('rt-1');
    const status = await accounts.status();
    expect(status.accounts).toEqual([{ email: 'me@example.com', features: ['calendar', 'tasks'], addedAt: expect.any(String), workspace: false }]);
    expect(JSON.stringify(status)).not.toContain('rt-1');
  });

  test('features follow what Google granted, not what was asked', () => {
    expect(featuresOf([...FEATURE_SCOPES.tasks, FEATURE_SCOPES.calendar[1]!])).toEqual(['tasks']);
    expect(emailFromIdToken(idToken('A@B.co'))).toBe('a@b.co');
    expect(emailFromIdToken('garbage')).toBeNull();
  });

  test('a refused consent, a missing refresh token, and a pasted address from another machine', async () => {
    let refresh = true;
    const { accounts, redirect } = setup(() => (refresh ? exchangeOk() : { status: 200, body: { access_token: 'at', id_token: idToken('x@y.z'), scope: allScopes.join(' ') } }));
    await accounts.setClient(CLIENT_ID, SECRET);
    const denied = await accounts.startSignIn(['tasks']);
    await redirect({ state: new URL(denied.authUrl).searchParams.get('state')!, error: 'access_denied' });
    expect(accounts.signIn(denied.id)).toEqual({ status: 'failed', message: 'Access was not allowed' });

    refresh = false;
    const noRefresh = await accounts.startSignIn(['tasks']);
    await redirect({ state: new URL(noRefresh.authUrl).searchParams.get('state')!, code: 'c' });
    expect(accounts.signIn(noRefresh.id)).toMatchObject({ status: 'failed', message: expect.stringContaining('no refresh token') });

    refresh = true;
    const pasted = await accounts.startSignIn(['tasks']);
    const state = new URL(pasted.authUrl).searchParams.get('state')!;
    await expect(accounts.finishSignIn(pasted.id, 'not a url')).rejects.toThrow('whole address');
    await expect(accounts.finishSignIn(pasted.id, `http://127.0.0.1:1234/?state=${state}&code=c`)).rejects.toThrow('not the one');
    expect(await accounts.finishSignIn(pasted.id, `http://127.0.0.1:49152/?state=${state}&code=c&scope=x`)).toMatchObject({ status: 'connected', email: 'me@example.com' });
  });
});

describe('Google requests', () => {
  const connected = async (answer: (call: Call) => { status: number; body: unknown }) => {
    const env = setup((call) => (call.url === TOKEN_URL && form(call).grant_type === 'authorization_code' ? exchangeOk() : answer(call)));
    await env.accounts.setClient(CLIENT_ID, SECRET);
    const started = await env.accounts.startSignIn(['calendar', 'tasks']);
    await env.redirect({ state: new URL(started.authUrl).searchParams.get('state')!, code: 'c' });
    return env;
  };

  test('a request carries the access token; one Google refused is refreshed once', async () => {
    let fresh = false;
    const { accounts, calls } = await connected((call) => {
      if (call.url === TOKEN_URL) {
        fresh = true;
        return { status: 200, body: { access_token: 'at-2', expires_in: 3600 } };
      }
      return call.headers.Authorization === 'Bearer at-2' ? { status: 200, body: { items: [1] } } : { status: 401, body: { error: { message: 'Invalid Credentials' } } };
    });
    expect(await accounts.request('me@example.com', 'GET', 'https://tasks.googleapis.com/tasks/v1/users/@me/lists')).toEqual({ items: [1] });
    expect(fresh).toBe(true);
    const refreshCall = calls.find((call) => call.url === TOKEN_URL && form(call).grant_type === 'refresh_token');
    expect(form(refreshCall!)).toMatchObject({ refresh_token: 'rt-1', client_id: CLIENT_ID, client_secret: SECRET });
    await expect(accounts.request('me@example.com', 'GET', 'https://evil.example/x')).rejects.toThrow('not a Google API');
  });

  test('a revoked refresh token asks to connect again; a missing scope says so', async () => {
    const { accounts } = await connected((call) => {
      if (call.url === TOKEN_URL) return { status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } };
      return { status: 401, body: {} };
    });
    await expect(accounts.request('me@example.com', 'GET', 'https://gmail.googleapis.com/gmail/v1/users/me/messages')).rejects.toThrow('connect it again');
    const scoped = await connected(() => ({ status: 403, body: { error: { message: 'Request had insufficient authentication scopes.' } } }));
    const failure = await scoped.accounts.request('me@example.com', 'GET', 'https://gmail.googleapis.com/gmail/v1/users/me/messages').catch((error) => error);
    expect(failure).toBeInstanceOf(GoogleError);
    expect((failure as GoogleError).status).toBe(403);
    expect((failure as GoogleError).message).toContain('has not allowed this');
  });

  test('removing an account revokes it; a new client starts without accounts', async () => {
    const { accounts, calls } = await connected(() => ({ status: 200, body: {} }));
    expect(await accounts.remove('ME@example.com')).toBe(true);
    expect(calls.some((call) => call.url === 'https://oauth2.googleapis.com/revoke' && form(call).token === 'rt-1')).toBe(true);
    expect((await accounts.status()).accounts).toEqual([]);
    expect(await accounts.remove('me@example.com')).toBe(false);

    const other = await connected(() => ({ status: 200, body: {} }));
    const second = `${'7654321'.repeat(2)}-${'zyxwvutsrq'.repeat(3)}.apps.googleusercontent.com`;
    expect((await other.accounts.setClient(second, SECRET)).accounts).toEqual([]);
  });
});
