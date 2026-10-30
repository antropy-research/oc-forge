// The service's agent routes as the host runs it: a process with only PATH and
// HOME (here XDG_CONFIG_HOME too, so OpenCode's config is a temporary folder),
// a stand-in `opencode` whose background server is stopped, and an empty plan.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const token = 'agent-routes-token';
let child: ChildProcess;
let base = '';
let root = '';
let config = '';

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });

const call = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

const waitFor = async (test: () => boolean) => {
  for (let attempt = 0; attempt < 40 && !test(); attempt++) await new Promise((resolve) => setTimeout(resolve, 50));
  return test();
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'planner-agent-routes-'));
  config = join(root, 'xdg', 'opencode');
  mkdirSync(join(config, 'agent'), { recursive: true });
  writeFileSync(join(config, 'agent', 'reviewer.md'), '---\ndescription: Reviews pull requests\n---\nReview.');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'opencode'), '#!/bin/sh\ncase "$1" in\n  service) echo stopped ;;\n  models) printf "openai/gpt-6\\nanthropic/claude-sonnet-5-5\\n" ;;\n  *) exit 1 ;;\nesac\n');
  chmodSync(join(bin, 'opencode'), 0o755);
  const port = await freePort();
  child = spawn(process.execPath, [join(import.meta.dir, '../service/main.ts')], {
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'xdg'), OPENCHAMBER_SERVICE_PORT: String(port), OPENCHAMBER_SERVICE_TOKEN: token, PLANNER_DATA_DIR: join(root, 'data') },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      if ((await fetch(`${base}/health`, { headers: { Authorization: `Bearer ${token}` } })).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the service did not start');
});

afterAll(async () => {
  const exited = new Promise((resolve) => child?.once('exit', resolve));
  child?.kill('SIGTERM');
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
  rmSync(root, { recursive: true, force: true });
});

describe('agent routes', () => {
  test('GET /agents: OpenCode\'s agents from its config folder, and the models', async () => {
    const answer = await call('GET', '/agents');
    expect(answer.status).toBe(200);
    expect((answer.body.agents as { name: string }[]).map((agent) => agent.name)).toEqual(['build', 'plan', 'reviewer']);
    expect((answer.body.models as { id: string }[]).map((model) => model.id)).toEqual(['anthropic/claude-sonnet-5-5', 'openai/gpt-6']);
    expect(answer.body.configDir).toBe(config);
    expect((await call('GET', '/agents?directory=relative/dir')).status).toBe(400);
  });

  test('POST /agents/commands writes an assignee\'s command and checks what it is given', async () => {
    const assignee = { id: 'agent-plan', name: 'Plan', agent: 'plan', model: null };
    const answer = await call('POST', '/agents/commands', { entries: [{ assignee, kind: 'agent' }], wait: true });
    expect(answer.body).toEqual({ commands: [{ id: 'agent-plan', name: 'oc-planner-agent-plan', changed: true }], listed: null, dir: join(config, 'command') });
    expect(readFileSync(join(config, 'command', 'oc-planner-agent-plan.md'), 'utf8')).toContain('agent: "plan"');
    for (const entries of [[{ assignee: { ...assignee, model: 'not a model' }, kind: 'agent' }], [{ assignee, kind: 'other' }], [{ assignee: { ...assignee, id: '../x' }, kind: 'agent' }]]) {
      expect((await call('POST', '/agents/commands', { entries })).status).toBe(400);
    }
  });

  test('presets saved through /commands get a command each; a removed one loses it', async () => {
    const preset = { id: 'plan-gpt-ab12', name: 'Plan · GPT-6', agent: 'plan', model: 'openai/gpt-6' };
    const file = join(config, 'command', 'oc-planner-plan-gpt-ab12.md');
    expect((await call('POST', '/commands', { commands: [{ cmd: 'p1', type: 'settings.updated', patch: { agentPresets: [preset] } }] })).status).toBe(200);
    expect(await waitFor(() => existsSync(file))).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('model: "openai/gpt-6"');
    expect((await call('POST', '/commands', { commands: [{ cmd: 'p2', type: 'settings.updated', patch: { agentPresets: [] } }] })).status).toBe(200);
    expect(await waitFor(() => !existsSync(file))).toBe(true);
    // The agent's own command is not a preset's; it stays.
    expect(existsSync(join(config, 'command', 'oc-planner-agent-plan.md'))).toBe(true);
  });
});
