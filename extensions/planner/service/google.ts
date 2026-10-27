// Google accounts for the Planner: OAuth with a desktop client the user creates
// in their own Google Cloud project, and the requests the Planner makes to
// Calendar, Tasks and Gmail with it. OpenChamber gives an extension one
// integration, which Linear has, and its OAuth callback needs HTTPS or
// localhost, so the sign-in runs here: Google redirects the browser to a
// one-off loopback listener on this machine, or, when the browser is elsewhere,
// the user pastes the address it was sent to. Client secret and refresh tokens
// stay in a file only the user can read, outside the synced data repository;
// the panel never gets them back.
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname } from 'node:path';

export const GOOGLE_FEATURES = ['calendar', 'tasks', 'mail'] as const;
export type GoogleFeature = (typeof GOOGLE_FEATURES)[number];

/** What each feature asks Google for; the least that does the job. */
export const FEATURE_SCOPES: Record<GoogleFeature, readonly string[]> = {
  calendar: ['https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/calendar.events'],
  tasks: ['https://www.googleapis.com/auth/tasks'],
  mail: ['https://www.googleapis.com/auth/gmail.readonly'],
};
const IDENTITY_SCOPES = ['openid', 'email'];

export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
/** The Google APIs the Planner calls; nothing else goes out with a token. */
const API_ORIGINS = ['https://www.googleapis.com/', 'https://tasks.googleapis.com/', 'https://gmail.googleapis.com/'];
/** The host gives up on a service request after 20 seconds, and then restarts the service. */
const TIMEOUT_MS = 12_000;
const SIGN_IN_MS = 10 * 60_000;
const MAX_ACCOUNTS = 10;
const CLIENT_ID = /^[0-9]{6,30}-[a-z0-9]{10,64}\.apps\.googleusercontent\.com$/;

interface StoredAccount {
  email: string;
  refreshToken: string;
  scopes: string[];
  addedAt: string;
}

interface StoredClient {
  id: string;
  secret: string;
}

/** What the panel may see of an account: everything but its token. */
export interface GoogleAccountInfo {
  email: string;
  /** The features Google granted every scope for. */
  features: GoogleFeature[];
  addedAt: string;
}

export interface GoogleStatus {
  /** The OAuth client's id; its secret never leaves the service. */
  client: { id: string } | null;
  accounts: GoogleAccountInfo[];
}

export type SignInResult = { status: 'pending' } | { status: 'connected'; email: string; features: GoogleFeature[] } | { status: 'failed'; message: string };

/** A refusal with the HTTP status the service answers it with. */
export class GoogleError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

/**
 * Tests point the service at a fake Google on this machine with
 * PLANNER_GOOGLE_API_BASE=http://127.0.0.1:<port>/: every *.googleapis.com
 * request then goes there, path kept. Only a loopback address is taken.
 */
export const testFetcher = (base: string | undefined): Fetcher | null => {
  if (!base || !/^http:\/\/127\.0\.0\.1:\d{2,5}\/$/.test(base)) return null;
  return (url, init) => fetch(url.replace(/^https:\/\/[a-z0-9-]+\.googleapis\.com\//, base), init);
};

const defaultFetcher: Fetcher = testFetcher(process.env.PLANNER_GOOGLE_API_BASE) ?? (fetch as unknown as Fetcher);

/** Start a callback listener for one sign-in; it answers each request with the page `onRequest` returns. */
export type Listen = (onRequest: (url: URL) => Promise<string>) => Promise<{ port: number; close(): void }>;

/** A listener on a free loopback port. */
export const loopbackListen: Listen = (onRequest) =>
  new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/') {
        res.writeHead(404).end();
        return;
      }
      void onRequest(url).then((page) => res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(page));
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as AddressInfo).port, close: () => server.close() }));
  });

const base64url = (bytes: Buffer): string => bytes.toString('base64url');

const page = (title: string, text: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:15px system-ui;margin:3em;max-width:36em"><h1 style="font-size:20px">${title}</h1><p>${text}</p>`;

/** The features whose scopes Google granted, all of them. */
export const featuresOf = (scopes: readonly string[]): GoogleFeature[] => GOOGLE_FEATURES.filter((feature) => FEATURE_SCOPES[feature].every((scope) => scopes.includes(scope)));

/** The email in an ID token's payload; the token came straight from Google over TLS, so it is not verified again. */
export const emailFromIdToken = (idToken: string | undefined): string | null => {
  const payload = idToken?.split('.')[1];
  if (!payload) return null;
  try {
    const email = (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { email?: unknown }).email;
    return typeof email === 'string' && /^[^\s@]+@[^\s@]+$/.test(email) ? email.toLowerCase() : null;
  } catch {
    return null;
  }
};

/** Google's own words for a failed request, where it gave some. */
const googleMessage = (body: string, status: number): string => {
  try {
    const parsed = JSON.parse(body) as { error?: string | { message?: string }; error_description?: string };
    if (typeof parsed.error === 'object' && parsed.error?.message) return parsed.error.message;
    if (parsed.error_description) return parsed.error_description;
    if (typeof parsed.error === 'string') return parsed.error;
  } catch {
    // Not JSON.
  }
  return `Google answered HTTP ${status}`;
};

/**
 * The status the service answers a refused Google request with: what the user
 * can fix (a bad value, no right to change it, a clash) keeps Google's
 * meaning; 410 is Google's answer for an event deleted a while ago; the rest
 * is Google's trouble.
 */
export const googleStatus = (status: number): number => {
  if (status === 404 || status === 410) return 404;
  if (status === 400 || status === 403 || status === 409) return status;
  if (status === 412) return 409;
  return 502;
};

const isStoredAccount = (value: unknown): value is StoredAccount => {
  const item = value as Record<string, unknown> | null;
  return Boolean(item) && typeof item!.email === 'string' && typeof item!.refreshToken === 'string' && typeof item!.addedAt === 'string' && Array.isArray(item!.scopes) && item!.scopes.every((scope) => typeof scope === 'string');
};

const publicInfo = (account: StoredAccount): GoogleAccountInfo => ({ email: account.email, features: featuresOf(account.scopes), addedAt: account.addedAt });

interface SignIn {
  state: string;
  verifier: string;
  redirectUri: string;
  expires: number;
  result: SignInResult;
  close: () => void;
}

export class GoogleAccounts {
  private client: StoredClient | null = null;
  private accounts: StoredAccount[] = [];
  private loaded: Promise<void> | null = null;
  private writes: Promise<unknown> = Promise.resolve();
  private readonly signIns = new Map<string, SignIn>();
  private readonly tokens = new Map<string, { token: string; expires: number }>();

  constructor(
    private readonly file: string,
    private readonly fetcher: Fetcher = defaultFetcher,
    private readonly listen: Listen = loopbackListen,
    private readonly log: (message: string) => void = () => {},
  ) {}

  async status(): Promise<GoogleStatus> {
    await this.load();
    return { client: this.client ? { id: this.client.id } : null, accounts: this.accounts.map(publicInfo) };
  }

  /** The OAuth client (a "Desktop app" client in the user's Google Cloud project). */
  setClient(rawId: string, rawSecret: string): Promise<GoogleStatus> {
    return this.serial(async () => {
      const id = rawId.trim();
      const secret = rawSecret.trim();
      if (!CLIENT_ID.test(id)) throw new GoogleError(400, 'That is not an OAuth client ID (it ends in .apps.googleusercontent.com)');
      if (!/^[A-Za-z0-9_-]{10,100}$/.test(secret)) throw new GoogleError(400, 'That does not look like the client secret Google shows with the client ID');
      await this.load();
      // Tokens belong to the client that issued them; a new client starts without accounts.
      if (this.client && this.client.id !== id) {
        this.accounts = [];
        this.tokens.clear();
      }
      this.client = { id, secret };
      await this.save();
      return this.status();
    });
  }

  /** Forget the client and, with it, every account it signed in. */
  clearClient(): Promise<GoogleStatus> {
    return this.serial(async () => {
      await this.load();
      for (const account of this.accounts) await this.revoke(account.refreshToken);
      this.client = null;
      this.accounts = [];
      this.tokens.clear();
      await this.save();
      return this.status();
    });
  }

  /**
   * Begin a sign-in that asks for `features`: a listener on a free loopback
   * port waits for Google's redirect, and the panel opens `authUrl`.
   */
  async startSignIn(features: readonly GoogleFeature[]): Promise<{ id: string; authUrl: string; redirectUri: string }> {
    await this.load();
    if (!this.client) throw new GoogleError(400, 'Add the OAuth client first');
    if (features.length === 0) throw new GoogleError(400, 'Choose at least one of Calendar, Tasks and Gmail');
    this.expireSignIns();
    const id = base64url(randomBytes(12));
    const state = base64url(randomBytes(24));
    const verifier = base64url(randomBytes(48));
    const challenge = base64url(createHash('sha256').update(verifier).digest());
    const listener = await this.listen((url) => this.callback(id, url));
    const redirectUri = `http://127.0.0.1:${listener.port}/`;
    const signIn: SignIn = { state, verifier, redirectUri, expires: Date.now() + SIGN_IN_MS, result: { status: 'pending' }, close: listener.close };
    this.signIns.set(id, signIn);
    // Nobody finished it in time: stop listening.
    setTimeout(() => this.endSignIn(id, { status: 'failed', message: 'The sign-in took too long; start it again' }), SIGN_IN_MS).unref?.();
    const scopes = [...IDENTITY_SCOPES, ...new Set(features.flatMap((feature) => FEATURE_SCOPES[feature]))];
    const query = new URLSearchParams({
      client_id: this.client.id,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: scopes.join(' '),
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      access_type: 'offline',
      // Ask again, so Google always sends a refresh token.
      prompt: 'consent',
      include_granted_scopes: 'true',
    });
    return { id, authUrl: `${AUTH_URL}?${query}`, redirectUri };
  }

  signIn(id: string): SignInResult {
    return this.signIns.get(id)?.result ?? { status: 'failed', message: 'That sign-in is over; start it again' };
  }

  /**
   * Finish a sign-in with the address the browser was sent to, when it could
   * not reach this machine's loopback listener (the browser runs elsewhere).
   */
  async finishSignIn(id: string, pasted: string): Promise<SignInResult> {
    const signIn = this.signIns.get(id);
    if (!signIn || signIn.result.status !== 'pending') return this.signIn(id);
    let url: URL;
    try {
      url = new URL(pasted.trim());
    } catch {
      throw new GoogleError(400, 'Paste the whole address from the browser, starting with http://127.0.0.1');
    }
    if (`${url.protocol}//${url.host}/` !== signIn.redirectUri) throw new GoogleError(400, `That address is not the one this sign-in waits for (${signIn.redirectUri})`);
    await this.callback(id, url);
    return this.signIn(id);
  }

  /** Remove an account; its refresh token is revoked at Google too, where Google is reachable. */
  remove(email: string): Promise<boolean> {
    return this.serial(async () => {
      await this.load();
      const account = this.accounts.find((item) => item.email === email.toLowerCase());
      if (!account) return false;
      this.accounts = this.accounts.filter((item) => item !== account);
      this.tokens.delete(account.email);
      await this.save();
      await this.revoke(account.refreshToken);
      return true;
    });
  }

  /**
   * A request to one of the Planner's Google APIs as `email`; the JSON answer,
   * or null for an empty one. A token Google no longer takes is refreshed once.
   */
  async request<T>(email: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, body?: unknown): Promise<T | null> {
    if (!API_ORIGINS.some((origin) => url.startsWith(origin))) throw new GoogleError(400, 'That is not a Google API the Planner uses');
    const send = async (token: string) => {
      try {
        return await this.fetcher(url, {
          method,
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        throw new GoogleError(502, `Could not reach Google: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    let response = await send(await this.accessToken(email));
    if (response.status === 401) {
      this.tokens.delete(email.toLowerCase());
      response = await send(await this.accessToken(email));
    }
    const text = await response.text();
    if (response.status >= 400) {
      const message = googleMessage(text, response.status);
      if (response.status === 403 && /insufficient|scope/i.test(message)) throw new GoogleError(403, `${email} has not allowed this; connect it again with that feature turned on`);
      throw new GoogleError(googleStatus(response.status), message);
    }
    return text ? (JSON.parse(text) as T) : null;
  }

  private async callback(id: string, url: URL): Promise<string> {
    const signIn = this.signIns.get(id);
    if (!signIn || signIn.result.status !== 'pending') return page('Planner', 'This sign-in is already over. You can close this tab.');
    if (url.searchParams.get('state') !== signIn.state) {
      // Not Google's answer to this sign-in; keep waiting for the right one.
      return page('Planner', 'This page does not belong to the sign-in the Planner is waiting for.');
    }
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    if (error || !code) {
      this.endSignIn(id, { status: 'failed', message: error === 'access_denied' ? 'Access was not allowed' : `Google said: ${error ?? 'no code'}` });
      return page('Not connected', 'Google did not let the Planner in. You can close this tab and try again.');
    }
    try {
      const account = await this.exchange(code, signIn);
      this.endSignIn(id, { status: 'connected', email: account.email, features: featuresOf(account.scopes) });
      return page('Connected', `The Planner can now use ${account.email}. You can close this tab.`);
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      this.endSignIn(id, { status: 'failed', message });
      return page('Not connected', `${message.replace(/[<>&]/g, '')}. You can close this tab.`);
    }
  }

  private async exchange(code: string, signIn: SignIn): Promise<StoredAccount> {
    const client = this.client;
    if (!client) throw new GoogleError(400, 'The OAuth client was removed');
    const answer = await this.token({ grant_type: 'authorization_code', code, code_verifier: signIn.verifier, redirect_uri: signIn.redirectUri, client_id: client.id, client_secret: client.secret });
    if (!answer.refresh_token) throw new GoogleError(400, 'Google sent no refresh token; remove the Planner at myaccount.google.com/permissions and connect again');
    const email = emailFromIdToken(answer.id_token);
    if (!email) throw new GoogleError(400, "Google did not say which account this is (the 'email' scope was not granted)");
    const account: StoredAccount = { email, refreshToken: answer.refresh_token, scopes: (answer.scope ?? '').split(' ').filter(Boolean), addedAt: new Date().toISOString() };
    await this.serial(async () => {
      const index = this.accounts.findIndex((item) => item.email === email);
      if (index < 0 && this.accounts.length >= MAX_ACCOUNTS) throw new GoogleError(400, `At most ${MAX_ACCOUNTS} Google accounts`);
      this.accounts = index < 0 ? [...this.accounts, account] : this.accounts.map((item, at) => (at === index ? { ...account, addedAt: item.addedAt } : item));
      await this.save();
    });
    if (answer.access_token) this.tokens.set(email, { token: answer.access_token, expires: Date.now() + (answer.expires_in ?? 3600) * 1000 });
    return account;
  }

  private async accessToken(rawEmail: string): Promise<string> {
    const email = rawEmail.toLowerCase();
    const cached = this.tokens.get(email);
    if (cached && cached.expires - 60_000 > Date.now()) return cached.token;
    await this.load();
    const account = this.accounts.find((item) => item.email === email);
    if (!account) throw new GoogleError(404, `${email} is not connected`);
    if (!this.client) throw new GoogleError(400, 'Add the OAuth client again');
    let answer: Awaited<ReturnType<GoogleAccounts['token']>>;
    try {
      answer = await this.token({ grant_type: 'refresh_token', refresh_token: account.refreshToken, client_id: this.client.id, client_secret: this.client.secret });
    } catch (error) {
      if (error instanceof GoogleError && /invalid_grant|expired|revoked/i.test(error.message)) throw new GoogleError(401, `Google no longer accepts the Planner's access to ${email}; connect it again`);
      throw error;
    }
    if (!answer.access_token) throw new GoogleError(502, 'Google sent no access token');
    this.tokens.set(email, { token: answer.access_token, expires: Date.now() + (answer.expires_in ?? 3600) * 1000 });
    return answer.access_token;
  }

  private async token(fields: Record<string, string>): Promise<{ access_token?: string; expires_in?: number; refresh_token?: string; scope?: string; id_token?: string }> {
    let response: Awaited<ReturnType<Fetcher>>;
    try {
      response = await this.fetcher(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams(fields).toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new GoogleError(502, `Could not reach Google: ${error instanceof Error ? error.message : String(error)}`);
    }
    const text = await response.text();
    if (response.status >= 400) throw new GoogleError(response.status === 400 || response.status === 401 ? 400 : 502, googleMessage(text, response.status));
    return JSON.parse(text) as { access_token?: string; expires_in?: number; refresh_token?: string; scope?: string; id_token?: string };
  }

  private async revoke(token: string): Promise<void> {
    try {
      await this.fetcher(REVOKE_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }).toString(), signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      this.log(`could not revoke a Google token: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private endSignIn(id: string, result: SignInResult): void {
    const signIn = this.signIns.get(id);
    if (!signIn || signIn.result.status !== 'pending') return;
    signIn.result = result;
    signIn.close();
    // Keep the outcome a while for the panel to read, then forget it.
    setTimeout(() => this.signIns.delete(id), 5 * 60_000).unref?.();
  }

  private expireSignIns(): void {
    for (const [id, signIn] of this.signIns) if (signIn.expires < Date.now()) this.endSignIn(id, { status: 'failed', message: 'The sign-in took too long; start it again' });
  }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      let text: string;
      try {
        text = await readFile(this.file, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      try {
        const parsed = JSON.parse(text) as { client?: unknown; accounts?: unknown };
        const client = parsed.client as StoredClient | null | undefined;
        this.client = client && typeof client.id === 'string' && typeof client.secret === 'string' ? { id: client.id, secret: client.secret } : null;
        this.accounts = Array.isArray(parsed.accounts) ? parsed.accounts.filter(isStoredAccount) : [];
      } catch {
        this.log(`${this.file} is not readable JSON; Google needs to be connected again`);
      }
    })();
    return this.loaded;
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify({ version: 1, client: this.client, accounts: this.accounts }, null, 2)}\n`, { mode: 0o600 });
    // The mode above applies only when the file is new.
    await chmod(temp, 0o600);
    await rename(temp, this.file);
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.writes.then(work, work);
    this.writes = next.catch(() => {});
    return next;
  }
}
