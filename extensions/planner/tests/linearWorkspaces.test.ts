import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LINEAR_API, LinearWorkspaces, WorkspaceError, type Fetcher } from '../service/linear.ts';
import { ASSIGNED_QUERY, WHOAMI_QUERY } from '../src/domain/linear.ts';

const dirs: string[] = [];
const fileIn = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'planner-linear-'));
  dirs.push(dir);
  return join(dir, 'state', 'linear-workspaces.json');
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Made-up keys in Linear's shape, built at run time so secret scanners do not take them for real ones.
const fakeKey = (kind: 'api' | 'oauth', fill: string): string => `lin_${kind}_${fill.repeat(40).slice(0, 40)}`;
const KEY_A = fakeKey('api', 'a');
const KEY_A2 = fakeKey('api', 'a2');
const KEY_B = fakeKey('oauth', 'b');

/** A fake Linear: each key belongs to one organization; calls are recorded. */
const fakeLinear = (orgs: Record<string, { id: string; name: string; urlKey: string; viewer: string }>) => {
  const calls: { url: string; authorization: string; query: string; variables: unknown }[] = [];
  const fetcher: Fetcher = async (url, init) => {
    const { query, variables } = JSON.parse(init.body) as { query: string; variables: unknown };
    calls.push({ url, authorization: init.headers.Authorization!, query, variables });
    const key = init.headers.Authorization!.replace(/^Bearer /, '');
    const org = orgs[key];
    if (!org) return { status: 400, text: async () => JSON.stringify({ errors: [{ message: 'Authentication required, not authenticated', extensions: { userPresentableMessage: 'You need to authenticate to access this operation.' } }] }) };
    if (query === WHOAMI_QUERY) return { status: 200, text: async () => JSON.stringify({ data: { viewer: { id: `u-${org.id}`, name: org.viewer }, organization: { id: org.id, name: org.name, urlKey: org.urlKey } } }) };
    return { status: 200, text: async () => JSON.stringify({ data: { viewer: { id: `u-${org.id}`, name: org.viewer, assignedIssues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } }) };
  };
  return { calls, fetcher };
};

const ORGS = {
  [KEY_A]: { id: 'org-a', name: 'Antropy', urlKey: 'antropy', viewer: 'Qihang' },
  [KEY_A2]: { id: 'org-a', name: 'Antropy', urlKey: 'antropy', viewer: 'Qihang' },
  [KEY_B]: { id: 'org-b', name: 'Side', urlKey: 'side', viewer: 'Q' },
};

describe('Linear workspaces with API keys', () => {
  test('a key is checked with Linear, kept privately, and never shown', async () => {
    const file = fileIn();
    const { calls, fetcher } = fakeLinear(ORGS);
    const store = new LinearWorkspaces(file, fetcher);
    const added = await store.add(`  ${KEY_A}\n`);
    expect(added).toMatchObject({ id: 'org-a', name: 'Antropy', urlKey: 'antropy', account: 'Qihang' });
    expect(JSON.stringify(added)).not.toContain(KEY_A);
    expect(JSON.stringify(await store.list())).not.toContain('lin_api_');
    expect(calls[0]).toMatchObject({ url: LINEAR_API, authorization: KEY_A, query: WHOAMI_QUERY });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(file, '..')).mode & 0o777).toBe(0o700);
    expect(readFileSync(file, 'utf8')).toContain(KEY_A);
    // A new service process reads the same workspaces back.
    expect((await new LinearWorkspaces(file, fetcher).list()).map((item) => item.id)).toEqual(['org-a']);
  });

  test('OAuth tokens go as bearer tokens; a second key for a workspace replaces the first', async () => {
    const { calls, fetcher } = fakeLinear(ORGS);
    const store = new LinearWorkspaces(fileIn(), fetcher);
    await store.add(KEY_B);
    expect(calls[0]!.authorization).toBe(`Bearer ${KEY_B}`);
    await store.add(KEY_A);
    await store.add(KEY_A2);
    expect((await store.list()).map((item) => item.id)).toEqual(['org-b', 'org-a']);
    await store.graphql('org-a', ASSIGNED_QUERY, { after: null });
    expect(calls.at(-1)).toMatchObject({ authorization: KEY_A2, variables: { after: null } });
  });

  test('keys Linear does not accept are refused and not kept', async () => {
    const { calls, fetcher } = fakeLinear(ORGS);
    const store = new LinearWorkspaces(fileIn(), fetcher);
    await expect(store.add('not a key')).rejects.toThrow('does not look like a Linear API key');
    expect(calls).toHaveLength(0);
    await expect(store.add(fakeKey('api', 'unknown'))).rejects.toThrow('Linear rejected the key');
    const unauthorized = new LinearWorkspaces(fileIn(), async () => ({ status: 401, text: async () => '' }));
    await expect(unauthorized.add(KEY_A)).rejects.toThrow('Linear rejected the key');
    const offline = new LinearWorkspaces(fileIn(), async () => {
      throw new Error('getaddrinfo ENOTFOUND api.linear.app');
    });
    const failure = await offline.add(KEY_A).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(WorkspaceError);
    expect((failure as WorkspaceError).status).toBe(502);
    expect(await store.list()).toEqual([]);
  });

  test("a key runs only the Planner's own documents, in a connected workspace", async () => {
    const { calls, fetcher } = fakeLinear(ORGS);
    const store = new LinearWorkspaces(fileIn(), fetcher);
    await store.add(KEY_A);
    const answer = await store.graphql('org-a', ASSIGNED_QUERY, { after: null });
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body).data.viewer.name).toBe('Qihang');
    const refused = await store.graphql('org-a', 'mutation { issueDelete(id: "x") { success } }', {}).catch((error: unknown) => error);
    expect((refused as WorkspaceError).status).toBe(400);
    const unknown = await store.graphql('org-z', ASSIGNED_QUERY, {}).catch((error: unknown) => error);
    expect((unknown as WorkspaceError).status).toBe(404);
    expect(calls.filter((call) => call.query.includes('issueDelete'))).toHaveLength(0);
  });

  test('removing a workspace forgets its key', async () => {
    const file = fileIn();
    const { fetcher } = fakeLinear(ORGS);
    const store = new LinearWorkspaces(file, fetcher);
    await store.add(KEY_A);
    await store.add(KEY_B);
    expect(await store.remove('org-a')).toBe(true);
    expect(await store.remove('org-a')).toBe(false);
    expect(readFileSync(file, 'utf8')).not.toContain(KEY_A);
    expect((await new LinearWorkspaces(file, fetcher).list()).map((item) => item.id)).toEqual(['org-b']);
  });
});
