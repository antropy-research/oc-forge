// Output, at the bottom: the page's and the rail's output channels, as channels of the runtime's own ("Git (page)"),
// each following its file. Every part's extension host writes its extensions' channels to files on the server, where
// the bridge runs too (VS Code's own layout: `<its logs>/output_logging_<time>/<n>-<name>.log`, and
// `<its logs>/<extension id>/<name>.log` for log channels). The page's and the rail's bridges list theirs; the
// runtime's appends what each file gains to its channel. The bottom is the only part that shows a panel.
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import * as vscode from 'vscode';
import type { Bus } from './bus.ts';
import { follow, outputFiles, type Followed } from './outputFiles.ts';
import type { OutputSpec } from './protocol.ts';

/** How a channel names the part it came from. */
export const PART_NAMES: Readonly<Record<string, string>> = { view: 'rail', editor: 'page' };

/** The page or the rail: its channels, for the runtime (when they change, and to a runtime that joins). */
export const startOutputSource = (bus: Bus, context: vscode.ExtensionContext): void => {
  const root = path.dirname(context.logUri.fsPath);
  let last = '';
  const publish = (always: boolean): void => {
    if (!bus.has('terminal')) return;
    const list = outputFiles(root);
    const key = JSON.stringify(list);
    if (key === last && !always) return;
    last = key;
    bus.send({ type: 'output.channels', to: 'terminal', channels: list });
  };
  const timer = setInterval(() => publish(false), 3_000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
  context.subscriptions.push({ dispose: bus.onMembers(() => publish(true)).dispose });
  publish(true);
};

interface Mirrored extends Followed {
  channel: vscode.OutputChannel;
  member: string;
}

/** The runtime: a channel for each of the page's and the rail's, following its file while that part is there. */
export const startOutputMirror = (bus: Bus, context: vscode.ExtensionContext, log: (line: string) => void): void => {
  const mirrors = new Map<string, Mirrored>();
  const drop = (key: string): void => {
    mirrors.get(key)?.channel.dispose();
    mirrors.delete(key);
  };
  const pump = (): void => {
    // Its window gone (VS Code keeps the extension host a while): nothing to show.
    if (bus.away) return;
    for (const mirrored of mirrors.values()) {
      try {
        mirrored.offset = follow(mirrored, (text) => mirrored.channel.append(text), () => mirrored.channel.clear());
      } catch {
        // Gone, or not readable now: the next tick.
      }
    }
  };
  bus.on('output.channels', (message) => {
    const member = message.from?.member;
    const part = message.from?.part;
    if (!member || !part) return;
    const keep = new Set<string>();
    for (const spec of (message.channels as OutputSpec[] | undefined) ?? []) {
      const key = `${member}|${spec.file}`;
      keep.add(key);
      if (mirrors.has(key)) continue;
      const channel = vscode.window.createOutputChannel(`${spec.label} (${PART_NAMES[part] ?? part})`, spec.log ? 'log' : undefined);
      mirrors.set(key, { channel, file: spec.file, offset: 0, decoder: new StringDecoder('utf8'), member });
    }
    for (const [key, mirrored] of mirrors) if (mirrored.member === member && !keep.has(key)) drop(key);
    pump();
  });
  const timer = setInterval(pump, 1_000);
  context.subscriptions.push({
    dispose: () => {
      clearInterval(timer);
      for (const key of [...mirrors.keys()]) drop(key);
    },
  });
  // A part that left takes its channels with it.
  context.subscriptions.push({
    dispose: bus.onMembers(() => {
      const gone = [...mirrors].filter(([, mirrored]) => !bus.members.has(mirrored.member)).map(([key]) => key);
      for (const key of gone) drop(key);
      if (gone.length) log(`output: ${gone.length} channel(s) of a part that left`);
    }).dispose,
  });
};
