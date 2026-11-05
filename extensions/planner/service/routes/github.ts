// GitHub's routes, all through `gh`: whether it is signed in, a page of a list, the repositories, linked items, the
// day's work for Daily Highlights, a pasted issue or pull request URL, and the pull requests agents opened. What gh
// could not do answers 502.
import { messageOf } from '../../src/domain/core/values.ts';
import { ACTIVITY_SOURCES, type ActivitySource } from '../../src/domain/github/activity.ts';
import { parseGitHubUrl } from '../../src/domain/github/github.ts';
import { LISTS, NODES_MAX, type ListKind } from '../github/github.ts';
import { bad, ok, readJson, type Answer, type Route } from '../http.ts';

const PULL_LOOKUPS_PER_REQUEST = 4;

/** A run's pull request to look up, as the panel sends it: by its URL once known, else by the run's branch. */
const isLookup = (value: unknown): value is { runId: string; branch: string | null; directories: string[]; url?: string } => {
  const lookup = value as { runId?: unknown; branch?: unknown; directories?: unknown; url?: unknown } | null;
  return (
    typeof lookup?.runId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(lookup.runId) &&
    (lookup.branch === null || (typeof lookup.branch === 'string' && lookup.branch.length <= 200)) &&
    (lookup.url === undefined || (typeof lookup.url === 'string' && lookup.url.length <= 300)) &&
    Array.isArray(lookup.directories) && lookup.directories.length <= 3 && lookup.directories.every((item) => typeof item === 'string' && item.length <= 1024)
  );
};

/** What gh answers, or why it could not (502). */
const viaGh = async (ask: () => Promise<Answer>): Promise<Answer> => {
  try {
    return await ask();
  } catch (error) {
    return { status: 502, body: { error: messageOf(error) } };
  }
};

export const githubRoute: Route = async ({ github }, req, url) => {
  const path = url.pathname;
  if (path === '/github/status' && req.method === 'GET') return ok(await github.status());
  if (path === '/github/list' && req.method === 'GET') {
    // A page of a list: from `after` (the previous page's cursor), narrowed by `q`; its `next` reaches the rest.
    const kind = url.searchParams.get('kind') ?? 'assigned';
    const after = url.searchParams.get('after');
    const text = url.searchParams.get('q') ?? '';
    if (!(kind in LISTS) || (after !== null && !/^[A-Za-z0-9+/=_-]{1,200}$/.test(after)) || text.length > 200) return bad('kind must be assigned, review or mine; after a cursor; q at most 200 characters');
    return viaGh(async () => ok(await github.list(kind as ListKind, { after, text })));
  }
  if (path === '/github/repos' && req.method === 'GET') {
    // The repositories the viewer contributes to, most recently pushed first (the panel's Repository choice).
    return viaGh(async () => ok({ repos: await github.repositories() }));
  }
  if (path === '/github/items' && req.method === 'POST') {
    const body = (await readJson(req)) as { ids?: unknown };
    const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === 'string' && /^[A-Za-z0-9_=-]{1,100}$/.test(id)) : [];
    // One gh call a request: the panel sends its linked items 100 at a time; more is refused, not cut short.
    if (ids.length > NODES_MAX) return bad(`at most ${NODES_MAX} ids a request`);
    return viaGh(async () => ok({ items: await github.items(ids) }));
  }
  if (path === '/github/activity' && req.method === 'GET') {
    // The day's GitHub work for Daily Highlights: the first page of each source, or the next page of one (`source`, `after`).
    const from = url.searchParams.get('from') ?? '';
    const to = url.searchParams.get('to') ?? '';
    const source = url.searchParams.get('source');
    const after = url.searchParams.get('after') ?? '';
    const instant = (value: string) => /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
    const span = Date.parse(to) - Date.parse(from);
    if (!instant(from) || !instant(to) || !(span > 0 && span <= 26 * 3_600_000) || (source !== null && !(ACTIVITY_SOURCES as readonly string[]).includes(source)) || !/^[A-Za-z0-9+/=_:-]{0,400}$/.test(after)) {
      return bad('from and to must be the bounds of one day (ISO instants); source one of the activity sources; after a cursor');
    }
    return viaGh(async () => ok(source ? await github.activityPage(source as ActivitySource, from, to, after) : await github.activity(from, to)));
  }
  if (path === '/github/resolve' && req.method === 'POST') {
    // A pasted issue or pull request URL, as Sunsama imports one: the item GitHub has there.
    const body = (await readJson(req)) as { url?: unknown };
    const link = body.url;
    if (typeof link !== 'string' || !parseGitHubUrl(link)) return bad('url must be a GitHub issue or pull request URL');
    return viaGh(async () => {
      const item = await github.byUrl(link);
      return item ? ok({ item }) : { status: 404, body: { error: `${parseGitHubUrl(link)!.key} was not found on GitHub, or this gh can't see it` } };
    });
  }
  if (path === '/github/pulls' && req.method === 'POST') {
    // Pull requests that agents opened from their runs' worktree branches, looked up in parallel, so the request
    // ends well within the host's 20 seconds.
    const body = (await readJson(req)) as { runs?: unknown };
    // The panel sends them PULL_LOOKUPS_PER_REQUEST at a time; more is refused, not cut short.
    if (Array.isArray(body.runs) && body.runs.length > PULL_LOOKUPS_PER_REQUEST) return bad(`at most ${PULL_LOOKUPS_PER_REQUEST} runs a request`);
    const runs = Array.isArray(body.runs) ? body.runs.filter(isLookup) : [];
    const results = await Promise.all(
      runs.map(async (run) => {
        try {
          return { runId: run.runId, pullRequest: run.url ? await github.pullRequestAt(run.url) : run.branch ? await github.pullRequestFor(run.branch, run.directories) : null };
        } catch (error) {
          return { runId: run.runId, pullRequest: null, error: messageOf(error) };
        }
      }),
    );
    return ok({ results });
  }
  return null;
};
