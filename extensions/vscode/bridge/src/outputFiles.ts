// The output channels' files of an extension host on the server, and following one as it grows (see output.ts).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { OutputSpec } from './protocol.ts';

/** At most this much of a long file the first time: its end. */
const FIRST_READ_MAX = 1 << 20;

/** The output channels' files in an extension host's log folder, with something in them. */
export const outputFiles = (root: string): OutputSpec[] => {
  const found: OutputSpec[] = [];
  const add = (file: string, label: string, log: boolean): void => {
    try {
      if (fs.statSync(file).size > 0) found.push({ label, file, log });
    } catch {
      // Gone meanwhile.
    }
  };
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const plain = entry.name.startsWith('output_logging_');
    // An extension's own folder is named by its id (`publisher.name`).
    if (!plain && !/^[^.]+\.[^.]+$/.test(entry.name)) continue;
    const dir = path.join(root, entry.name);
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.log')) continue;
      if (!plain) add(path.join(dir, name), name.slice(0, -'.log'.length), true);
      else {
        const match = /^\d+-(.+)\.log$/.exec(name);
        if (match) add(path.join(dir, name), match[1]!, false);
      }
    }
  }
  return found.sort((a, b) => a.label.localeCompare(b.label) || a.file.localeCompare(b.file));
};

/** A file a channel follows: how much of it the channel has. */
export interface Followed {
  file: string;
  offset: number;
  decoder: StringDecoder;
}

/** Appends what `file` gained since `offset`: the new offset (0 again when the file was cut, after clearing). */
export const follow = (mirrored: Followed, append: (text: string) => void, clear: () => void): number => {
  const size = fs.statSync(mirrored.file).size;
  let offset = mirrored.offset;
  if (size < offset) {
    clear();
    offset = 0;
    mirrored.decoder = new StringDecoder('utf8');
  }
  if (size === offset) return offset;
  const start = offset === 0 && size > FIRST_READ_MAX ? size - FIRST_READ_MAX : offset;
  const buffer = Buffer.alloc(size - start);
  const fd = fs.openSync(mirrored.file, 'r');
  try {
    fs.readSync(fd, buffer, 0, buffer.length, start);
  } finally {
    fs.closeSync(fd);
  }
  append(mirrored.decoder.write(buffer));
  return size;
};
