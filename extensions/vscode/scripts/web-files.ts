#!/usr/bin/env bun
// Writes service/web-files.json: the files of a VS Code Server install the
// browser loads, for a VS Code Server the service reaches only over HTTP (it
// cannot list a server's folders, only fetch named files). Run it on a VS Code
// Server for the web of the release vendors.json pins, e.g. from the dev
// container: docker cp oc-forge-vscode-dev:/opt/vscode-server /tmp/vscode-server
//            bun run web-files /tmp/vscode-server
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { clientFileName, WEB_NODE_MODULES } from '../src/clientFiles.ts';

const install = process.argv[2];
if (!install) {
  console.error('Usage: bun scripts/web-files.ts <VS Code Server install folder>');
  process.exit(1);
}
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
const wanted = files.filter((path) => clientFileName(path) !== null || path === 'out/media/codicon.ttf').sort();
const product = JSON.parse(readFileSync(join(install, 'product.json'), 'utf8')) as { commit?: string };
const version = (JSON.parse(readFileSync(join(install, 'package.json'), 'utf8')) as { version?: string }).version;
writeFileSync(join(import.meta.dir, '..', 'service', 'web-files.json'), `${JSON.stringify(wanted, null, 1)}\n`);
console.log(`service/web-files.json: ${wanted.length} files of VS Code ${version} (${product.commit?.slice(0, 8)})`);
