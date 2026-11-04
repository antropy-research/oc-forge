// Two throwaway OpenChamber instances on this machine for the end-to-end check,
// of the release vendors.json pins: `stock` (that npm release) and `adapted`
// (dist/openchamber-web-<v>.tgz, built from vendors/openchamber),
// each with its own HOME, data dir and loopback port, the same extensions and
// one demo project. Nothing is shared with the dev containers or with the
// session that runs this (see instanceEnv).
//
//   node tests/e2e/openchamber-adapters/stack.mjs prepare  install both builds and the check's tools (network)
//   node tests/e2e/openchamber-adapters/stack.mjs up       start both
//   node tests/e2e/openchamber-adapters/stack.mjs restart <stock|adapted>   stop and start one instance
//   node tests/e2e/openchamber-adapters/stack.mjs down     stop everything and delete the work dir
//
// WORK (default /tmp/opencode/oc-adapters/e2e) holds everything, including the
// generated UI password (secrets.env, mode 0600); it is never printed. `up`
// runs `prepare` first if something is missing.
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const work = process.env.WORK ?? '/tmp/opencode/oc-adapters/e2e';
// The OpenChamber release vendors.json pins (`mise run vendors:update` moves it), unless set.
const pins = JSON.parse(readFileSync(join(repo, 'vendors.json'), 'utf8'));
const version = process.env.OPENCHAMBER_VERSION ?? pins.openchamber.release.replace(/^v/, '');
const packageFile = process.env.PACKAGE ?? join(repo, `dist/openchamber-web-${version}.tgz`);
// Two stacks can run side by side with their own WORK and STACK_PORT_BASE (stock, adapted).
const BASE = Number(process.env.STACK_PORT_BASE ?? 35350);
export const instances = {
  stock: { port: BASE, install: `@openchamber/web@${version}` },
  adapted: { port: BASE + 1, install: packageFile },
};

const env = () => {
  const next = { ...process.env };
  delete next.BASH_ENV;
  return next;
};

// The scratch servers start like fresh installs: without the variables the
// OpenChamber or OpenCode this runs under hands its children (its config, server
// passwords, agent-tool URL, Linear auth) and without credentials, so they can
// neither load the host's config nor reach its services.
const instanceEnv = () => Object.fromEntries(Object.entries(env())
  .filter(([name]) => !/^(OPENCODE|OPENCHAMBER)/.test(name) && !/TOKEN|SECRET|PASSW|API_?KEY|AUTH|CREDENTIAL/i.test(name)));

const secret = (name) => new RegExp(`^${name}=(.+)$`, 'm').exec(readFileSync(join(work, 'secrets.env'), 'utf8'))?.[1]?.trim();
export const password = () => secret('OPENCHAMBER_UI_PASSWORD');

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

const prepare = async () => {
  mkdirSync(work, { recursive: true });
  chmodSync(work, 0o700);
  const secrets = join(work, 'secrets.env');
  if (!existsSync(secrets)) {
    writeFileSync(secrets, `OPENCHAMBER_UI_PASSWORD=${randomBytes(24).toString('hex')}\n`, { mode: 0o600 });
  }

  // The check's own tools: Playwright, and the SDK the test extension's page bundles.
  const deps = join(work, 'deps');
  const versionOf = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).version : null);
  if (!existsSync(join(deps, 'node_modules/playwright-core')) || versionOf(join(deps, 'node_modules/@openchamber/sdk/package.json')) !== version) {
    mkdirSync(deps, { recursive: true });
    writeFileSync(join(deps, 'package.json'), '{ "name": "ocforge-e2e-deps", "private": true, "type": "module" }\n');
    execFileSync('bun', ['add', 'playwright-core@1.63.0', `@openchamber/sdk@${version}`], { cwd: deps, stdio: 'inherit', env: env() });
  }
  for (const [name, instance] of Object.entries(instances)) {
    const prefix = join(work, name, 'prefix');
    const stamp = join(work, name, 'installed');
    const wanted = existsSync(instance.install) ? String(statSync(instance.install).mtimeMs) : instance.install;
    if (existsSync(stamp) && readFileSync(stamp, 'utf8') === wanted && existsSync(join(prefix, 'lib/node_modules/@openchamber/web/package.json'))) continue;
    stop(name);
    rmSync(prefix, { recursive: true, force: true });
    execFileSync('npm', ['install', '-g', '--prefix', prefix, '--allow-scripts=node-pty', instance.install], { stdio: 'inherit', env: env() });
    writeFileSync(stamp, wanted);
  }
};

const prepared = () => existsSync(join(work, 'secrets.env')) && existsSync(join(work, 'deps/node_modules/playwright-core'))
  && Object.entries(instances).every(([name, instance]) => {
    const stamp = join(work, name, 'installed');
    const wanted = existsSync(instance.install) ? String(statSync(instance.install).mtimeMs) : instance.install;
    return existsSync(stamp) && readFileSync(stamp, 'utf8') === wanted;
  });

const spawnLogged = (name, command, args, options) => {
  mkdirSync(join(work, name), { recursive: true });
  const log = openSync(join(work, name, `${name}.log`), 'a');
  const child = spawn(command, args, { ...options, detached: true, stdio: ['ignore', log, log] });
  child.unref();
  writeFileSync(join(work, name, 'pid'), String(child.pid));
};

const up = async () => {
  if (!prepared()) await prepare();

  // The extension under test, as a copy (it writes into its own folder) of this checkout's own files: tracked, or new
  // and not ignored. What the checkout ignores (node_modules) is not its to start from.
  const extensions = join(work, 'extensions');
  rmSync(extensions, { recursive: true, force: true });
  mkdirSync(extensions, { recursive: true });
  for (const name of ['planner']) {
    const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', `extensions/${name}`], { cwd: repo }).toString().split('\0').filter(Boolean);
    for (const file of files) {
      if (!existsSync(join(repo, file))) continue;
      const target = join(extensions, file.slice('extensions/'.length));
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(repo, file), target);
    }
  }
  execFileSync('bun', [join(here, 'build-fixture.ts'), extensions, join(work, 'deps/node_modules/@openchamber/sdk')], { stdio: 'inherit', env: env() });

  for (const [name, instance] of Object.entries(instances)) {
    if (!await healthy(instance.port)) await start(name);
  }
  for (const name of Object.keys(instances)) await waitReady(name);
};

// One OpenChamber instance, with its own HOME, data dir and port.
const start = async (name) => {
  const instance = instances[name];
  const root = join(work, name);
  const prefix = join(root, 'prefix');
  stop(name);
  for (let attempt = 0; attempt < 20 && await fetch(`http://127.0.0.1:${instance.port}/health`).then(() => true).catch(() => false); attempt += 1) await wait(500);
  const home = join(root, 'home');
  const project = join(home, 'projects/demo');
  if (!existsSync(project)) {
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'README.md'), '# demo\n\nA project for the oc-forge adapter check.\n');
    execFileSync('git', ['init', '-q', '-b', 'main', project]);
    execFileSync('git', ['-C', project, '-c', 'user.name=oc-forge e2e', '-c', 'user.email=e2e@oc-forge.invalid', 'add', '.'], { env: env() });
    execFileSync('git', ['-C', project, '-c', 'user.name=oc-forge e2e', '-c', 'user.email=e2e@oc-forge.invalid', 'commit', '-qm', 'demo'], { env: env() });
  }
  spawnLogged(name, 'node', [join(prefix, 'lib/node_modules/@openchamber/web/bin/cli.js'), 'serve', '--foreground', '--port', String(instance.port), '--host', '127.0.0.1'], {
    cwd: home,
    env: {
      ...instanceEnv(),
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME: join(home, '.local/share'),
      XDG_STATE_HOME: join(home, '.local/state'),
      XDG_CACHE_HOME: join(home, '.cache'),
      OPENCHAMBER_DATA_DIR: join(home, '.config/openchamber'),
      OPENCHAMBER_UI_PASSWORD: password(),
      OPENCHAMBER_RELAY_HOST: 'off',
      OPENCHAMBER_PUSH_RELAY_DISABLED: '1',
    },
  });
};

const waitReady = async (name) => {
  const base = `http://127.0.0.1:${instances[name].port}`;
  for (let attempt = 0; ; attempt += 1) {
    const health = await fetch(`${base}/health`).then((response) => response.json()).catch(() => null);
    if (health?.isOpenCodeReady) break;
    if (attempt > 240) throw new Error(`${name} did not become ready; see ${join(work, name, `${name}.log`)}`);
    await wait(500);
  }
  console.log(`${name}: ${base} ready`);
};

const healthy = async (port) => Boolean((await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json()).catch(() => null))?.isOpenCodeReady);

// Stops an instance's whole process group: OpenChamber, its OpenCode and extension services.
const stop = (name) => {
  const pidFile = join(work, name, 'pid');
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, 'utf8'));
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
  rmSync(pidFile, { force: true });
};

const down = () => {
  for (const name of Object.keys(instances)) stop(name);
  if (process.argv.includes('--keep-work')) return;
  rmSync(work, { recursive: true, force: true });
};

const command = process.argv[2];
if (command === 'prepare') await prepare();
else if (command === 'up') await up();
else if (command === 'restart' && instances[process.argv[3]]) {
  // OpenCode 2.1.4 sometimes stops answering under load (all threads parked on
  // futexes) and OpenChamber's own restarts of it hang the same way; a fresh
  // OpenChamber process brings up a working one.
  await start(process.argv[3]);
  await waitReady(process.argv[3]);
}
else if (command === 'down') down();
else if (command) {
  console.error('usage: stack.mjs prepare|up|restart <stock|adapted>|down');
  process.exit(2);
}
