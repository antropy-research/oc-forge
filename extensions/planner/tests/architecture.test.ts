// The Planner's layers hold one way (README, "Architecture"): the domain is pure and shared, the service and the panel
// build on it and never on each other, and the panel's state never reaches into its components. A check of the
// imports, so the structure stays as clear as it is.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

const root = join(import.meta.dir, '..');
const sources = (dir: string): string[] =>
  readdirSync(join(root, dir)).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules') return [];
    if (statSync(join(root, path)).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
/** The files a source imports, by their path from the extension's root. */
const importsOf = (file: string): string[] =>
  [...readFileSync(join(root, file), 'utf8').matchAll(/(?:\bfrom|\bimport)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)].map((match) => normalize(join(dirname(file), match[1]!)));
const files = ['src', 'service', 'panel'].flatMap(sources);

const rules: Array<{ rule: string; broken: (file: string, target: string) => boolean }> = [
  { rule: 'the domain imports only the domain', broken: (file, target) => file.startsWith('src/domain/') && !target.startsWith('src/domain/') },
  { rule: 'the service never imports the panel', broken: (file, target) => file.startsWith('service/') && target.startsWith('panel/') },
  { rule: 'the panel never imports the service', broken: (file, target) => file.startsWith('panel/') && target.startsWith('service/') },
  { rule: "the panel's state never imports its components", broken: (file, target) => file.startsWith('panel/lib/') && target.startsWith('panel/components/') },
  {
    rule: "the domain's core imports no feature, but its events, which check every feature's commands",
    broken: (file, target) => file.startsWith('src/domain/core/') && file !== 'src/domain/core/events.ts' && target.startsWith('src/domain/') && !target.startsWith('src/domain/core/'),
  },
];

describe('the layers', () => {
  for (const { rule, broken } of rules) {
    test(rule, () => {
      const breaking = files.flatMap((file) => importsOf(file).filter((target) => broken(file, target)).map((target) => `${file} -> ${target}`));
      expect(breaking).toEqual([]);
    });
  }
});
