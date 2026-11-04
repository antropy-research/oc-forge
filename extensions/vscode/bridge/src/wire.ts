// What goes between the parts as JSON: diagnostics and document symbols.

export type WireRange = [number, number, number, number];

export interface WireDiagnostic {
  range: WireRange;
  message: string;
  severity: number;
  source?: string;
  code?: string | number | { value: string | number; target: string };
  tags?: number[];
  related?: { uri: string; range: WireRange; message: string }[];
}

/** One diagnostic as a string, to compare. */
export const diagnosticKey = (diagnostic: WireDiagnostic): string => JSON.stringify([
  diagnostic.range,
  diagnostic.message,
  diagnostic.severity,
  diagnostic.source ?? null,
  diagnostic.code ?? null,
  diagnostic.tags ?? [],
  diagnostic.related ?? [],
]);

/** `all` without one of each of `mine` (a part's own are what it sees, but what it shows for the others). */
export const subtractDiagnostics = (all: readonly WireDiagnostic[], mine: readonly WireDiagnostic[]): WireDiagnostic[] => {
  const left = new Map<string, number>();
  for (const diagnostic of mine) left.set(diagnosticKey(diagnostic), (left.get(diagnosticKey(diagnostic)) ?? 0) + 1);
  return all.filter((diagnostic) => {
    const key = diagnosticKey(diagnostic);
    const count = left.get(key) ?? 0;
    if (count === 0) return true;
    left.set(key, count - 1);
    return false;
  });
};

/** What a part's Git knows of a repository (the Git extension's `RepositoryState`, as far as compared). */
export interface GitStateData {
  readonly HEAD?: { readonly name?: string; readonly commit?: string };
  readonly indexChanges: readonly { readonly uri: { toString(): string }; readonly status: number }[];
  readonly workingTreeChanges: readonly { readonly uri: { toString(): string }; readonly status: number }[];
  readonly mergeChanges: readonly { readonly uri: { toString(): string }; readonly status: number }[];
  readonly untrackedChanges?: readonly { readonly uri: { toString(): string }; readonly status: number }[];
}

/** A repository's state as a string: the same in two parts once their Git saw the same repository. */
export const gitFingerprint = (state: GitStateData): string => JSON.stringify([
  state.HEAD?.name ?? null,
  state.HEAD?.commit ?? null,
  ...[state.indexChanges, state.workingTreeChanges, state.mergeChanges, state.untrackedChanges ?? []]
    .map((changes) => changes.map((change) => `${change.status} ${change.uri.toString()}`).sort()),
]);

export interface WireSymbol {
  name: string;
  detail: string;
  kind: number;
  range: WireRange;
  selectionRange: WireRange;
  children: WireSymbol[];
}

const contains = (outer: WireRange, line: number, character: number): boolean =>
  (line > outer[0] || (line === outer[0] && character >= outer[1])) && (line < outer[2] || (line === outer[2] && character <= outer[3]));

/** The innermost symbols around a position, outermost first (the Outline's "follow cursor"). */
export const symbolPath = (symbols: readonly WireSymbol[], line: number, character: number): WireSymbol[] => {
  for (const symbol of symbols) {
    if (!contains(symbol.range, line, character)) continue;
    return [symbol, ...symbolPath(symbol.children, line, character)];
  }
  return [];
};

/** VS Code's symbol kinds, as its codicons name them (`symbol-<name>`), by `SymbolKind` value. */
export const SYMBOL_ICONS = [
  'file', 'module', 'namespace', 'package', 'class', 'method', 'property', 'field', 'constructor', 'enum', 'interface',
  'function', 'variable', 'constant', 'string', 'number', 'boolean', 'array', 'object', 'key', 'null', 'enum-member',
  'struct', 'event', 'operator', 'type-parameter',
];
