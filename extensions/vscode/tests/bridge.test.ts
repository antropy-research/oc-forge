// The bridge extension's parts that need no VS Code (bridge/src) and the service's .vsix (service/bridge.ts).
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { applyDelta, BreakpointStore, diff, sameList, union, type BreakpointData } from '../bridge/src/breakpoints.ts';
import { BreakpointTracker, toMainThread, type BreakpointState, type DapMessage } from '../bridge/src/dap.ts';
import { Heartbeat } from '../bridge/src/heartbeat.ts';
import { tryLock, withLock } from '../bridge/src/lock.ts';
import { Mirror, type MirrorLink } from '../bridge/src/mirror.ts';
import { follow, outputFiles } from '../bridge/src/outputFiles.ts';
import { askVariables, editorValues, needsFront, replaceVariables, variablesIn } from '../bridge/src/variables.ts';
import { gitFingerprint, subtractDiagnostics, symbolPath, type GitStateData, type WireDiagnostic, type WireSymbol } from '../bridge/src/wire.ts';
import { BridgeBuilder, Claims, crc32, zip } from '../service/bridge.ts';
import { taskSpecOf } from '../workbench/bridge.ts';

const temporary = (): string => mkdtempSync(join(tmpdir(), 'bridge-test-'));

describe('lock', () => {
  test('one holder at a time; released, the next takes it', () => {
    const dir = temporary();
    const file = join(dir, 'a.lock');
    const release = tryLock(file);
    expect(release).not.toBeNull();
    expect(tryLock(file)).toBeNull();
    release!();
    const again = tryLock(file);
    expect(again).not.toBeNull();
    again!();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a lock whose process is gone is taken over; a released lock that isn't ours stays", () => {
    const dir = temporary();
    const file = join(dir, 'b.lock');
    // A pid no process has (Linux pids stay below 2^22).
    writeFileSync(file, '4194999');
    const release = tryLock(file);
    expect(release).not.toBeNull();
    expect(readFileSync(file, 'utf8')).toBe(String(process.pid));
    writeFileSync(file, '1');
    release!();
    expect(readFileSync(file, 'utf8')).toBe('1');
    rmSync(dir, { recursive: true, force: true });
  });

  test('withLock runs one at a time', async () => {
    const dir = temporary();
    const file = join(dir, 'c.lock');
    let inside = 0;
    let most = 0;
    await Promise.all(Array.from({ length: 6 }, () => withLock(file, async () => {
      inside++;
      most = Math.max(most, inside);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inside--;
    }, 5_000)));
    expect(most).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });
});

const bp = (line: number, extra: Partial<BreakpointData> = {}): BreakpointData => ({ key: `src|file:///a.js|${line}|0`, kind: 'source', uri: 'file:///a.js', line, character: 0, enabled: true, ...extra });

describe('breakpoints', () => {
  test('a change is what was put and what was removed; applied, it gives the new list', () => {
    const before = [bp(1), bp(2), bp(3)];
    const after = [bp(1), bp(2, { condition: 'x > 1' }), bp(4)];
    const delta = diff(before, after);
    expect(delta.put.map((item) => item.line)).toEqual([2, 4]);
    expect(delta.remove).toEqual([bp(3).key]);
    expect(sameList(applyDelta(before, delta), after)).toBe(true);
    expect(diff(after, [...after].reverse()).put).toEqual([]);
  });

  test('an empty condition is no condition', () => {
    expect(sameList([bp(1, { condition: '' })], [bp(1)])).toBe(true);
  });

  test('a union keeps every key, the last list winning', () => {
    expect(union([bp(1), bp(2, { enabled: false })], [bp(2), bp(3)]).map((item) => [item.line, item.enabled])).toEqual([[1, true], [2, true], [3, true]]);
  });

  test("the folder's file takes changes as changes: a window's change doesn't undo another's it hasn't heard of", async () => {
    const dir = temporary();
    const store = new BreakpointStore(join(dir, 'x', 'folder.breakpoints.json'));
    const first = await store.init(() => [bp(1)]);
    expect(first.created).toBe(true);
    expect((await store.init(() => [bp(9)])).list.map((item) => item.line)).toEqual([1]);
    // Window A adds 2; window B, which never heard of 2, removes 1.
    await Promise.all([store.update({ put: [bp(2)], remove: [] }), store.update({ put: [], remove: [bp(1).key] })]);
    expect(store.read()!.map((item) => item.line)).toEqual([2]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('DAP between a real session and its mirrors', () => {
  test("a request's file goes to the runtime's main thread as the server's (vscode-remote), not the browser's", () => {
    expect(toMainThread({ source: { path: '/tmp/a b.js' }, line: 3 }, '127.0.0.1:8000')).toEqual({ source: { path: 'vscode-remote://127.0.0.1:8000/tmp/a%20b.js' }, line: 3 });
    expect(toMainThread({ source: { path: '/x.js', sourceReference: 4 } }, 'h')).toEqual({ source: { path: '/x.js', sourceReference: 4 } });
    expect(toMainThread({ threadId: 1 }, 'h')).toEqual({ threadId: 1 });
    expect(toMainThread({ source: { path: 'relative.js' } }, 'h')).toEqual({ source: { path: 'relative.js' } });
  });

  test("the runtime tracks what the adapter said of each breakpoint: its answer, then its events", () => {
    const tracker = new BreakpointTracker();
    tracker.request({ type: 'request', seq: 7, command: 'setBreakpoints', arguments: { source: { path: '/a.js' }, breakpoints: [{ line: 2 }, { line: 5 }] } });
    expect(tracker.message({ type: 'response', request_seq: 7, command: 'setBreakpoints', success: true, body: { breakpoints: [{ id: 11, verified: false }, { id: 12, verified: true, line: 6 }] } })).toBe('/a.js');
    expect(tracker.statesOf('/a.js')).toEqual([{ line: 2, verified: false }, { line: 5, verified: true, actualLine: 6 }]);
    expect(tracker.message({ type: 'event', event: 'breakpoint', body: { reason: 'changed', breakpoint: { id: 11, verified: true } } })).toBe('/a.js');
    expect(tracker.statesOf('/a.js')[0]).toEqual({ line: 2, verified: true });
    expect(tracker.message({ type: 'event', event: 'breakpoint', body: { reason: 'changed', breakpoint: { id: 99, verified: true } } })).toBeNull();
  });
});

const fakeLink = (answers: Record<string, unknown> = {}) => {
  const requests: { type: string; payload: Record<string, unknown> }[] = [];
  const sent: { type: string; payload: Record<string, unknown> }[] = [];
  const link: MirrorLink = {
    request: async <T>(type: string, payload: Record<string, unknown>) => {
      requests.push({ type, payload });
      const answer = answers[type];
      if (answer instanceof Error) throw answer;
      return (typeof answer === 'function' ? (answer as (p: Record<string, unknown>) => unknown)(payload) : answer) as T;
    },
    send: (type, payload) => void sent.push({ type, payload }),
  };
  return { link, requests, sent };
};

const mirrorOf = (answers: Record<string, unknown>, states: Record<string, BreakpointState[]> = {}) => {
  const fake = fakeLink(answers);
  const mirror = new Mirror(fake.link, 'real-1', (file) => states[file]);
  const out: DapMessage[] = [];
  mirror.onDidSendMessage((message) => void out.push(message));
  let seq = 1;
  const ask = async (command: string, args: Record<string, unknown> = {}): Promise<DapMessage> => {
    const request = { type: 'request', seq: seq++, command, arguments: args };
    await mirror.handleMessage(request);
    return out.findLast((message) => message.type === 'response' && message.request_seq === request.seq)!;
  };
  return { mirror, out, ask, ...fake };
};

describe('mirror', () => {
  test("starts as the real session: its capabilities (and a restart, a terminate), then initialized; the paused threads once configured", async () => {
    const { ask, out, requests } = mirrorOf({ 'dap.caps': { supportsEvaluateForHovers: true }, 'dap.state': { stopped: [{ reason: 'breakpoint', threadId: 1 }] } });
    const init = await ask('initialize', { adapterID: 'openchamber-mirror' });
    expect(init.success).toBe(true);
    expect(init.body).toMatchObject({ supportsEvaluateForHovers: true, supportsConfigurationDoneRequest: true, supportsTerminateRequest: true, supportsRestartRequest: true });
    expect(out.some((message) => message.event === 'initialized')).toBe(true);
    expect((await ask('launch')).success).toBe(true);
    await ask('configurationDone');
    expect(out.filter((message) => message.event === 'stopped').map((message) => message.body)).toEqual([{ reason: 'breakpoint', threadId: 1 }]);
    expect(requests.map((request) => request.type)).toEqual(['dap.caps', 'dap.state']);
  });

  test('a session that ended answers its start with an error', async () => {
    const { ask } = mirrorOf({ 'dap.caps': null });
    const init = await ask('initialize');
    expect(init.success).toBe(false);
  });

  test("its breakpoints are the folder's: each keeps its id, and says what the real adapter said of it, then what changes", async () => {
    const states: Record<string, BreakpointState[]> = { '/a.js': [{ line: 3, verified: true }, { line: 7, verified: false }] };
    const { mirror, ask, out, requests } = mirrorOf({}, states);
    const first = await ask('setBreakpoints', { source: { path: '/a.js' }, breakpoints: [{ line: 3 }, { line: 7 }] });
    const [three, seven] = first.body!.breakpoints as { id: number; verified: boolean; line: number }[];
    expect([three!.verified, seven!.verified]).toEqual([true, false]);
    const again = await ask('setBreakpoints', { source: { path: '/a.js' }, breakpoints: [{ line: 7 }, { line: 9 }] });
    const ids = (again.body!.breakpoints as { id: number }[]).map((item) => item.id);
    expect(ids[0]).toBe(seven!.id);
    expect(ids[1]).not.toBe(three!.id);
    mirror.breakpointStates('/a.js', [{ line: 7, verified: true, actualLine: 8 }, { line: 9, verified: false }]);
    const events = out.filter((message) => message.event === 'breakpoint');
    expect(events.map((message) => message.body)).toEqual([{ reason: 'changed', breakpoint: { id: seven!.id, verified: true, line: 8 } }]);
    mirror.breakpointStates('/a.js', [{ line: 7, verified: true, actualLine: 8 }]);
    expect(out.filter((message) => message.event === 'breakpoint')).toHaveLength(1);
    expect(requests).toEqual([]);
  });

  test("exception filters: its own as it starts; the user's changes after, the real session's", async () => {
    const { ask, requests } = mirrorOf({ 'dap.caps': {}, 'dap.state': { stopped: [] }, 'dap.request': {} });
    await ask('initialize');
    await ask('setExceptionBreakpoints', { filters: ['all'] });
    expect(requests.filter((request) => request.type === 'dap.request')).toEqual([]);
    await ask('configurationDone');
    await ask('setExceptionBreakpoints', { filters: [] });
    expect(requests.filter((request) => request.type === 'dap.request').map((request) => request.payload.command)).toEqual(['setExceptionBreakpoints']);
  });

  test('everything else goes to the real session; its error comes back as one', async () => {
    const { ask, requests } = mirrorOf({ 'dap.request': (payload: Record<string, unknown>) => (payload.command === 'evaluate' ? { result: '42' } : Promise.reject(new Error('that debug session ended'))) });
    expect((await ask('evaluate', { expression: 'x' })).body).toEqual({ result: '42' });
    const failed = await ask('stackTrace', { threadId: 1 });
    expect(failed.success).toBe(false);
    expect(failed.message).toBe('that debug session ended');
    expect(requests.map((request) => request.payload)).toEqual([{ realId: 'real-1', command: 'evaluate', args: { expression: 'x' } }, { realId: 'real-1', command: 'stackTrace', args: { threadId: 1 } }]);
  });

  test("Stop stops the real session and waits for its end; a window closing disconnects without stopping it", async () => {
    const stop = mirrorOf({});
    await stop.ask('terminate', {});
    expect(stop.sent).toEqual([{ type: 'session.stop', payload: { realId: 'real-1' } }]);
    expect(stop.mirror.ended).toBe(false);
    stop.mirror.event('terminated');
    expect(stop.mirror.ended).toBe(true);
    await stop.ask('disconnect', { terminateDebuggee: false });
    expect(stop.sent).toHaveLength(1);
    stop.mirror.event('stopped', { threadId: 1 });
    expect(stop.out.filter((message) => message.event === 'stopped')).toEqual([]);

    const closing = mirrorOf({});
    await closing.ask('disconnect', {});
    expect(closing.sent).toEqual([]);
    const user = mirrorOf({});
    await user.ask('disconnect', { restart: false, terminateDebuggee: true });
    expect(user.sent.map((item) => item.type)).toEqual(['session.stop']);
  });

  test("Restart is VS Code's restart of the real session, in the runtime", async () => {
    const { ask, requests } = mirrorOf({ 'session.restart': true });
    expect((await ask('restart', { arguments: {} })).success).toBe(true);
    expect(requests).toEqual([{ type: 'session.restart', payload: { realId: 'real-1' } }]);
  });
});

describe('launch variables resolved where the user is', () => {
  test('which a configuration names, and which need the page or the user', () => {
    const config = { program: '${file}', args: ['${input:mode}', '${env:HOME}'], cwd: '${workspaceFolder}', pid: '${command:PickProcess}' };
    const names = variablesIn(config);
    expect([...names].sort()).toEqual(['command:PickProcess', 'env:HOME', 'file', 'input:mode', 'workspaceFolder']);
    expect(needsFront(names)).toEqual({ editor: true, ask: true });
    expect(needsFront(['workspaceFolder', 'env:HOME'])).toEqual({ editor: false, ask: false });
  });

  test("the editor's values, and only the variables given are replaced", () => {
    const values = editorValues({ file: '/w/src/app.test.js', folder: '/w', line: 4, column: 2, selectedText: 'x' });
    expect(Object.fromEntries(values)).toMatchObject({ file: '/w/src/app.test.js', fileBasename: 'app.test.js', fileBasenameNoExtension: 'app.test', fileExtname: '.js', fileDirname: '/w/src', relativeFile: 'src/app.test.js', relativeFileDirname: 'src', lineNumber: '4', fileWorkspaceFolderBasename: 'w' });
    expect(replaceVariables({ a: ['${file}', '${workspaceFolder}'] }, values)).toEqual({ a: ['/w/src/app.test.js', '${workspaceFolder}'] });
  });

  test('inputs and commands are asked once each, in order; a cancel aborts', async () => {
    const asked: string[] = [];
    const asker = {
      prompt: async (input: { id: string }) => (asked.push(`prompt:${input.id}`), 'typed'),
      pick: async (input: { id: string }) => (asked.push(`pick:${input.id}`), 'picked'),
      command: async (id: string) => (asked.push(`command:${id}`), id === 'cancel' ? undefined : 1234),
    };
    const inputs = [{ id: 'name', type: 'promptString' as const }, { id: 'mode', type: 'pickString' as const, options: ['a', 'b'] }];
    const values = await askVariables(['input:name', 'input:mode', 'command:PickProcess', 'input:name', 'workspaceFolder'], inputs, asker, {}, { PickProcess: 'js.pick' });
    expect(Object.fromEntries(values!)).toEqual({ 'input:name': 'typed', 'input:mode': 'picked', 'command:PickProcess': '1234' });
    expect(asked).toEqual(['prompt:name', 'pick:mode', 'command:js.pick']);
    expect(await askVariables(['command:cancel'], [], asker, {})).toBeNull();
    await expect(askVariables(['input:missing'], [], asker, {})).rejects.toThrow('missing');
  });
});

describe('what goes between the parts', () => {
  test("a part's own diagnostics: what it sees without one of each it shows for the others", () => {
    const d = (message: string): WireDiagnostic => ({ range: [0, 0, 0, 1], message, severity: 0 });
    expect(subtractDiagnostics([d('a'), d('a'), d('b')], [d('a')]).map((item) => item.message)).toEqual(['a', 'b']);
    expect(subtractDiagnostics([d('a')], [d('c')]).map((item) => item.message)).toEqual(['a']);
  });

  test("a repository's state, compared across parts: the same once both parts' Git saw the same repository", () => {
    const change = (path: string, status: number) => ({ uri: { toString: () => `file:///w/${path}` }, status });
    const state = (index: ReturnType<typeof change>[], head = 'abc'): GitStateData => ({ HEAD: { name: 'main', commit: head }, indexChanges: index, workingTreeChanges: [change('b.js', 5)], mergeChanges: [] });
    expect(gitFingerprint(state([change('a.js', 0), change('c.js', 0)]))).toBe(gitFingerprint(state([change('c.js', 0), change('a.js', 0)])));
    expect(gitFingerprint(state([change('a.js', 0)]))).not.toBe(gitFingerprint(state([])));
    expect(gitFingerprint(state([], 'abc'))).not.toBe(gitFingerprint(state([], 'def')));
  });

  test("the Outline follows the cursor to the innermost symbol around it", () => {
    const s = (name: string, range: [number, number, number, number], children: WireSymbol[] = []): WireSymbol => ({ name, detail: '', kind: 4, range, selectionRange: range, children });
    const tree = [s('A', [0, 0, 10, 0], [s('m', [2, 0, 4, 0]), s('n', [5, 0, 8, 0])]), s('B', [11, 0, 20, 0])];
    expect(symbolPath(tree, 6, 3).map((item) => item.name)).toEqual(['A', 'n']);
    expect(symbolPath(tree, 10, 5).map((item) => item.name)).toEqual([]);
    expect(symbolPath(tree, 12, 0).map((item) => item.name)).toEqual(['B']);
  });
});

describe("Output: the page's and the rail's channels, followed at the bottom", () => {
  test("an extension host's channels: its plain ones and its extensions' log ones, with something in them", () => {
    const root = temporary();
    mkdirSync(join(root, 'output_logging_20261030T101010'));
    writeFileSync(join(root, 'output_logging_20261030T101010', '1-Tasks.log'), 'ran\n');
    writeFileSync(join(root, 'output_logging_20261030T101010', '2-Empty.log'), '');
    mkdirSync(join(root, 'vscode.git'));
    writeFileSync(join(root, 'vscode.git', 'Git.log'), '2026-10-30 10:10:10.000 [info] ok\n');
    writeFileSync(join(root, 'vscode.git', 'notes.txt'), 'x');
    mkdirSync(join(root, 'tsserver-logs'));
    writeFileSync(join(root, 'tsserver-logs', 'a.log'), 'x');
    writeFileSync(join(root, 'remoteexthost.log'), 'x');
    expect(outputFiles(root).map(({ label, log }) => [label, log])).toEqual([['Git', true], ['Tasks', false]]);
    expect(outputFiles(join(root, 'missing'))).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  test('a file followed: what it gains, a character cut between two reads whole, and from the start again when cut', () => {
    const root = temporary();
    const file = join(root, 'a.log');
    writeFileSync(file, 'one\n');
    const followed = { file, offset: 0, decoder: new StringDecoder('utf8') };
    let shown = '';
    const append = (text: string): void => {
      shown += text;
    };
    const clear = (): void => {
      shown = '';
    };
    followed.offset = follow(followed, append, clear);
    expect(shown).toBe('one\n');
    const euro = Buffer.from('€', 'utf8');
    appendFileSync(file, Buffer.concat([Buffer.from('two '), euro.subarray(0, 1)]));
    followed.offset = follow(followed, append, clear);
    appendFileSync(file, Buffer.concat([euro.subarray(1), Buffer.from('\n')]));
    followed.offset = follow(followed, append, clear);
    expect(shown).toBe('one\ntwo €\n');
    expect(follow(followed, append, clear)).toBe(followed.offset);
    truncateSync(file, 0);
    appendFileSync(file, 'three\n');
    followed.offset = follow(followed, append, clear);
    expect(shown).toBe('three\n');
    rmSync(root, { recursive: true, force: true });
  });
});

describe('heartbeat', () => {
  const clock = () => {
    let now = 0;
    const timers: { at: number; fn: () => void }[] = [];
    return {
      now: () => now,
      setTimer: (fn: () => void, ms: number) => {
        timers.push({ at: now + ms, fn });
        return timers.length;
      },
      clearTimer: () => undefined,
      advance: async (ms: number) => {
        const end = now + ms;
        for (;;) {
          timers.sort((a, b) => a.at - b.at);
          const next = timers[0];
          if (!next || next.at > end) break;
          timers.shift();
          now = next.at;
          next.fn();
          await Promise.resolve();
        }
        now = end;
      },
    };
  };

  test("a window that doesn't answer is away; one question waits at a time; it asks less often; the answer brings it back", async () => {
    const time = clock();
    let answer: (() => void) | null = null;
    let away = 0;
    let back = 0;
    const beat = new Heartbeat({
      ping: () => new Promise<void>((resolve) => {
        answer = resolve;
      }),
      onAway: () => away++,
      onBack: () => back++,
      everyMs: 2_000,
      timeoutMs: 3_000,
      maxAwayMs: 16_000,
      ...time,
    });
    beat.start();
    await time.advance(2_000);
    expect(beat.pings).toBe(1);
    await time.advance(10_000);
    expect(away).toBe(1);
    expect(beat.away).toBe(true);
    // Away for minutes: still the one question.
    await time.advance(240_000);
    expect(beat.pings).toBe(1);
    answer!();
    await Promise.resolve();
    await Promise.resolve();
    expect(back).toBe(1);
    expect(beat.away).toBe(false);
    beat.stop();
  });

  test('a window that answers stays; an error is an answer', async () => {
    const time = clock();
    let away = 0;
    const beat = new Heartbeat({ ping: () => Promise.reject(new Error('no command')), onAway: () => away++, onBack: () => undefined, ...time });
    beat.start();
    await time.advance(20_000);
    expect(away).toBe(0);
    expect(beat.pings).toBeGreaterThanOrEqual(9);
    beat.stop();
  });
});

describe("the service's bridge package", () => {
  test('crc32 and a zip that unzip reads', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    const dir = temporary();
    const file = join(dir, 'a.zip');
    writeFileSync(file, zip([{ name: 'a/b.txt', data: new TextEncoder().encode('hello') }, { name: 'c.json', data: new TextEncoder().encode('{}') }]));
    const listed = execFileSync('unzip', ['-l', file], { encoding: 'utf8' });
    expect(listed).toContain('a/b.txt');
    expect(listed).toContain('c.json');
    expect(execFileSync('unzip', ['-p', file, 'a/b.txt'], { encoding: 'utf8' })).toBe('hello');
    rmSync(dir, { recursive: true, force: true });
  });

  test('the .vsix: the manifest with its build, the bundle, the same bytes each time', () => {
    const root = temporary();
    mkdirSync(join(root, 'bridge'), { recursive: true });
    writeFileSync(join(root, 'bridge', 'package.json'), JSON.stringify({ name: 'openchamber-bridge', publisher: 'openchamber', version: '1.2.3', displayName: 'B', description: 'd & <e>', engines: { vscode: '^1.90.0' }, extensionKind: ['workspace'] }));
    writeFileSync(join(root, 'bridge', 'main.js'), 'exports.activate = () => {};\n');
    const builder = new BridgeBuilder(root);
    const pkg = builder.package();
    expect(pkg).toMatchObject({ id: 'openchamber.openchamber-bridge', version: '1.2.3' });
    expect(pkg.build).toMatch(/^[0-9a-f]{16}$/);
    expect(new BridgeBuilder(root).package().vsix).toBe(pkg.vsix);
    const file = join(root, 'b.vsix');
    writeFileSync(file, Buffer.from(pkg.vsix, 'base64'));
    const manifest = JSON.parse(execFileSync('unzip', ['-p', file, 'extension/package.json'], { encoding: 'utf8' })) as { openchamberBuild: string };
    expect(manifest.openchamberBuild).toBe(pkg.build);
    expect(execFileSync('unzip', ['-p', file, 'extension.vsixmanifest'], { encoding: 'utf8' })).toContain('d &#38; &#60;e&#62;');
    rmSync(root, { recursive: true, force: true });
  });

  test('one claim per key at a time', () => {
    let now = 0;
    const claims = new Claims(1_000, () => now);
    expect(claims.claim('a')).toBe(true);
    expect(claims.claim('a')).toBe(false);
    expect(claims.claim('b')).toBe(true);
    now = 1_000;
    expect(claims.claim('a')).toBe(true);
  });
});

describe("the frame's catch of a task", () => {
  test('a task as the runtime finds it again: label, source and definition without VS Code key', () => {
    const task = { _label: 'build', _source: { label: 'npm' }, getDefinition: () => ({ _key: 'npm,build', type: 'npm', script: 'build' }) };
    expect(taskSpecOf(task)).toEqual({ label: 'build', source: 'npm', definition: { type: 'npm', script: 'build' }, definitionType: 'npm' });
    expect(taskSpecOf({ _label: 'echo', _source: { label: 'Workspace' }, getDefinition: () => ({ type: 'shell' }) })!.definitionType).toBeUndefined();
  });
});
