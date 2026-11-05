// Agents for Area E's scenarios (tests/agents.test.ts): a stand-in `opencode` CLI for the service, a project checkout
// whose origin is the fake GitHub's repository, OpenChamber making worktrees for a window's chats, and the git and gh
// an agent runs in its worktree.
import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { GuestProject, GuestWorktree, StartSessionRequest, StartSessionResult } from '@openchamber/sdk';
import type { Planner, PlannerWindow } from './planner.ts';

/**
 * A stand-in `opencode` for the service (written to `bin/opencode` in its home): `running` says whether OpenCode's
 * background server is up. Its models are `models.txt` in the home (a line each, as `opencode models` prints them),
 * printed after `modelsDelay` seconds; with the server up it answers the API: model names and variants, its agents, and
 * the commands it finds in OpenCode's command folder. Every call is logged in `opencode.log` in the home.
 */
export const opencodeStandIn = ({ running, modelsDelay = 0 }: { running: boolean; modelsDelay?: number }): string => `#!/bin/sh
echo "$*" >> "$HOME/opencode.log"
config="\${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
case "$1" in
  service) echo ${running ? 'http://127.0.0.1:4096' : 'stopped'} ;;
  models) sleep ${modelsDelay}; cat "$HOME/models.txt" ;;
  api)
    ${running ? '' : 'exit 1'}
    case "$3" in
      /api/model*) printf '%s' '{"data":[{"id":"claude-sonnet-5-5","providerID":"anthropic","name":"Claude Sonnet 5.5","variants":[{"id":"high"},"low",{"id":"has space"}]},{"id":"x"}]}' ;;
      /api/agent*) printf '%s' '{"data":[{"id":"build","name":"Build","mode":"primary","hidden":false,"description":"The default agent."},{"id":"explore","name":"Explore","mode":"subagent","hidden":false},{"id":"title","name":"Title","mode":"primary","hidden":true},{"id":"claude-reviewer","name":"claude-reviewer","mode":"primary","hidden":false,"model":{"providerID":"anthropic","id":"claude-x","variant":"max"},"color":"#00aa00"}]}' ;;
      /api/command*)
        printf '{"data":[{"name":"init"}'
        for file in "$config"/command/*.md; do [ -e "$file" ] && printf ',{"name":"%s"}' "$(basename "$file" .md)"; done
        printf ']}' ;;
      *) exit 1 ;;
    esac ;;
  *) exit 1 ;;
esac
`;

/** `opencode models`' output: duplicates, a warning and blank lines among the models, as OpenCode prints them. */
export const MODELS = 'opencode/big-pickle\nwarning: something\n\nanthropic/claude-sonnet-5-5\nopencode/big-pickle\nbad line here\n';

/** The stand-in made runnable (the harness writes files read-write only); the service finds it when it first asks. */
export const enableStandIn = (planner: Planner): void => chmodSync(join(planner.home, 'bin', 'opencode'), 0o755);

/** What the service asked the stand-in so far. */
export const opencodeCalls = (planner: Planner): string[] => {
  const log = join(planner.home, 'opencode.log');
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
};

/** git and gh for the agent: the service's home (its gh config reaches the fake GitHub), nothing of this machine's. */
const agentEnv = (planner: Planner) => ({
  HOME: planner.home,
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  LANG: 'C.UTF-8',
  GH_NO_UPDATE_NOTIFIER: '1',
  GH_PROMPT_DISABLED: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Harness Agent',
  GIT_AUTHOR_EMAIL: 'agent@example.invalid',
  GIT_COMMITTER_NAME: 'Harness Agent',
  GIT_COMMITTER_EMAIL: 'agent@example.invalid',
});

/** Runs a command the way an agent's shell does, without blocking this process (the fake GitHub answers from it). */
export const sh = (planner: Planner, cwd: string, command: string, ...args: string[]): Promise<string> =>
  new Promise((resolve, reject) =>
    execFile(command, args, { cwd, env: agentEnv(planner) }, (error, stdout, stderr) => (error ? reject(new Error(`${command} ${args.join(' ')}: ${stderr || error.message}`)) : resolve(stdout.trim()))),
  );

/**
 * A project OpenChamber knows, checked out in the service's home: its origin's fetch URL is the fake GitHub's
 * repository (what gh reads), its push URL the fake's git server, into a bare copy the fake checks pull requests with.
 */
export const projectCheckout = async (planner: Planner): Promise<GuestProject> => {
  const github = planner.github!;
  const repo = github.world.repos[0]!;
  const bare = join(planner.home, 'remote.git');
  const directory = join(planner.home, 'projects', repo.name);
  mkdirSync(directory, { recursive: true });
  repo.bare = bare;
  await sh(planner, planner.home, 'git', 'init', '-q', '--bare', '-b', 'main', bare);
  await sh(planner, directory, 'git', 'init', '-q', '-b', 'main');
  writeFileSync(join(directory, 'README.md'), '# Demo\n');
  await sh(planner, directory, 'git', 'add', 'README.md');
  await sh(planner, directory, 'git', 'commit', '-q', '-m', 'Start');
  await sh(planner, directory, 'git', 'remote', 'add', 'origin', `https://github.com/${repo.owner}/${repo.name}.git`);
  await sh(planner, directory, 'git', 'remote', 'set-url', '--push', 'origin', github.gitUrl(repo.owner, repo.name)!);
  await sh(planner, directory, 'git', 'push', '-q', 'origin', 'main');
  return { id: 'p-demo', name: repo.name, directory };
};

/**
 * OpenChamber making worktrees for a window's chats, as its startSession does: a chat asked for a new worktree gets a
 * git worktree of its project on a branch of that name (listed as ready from then on, in `worktrees`, which the window
 * lists); one asked for an existing worktree starts there; the answer says where, as OpenChamber's does.
 */
export const makesWorktrees = (planner: Planner, window: PlannerWindow, projects: GuestProject[], worktrees: Record<string, GuestWorktree[]>): void => {
  const host = window.host as unknown as { startSession(request: StartSessionRequest): Promise<StartSessionResult> };
  const start = host.startSession.bind(host);
  host.startSession = async (request) => {
    const { sessionId } = (await start(request)) as { sessionId: string };
    const project = projects.find((item) => item.id === request.projectId)!;
    const asked = request.worktree;
    if (asked && typeof asked === 'object' && asked.kind === 'new') {
      const branch = asked.name ?? `planner/${sessionId}`;
      const directory = join(`${project.directory}-worktrees`, branch.replace(/\//g, '-'));
      execFileSync('git', ['worktree', 'add', '-q', '-b', branch, directory], { cwd: project.directory, env: agentEnv(planner), stdio: 'ignore' });
      const worktree: GuestWorktree = { directory, name: basename(directory), branch, status: 'ready' };
      (worktrees[project.id] ??= []).push(worktree);
      return { sessionId, sent: request.text ? 'sent' : 'skipped', directory, worktree };
    }
    if (asked && typeof asked === 'object' && asked.kind === 'existing') {
      const worktree = (worktrees[project.id] ?? []).find((item) => item.directory === asked.directory);
      return { sessionId, sent: 'sent', directory: asked.directory, ...(worktree ? { worktree } : {}) };
    }
    return { sessionId, sent: 'sent', directory: project.directory };
  };
};
