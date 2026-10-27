// A fake GitHub for the GitHub CLI (`gh`), so that an agent's `gh pr create`, and the
// Planner's `gh pr list --head` and `gh pr view <url>`, can be checked without a GitHub
// account.
//
// gh sends every request through a Unix socket when its config.yml says
// `http_unix_socket: <path>`: plain HTTP, also for https://api.github.com, so nothing
// reaches GitHub. Give a checkout an origin whose fetch URL is
// https://github.com/<owner>/<repo> (what gh reads) and whose push URL is a local bare
// repository (where `git push` lands). Then `git push` and `gh pr create` open a pull
// request here, and gh finds it again by branch or by URL. As GitHub does, a pull
// request needs its branch pushed, with commits the base branch does not have.
//
//   import { defaultGithubWorld, ghConfigFiles, startFakeGithub } from './fakeGithub.mjs';
//   const gh = await startFakeGithub({ socket: '/tmp/x/gh.sock', world: defaultGithubWorld({ bare: '/tmp/x/remote.git' }) });
//   // write ghConfigFiles(gh.socket) into <HOME>/.config/gh/ for the gh that should use it
//   gh.world.pulls: what was opened; gh.requests: what gh asked; await gh.close();
//
// On its own, e.g. in the dev container where the agents' gh runs:
//   node fakeGithub.mjs <socket> <state.json> <world.json>
// keeps <state.json> up to date ({ pid, pulls, requests }) and stops on SIGTERM.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The token gh is given for the fake; it is never sent anywhere else. */
export const FAKE_TOKEN = 'harness-fake-github-token';

/** One repository, `bare` being where its pushes land (a pull request needs its branch there). */
export const defaultGithubWorld = ({ owner = 'harness-org', repo = 'planner-pr-demo', viewer = 'harness-bot', bare = null, defaultBranch = 'main' } = {}) => ({
  viewer,
  repos: [{ id: `R_${owner}_${repo}`, owner, name: repo, defaultBranch, bare }],
  pulls: [],
  next: 1,
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

export const startFakeGithub = async ({ socket = null, port = 0, world = defaultGithubWorld(), onChange = () => {} } = {}) => {
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
    const repo = world.repos.find((item) => full(item) === pull.repo);
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
      closedAt: null,
      mergedAt: null,
      headRefName: pull.headRefName,
      headRefOid: pull.headOid,
      baseRefName: pull.baseRefName,
      isCrossRepository: false,
      maintainerCanModify: false,
      headRepositoryOwner: { id: `O_${repo.owner}`, login: repo.owner },
      headRepository: { id: repo.id, name: repo.name },
      author: viewerNode(),
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

  const graphql = (query, variables = {}) => {
    const data = {};
    if (/\bviewer\s*\{/.test(query)) data.viewer = viewerNode();
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
    if (data.viewer) return { data };
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
  if (socket) {
    mkdirSync(dirname(socket), { recursive: true });
    rmSync(socket, { force: true });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socket, resolve);
    });
  } else {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  }
  return {
    socket,
    port: socket ? null : server.address().port,
    world,
    requests,
    close: () => new Promise((resolve) => server.close(() => {
      if (socket) rmSync(socket, { force: true });
      resolve();
    })),
  };
};

// node fakeGithub.mjs <socket> <state.json> <world.json>
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [socket, stateFile, worldFile] = process.argv.slice(2);
  if (!socket || !stateFile || !worldFile) {
    console.error('usage: node fakeGithub.mjs <socket> <state.json> <world.json>');
    process.exit(2);
  }
  const world = JSON.parse(readFileSync(worldFile, 'utf8'));
  let fake = null;
  const save = () => {
    const temporary = `${stateFile}.tmp`;
    writeFileSync(temporary, JSON.stringify({ pid: process.pid, socket, pulls: world.pulls, requests: fake?.requests ?? [] }, null, 1));
    renameSync(temporary, stateFile);
  };
  fake = await startFakeGithub({ socket, world, onChange: save });
  save();
  const stop = () => void fake.close().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
