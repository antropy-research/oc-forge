#!/usr/bin/env bun
// Writes service/web-files.json: the files of a VS Code Server install the
// browser loads, for a VS Code Server the service reaches only over HTTP (it
// cannot list a server's folders, only fetch named files). Run it on a VS Code
// Server for the web of the release vendors.json pins and on one of the
// release before it: the list is both releases' files, so a server one
// release behind still gets all of its own (a file another release lacks is
// skipped when that server answers 404). E.g. from Microsoft's builds:
//            bun run web-files /tmp/vscode-server-1.144.0 /tmp/vscode-server-1.143.1
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { clientFileName, WEB_NODE_MODULES } from '../src/clientFiles.ts';

const installs = process.argv.slice(2);
if (installs.length === 0) {
  console.error('Usage: bun scripts/web-files.ts <VS Code Server install folder>...');
  process.exit(1);
}
const filesOf = (install: string): string[] => {
  const files: string[] = [];
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(relative(install, path));
    }
  };
  walk(join(install, 'out'));
  for (const module of WEB_NODE_MODULES) walk(join(install, 'node_modules', module));
  // The font is inlined into the stylesheet, so it is fetched although it is not served.
  return files.filter((path) => clientFileName(path) !== null || path === 'out/media/codicon.ttf');
};
const each = installs.map((install) => {
  const product = JSON.parse(readFileSync(join(install, 'product.json'), 'utf8')) as { commit?: string };
  const version = (JSON.parse(readFileSync(join(install, 'package.json'), 'utf8')) as { version?: string }).version;
  return { name: `VS Code ${version} (${product.commit?.slice(0, 8)})`, files: filesOf(install) };
});
const wanted = [...new Set(each.flatMap((install) => install.files))].sort();
writeFileSync(join(import.meta.dir, '..', 'service', 'web-files.json'), `${JSON.stringify(wanted, null, 1)}\n`);
console.log(`service/web-files.json: ${wanted.length} files, of ${each.map((install) => `${install.name}: ${install.files.length}`).join('; ')}`);
