// The folder's breakpoints in each part, through the stable breakpoints API: a change in one part goes to the
// window's other parts (`bp.delta`) and into the folder's file; a part that joins takes the file's list.
import * as vscode from 'vscode';
import type { Bus } from './bus.ts';
import { applyDelta, diff, functionKey, isEmpty, sorted, sourceKey, union, type BreakpointData, type BreakpointStore, type Delta } from './breakpoints.ts';

const dataOf = (bp: vscode.Breakpoint): BreakpointData | null => {
  const common = {
    enabled: bp.enabled,
    condition: bp.condition || undefined,
    hitCondition: bp.hitCondition || undefined,
    logMessage: bp.logMessage || undefined,
  };
  if (bp instanceof vscode.SourceBreakpoint) {
    const { uri, range } = bp.location;
    return { key: sourceKey(uri.toString(), range.start.line, range.start.character), kind: 'source', uri: uri.toString(), line: range.start.line, character: range.start.character, ...common };
  }
  if (bp instanceof vscode.FunctionBreakpoint) return { key: functionKey(bp.functionName), kind: 'function', functionName: bp.functionName, ...common };
  return null;
};

const breakpointOf = (data: BreakpointData): vscode.Breakpoint => (data.kind === 'source'
  ? new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.parse(data.uri ?? ''), new vscode.Position(data.line ?? 0, data.character ?? 0)), data.enabled, data.condition, data.hitCondition, data.logMessage)
  : new vscode.FunctionBreakpoint(data.functionName ?? '', data.enabled, data.condition, data.hitCondition, data.logMessage));

export interface BreakpointSync extends vscode.Disposable {
  /** Takes the folder's list (the file's, or the first time what every part has). */
  join(): Promise<void>;
}

export const syncBreakpoints = (bus: Bus, store: BreakpointStore, log: (line: string) => void): BreakpointSync => {
  const local = (): BreakpointData[] => sorted(vscode.debug.breakpoints.map(dataOf).filter((data): data is BreakpointData => data !== null));
  let known = local();
  let applying = false;
  /** Makes this part's breakpoints `list`. */
  const apply = (list: readonly BreakpointData[]): void => {
    const target = new Map(list.map((item) => [item.key, item]));
    const have = vscode.debug.breakpoints.map((bp) => ({ bp, data: dataOf(bp) })).filter((item): item is { bp: vscode.Breakpoint; data: BreakpointData } => item.data !== null);
    const delta = diff(have.map((item) => item.data), list);
    const changed = new Set(delta.put.map((item) => item.key));
    const remove = have.filter((item) => !target.has(item.data.key) || changed.has(item.data.key)).map((item) => item.bp);
    applying = true;
    try {
      if (remove.length) vscode.debug.removeBreakpoints(remove);
      if (delta.put.length) vscode.debug.addBreakpoints(delta.put.map(breakpointOf));
    } finally {
      applying = false;
    }
    known = local();
  };
  const disposable = vscode.debug.onDidChangeBreakpoints(() => {
    if (applying) return;
    const now = local();
    const delta = diff(known, now);
    if (isEmpty(delta)) return;
    known = now;
    bus.send({ type: 'bp.delta', delta });
    void store.update(delta).catch((error) => log(`could not keep the folder's breakpoints: ${error}`));
  });
  bus.on('bp.delta', (message) => apply(applyDelta(local(), message.delta as Delta)));
  bus.on('bp.ask', () => local());
  return {
    dispose: () => disposable.dispose(),
    join: async () => {
      const { list, created } = await store.init(async () => union(...(await bus.gather<BreakpointData[]>('bp.ask')), local()));
      apply(list);
      if (created) bus.send({ type: 'bp.delta', delta: { put: list, remove: [] } satisfies Delta });
    },
  };
};
