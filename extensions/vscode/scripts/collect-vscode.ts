#!/usr/bin/env bun
// Take from a compiled VS Code what the editor needs to color code the way
// VS Code does: the languages and TextMate grammars its built-in extensions
// contribute, their language configurations, and the default themes.
//
//   bun scripts/collect-vscode.ts <vscode-dir> [out-dir]
//
// <vscode-dir> is a VS Code build: the VS Code Server for the web in the dev
// container (/opt/vscode-server; `docker cp oc-forge-vscode-dev:/opt/vscode-server/extensions`
// and its package.json and product.json to a folder here), or any VS Code
// installation's resources/app. out-dir defaults to editor/vscode.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseRawGrammar } from 'vscode-textmate';
import { collectLanguages, parseJsonc, resolveTheme, type ExtensionManifest, type VscodeIndex, type VscodeThemeFile } from '../src/vscodeData.ts';

const [source, target = join(import.meta.dir, '..', 'editor', 'vscode')] = process.argv.slice(2);
if (!source) {
  console.error('Usage: bun scripts/collect-vscode.ts <vscode-dir> [out-dir]');
  process.exit(1);
}
const root = resolve(source);
const out = resolve(target);
const extensionsDir = join(root, 'extensions');
if (!existsSync(extensionsDir)) {
  console.error(`No extensions folder in ${root}`);
  process.exit(1);
}

/** The default themes the editor offers, by their label in VS Code. */
const THEMES = [
  { label: 'Dark Modern', id: 'dark-modern' },
  { label: 'Light Modern', id: 'light-modern' },
  { label: 'Dark+', id: 'dark-plus' },
  { label: 'Light+', id: 'light-plus' },
];

const readJson = <T>(path: string): T => parseJsonc(readFileSync(path, 'utf8')) as T;

const manifests: ExtensionManifest[] = [];
const dirs = new Map<ExtensionManifest, string>();
for (const name of readdirSync(extensionsDir).sort()) {
  const file = join(extensionsDir, name, 'package.json');
  if (name === 'node_modules' || !existsSync(file)) continue;
  const manifest = readJson<ExtensionManifest>(file);
  manifests.push(manifest);
  dirs.set(manifest, join(extensionsDir, name));
}

const { languages, grammars, grammarPaths, configurationPaths } = collectLanguages(manifests);

rmSync(out, { recursive: true, force: true });
for (const folder of ['grammars', 'languages', 'themes']) mkdirSync(join(out, folder), { recursive: true });

let bytes = 0;
const write = (path: string, text: string) => {
  writeFileSync(path, text);
  bytes += Buffer.byteLength(text);
};

for (const grammar of grammars) {
  const from = grammarPaths.get(grammar.scopeName)!;
  const path = join(dirs.get(from.manifest)!, from.path);
  // JSON or a plist (.tmLanguage), read as VS Code reads it; written as JSON without spaces.
  write(join(out, 'grammars', grammar.file), JSON.stringify(parseRawGrammar(readFileSync(path, 'utf8'), path)));
}
for (const [id, from] of configurationPaths) {
  try {
    write(join(out, 'languages', `${id}.json`), JSON.stringify(readJson(join(dirs.get(from.manifest)!, from.path))));
  } catch (error) {
    console.warn(`skipped the configuration of ${id}: ${error instanceof Error ? error.message : String(error)}`);
    const language = languages.find((item) => item.id === id);
    if (language) language.configuration = false;
  }
}

const themes: VscodeIndex['themes'] = [];
const defaults = manifests.find((manifest) => manifest.name === 'theme-defaults');
for (const wanted of THEMES) {
  const entry = defaults?.contributes?.themes?.find((theme) => theme.label === wanted.label || theme.id === wanted.label || theme.label?.endsWith(wanted.label));
  if (!entry?.path) continue;
  const path = join(dirs.get(defaults!)!, entry.path);
  const theme = resolveTheme(readJson<VscodeThemeFile>(path), (include) => readJson<VscodeThemeFile>(join(dirname(path), include)));
  const type = entry.uiTheme === 'vs' || theme.type === 'light' ? 'light' : 'dark';
  write(join(out, 'themes', `${wanted.id}.json`), JSON.stringify({ name: wanted.label, type, colors: theme.colors, tokenColors: theme.tokenColors }));
  themes.push({ id: wanted.id, label: wanted.label, type });
}

// Where each grammar comes from, for the notices: the extensions' component manifests.
const notices: string[] = [];
for (const manifest of manifests) {
  const file = join(dirs.get(manifest)!, 'cgmanifest.json');
  if (!existsSync(file)) continue;
  const registrations = (readJson<{ registrations?: { component?: { git?: { name?: string; repositoryUrl?: string; commitHash?: string } }; license?: string; version?: string }[] }>(file).registrations ?? []);
  for (const item of registrations) {
    const git = item.component?.git;
    if (git?.name) notices.push(`| ${manifest.name} | ${git.name} | ${git.repositoryUrl ?? ''} | ${git.commitHash?.slice(0, 12) ?? ''} | ${item.license ?? ''} |`);
  }
}

const pkg = existsSync(join(root, 'package.json')) ? readJson<{ version?: string }>(join(root, 'package.json')) : {};
const product = existsSync(join(root, 'product.json')) ? readJson<{ commit?: string }>(join(root, 'product.json')) : {};
const index: VscodeIndex = { vscode: { version: pkg.version ?? 'unknown', commit: product.commit ?? null }, languages, grammars, themes };
write(join(out, 'index.json'), `${JSON.stringify(index, null, 1)}\n`);
write(
  join(out, 'NOTICE.md'),
  [
    `# From Visual Studio Code ${index.vscode.version}${index.vscode.commit ? ` (${index.vscode.commit})` : ''}`,
    '',
    'The grammars, language configurations and themes in this folder are copied from the built-in extensions of a compiled',
    "VS Code by `scripts/collect-vscode.ts`. VS Code is MIT licensed (see LICENSE.vscode.txt when present); each grammar's own",
    'origin and license, as its extension records it:',
    '',
    '| Extension | Component | Repository | Commit | License |',
    '|---|---|---|---|---|',
    ...notices.sort(),
    '',
  ].join('\n'),
);
if (existsSync(join(root, 'LICENSE'))) write(join(out, 'LICENSE.vscode.txt'), readFileSync(join(root, 'LICENSE'), 'utf8'));
else if (existsSync(join(root, 'LICENSE.txt'))) write(join(out, 'LICENSE.vscode.txt'), readFileSync(join(root, 'LICENSE.txt'), 'utf8'));

console.log(`VS Code ${index.vscode.version}: ${languages.length} languages, ${grammars.length} grammars, ${themes.length} themes, ${(bytes / 1e6).toFixed(1)} MB in ${out}`);
