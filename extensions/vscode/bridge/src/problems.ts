// Problems, both ways: each part publishes the diagnostics it has of its own (its language servers' for the files the
// page shows, the runtime's task problem matchers'), and the window's other parts show them as theirs, through a
// diagnostic collection of the bridge's. The bottom's Problems view lists the page's; the page's editor marks a build
// task's; the rail's Explorer colours files with problems.
import * as vscode from 'vscode';
import type { Bus } from './bus.ts';
import { diagnosticKey, subtractDiagnostics, type WireDiagnostic } from './wire.ts';

const toWire = (diagnostic: vscode.Diagnostic): WireDiagnostic => ({
  range: [diagnostic.range.start.line, diagnostic.range.start.character, diagnostic.range.end.line, diagnostic.range.end.character],
  message: diagnostic.message,
  severity: diagnostic.severity,
  source: diagnostic.source,
  code: typeof diagnostic.code === 'object' && diagnostic.code !== null ? { value: diagnostic.code.value, target: diagnostic.code.target.toString() } : diagnostic.code,
  tags: diagnostic.tags,
  related: diagnostic.relatedInformation?.map((item) => ({ uri: item.location.uri.toString(), range: [item.location.range.start.line, item.location.range.start.character, item.location.range.end.line, item.location.range.end.character] as [number, number, number, number], message: item.message })),
});

const range = ([sl, sc, el, ec]: readonly [number, number, number, number]): vscode.Range => new vscode.Range(sl, sc, el, ec);

const fromWire = (wire: WireDiagnostic): vscode.Diagnostic => {
  const diagnostic = new vscode.Diagnostic(range(wire.range), wire.message, wire.severity as vscode.DiagnosticSeverity);
  if (wire.source !== undefined) diagnostic.source = wire.source;
  if (wire.code !== undefined) diagnostic.code = typeof wire.code === 'object' ? { value: wire.code.value, target: vscode.Uri.parse(wire.code.target) } : wire.code;
  if (wire.tags) diagnostic.tags = wire.tags as vscode.DiagnosticTag[];
  if (wire.related) diagnostic.relatedInformation = wire.related.map((item) => new vscode.DiagnosticRelatedInformation(new vscode.Location(vscode.Uri.parse(item.uri), range(item.range)), item.message));
  return diagnostic;
};

export const startProblems = (bus: Bus, context: vscode.ExtensionContext, log: (line: string) => void): void => {
  const mirrored = vscode.languages.createDiagnosticCollection('openchamber');
  context.subscriptions.push(mirrored);
  /** The others' diagnostics: member → uri → list. */
  const others = new Map<string, Map<string, WireDiagnostic[]>>();
  /** What this part last published, per uri (its key list). */
  const published = new Map<string, string>();
  const own = (uri: vscode.Uri): WireDiagnostic[] => subtractDiagnostics(vscode.languages.getDiagnostics(uri).map(toWire), (mirrored.get(uri) ?? []).map(toWire));
  const show = (uris: Iterable<string>): void => {
    for (const uri of uris) {
      const list = [...others.values()].flatMap((byUri) => byUri.get(uri) ?? []);
      mirrored.set(vscode.Uri.parse(uri), list.length ? list.map(fromWire) : undefined);
    }
  };
  const dirty = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const publish = (): void => {
    timer = null;
    const changes: { uri: string; diagnostics: WireDiagnostic[] }[] = [];
    for (const uri of dirty) {
      const list = own(vscode.Uri.parse(uri));
      const key = list.map(diagnosticKey).sort().join('\n');
      if ((published.get(uri) ?? '') === key) continue;
      if (key) published.set(uri, key);
      else published.delete(uri);
      changes.push({ uri, diagnostics: list });
    }
    dirty.clear();
    if (changes.length) bus.send({ type: 'diag.update', changes });
  };
  context.subscriptions.push(vscode.languages.onDidChangeDiagnostics((event) => {
    for (const uri of event.uris) dirty.add(uri.toString());
    timer ??= setTimeout(publish, 150);
  }));
  bus.on('diag.update', (message) => {
    const member = message.from?.member;
    if (!member) return;
    const byUri = others.get(member) ?? new Map<string, WireDiagnostic[]>();
    others.set(member, byUri);
    const changes = (message.changes as { uri: string; diagnostics: WireDiagnostic[] }[] | undefined) ?? [];
    for (const change of changes) {
      if (change.diagnostics.length) byUri.set(change.uri, change.diagnostics);
      else byUri.delete(change.uri);
    }
    show(changes.map((change) => change.uri));
  });
  bus.on('diag.all', () => vscode.languages.getDiagnostics()
    .map(([uri]) => ({ uri: uri.toString(), diagnostics: own(uri) }))
    .filter((item) => item.diagnostics.length > 0));
  // A part that joins (or rejoins) takes everyone's; a part that left takes its own with it.
  const refresh = async (): Promise<void> => {
    const members = [...bus.members.keys()].filter((member) => member !== bus.me.member);
    const gone = [...others.keys()].filter((member) => !members.includes(member));
    const touched = new Set<string>();
    for (const member of gone) {
      for (const uri of others.get(member)?.keys() ?? []) touched.add(uri);
      others.delete(member);
    }
    for (const member of members.filter((item) => !others.has(item))) {
      const all = await bus.request<{ uri: string; diagnostics: WireDiagnostic[] }[]>(member, 'diag.all', {}, 5_000).catch(() => null);
      if (!all) continue;
      const byUri = new Map(all.map((item) => [item.uri, item.diagnostics]));
      others.set(member, byUri);
      for (const uri of byUri.keys()) touched.add(uri);
    }
    show(touched);
  };
  context.subscriptions.push({ dispose: bus.onMembers(() => void refresh().catch((error) => log(`problems: ${error}`))).dispose });
  void refresh().catch((error) => log(`problems: ${error}`));
};
