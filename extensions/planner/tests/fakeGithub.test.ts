// The E2E journeys' fake GitHub (tests/e2e/fakeGithub.mjs) against the real GitHub CLI: what an
// assigned agent runs (gh auth status, git push, gh pr create) and what the Planner's service
// asks afterwards (gh pr list --head <branch>, gh pr view <url>), in a scratch HOME whose gh
// config sends every request to the fake through a Unix socket. Skipped where gh is missing.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultGithubWorld, ghConfigFiles, startFakeGithub, type FakeGithub } from './e2e/fakeGithub.mjs';

const GH = Bun.which('gh');
const root = mkdtempSync(join(tmpdir(), 'planner-fake-github-'));
const home = join(root, 'home');
const bare = join(root, 'remote.git');
const work = join(root, 'work');
// Only what gh and git need: no GH_TOKEN, GITHUB_TOKEN or the real HOME reach gh here.
const env = { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', GH_NO_UPDATE_NOTIFIER: '1', GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' };

/** Run asynchronously: the fake answers from this process while gh waits. */
const run = async (cmd: string, args: string[]) => {
  const child = Bun.spawn([cmd, ...args], { cwd: work, env, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, out: out.trim(), err: err.trim() };
};
const ok = async (cmd: string, args: string[]) => {
  const result = await run(cmd, args);
  if (result.code !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${result.err || result.out}`);
  return result.out;
};
const commit = async (file: string) => {
  writeFileSync(join(work, file), `${file}\n`);
  await ok('git', ['add', file]);
  await ok('git', ['commit', '-q', '-m', `Add ${file}`]);
};

let fake: FakeGithub;

describe.skipIf(!GH)('the fake GitHub answers the real gh as GitHub would', () => {
  beforeAll(async () => {
    mkdirSync(join(home, '.config', 'gh'), { recursive: true });
    mkdirSync(work);
    await ok('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    await ok('git', ['init', '-q', '-b', 'main', work]);
    await ok('git', ['config', 'user.name', 'Harness Agent']);
    await ok('git', ['config', 'user.email', 'agent@example.invalid']);
    await commit('README.md');
    // gh reads the fetch URL (a GitHub repository); git pushes to the bare one.
    await ok('git', ['remote', 'add', 'origin', 'https://github.com/harness-org/planner-pr-demo.git']);
    await ok('git', ['remote', 'set-url', '--push', 'origin', bare]);
    await ok('git', ['push', '-q', 'origin', 'main']);
    fake = await startFakeGithub({ socket: join(root, 'gh.sock'), world: defaultGithubWorld({ bare }) });
    for (const [name, text] of Object.entries(ghConfigFiles(fake.socket!))) writeFileSync(join(home, '.config', 'gh', name), text, { mode: 0o600 });
  });
  afterAll(async () => {
    await fake?.close();
    rmSync(root, { recursive: true, force: true });
  });

  test('an agent checks gh, pushes its branch and opens a pull request; the Planner finds it by branch and by URL', async () => {
    expect((await run(GH!, ['auth', 'status'])).code).toBe(0);
    await ok('git', ['checkout', '-q', '-b', 'planner/harness-one']);
    await commit('one.txt');
    await ok('git', ['push', '-q', '-u', 'origin', 'planner/harness-one']);
    const url = await ok(GH!, ['pr', 'create', '--title', 'Add one', '--body', 'What changed: one.txt.']);
    expect(url).toBe('https://github.com/harness-org/planner-pr-demo/pull/1');
    expect(fake.world.pulls).toMatchObject([{ number: 1, headRefName: 'planner/harness-one', baseRefName: 'main', title: 'Add one', state: 'OPEN' }]);

    // What the service runs (service/github.ts): by branch in the worktree, then by URL.
    const fields = 'number,url,state,isDraft,title,updatedAt';
    const listed = JSON.parse(await ok(GH!, ['pr', 'list', '--head', 'planner/harness-one', '--state', 'all', '--limit', '10', '--json', fields]));
    expect(listed).toMatchObject([{ number: 1, url, state: 'OPEN', isDraft: false, title: 'Add one' }]);
    expect(JSON.parse(await ok(GH!, ['pr', 'view', url, '--json', fields]))).toMatchObject({ number: 1, state: 'OPEN' });
    expect(fake.requests.map((request) => request.operation).filter(Boolean)).toEqual(expect.arrayContaining(['mutation PullRequestCreate', 'query PullRequestList', 'query PullRequestByNumber']));

    // Merged on "GitHub": gh says so.
    expect((await ok(GH!, ['api', '-X', 'PUT', 'repos/harness-org/planner-pr-demo/pulls/1/merge', '--jq', '.merged']))).toBe('true');
    expect(JSON.parse(await ok(GH!, ['pr', 'view', url, '--json', 'state'])).state).toBe('MERGED');
  });

  test('as GitHub does, it refuses a second pull request for a branch, a branch never pushed, and one with nothing new', async () => {
    await ok('git', ['checkout', '-q', '-b', 'planner/harness-two', 'main']);
    await commit('two.txt');
    await ok('git', ['push', '-q', '-u', 'origin', 'planner/harness-two']);
    await ok(GH!, ['pr', 'create', '--title', 'Add two', '--body', 'x']);
    expect((await run(GH!, ['pr', 'create', '--title', 'Add two again', '--body', 'x'])).err).toContain('already exists');

    await ok('git', ['checkout', '-q', '-b', 'planner/harness-unpushed', 'main']);
    await commit('three.txt');
    expect((await run(GH!, ['pr', 'create', '--fill', '--head', 'planner/harness-unpushed'])).err).toContain('push it first');

    await ok('git', ['checkout', '-q', '-b', 'planner/harness-empty', 'main']);
    await ok('git', ['push', '-q', '-u', 'origin', 'planner/harness-empty']);
    expect((await run(GH!, ['pr', 'create', '--title', 'Nothing', '--body', 'x'])).err).toContain('No commits between main and planner/harness-empty');
    expect(fake.world.pulls.map((pull) => pull.headRefName)).toEqual(['planner/harness-one', 'planner/harness-two']);
  });
});
