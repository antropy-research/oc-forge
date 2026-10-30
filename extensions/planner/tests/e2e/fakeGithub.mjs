// A fake GitHub for the GitHub CLI (`gh`), so that an agent's `gh pr create`, and the
// Planner's `gh pr list --head` and `gh pr view <url>`, can be checked without a GitHub
// account.
//
// gh sends every request through a Unix socket when its config.yml says
// `http_unix_socket: <path>`: plain HTTP, also for https://api.github.com, so nothing
// reaches GitHub. Give a checkout an origin whose fetch URL is
// https://github.com/<owner>/<repo> (what gh reads) and whose push URL is the fake's
// own git server, `gitUrl(repo)` (http://127.0.0.1:<port>/<owner>/<repo>.git, served by
// `git http-backend` from the repository's bare copy; OpenChamber accepts only http(s)
// and ssh endpoints for a remote, so not a local path). Then `git push` and
// `gh pr create` open a pull request here, and gh finds it again by branch or by URL.
// As GitHub does, a pull request needs its branch pushed, with commits the base branch
// does not have.
//
//   import { defaultGithubWorld, ghConfigFiles, startFakeGithub } from './fakeGithub.mjs';
//   const gh = await startFakeGithub({ socket: '/tmp/x/gh.sock', gitPort: 0, world: defaultGithubWorld({ bare: '/tmp/x/remote.git' }) });
//   // write ghConfigFiles(gh.socket) into <HOME>/.config/gh/ for the gh that should use it
//   gh.world.pulls: what was opened; gh.requests: what gh asked; await gh.close();
//
// The Planner's GitHub source reads issues and pull requests through `gh api graphql`: a page of a
// search (`search(query:, type: ISSUE, first:, after:)`, aliased or not, filtered by the qualifiers it
// sends, with `issueCount` and `pageInfo`), items by node id (`nodes(ids:)`) and one by its URL
// (`resource(url:)`). `world.issues` are the issues it finds; `world.pulls` the pull requests (with
// `author`, `mergedAt`, `mergedBy` and `reviews` for the day's work). Daily Highlights reads the
// viewer's work of a day: review contributions (`contributionsCollection(from:, to:)`), issue
// comments last updated first (`world.issueComments`, each `on` an issue's or pull request's URL),
// discussions newest first (`world.discussions`) and discussion comments oldest first, from either
// end (`world.discussionComments`, each of a `discussionId`).
//
// On its own, e.g. in the dev container where the agents' gh runs:
//   node fakeGithub.mjs <socket> <state.json> <world.json> [<git port>]
// keeps <state.json> up to date ({ pid, gitPort, pulls, requests }) and stops on SIGTERM.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The token gh is given for the fake; it is never sent anywhere else. */
export const FAKE_TOKEN = 'harness-fake-github-token';

/** One repository, `bare` being where its pushes land (a pull request needs its branch there). */
export const defaultGithubWorld = ({ owner = 'harness-org', repo = 'planner-pr-demo', viewer = 'harness-bot', bare = null, defaultBranch = 'main' } = {}) => ({
  viewer,
  repos: [{ id: `R_${owner}_${repo}`, owner, name: repo, defaultBranch, bare }],
  pulls: [],
  issues: [],
  issueComments: [],
  discussions: [],
  discussionComments: [],
  next: 1,
});

/** An issue of `repo` (owner/name), assigned to `assignees` (logins), as the fake's world keeps one. */
export const fakeIssue = (repo, number, { title = `Issue ${number}`, state = 'OPEN', assignees = [], updatedAt = new Date(Date.UTC(2026, 9, 1) + number * 60_000).toISOString() } = {}) => ({
  id: `I_${repo.replace(/[^A-Za-z0-9]/g, '_')}_${number}`,
  number,
  repo,
  url: `https://github.com/${repo}/issues/${number}`,
  title,
  state,
  assignees,
  updatedAt,
});

/** gh's config.yml and hosts.yml for the fake: every request through `socket`, signed in to github.com with a fake token. */
export const ghConfigFiles = (socket, viewer = 'harness-bot') => ({
  'config.yml': ['version: "1"', `http_unix_socket: ${socket}`, 'prompt: disabled', 'git_protocol: https', ''].join('\n'),
  'hosts.yml': ['github.com:', '    users:', `        ${viewer}:`, `            oauth_token: ${FAKE_TOKEN}`, '    git_protocol: https', `    oauth_token: ${FAKE_TOKEN}`, `    user: ${viewer}`, ''].join('\n'),
});

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'X-OAuth-Scopes': 'repo, read:org, workflow', 'X-GitHub-Media-Type': 'github.v3; format=json' });
  res.end(JSON.stringify(body));
};

const git = (bare, args) => execFileSync('git', ['--git-dir', bare, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/**
 * Git's smart HTTP for /<owner>/<repo>.git/…, through `git http-backend` (CGI) on the
 * repository's bare copy. REMOTE_USER is set, so pushes are allowed, as for a signed-in
 * user on GitHub.
 */
const gitHttp = (req, res, url, repo, viewer) => {
  const prefix = `/${repo.owner}/${repo.name}.git`;
  const backend = spawn('git', ['http-backend'], {
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      GIT_PROJECT_ROOT: dirname(repo.bare),
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: `/${basename(repo.bare)}${url.pathname.slice(prefix.length)}`,
      REQUEST_METHOD: req.method ?? 'GET',
      QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: req.headers['content-type'] ?? '',
      REMOTE_USER: viewer,
      REMOTE_ADDR: '127.0.0.1',
      ...(req.headers['content-encoding'] ? { HTTP_CONTENT_ENCODING: String(req.headers['content-encoding']) } : {}),
      ...(req.headers['git-protocol'] ? { GIT_PROTOCOL: String(req.headers['git-protocol']) } : {}),
    },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  req.pipe(backend.stdin);
  let head = Buffer.alloc(0);
  let started = false;
  backend.stdout.on('data', (chunk) => {
    if (started) {
      res.write(chunk);
      return;
    }
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf('\r\n\r\n') >= 0 ? head.indexOf('\r\n\r\n') : head.indexOf('\n\n');
    if (end < 0) return;
    const gap = head[end] === 0x0d ? 4 : 2;
    let status = 200;
    const headers = {};
    for (const line of head.subarray(0, end).toString('utf8').split(/\r?\n/)) {
      const at = line.indexOf(':');
      if (at < 0) continue;
      const [name, value] = [line.slice(0, at).trim(), line.slice(at + 1).trim()];
      if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10) || 200;
      else headers[name] = value;
    }
    res.writeHead(status, headers);
    started = true;
    res.write(head.subarray(end + gap));
  });
  backend.on('close', () => {
    if (!started) res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end();
  });
  backend.on('error', () => {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end();
  });
};

export const startFakeGithub = async ({ socket = null, port = 0, gitPort = null, world = defaultGithubWorld(), onChange = () => {} } = {}) => {
  const requests = [];
  const full = (repo) => `${repo.owner}/${repo.name}`;
  const repoOf = (owner, name) => world.repos.find((repo) => repo.owner.toLowerCase() === String(owner ?? '').toLowerCase() && repo.name.toLowerCase() === String(name ?? '').toLowerCase()) ?? null;
  const viewerNode = () => ({ id: `U_${world.viewer}`, login: world.viewer, name: 'Harness Bot', __typename: 'User' });
  const repoNode = (repo) => ({
    id: repo.id,
    name: repo.name,
    nameWithOwner: full(repo),
    owner: { id: `O_${repo.owner}`, login: repo.owner },
    url: `https://github.com/${full(repo)}`,
    description: '',
    isPrivate: true,
    visibility: 'PRIVATE',
    isFork: false,
    isArchived: false,
    isEmpty: false,
    isInOrganization: true,
    hasIssuesEnabled: true,
    hasWikiEnabled: false,
    hasProjectsEnabled: false,
    hasDiscussionsEnabled: false,
    viewerPermission: 'ADMIN',
    defaultBranchRef: { name: repo.defaultBranch },
    parent: null,
    mergeCommitAllowed: true,
    rebaseMergeAllowed: true,
    squashMergeAllowed: true,
    pullRequestTemplates: [],
    issueTemplates: [],
  });
  const pullNode = (pull) => {
    // A pull request of a repository the world doesn't hold (someone else's, for the day's work) is named by it.
    const [owner, name] = pull.repo.split('/');
    const repo = world.repos.find((item) => full(item) === pull.repo) ?? { id: `R_${owner}_${name}`, owner, name };
    return {
      id: pull.id,
      number: pull.number,
      url: pull.url,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      isDraft: pull.isDraft,
      closed: pull.state !== 'OPEN',
      merged: pull.state === 'MERGED',
      createdAt: pull.createdAt,
      updatedAt: pull.updatedAt,
      closedAt: pull.mergedAt ?? null,
      mergedAt: pull.mergedAt ?? null,
      mergedBy: pull.mergedBy ? { login: pull.mergedBy } : null,
      headRefName: pull.headRefName,
      headRefOid: pull.headOid,
      baseRefName: pull.baseRefName,
      isCrossRepository: false,
      maintainerCanModify: false,
      headRepositoryOwner: { id: `O_${repo.owner}`, login: repo.owner },
      headRepository: { id: repo.id, name: repo.name },
      author: pull.author ? { id: `U_${pull.author}`, login: pull.author, __typename: 'User' } : viewerNode(),
      additions: 0,
      deletions: 0,
      changedFiles: 0,
      mergeable: 'MERGEABLE',
      reviewDecision: '',
      labels: { nodes: [], totalCount: 0 },
      assignees: { nodes: [], totalCount: 0 },
      repository: { id: repo.id, name: repo.name, nameWithOwner: full(repo), owner: { login: repo.owner } },
    };
  };
  const notFound = (owner, name) => ({ data: { repository: null }, errors: [{ type: 'NOT_FOUND', path: ['repository'], message: `Could not resolve to a Repository with the name '${owner}/${name}'.` }] });
  const unprocessable = (message) => ({ data: { createPullRequest: null }, errors: [{ type: 'UNPROCESSABLE', path: ['createPullRequest'], message }] });
  const branchOf = (ref, repo) => String(ref ?? '').replace(new RegExp(`^${repo.owner}:`, 'i'), '').replace(/^refs\/heads\//, '');
  const changed = () => {
    try {
      onChange();
    } catch {
      // the state file is best effort
    }
  };

  /** As GitHub checks it: the head branch is in the repository and has commits the base does not. */
  const pushed = (repo, head, base) => {
    if (!repo.bare) return { oid: `fake-${head}` };
    let oid;
    try {
      oid = git(repo.bare, ['rev-parse', '--verify', `refs/heads/${head}^{commit}`]);
    } catch {
      return { error: `Head ref must be a branch: ${head} is not in ${full(repo)}; push it first` };
    }
    try {
      const ahead = git(repo.bare, ['rev-list', '--count', `refs/heads/${base}..refs/heads/${head}`]);
      if (Number(ahead) === 0) return { error: `No commits between ${base} and ${head}` };
    } catch {
      return { error: `Base ref must be a branch: ${base} is not in ${full(repo)}` };
    }
    return { oid };
  };

  const createPull = ({ repo, title, body, head, base, draft }) => {
    if (!title?.trim()) return { error: 'Title can\'t be blank' };
    const headRefName = branchOf(head, repo);
    const baseRefName = branchOf(base || repo.defaultBranch, repo);
    if (world.pulls.some((pull) => pull.repo === full(repo) && pull.headRefName === headRefName && pull.state === 'OPEN')) return { error: `A pull request already exists for ${repo.owner}:${headRefName}.` };
    const check = pushed(repo, headRefName, baseRefName);
    if (check.error) return { error: check.error };
    const number = world.next++;
    const now = new Date().toISOString();
    const pull = { id: `PR_${repo.name}_${number}`, number, repo: full(repo), url: `https://github.com/${full(repo)}/pull/${number}`, title: title.trim(), body: body ?? '', headRefName, baseRefName, headOid: check.oid, isDraft: Boolean(draft), state: 'OPEN', createdAt: now, updatedAt: now };
    world.pulls.push(pull);
    changed();
    return { pull };
  };

  const pullsOf = (repo, { head, base, states }) => world.pulls
    .filter((pull) => pull.repo === full(repo) && (!head || pull.headRefName === branchOf(head, repo)) && (!base || pull.baseRefName === base) && (!states?.length || states.includes(pull.state)))
    .sort((a, b) => b.number - a.number);

  const itemNode = (item) => (item.headRefName === undefined
    ? { __typename: 'Issue', id: item.id, number: item.number, title: item.title, url: item.url, state: item.state, updatedAt: item.updatedAt, repository: { nameWithOwner: item.repo } }
    : { __typename: 'PullRequest', ...pullNode(item) });
  /** A date qualifier's value (`A..B`, `>=A`, `>A`, `<=A`, `<A`, or a day) as a test of an instant. */
  const dateTest = (value) => {
    const at = (text) => Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00Z` : text);
    const range = /^(.+?)\.\.(.+)$/.exec(value);
    if (range) return (instant) => instant >= at(range[1]) && instant <= at(range[2]);
    const compare = /^(>=|>|<=|<)(.+)$/.exec(value);
    if (compare) return { '>=': (instant) => instant >= at(compare[2]), '>': (instant) => instant > at(compare[2]), '<=': (instant) => instant <= at(compare[2]), '<': (instant) => instant < at(compare[2]) }[compare[1]];
    return (instant) => new Date(instant).toISOString().slice(0, 10) === value;
  };
  const authorOf = (item) => (item.headRefName !== undefined ? item.author ?? world.viewer : item.author ?? '');
  /**
   * GitHub's issue search, for the qualifiers the Planner sends (is:, assignee:, review-requested:, reviewed-by:,
   * involves:, author:, repo:, created:, merged:, updated:, sort:, a `-` before one leaves its matches out) and words in the title.
   */
  const searchItems = (q) => {
    let items = [...(world.issues ?? []), ...world.pulls];
    const words = [];
    for (const raw of String(q ?? '').split(/\s+/).filter(Boolean)) {
      const negated = raw.startsWith('-') && raw.includes(':');
      const token = negated ? raw.slice(1) : raw;
      const [qualifier, value] = token.includes(':') ? [token.slice(0, token.indexOf(':')).toLowerCase(), token.slice(token.indexOf(':') + 1)] : [null, token];
      const me = (login) => (value === '@me' ? world.viewer : value).toLowerCase() === String(login).toLowerCase();
      const commented = (item) => (world.issueComments ?? []).some((comment) => comment.on === item.url && me(comment.author));
      const tests = {
        is: (item) => (value === 'open' ? item.state === 'OPEN' : value === 'closed' ? item.state !== 'OPEN' : value === 'issue' ? item.headRefName === undefined : value === 'pr' ? item.headRefName !== undefined : value === 'merged' ? Boolean(item.mergedAt) || item.state === 'MERGED' : true),
        assignee: (item) => (item.assignees ?? []).some(me),
        'review-requested': (item) => (item.reviewRequested ?? []).some(me),
        'reviewed-by': (item) => (item.reviews ?? []).some((review) => me(review.author)),
        author: (item) => me(authorOf(item)),
        involves: (item) => me(authorOf(item)) || (item.assignees ?? []).some(me) || commented(item),
        commenter: commented,
        repo: (item) => item.repo.toLowerCase() === value.toLowerCase(),
        created: (item) => Boolean(item.createdAt) && dateTest(value)(Date.parse(item.createdAt)),
        merged: (item) => Boolean(item.mergedAt) && dateTest(value)(Date.parse(item.mergedAt)),
        updated: (item) => Boolean(item.updatedAt) && dateTest(value)(Date.parse(item.updatedAt)),
      };
      if (qualifier === 'archived' || qualifier === 'sort') continue;
      if (qualifier && tests[qualifier]) items = items.filter((item) => tests[qualifier](item) !== negated);
      else words.push(token.toLowerCase());
    }
    if (words.length) items = items.filter((item) => words.every((word) => item.title.toLowerCase().includes(word)));
    return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.number - a.number);
  };
  const cursorOf = (offset) => Buffer.from(`cursor:${offset}`).toString('base64');
  const offsetOf = (cursor) => (cursor ? Number(/^cursor:(\d+)$/.exec(Buffer.from(String(cursor), 'base64').toString('utf8'))?.[1] ?? 0) : 0);

  /** A page of `all` from a cursor on (`first`/`after`), or up to one (`last`/`before`), the cursors positions in it. */
  const pageOf = (all, { first, last, after, before }) => {
    if (Number.isFinite(last)) {
      const end = before ? offsetOf(before) : all.length;
      const start = Math.max(0, end - last);
      return { nodes: all.slice(start, end), pageInfo: { hasPreviousPage: start > 0, startCursor: cursorOf(start), hasNextPage: end < all.length, endCursor: cursorOf(end) } };
    }
    const from = offsetOf(after);
    const size = Math.min(100, Number.isFinite(first) ? first : 10);
    const nodes = all.slice(from, from + size);
    return { nodes, pageInfo: { hasNextPage: from + size < all.length, endCursor: nodes.length ? cursorOf(from + nodes.length) : null, hasPreviousPage: from > 0, startCursor: cursorOf(from) } };
  };
  const viewerIs = (login) => String(login ?? '').toLowerCase() === world.viewer.toLowerCase();
  const targetOf = (item) => (item ? { id: item.id, number: item.number, title: item.title, url: item.url, repository: { nameWithOwner: item.repo } } : null);

  const graphql = (query, variables = {}) => {
    const data = {};
    /** A connection's arguments in the query: its page size and the cursor variables it names. */
    const argsOf = (name) => {
      const found = new RegExp(`\\b${name}\\s*\\(([^)]*)\\)`).exec(query)?.[1] ?? '';
      const number = (key) => Number(new RegExp(`\\b${key}\\s*:\\s*(\\d+)`).exec(found)?.[1] ?? NaN);
      const variable = (key) => {
        const named = new RegExp(`\\b${key}\\s*:\\s*\\$(\\w+)`).exec(found)?.[1];
        return named ? variables[named] : undefined;
      };
      return { first: number('first'), last: number('last'), after: variable('after'), before: variable('before') };
    };
    // Searches, one a query or several aliased (the day's work asks four at once).
    const searches = [...query.matchAll(/(?:(\w+)\s*:\s*)?\bsearch\s*\(\s*query\s*:\s*\$(\w+)\s*,\s*type\s*:\s*\w+\s*,\s*first\s*:\s*(\d+)(?:\s*,\s*after\s*:\s*\$(\w+))?/g)];
    for (const [, alias, qVariable, first, afterVariable] of searches) {
      const all = searchItems(variables[qVariable]);
      const page = pageOf(all, { first: Number(variables.first ?? first), after: afterVariable ? variables[afterVariable] : undefined });
      data[alias ?? 'search'] = { issueCount: all.length, pageInfo: { hasNextPage: page.pageInfo.hasNextPage, endCursor: page.pageInfo.endCursor }, nodes: page.nodes.map(itemNode) };
    }
    if (/\bnodes\s*\(\s*ids/.test(query)) {
      const ids = [].concat(variables.ids ?? []);
      const nodes = ids.map((id) => [...(world.issues ?? []), ...world.pulls].find((item) => item.id === id) ?? null);
      const missing = ids.filter((_, index) => nodes[index] === null);
      return { data: { nodes: nodes.map((node) => (node ? itemNode(node) : null)) }, ...(missing.length ? { errors: missing.map((id) => ({ type: 'NOT_FOUND', path: ['nodes'], message: `Could not resolve to a node with the global id of '${id}'` })) } : {}) };
    }
    if (/\bresource\s*\(/.test(query)) {
      const url = String(variables.url ?? '').replace(/\/$/, '');
      const found = [...(world.issues ?? []), ...world.pulls].find((item) => item.url.toLowerCase() === url.toLowerCase());
      return { data: { resource: found ? itemNode(found) : null } };
    }
    if (/\bviewer\s*\{/.test(query)) data.viewer = viewerNode();
    // The viewer's work of a day (Daily Highlights).
    if (data.viewer && /\bcontributionsCollection\s*\(/.test(query)) {
      const [from, to] = [Date.parse(variables.from ?? ''), Date.parse(variables.to ?? '')];
      const reviews = world.pulls
        .flatMap((pull) => (pull.reviews ?? []).filter((review) => viewerIs(review.author) && Date.parse(review.submittedAt) >= from && Date.parse(review.submittedAt) <= to).map((review) => ({ occurredAt: review.submittedAt, pullRequestReview: { id: review.id, url: review.url, state: review.state }, pullRequest: targetOf(pull) })))
        .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
      data.viewer.contributionsCollection = { pullRequestReviewContributions: pageOf(reviews, argsOf('pullRequestReviewContributions')) };
    }
    if (data.viewer && /\bissueComments\s*\(/.test(query)) {
      const byUrl = (url) => [...(world.issues ?? []), ...world.pulls].find((item) => item.url === url) ?? null;
      const comments = (world.issueComments ?? [])
        .filter((comment) => viewerIs(comment.author))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((comment) => {
          const on = byUrl(comment.on);
          return { id: comment.id, url: comment.url, createdAt: comment.createdAt, updatedAt: comment.updatedAt, issue: targetOf(on), pullRequest: on && on.headRefName !== undefined ? targetOf(on) : null };
        });
      data.viewer.issueComments = pageOf(comments, argsOf('issueComments'));
    }
    if (data.viewer && /\brepositoryDiscussions\s*\(/.test(query)) {
      const discussions = (world.discussions ?? []).filter((discussion) => viewerIs(discussion.author)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((discussion) => ({ ...targetOf(discussion), createdAt: discussion.createdAt }));
      data.viewer.repositoryDiscussions = pageOf(discussions, argsOf('repositoryDiscussions'));
    }
    if (data.viewer && /\brepositoryDiscussionComments\s*\(/.test(query)) {
      const comments = (world.discussionComments ?? [])
        .filter((comment) => viewerIs(comment.author))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((comment) => ({ id: comment.id, url: comment.url, createdAt: comment.createdAt, discussion: targetOf((world.discussions ?? []).find((discussion) => discussion.id === comment.discussionId)) }));
      data.viewer.repositoryDiscussionComments = pageOf(comments, argsOf('repositoryDiscussionComments'));
    }
    if (/createPullRequest\s*\(/.test(query)) {
      const input = variables.input ?? {};
      const repo = world.repos.find((item) => item.id === input.repositoryId);
      if (!repo) return { data: { createPullRequest: null }, errors: [{ type: 'NOT_FOUND', message: `Could not resolve to a node with the global id of '${input.repositoryId}'.` }] };
      const made = createPull({ repo, title: input.title, body: input.body, head: input.headRefName, base: input.baseRefName, draft: input.draft });
      if (made.error) return unprocessable(made.error);
      return { data: { createPullRequest: { pullRequest: pullNode(made.pull) } } };
    }
    // RepositoryNetwork: aliases such as repo_000: repository(owner: "o", name: "r").
    const aliased = [...query.matchAll(/(\w+)\s*:\s*repository\s*\(\s*owner\s*:\s*"([^"]+)"\s*,\s*name\s*:\s*"([^"]+)"\s*\)/g)];
    if (aliased.length) {
      for (const [, alias, owner, name] of aliased) {
        const repo = repoOf(owner, name);
        data[alias] = repo ? repoNode(repo) : null;
      }
      return { data };
    }
    if (/\brepository\s*\(/.test(query)) {
      const owner = variables.owner;
      const name = variables.name ?? variables.repo;
      const repo = repoOf(owner, name);
      if (!repo) return notFound(owner, name);
      const repository = repoNode(repo);
      const byNumber = /pullRequest\s*\(\s*number/.test(query);
      if (byNumber) {
        const number = Number(variables.pr_number ?? variables.number);
        const pull = world.pulls.find((item) => item.repo === full(repo) && item.number === number);
        if (!pull) return { data: { repository: { ...repository, pullRequest: null } }, errors: [{ type: 'NOT_FOUND', path: ['repository', 'pullRequest'], message: `Could not resolve to a PullRequest with the number of ${number}.` }] };
        repository.pullRequest = pullNode(pull);
      } else if (/pullRequests\s*\(/.test(query)) {
        const stateVariable = variables.states ?? variables.state;
        const states = stateVariable === undefined ? (/\$state:\s*\[PullRequestState!\]\s*=\s*OPEN/.test(query) ? ['OPEN'] : null) : [].concat(stateVariable);
        const nodes = pullsOf(repo, { head: variables.headRefName ?? variables.headBranch, base: variables.baseRefName ?? variables.baseBranch, states }).slice(0, Number(variables.limit ?? variables.first ?? 30)).map(pullNode);
        repository.pullRequests = { totalCount: nodes.length, nodes, pageInfo: { hasNextPage: false, endCursor: null } };
      }
      data.repository = repository;
      return { data };
    }
    if (data.viewer || searches.length) return { data };
    const operation = /\b(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? 'this request';
    return { errors: [{ type: 'NOT_SUPPORTED', message: `the fake GitHub does not answer ${operation}` }] };
  };

  const restPull = (pull) => {
    const [owner, name] = pull.repo.split('/');
    return { id: pull.number, node_id: pull.id, number: pull.number, html_url: pull.url, url: `https://api.github.com/repos/${pull.repo}/pulls/${pull.number}`, state: pull.state === 'OPEN' ? 'open' : 'closed', draft: pull.isDraft, title: pull.title, body: pull.body, merged: pull.state === 'MERGED', created_at: pull.createdAt, updated_at: pull.updatedAt, user: { login: world.viewer }, head: { ref: pull.headRefName, sha: pull.headOid, repo: { full_name: pull.repo, name, owner: { login: owner } } }, base: { ref: pull.baseRefName, repo: { full_name: pull.repo, name, owner: { login: owner } } } };
  };

  const rest = (method, url, body) => {
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    // `gh auth status` checks the token on the API's root (and reads its scopes from the headers).
    if (method === 'GET' && url.pathname === '/') return [200, { current_user_url: 'https://api.github.com/user', repository_url: 'https://api.github.com/repos/{owner}/{repo}' }];
    if (method === 'GET' && url.pathname === '/user') return [200, { login: world.viewer, id: 1, name: 'Harness Bot', type: 'User' }];
    if (parts[0] === 'repos' && parts.length >= 3) {
      const repo = repoOf(parts[1], parts[2]);
      if (!repo) return [404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' }];
      if (parts.length === 3 && method === 'GET') return [200, { id: 1, node_id: repo.id, name: repo.name, full_name: full(repo), owner: { login: repo.owner }, private: true, html_url: `https://github.com/${full(repo)}`, default_branch: repo.defaultBranch, permissions: { admin: true, push: true, pull: true } }];
      if (parts[3] === 'pulls' && parts.length === 4 && method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        const states = state === 'all' ? null : state === 'closed' ? ['CLOSED', 'MERGED'] : ['OPEN'];
        return [200, pullsOf(repo, { head: url.searchParams.get('head'), base: url.searchParams.get('base'), states }).map(restPull)];
      }
      if (parts[3] === 'pulls' && parts.length === 4 && method === 'POST') {
        const made = createPull({ repo, title: body?.title, body: body?.body, head: body?.head, base: body?.base, draft: body?.draft });
        return made.error ? [422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'custom', message: made.error }] }] : [201, restPull(made.pull)];
      }
      const pull = parts[3] === 'pulls' && parts.length >= 5 ? world.pulls.find((item) => item.repo === full(repo) && item.number === Number(parts[4])) : null;
      if (parts[3] === 'pulls' && parts.length >= 5 && !pull) return [404, { message: 'Not Found' }];
      if (pull && parts.length === 5 && method === 'GET') return [200, restPull(pull)];
      // Closing (PATCH state) and merging (PUT …/merge), as GitHub's REST API does them; the git side is left alone.
      if (pull && parts.length === 5 && method === 'PATCH') {
        if (body?.state === 'closed' && pull.state === 'OPEN') pull.state = 'CLOSED';
        if (body?.state === 'open' && pull.state === 'CLOSED') pull.state = 'OPEN';
        if (typeof body?.title === 'string') pull.title = body.title;
        pull.updatedAt = new Date().toISOString();
        changed();
        return [200, restPull(pull)];
      }
      if (pull && parts[5] === 'merge' && method === 'PUT') {
        if (pull.state !== 'OPEN') return [405, { message: 'Pull Request is not mergeable' }];
        pull.state = 'MERGED';
        pull.updatedAt = new Date().toISOString();
        changed();
        return [200, { sha: pull.headOid, merged: true, message: 'Pull Request successfully merged' }];
      }
    }
    return [404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' }];
  };

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://api.github.com');
      const text = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      if (req.method === 'POST' && /^\/(api\/)?graphql$/.test(url.pathname)) {
        const query = String(body?.query ?? '');
        const operation = /\b(query|mutation)\s+(\w+)/.exec(query);
        requests.push({ method: 'POST', path: url.pathname, operation: operation ? `${operation[1]} ${operation[2]}` : 'query', variables: body?.variables ?? {} });
        const answer = graphql(query, body?.variables ?? {});
        changed();
        json(res, 200, answer);
        return;
      }
      requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });
      const [status, payload] = rest(req.method, url, body);
      changed();
      json(res, status, payload);
    });
  });
  const listen = (target, ...where) => new Promise((resolve, reject) => {
    target.once('error', reject);
    target.listen(...where, resolve);
  });
  if (socket) {
    mkdirSync(dirname(socket), { recursive: true });
    rmSync(socket, { force: true });
    await listen(server, socket);
  } else await listen(server, port, '127.0.0.1');

  // The repositories' git server, for push URLs: http://127.0.0.1:<gitPort>/<owner>/<repo>.git
  const gitServer = gitPort === null ? null : createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const repo = world.repos.find((item) => item.bare && url.pathname.toLowerCase().startsWith(`/${item.owner}/${item.name}.git/`.toLowerCase()));
    if (!repo) {
      req.resume();
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Repository not found.');
      return;
    }
    requests.push({ method: req.method, path: url.pathname, operation: `git ${url.searchParams.get('service') ?? url.pathname.split('/').pop()}` });
    gitHttp(req, res, url, repo, world.viewer);
    if (req.method === 'POST' && url.pathname.endsWith('/git-receive-pack')) res.on('finish', changed);
  });
  if (gitServer) await listen(gitServer, gitPort, '127.0.0.1');
  const gitBase = gitServer ? `http://127.0.0.1:${gitServer.address().port}` : null;
  const close = (target) => new Promise((resolve) => (target ? target.close(() => resolve()) : resolve()));
  return {
    socket,
    port: socket ? null : server.address().port,
    gitPort: gitServer ? gitServer.address().port : null,
    /** Where `git push` reaches a repository's bare copy (null without a git server). */
    gitUrl: (owner, name) => (gitBase ? `${gitBase}/${owner}/${name}.git` : null),
    world,
    requests,
    close: async () => {
      await Promise.all([close(server), close(gitServer)]);
      if (socket) rmSync(socket, { force: true });
    },
  };
};

// node fakeGithub.mjs <socket> <state.json> <world.json> [<git port>]
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [socket, stateFile, worldFile, gitPortArg] = process.argv.slice(2);
  if (!socket || !stateFile || !worldFile) {
    console.error('usage: node fakeGithub.mjs <socket> <state.json> <world.json> [<git port>]');
    process.exit(2);
  }
  const world = JSON.parse(readFileSync(worldFile, 'utf8'));
  let fake = null;
  const save = () => {
    const temporary = `${stateFile}.tmp`;
    writeFileSync(temporary, JSON.stringify({ pid: process.pid, socket, gitPort: fake?.gitPort ?? null, pulls: world.pulls, requests: fake?.requests ?? [] }, null, 1));
    renameSync(temporary, stateFile);
  };
  fake = await startFakeGithub({ socket, world, gitPort: gitPortArg === undefined ? null : Number(gitPortArg), onChange: save });
  save();
  const stop = () => void fake.close().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
