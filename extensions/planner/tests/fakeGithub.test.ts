// The E2E journeys' fake GitHub (tests/e2e/fakeGithub.mjs) against the real GitHub CLI: what an
// assigned agent runs (gh auth status, git push, gh pr create) and what the Planner's service
// asks afterwards (gh pr list --head <branch>, gh pr view <url>), in a scratch HOME whose gh
// config sends every request to the fake through a Unix socket. Skipped where gh is missing.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultGithubWorld, fakeIssue, ghConfigFiles, startFakeGithub, type FakeGithub } from './e2e/fakeGithub.mjs';
import { GitHubSource, LISTS } from '../service/github.ts';

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
    fake = await startFakeGithub({ socket: join(root, 'gh.sock'), gitPort: 0, world: defaultGithubWorld({ bare }) });
    for (const [name, text] of Object.entries(ghConfigFiles(fake.socket!))) writeFileSync(join(home, '.config', 'gh', name), text, { mode: 0o600 });
    // gh reads the fetch URL (a GitHub repository); git pushes over HTTP to the fake's git server.
    await ok('git', ['remote', 'add', 'origin', 'https://github.com/harness-org/planner-pr-demo.git']);
    await ok('git', ['remote', 'set-url', '--push', 'origin', fake.gitUrl('harness-org', 'planner-pr-demo')!]);
    await ok('git', ['push', '-q', 'origin', 'main']);
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
    expect(fake.requests.map((request) => request.operation).filter(Boolean)).toEqual(expect.arrayContaining(['git git-receive-pack', 'mutation PullRequestCreate', 'query PullRequestList', 'query PullRequestByNumber']));
    // The push went over the fake's git server (an http endpoint, as OpenChamber requires of a remote) into the bare copy.
    expect(fake.gitUrl('harness-org', 'planner-pr-demo')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/harness-org\/planner-pr-demo\.git$/);
    expect(await ok('git', ['--git-dir', bare, 'log', '--format=%s', '-1', 'planner/harness-one'])).toBe('Add one.txt');

    // Merged on "GitHub": gh says so.
    expect((await ok(GH!, ['api', '-X', 'PUT', 'repos/harness-org/planner-pr-demo/pulls/1/merge', '--jq', '.merged']))).toBe('true');
    expect(JSON.parse(await ok(GH!, ['pr', 'view', url, '--json', 'state'])).state).toBe('MERGED');
  });

  // Review 11 (P1-3), with the GitHub CLI itself: 51 assigned issues are all reachable, a page at a time, and one is
  // found by its URL, as the Planner's service asks for them (service/github.ts).
  test("the Planner's list reads 51 assigned issues in two pages, its cursor reaching the 51st; an issue by its URL; linked items by id", async () => {
    const repo = 'harness-org/planner-pr-demo';
    // Issue 1 updated last: the oldest, issue 51, comes last, on the second page.
    fake.world.issues = Array.from({ length: 51 }, (_, n) => fakeIssue(repo, n + 1, { title: `Planner issue ${n + 1}`, assignees: ['harness-bot'], updatedAt: new Date(Date.UTC(2026, 9, 28) - n * 60_000).toISOString() }));
    fake.world.issues.push(fakeIssue(repo, 99, { title: 'Not mine', assignees: ['someone-else'] }));
    // As the service's ghRunner: a failure keeps what gh printed.
    const source = new GitHubSource(async (args) => {
      const result = await run(GH!, args);
      if (result.code !== 0) throw Object.assign(new Error(result.err), { stdout: result.out, stderr: result.err });
      return result.out;
    });
    const first = await source.list('assigned');
    expect([first.items.length, first.total, first.items[0]!.key, first.items.at(-1)!.key, Boolean(first.next)]).toEqual([50, 51, `${repo}#1`, `${repo}#50`, true]);
    const second = await source.list('assigned', { after: first.next });
    expect([second.items.map((item) => [item.key, item.title, item.url]), second.next]).toEqual([[[`${repo}#51`, 'Planner issue 51', `https://github.com/${repo}/issues/51`]], null]);
    const searches = fake.requests.filter((request) => request.operation === 'query PlannerGitHubList');
    expect(searches.map((request) => [request.variables?.q, request.variables?.after ?? null])).toEqual([[LISTS.assigned, null], [LISTS.assigned, first.next]]);
    // Words narrow it.
    expect((await source.list('assigned', { text: 'issue 51' })).items.map((item) => item.number)).toEqual([51]);
    // By URL, a comment's address too; none where there is no such issue.
    expect(await source.byUrl(`https://github.com/${repo}/issues/51#issuecomment-1`)).toMatchObject({ id: fake.world.issues[50]!.id, key: `${repo}#51`, title: 'Planner issue 51', state: 'OPEN' });
    expect(await source.byUrl(`https://github.com/${repo}/issues/404`)).toBeNull();
    // Linked items, by node id, past GitHub's 100 a call; ones deleted since (gh exits 1 on GitHub's errors) leave the rest read.
    const ids = [...fake.world.issues.map((issue) => issue.id), ...Array.from({ length: 60 }, (_, n) => `I_gone_${n}`)];
    expect((await source.items(ids)).length).toBe(52);
    expect((await run(GH!, ['api', 'graphql', '-f', 'query=query X($ids: [ID!]!) { nodes(ids: $ids) { id } }', '-f', 'ids[]=I_gone'])).code).toBe(1);
    expect(fake.requests.filter((request) => request.operation === 'query PlannerGitHubNodes').map((request) => (request.variables?.ids as string[]).length)).toEqual([100, 12]);
  });

  // Daily Highlights, with the GitHub CLI itself: the day's work read as the service reads it (service/githubActivity.ts),
  // one gh call for every source's first page, then a source with more of the day page by page.
  test("the day's work: pull requests opened, reviewed and merged, comments past one page, discussions and their comments", async () => {
    const repo = 'harness-org/planner-pr-demo';
    // A day well before the pull requests the other tests open now.
    const from = '2026-10-20T07:00:00.000Z';
    const to = '2026-10-21T07:00:00.000Z';
    const before = { pulls: [...fake.world.pulls], issues: fake.world.issues };
    const at = (hours: number) => new Date(Date.parse(from) + hours * 3_600_000).toISOString();
    const viewer = fake.world.viewer;
    const pullOf = (number: number, extra: Record<string, unknown>) => ({ id: `PR_day_${number}`, number, repo, url: `https://github.com/${repo}/pull/${number}`, title: `Day pull ${number}`, body: '', headRefName: `day-${number}`, baseRefName: 'main', headOid: 'x', isDraft: false, state: 'OPEN' as const, createdAt: at(-48), updatedAt: at(1), ...extra });
    try {
    fake.world.pulls.push(
      pullOf(101, { createdAt: at(2), updatedAt: at(2) }),
      pullOf(102, { author: 'ann', reviews: [{ id: 'RV_1', author: viewer, state: 'CHANGES_REQUESTED', submittedAt: at(3), url: `https://github.com/${repo}/pull/102#pullrequestreview-1` }, { id: 'RV_2', author: viewer, state: 'APPROVED', submittedAt: at(5), url: `https://github.com/${repo}/pull/102#pullrequestreview-2` }] }),
      pullOf(103, { state: 'MERGED', mergedAt: at(4), mergedBy: 'ann' }),
      pullOf(104, { author: 'bo', state: 'MERGED', mergedAt: at(6), mergedBy: viewer, reviews: [{ id: 'RV_3', author: viewer, state: 'APPROVED', submittedAt: at(-30), url: `https://github.com/${repo}/pull/104#pullrequestreview-3` }] }),
      pullOf(105, { author: 'bo', state: 'MERGED', mergedAt: at(6), mergedBy: 'ann' }),
    );
    // 55 comments of the day on issue 1 (more than a page of 50), one of yesterday updated today, one of last week.
    fake.world.issues = [fakeIssue(repo, 1, { title: 'Day issue 1' })];
    fake.world.issueComments = [
      ...Array.from({ length: 55 }, (_, n) => ({ id: `IC_${n}`, author: viewer, on: `https://github.com/${repo}/issues/1`, url: `https://github.com/${repo}/issues/1#issuecomment-${n}`, createdAt: at(8 + n / 60), updatedAt: at(8 + n / 60) })),
      { id: 'IC_y', author: viewer, on: `https://github.com/${repo}/issues/1`, url: `https://github.com/${repo}/issues/1#issuecomment-y`, createdAt: at(-20), updatedAt: at(2) },
      { id: 'IC_old', author: viewer, on: `https://github.com/${repo}/issues/1`, url: `https://github.com/${repo}/issues/1#issuecomment-old`, createdAt: at(-200), updatedAt: at(-200) },
      { id: 'IC_pr', author: viewer, on: `https://github.com/${repo}/pull/102`, url: `https://github.com/${repo}/pull/102#issuecomment-pr`, createdAt: at(9.5), updatedAt: at(9.5) },
    ];
    fake.world.discussions = [{ id: 'DS_1', number: 7, repo, title: 'Roadmap', url: `https://github.com/${repo}/discussions/7`, author: viewer, createdAt: at(10) }, { id: 'DS_0', number: 6, repo, title: 'Old', url: `https://github.com/${repo}/discussions/6`, author: viewer, createdAt: at(-100) }];
    fake.world.discussionComments = [{ id: 'DCM_0', discussionId: 'DS_0', author: viewer, url: `https://github.com/${repo}/discussions/6#discussioncomment-0`, createdAt: at(-90) }, { id: 'DCM_1', discussionId: 'DS_0', author: viewer, url: `https://github.com/${repo}/discussions/6#discussioncomment-1`, createdAt: at(11) }];
    const source = new GitHubSource(async (args) => {
      const result = await run(GH!, args);
      if (result.code !== 0) throw Object.assign(new Error(result.err), { stdout: result.out, stderr: result.err });
      return result.out;
    });
    const first = await source.activity(from, to);
    expect(first.login).toBe(viewer);
    const kinds = (items: { kind: string; id: string }[]) => items.filter((item) => item.kind !== 'commented').map((item) => item.id);
    // Bo's pull request merged by me is found through my review of it (involves: covers no reviewer); Bo's merged by Ann isn't mine.
    expect(kinds(first.items)).toEqual(['opened:PR_day_101', 'merged:PR_day_103', 'merged:PR_day_104', 'reviewed:RV_2', 'reviewed:RV_1', 'discussion:DS_1', 'discussionComment:DCM_1']);
    // Last updated first: the comment on pull request 102 (9:30) and 49 of issue 1's; the rest on the next page, where
    // yesterday's comment (updated today) and last week's end the reading.
    const comments = first.items.filter((item) => item.kind === 'commented');
    expect([comments.length, comments[0]!.id, comments[0]!.target.type, comments[0]!.target.number]).toEqual([50, 'commented:IC_pr', 'pull', 102]);
    expect(Object.keys(first.more)).toEqual(['commented']);
    const rest = await source.activityPage('commented', from, to, first.more.commented!);
    expect([rest.items.map((item) => item.id), rest.more]).toEqual([['commented:IC_5', 'commented:IC_4', 'commented:IC_3', 'commented:IC_2', 'commented:IC_1', 'commented:IC_0'], {}]);
    const asked = fake.requests.filter((request) => request.operation?.startsWith('query PlannerGitHubActivity'));
    expect(asked.map((request) => request.operation)).toEqual(['query PlannerGitHubActivity', 'query PlannerGitHubActivityComments']);
    expect(asked[0]!.variables).toMatchObject({ opened: `is:pr author:@me created:2026-10-20T07:00:00+00:00..2026-10-21T06:59:59+00:00`, from, to: '2026-10-21T06:59:59.000Z' });
    } finally {
      fake.world.pulls = before.pulls;
      fake.world.issues = before.issues;
      fake.world.issueComments = [];
      fake.world.discussions = [];
      fake.world.discussionComments = [];
    }
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
