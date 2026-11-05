// GitHub as Sunsama's GitHub integration has it, end to end: the Planner's service with the real gh signed in to the
// fake GitHub (tests/e2e/fakeGithub.mjs, on a socket), and Planner windows made of the panel's own stores (the browser
// journey tests/e2e/sunsama.mjs shows the same panel on screen). The GitHub scenarios skip where gh is not installed.
// The last scenario is Sunsama's "Add via URL" (a pasted Linear issue, Linear connected, is in tests/linear.test.ts).
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { addParsedTask } from '../panel/lib/addTask.ts';
import { keptRead, readAndKeep } from '../panel/lib/githubActivity.ts';
import { addDays, instantAt } from '../src/domain/dates.ts';
import { taskFromGitHub, withRepo } from '../src/domain/github.ts';
import { gmailUrl } from '../src/domain/google.ts';
import { parseQuickAdd } from '../src/domain/quickAdd.ts';
import type { Task } from '../src/domain/types.ts';
import { fakeIssue } from './e2e/fakeGithub.mjs';
import { VIEWER, assignedIssues, firstOf, itemOf, notesOf, reviewRequests, slowRelay, startKeepingTimers } from './support/github.ts';
import { ME, PRINTED_MESSAGE, THREADS, mailWorld } from './support/gmail.ts';
import { realGh, startPlanner, until, usePlanner, type PlannerWindow } from './support/planner.ts';

const ZONE = 'America/Los_Angeles';
const REPO = 'harness-org/planner-pr-demo';
const planner = usePlanner({ zone: ZONE, github: true, google: mailWorld(ZONE) });
const withGh = test.skipIf(!realGh);
if (!realGh) console.warn('tests/github.test.ts: gh is not installed here, so its GitHub scenarios are skipped');

const shown = (window: PlannerWindow) => {
  const view = window.github.getView();
  return { count: view.items.length, first: view.items[0]?.key, last: view.items.at(-1)?.key, next: view.next !== null, loading: view.loading, loadingMore: view.loadingMore, error: view.error };
};
const asked = (operation: string) => planner.github!.requests.filter((request) => request.operation === operation);
const settled = (window: PlannerWindow) => until(() => !window.github.getView().loading && !window.github.getView().loadingMore);
const taskOf = (window: PlannerWindow, sourceId: string): Task | undefined => Object.values(window.client.getView().state.tasks).find((task) => task.source?.id === sourceId && !task.deletedAt);
/** Tasks linked to GitHub by the scenarios before, deleted, so each scenario's linked items are its own. */
const forgetGitHubTasks = async () => {
  const linked = Object.values((await planner.state()).tasks).filter((task) => task.source?.kind === 'github' && !task.deletedAt);
  if (linked.length) await planner.commands(...linked.map((task) => ({ type: 'task.deleted' as const, taskId: task.id })));
};

describe('GitHub, through gh', () => {
  test('without gh, or with gh signed out, the GitHub source says which and how to sign in; nothing is read, a pasted GitHub address stays a link, and runs say why their pull requests are not looked up', async () => {
    const noGh = (process.env.PATH ?? '').split(':').filter((dir) => dir && !existsSync(join(dir, 'gh')) && !existsSync(join(dir, 'opencode'))).join(':');
    const [missing, signedOut] = await Promise.all([startPlanner({ zone: ZONE, env: { PATH: noGh } }), startPlanner({ zone: ZONE })]);
    try {
      const without = await missing.window();
      await without.github.checkStatus();
      expect(without.github.getView().status).toMatchObject({ available: false, reason: 'missing' });
      expect(without.github.getView().status?.message).toContain('not installed');

      const window = await signedOut.window();
      const notes = notesOf(window);
      await window.github.checkStatus();
      expect(window.github.getView().status).toMatchObject({ available: false, reason: 'signed-out' });
      expect(window.github.getView().status?.message).toContain('gh auth login');
      expect(window.github.getView().items).toEqual([]);

      const today = window.client.getView().today;
      await addParsedTask(window, parseQuickAdd('https://github.com/acme/app/pull/7', today), { kind: 'day', date: today }, 'bottom', today);
      expect(Object.values(window.client.getView().state.tasks).map((task) => task.source)).toMatchObject([{ kind: 'link', url: 'https://github.com/acme/app/pull/7' }]);
      expect(notes.at(-1)).toContain('GitHub (gh) is not signed in');

      await window.client.dispatch([
        { type: 'task.created', task: { id: 'gh-run-task', title: 'Write tests', placement: { kind: 'day', date: today }, position: 1 } },
        { type: 'run.started', run: { id: 'gh-run', taskId: 'gh-run-task', sessionId: 'ses_gh', projectId: null, directory: signedOut.home, worktree: { directory: signedOut.home, branch: 'planner/write-tests' }, title: 'Write tests' } },
      ]);
      await window.agents.refreshPullRequests();
      expect(window.agents.getView().prError).toContain('gh auth login');
    } finally {
      await Promise.all([missing.stop(), signedOut.stop()]);
    }
  });

  withGh('assigned issues come 50 a page: Load more and Refresh reach every one, words and a repository narrow the list, and one plans as a task linked to it (review 11, P1-3)', async () => {
    const world = planner.github!.world;
    world.issues = [fakeIssue('harness-org/tools', 1, { title: 'Tools issue', assignees: [VIEWER], updatedAt: '2026-10-29T00:00:00Z' }), ...assignedIssues(REPO, 'Planner issue', 120), fakeIssue(REPO, 999, { title: 'Not mine', assignees: ['someone-else'] })];
    world.pulls = [];
    const window = await planner.window();
    await window.github.checkStatus();
    expect(window.github.getView().status).toMatchObject({ available: true, login: VIEWER });
    expect([shown(window).count, window.github.getView().total, shown(window).next]).toEqual([50, 121, true]);
    await window.github.loadMore();
    expect(shown(window)).toMatchObject({ count: 100, last: `${REPO}#99`, next: true });

    // Refresh reads both pages again, from the first, not the first alone; the rest stays a Load more away.
    planner.github!.requests.length = 0;
    await window.github.refresh();
    expect(asked('query PlannerGitHubList').map((request) => Boolean(request.variables?.after))).toEqual([false, true]);
    expect(shown(window)).toMatchObject({ count: 100, next: true });
    await window.github.loadMore();
    expect(shown(window)).toMatchObject({ count: 121, last: `${REPO}#120`, next: false });
    expect(new Set(window.github.getView().items.map((item) => item.id)).size).toBe(121);

    // Words narrow it, in GitHub's search after the list's own qualifiers.
    window.github.setText('issue 51');
    await settled(window);
    expect(window.github.getView().items.map((item) => item.key)).toEqual([`${REPO}#51`]);
    expect(String(asked('query PlannerGitHubList').at(-1)!.variables?.q)).toMatch(/assignee:@me .*issue 51$/);

    // The repositories the viewer works in, the latest first; one chosen narrows the list; read again only after ten minutes.
    await window.github.loadRepos();
    expect(window.github.getView().repos).toEqual(['harness-org/tools', REPO]);
    window.github.setText(withRepo(window.github.getView().text, 'harness-org/tools'));
    await settled(window);
    expect([window.github.getView().items.map((item) => item.key), String(asked('query PlannerGitHubList').at(-1)!.variables?.q)]).toEqual([[], expect.stringContaining('repo:harness-org/tools issue 51')]);
    window.github.setText(withRepo('', 'harness-org/tools'));
    await settled(window);
    expect(window.github.getView().items.map((item) => item.key)).toEqual(['harness-org/tools#1']);
    await (await planner.window()).github.loadRepos();
    expect(asked('query PlannerGitHubRepos')).toHaveLength(1);

    // The 51st, planned: a task with its real id, title and address.
    window.github.setText('issue 51');
    await settled(window);
    const today = window.client.getView().today;
    await window.github.plan(window.github.getView().items[0]!, { kind: 'day', date: today });
    const issue = world.issues.find((item) => item.repo === REPO && item.number === 51)!;
    expect(taskOf(window, issue.id)).toMatchObject({ title: 'Planner issue 51', placement: { kind: 'day', date: today }, source: { kind: 'github', key: `${REPO}#51`, url: issue.url } });
  });

  withGh('linked tasks follow GitHub, 100 a gh call and every one of them; one whose issue is gone leaves the rest read; a merged pull request updates its task, and a task renamed here keeps its title', async () => {
    const world = planner.github!.world;
    const linked = assignedIssues('harness-org/linked', 'Linked', 230).map((issue) => ({ ...issue, assignees: [] }));
    world.issues = [...linked];
    world.pulls = reviewRequests(REPO, 'Add retries', 1);
    await forgetGitHubTasks();
    const window = await planner.window();
    const today = window.client.getView().today;
    await planner.commands(...linked.map((issue, n) => ({ type: 'task.created' as const, task: taskFromGitHub(itemOf(issue), `linked-${n}`, { kind: 'backlog', bucket: 'someday' }, 1000 + n) })));
    await window.client.refresh();
    world.issues[229]!.title = 'Linked 230, renamed on GitHub';
    world.issues.splice(228, 1);
    planner.github!.requests.length = 0;
    await window.github.checkStatus();
    // gh exits 1 on the batch with the issue gone; what it printed is still read.
    expect(asked('query PlannerGitHubNodes').map((request) => (request.variables?.ids as string[]).length)).toEqual([100, 100, 30]);
    expect([taskOf(window, linked[229]!.id)?.title, taskOf(window, linked[228]!.id)?.title, taskOf(window, linked[0]!.id)?.title, window.github.getView().error]).toEqual(['Linked 230, renamed on GitHub', 'Linked 229', 'Linked 1', null]);

    window.github.setKind('review');
    await settled(window);
    await window.github.plan(window.github.getView().items[0]!, { kind: 'day', date: today });
    const pull = world.pulls[0]!;
    expect(taskOf(window, pull.id)).toMatchObject({ title: 'Add retries 1', source: { kind: 'github', status: { name: 'Open', type: 'open' } } });
    Object.assign(pull, { state: 'MERGED', mergedAt: new Date().toISOString(), title: 'Add retries to sync' });
    await window.github.refresh();
    expect(taskOf(window, pull.id)).toMatchObject({ title: 'Add retries to sync', source: { title: 'Add retries to sync', status: { name: 'Merged', type: 'completed' } } });
    await window.client.dispatch([{ type: 'task.updated', taskId: taskOf(window, pull.id)!.id, patch: { title: 'Review the retries' } }]);
    pull.title = 'Add retries to sync, with backoff';
    await window.github.refresh();
    expect(taskOf(window, pull.id)).toMatchObject({ title: 'Review the retries', source: { title: 'Add retries to sync, with backoff' } });
    await forgetGitHubTasks();
  });
});

// Round 12's review (P1-2): a search changed while Load more was on its way left the list "Loading…" for good.
describe('a GitHub list changed while its Load more is on its way (round 12, P1-2)', () => {
  const lists = () => {
    const world = planner.github!.world;
    world.issues = [...assignedIssues('acme/beta', 'beta', 101), ...assignedIssues('acme/app', 'alpha', 101)];
    world.pulls = reviewRequests('acme/pulls', 'alpha', 101);
  };
  const listPage = (request: { path: string }) => request.path.startsWith('/github/list');

  withGh("a new search, another repository, another list kind or Refresh: the old page, answering before or after the new list's first, never joins it, nothing is left loading, and the new list's Load more reaches its #101", async () => {
    lists();
    const changes = [
      { name: 'a new search', from: '', change: (window: PlannerWindow) => window.github.setText('alpha'), repo: 'acme/app', order: 'before' },
      { name: 'another repository', from: '', change: (window: PlannerWindow) => window.github.setText(withRepo('', 'acme/app')), repo: 'acme/app', order: 'after' },
      { name: 'another list kind', from: '', change: (window: PlannerWindow) => window.github.setKind('review'), repo: 'acme/pulls', order: 'after' },
      { name: 'Refresh', from: 'beta', change: (window: PlannerWindow) => void window.github.refresh(), repo: 'acme/beta', order: 'before' },
    ];
    for (const { name, from, change, repo, order } of changes) {
      const window = await planner.window();
      const relay = slowRelay(window);
      if (from) window.github.setText(from);
      await window.github.checkStatus();
      expect(shown(window)).toMatchObject({ count: 50, next: true, loadingMore: false });
      relay.hold((request) => listPage(request) && request.path.includes('after='));
      const old = window.github.loadMore();
      await until(() => relay.held.length === 1);
      expect(window.github.getView().loadingMore).toBe(true);
      relay.hold(listPage);
      change(window);
      await until(() => relay.held.length === 2);
      expect({ name, ...shown(window) }).toMatchObject({ name, loading: true, loadingMore: false, count: name === 'Refresh' ? 50 : 0 });
      const [oldPage, newPage] = relay.held;
      if (order === 'before') {
        oldPage!.release();
        await old;
        expect({ name, ...shown(window) }).toMatchObject({ name, loading: true, loadingMore: false, count: name === 'Refresh' ? 50 : 0 });
        newPage!.release();
      } else {
        newPage!.release();
        await settled(window);
        oldPage!.release();
        await old;
      }
      await settled(window);
      expect({ name, ...shown(window) }).toEqual({ name, count: 50, first: `${repo}#1`, last: `${repo}#50`, next: true, loading: false, loadingMore: false, error: null });
      relay.hold(() => false);
      await window.github.loadMore();
      await window.github.loadMore();
      expect({ name, ...shown(window) }).toMatchObject({ name, count: 101, last: `${repo}#101`, next: false, loadingMore: false });
      expect(window.github.getView().items.every((item) => item.repo === repo)).toBe(true);
      expect(new Set(window.github.getView().items.map((item) => item.id)).size).toBe(101);
    }
  });

  withGh('an old Load more that fails says nothing over the new list; Load more waits while the list is read again; the five-minute refresh leaves a Load more under way alone', async () => {
    lists();
    const window = await planner.window();
    const relay = slowRelay(window);
    await window.github.checkStatus();
    relay.hold((request) => listPage(request) && request.path.includes('after='));
    const old = window.github.loadMore();
    await until(() => relay.held.length === 1);
    window.github.setText('alpha');
    await settled(window);
    relay.held[0]!.fail(502, 'gh: HTTP 502');
    await old;
    expect(shown(window)).toEqual({ count: 50, first: 'acme/app#1', last: 'acme/app#50', next: true, loading: false, loadingMore: false, error: null });

    relay.hold(listPage);
    const reading = window.github.refresh();
    await until(() => relay.held.length === 2);
    const before = relay.asked.length;
    await window.github.loadMore();
    expect([relay.asked.length - before, window.github.getView().loadingMore]).toEqual([0, false]);
    relay.held[1]!.release();
    await reading;
    relay.hold(() => false);
    await window.github.loadMore();
    expect(shown(window)).toMatchObject({ count: 100, last: 'acme/app#100', next: true });

    const timed = await planner.window();
    const timedRelay = slowRelay(timed);
    const [everyFiveMinutes] = await startKeepingTimers(() => timed.github.start());
    timedRelay.hold((request) => listPage(request) && request.path.includes('after='));
    const more = timed.github.loadMore();
    await until(() => timedRelay.held.length === 1);
    const quiet = timedRelay.asked.length;
    everyFiveMinutes!();
    expect(timedRelay.asked.length).toBe(quiet);
    timedRelay.held[0]!.release();
    await more;
    timedRelay.hold(() => false);
    everyFiveMinutes!();
    await settled(timed);
    expect(timedRelay.asked.slice(quiet).filter((request) => request.includes('/github/list')).map((request) => request.includes('after='))).toEqual([false, true]);
    expect(shown(timed)).toMatchObject({ count: 100, loadingMore: false });
  });
});

describe("the day's GitHub work in Daily Highlights", () => {
  withGh("pull requests opened, reviewed and merged, comments past a page, discussions and their comments: all of the day and nothing else, through gh; past ten more pages a source is named as cut; a read asked for later is the one kept; only https links are saved", async () => {
    const day = '2026-10-20';
    const [from, to] = [instantAt(day, 0, ZONE), instantAt(addDays(day, 1), 0, ZONE)];
    const at = (hours: number) => new Date(Date.parse(from) + hours * 3_600_000).toISOString();
    const url = (path: string) => `https://github.com/${REPO}/${path}`;
    const pull = (number: number, extra: object) => ({ id: `PR_day_${number}`, number, repo: REPO, url: url(`pull/${number}`), title: `Day pull ${number}`, body: '', headRefName: `day-${number}`, baseRefName: 'main', headOid: 'x', isDraft: false, state: 'OPEN' as const, createdAt: at(-48), updatedAt: at(1), ...extra });
    const review = (number: number, id: string, state: 'APPROVED' | 'CHANGES_REQUESTED', hours: number) => ({ id, author: VIEWER, state, submittedAt: at(hours), url: url(`pull/${number}#${id}`) });
    const comment = (id: string, created: number, updated = created, on = url('issues/1')) => ({ id, author: VIEWER, on, url: `${on}#${id}`, createdAt: at(created), updatedAt: at(updated) });
    const discussion = (id: string, number: number, hours: number) => ({ id, number, repo: REPO, title: id, url: url(`discussions/${number}`), author: VIEWER, createdAt: at(hours) });
    const world = planner.github!.world;
    // Mine opened; Ann's reviewed twice; mine merged by Ann; Bo's merged by me, found through my review the day before; Bo's merged by Ann.
    world.pulls = [pull(101, { createdAt: at(2) }), pull(102, { author: 'ann', reviews: [review(102, 'RV_1', 'CHANGES_REQUESTED', 3), review(102, 'RV_2', 'APPROVED', 5)] }), pull(103, { state: 'MERGED', mergedAt: at(4), mergedBy: 'ann' }), pull(104, { author: 'bo', state: 'MERGED', mergedAt: at(6), mergedBy: VIEWER, reviews: [review(104, 'RV_3', 'APPROVED', -30)] }), pull(105, { author: 'bo', state: 'MERGED', mergedAt: at(6), mergedBy: 'ann' })];
    // Comments past a page, one of yesterday updated today, one of last week, one on a pull request; a discussion of the
    // day and an older one, a comment on it from each day.
    world.issues = [fakeIssue(REPO, 1)];
    world.issueComments = [...Array.from({ length: 55 }, (_, n) => comment(`IC_${n}`, 8 + n / 60)), comment('IC_yesterday', -20, 2), comment('IC_old', -200), comment('IC_pr', 9.5, 9.5, url('pull/102'))];
    world.discussions = [discussion('DS_1', 7, 10), discussion('DS_0', 6, -100)];
    world.discussionComments = [-90, 11].map((hours, n) => ({ id: `DCM_${n}`, discussionId: 'DS_0', author: VIEWER, url: url(`discussions/6#${n}`), createdAt: at(hours) }));
    const window = await planner.window();
    planner.github!.requests.length = 0;

    const read = await readAndKeep(window.client, `${day}|${ZONE}`, from, to);
    expect(read.login).toBe(VIEWER);
    expect(read.items.filter((item) => item.kind !== 'commented').map((item) => item.id)).toEqual(['opened:PR_day_101', 'merged:PR_day_103', 'merged:PR_day_104', 'reviewed:RV_2', 'reviewed:RV_1', 'discussion:DS_1', 'discussionComment:DCM_1']);
    const comments = read.items.filter((item) => item.kind === 'commented');
    expect([comments.length, comments[0]!.id, comments[0]!.target.type, comments.some((item) => /yesterday|old/.test(item.id)), read.cut]).toEqual([56, 'commented:IC_pr', 'pull', false, []]);
    expect(planner.github!.requests.map((request) => request.operation).filter((operation) => operation?.startsWith('query PlannerGitHubActivity'))).toEqual(['query PlannerGitHubActivity', 'query PlannerGitHubActivityComments']);

    // 600 comments of the day: the first page and ten more are read, and the rest is GitHub's to show.
    world.issueComments = Array.from({ length: 600 }, (_, n) => comment(`MC_${n}`, 1 + n / 100));
    const cut = await readAndKeep(window.client, `${day}|cut`, from, to);
    expect([cut.items.filter((item) => item.kind === 'commented').length, cut.cut]).toEqual([550, ['commented']]);

    // Read twice at once (a Refresh): the read asked for last is the one kept for going back to the day, whichever answers last.
    world.issueComments = [];
    const relay = slowRelay(window);
    relay.hold(firstOf((request) => request.path.startsWith('/github/activity')));
    const first = readAndKeep(window.client, `${day}|${ZONE}`, from, to);
    await until(() => relay.held.length === 1);
    await relay.held[0]!.answered;
    world.discussions.push(discussion('DS_2', 8, 12));
    await readAndKeep(window.client, `${day}|${ZONE}`, from, to);
    relay.held[0]!.release();
    expect((await first).items.some((item) => item.id === 'discussion:DS_2')).toBe(false);
    expect(keptRead(`${day}|${ZONE}`)?.items.some((item) => item.id === 'discussion:DS_2')).toBe(true);

    // A highlight included from GitHub keeps an https link only.
    const highlight = (url: string) => planner.call('POST', '/commands', { commands: [{ cmd: `hl${url.length}`, type: 'ritual.saved', ritual: 'highlights', date: day, fields: { items: [{ id: 'h1', text: 'Merged pull request', taskId: null, starred: true, url, ref: 'github:merged:PR_day_103' }] } }] });
    expect((await highlight(url('pull/103'))).status).toBe(200);
    for (const link of ['javascript:alert(1)', `http://github.com/${REPO}/pull/103`]) expect((await highlight(link)).body.error).toBe('a highlight is invalid');
  });
});

// Sunsama's "Add via URL": an address pasted alone as a new task's title. Review 11 found a pasted GitHub issue URL made
// a task titled with the URL, linked to nothing.
describe('a URL pasted as a new task', () => {
  test('a GitHub issue or pull request, a Gmail message or a Calendar event becomes a task linked to it; one that cannot be found, or a Linear issue with Linear not connected, becomes a link task and the Planner says why; any other page is a link task', async () => {
    const world = planner.github!.world;
    world.issues = [fakeIssue('acme/app', 51, { title: 'Issue 51' })];
    world.pulls = reviewRequests('acme/app', 'Retries', 7).slice(6);
    await forgetGitHubTasks();
    const window = await planner.window();
    const notes = notesOf(window);
    await window.google.checkStatus();
    if (realGh) await window.github.checkStatus();
    const today = window.client.getView().today;
    const add = async (text: string): Promise<Task> => {
      const before = new Set(Object.keys(window.client.getView().state.tasks));
      await addParsedTask(window, parseQuickAdd(text, today), { kind: 'day', date: today }, 'bottom', today);
      return Object.values(window.client.getView().state.tasks).find((task) => !before.has(task.id))!;
    };

    if (realGh) {
      expect(await add('https://github.com/acme/app/issues/51#issuecomment-9 ~30m')).toMatchObject({ title: 'Issue 51', plannedMinutes: 30, source: { kind: 'github', id: world.issues[0]!.id, key: 'acme/app#51', url: 'https://github.com/acme/app/issues/51' } });
      expect(asked('query PlannerGitHubResource').at(-1)!.variables).toEqual({ url: 'https://github.com/acme/app/issues/51' });
      expect(await add('https://github.com/acme/app/pull/7/files')).toMatchObject({ title: 'Retries 7', source: { kind: 'github', id: world.pulls[0]!.id } });
      expect(await add('https://github.com/acme/app/issues/404')).toMatchObject({ title: 'github.com › acme › app › issues › 404', source: { kind: 'link' } });
      expect(notes.at(-1)).toBe("acme/app#404 was not found on GitHub, or this gh can't see it; added the link as a task");
    }

    // A thread's address, as the Planner links one: its latest message; a printed message by its own id, in the
    // account Gmail has it, not the one the address names; one in none of them; Gmail's own links, which no app can read.
    expect(await add(gmailUrl(ME, THREADS.numbers))).toMatchObject({ title: 'Re: Quarterly numbers', source: { kind: 'email', id: '18b2f3c4d5e6f702', account: ME } });
    expect(await add(`https://mail.google.com/mail/u/someone%40example.com/?ik=abc&view=pt&search=all&permthid=thread-f%3A${PRINTED_MESSAGE}&simpl=msg-f%3A${PRINTED_MESSAGE}`)).toMatchObject({ title: 'Lunch?', source: { kind: 'email', account: ME } });
    expect(await add('https://mail.google.com/mail/u/0/#inbox/18b2f3c4d5e6f7ff')).toMatchObject({ source: { kind: 'link' } });
    expect(notes.at(-1)).toBe("Couldn't find this message in Gmail (This message is in none of your Gmail accounts); added the link as a task");
    const resolves = planner.google!.requests.filter((request) => request.path.startsWith('/gmail/')).length;
    expect(await add('https://mail.google.com/mail/u/0/#inbox/FMfcgzQgLjNPlfJCVRfnNkPGkLhWClCW')).toMatchObject({ source: { kind: 'link', key: 'mail.google.com' } });
    expect([notes.at(-1), planner.google!.requests.filter((request) => request.path.startsWith('/gmail/')).length]).toEqual([expect.stringContaining("Gmail's own links can't be read by other apps"), resolves]);

    // A Calendar event, as "Add to tasks" adds it: on its day, its length planned.
    const eid = Buffer.from(`planning ${ME}`).toString('base64').replace(/=+$/, '');
    expect(await add(`https://calendar.google.com/calendar/event?eid=${eid}`)).toMatchObject({ title: 'Quarter planning', plannedMinutes: 60, placement: { kind: 'day', date: today }, source: { kind: 'event' } });

    expect(await add('https://linear.app/harness/issue/HAR-1/x')).toMatchObject({ source: { kind: 'link', url: 'https://linear.app/harness/issue/HAR-1/x' } });
    expect(notes.at(-1)).toContain('Linear is not connected');

    expect(await add('http://intranet.example.com/wiki/Runbook ~15m')).toMatchObject({ title: 'intranet.example.com › wiki › Runbook', plannedMinutes: 15, source: { kind: 'link', url: 'http://intranet.example.com/wiki/Runbook' } });
    const plain = await add('Fix the crash');
    expect([plain.title, plain.source ?? null]).toEqual(['Fix the crash', null]);
  });
});
