// Markdown (Linear's issue descriptions and comments) → a small tree the panel
// draws with plain elements. Raw HTML shows as text, links keep only http(s)
// and mailto, and images become links: nothing from an issue reaches innerHTML.
import { lexer, type Token, type Tokens } from 'marked';

export type MdInline =
  | { kind: 'text'; text: string }
  | { kind: 'strong' | 'em' | 'del'; children: MdInline[] }
  | { kind: 'code'; text: string }
  | { kind: 'link'; href: string; children: MdInline[] }
  | { kind: 'image'; href: string | null; alt: string }
  | { kind: 'br' };

export interface MdItem {
  /** A checklist item's state; null for a plain item. */
  checked: boolean | null;
  /** Checklist items count in document order, for toggling. */
  task: number | null;
  children: MdBlock[];
}

export type MdBlock =
  | { kind: 'heading'; depth: number; children: MdInline[] }
  | { kind: 'paragraph'; children: MdInline[] }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'quote'; children: MdBlock[] }
  | { kind: 'list'; ordered: boolean; start: number; items: MdItem[] }
  | { kind: 'table'; align: ('left' | 'center' | 'right' | null)[]; header: MdInline[][]; rows: MdInline[][][] }
  | { kind: 'hr' };

export interface MdDocument {
  blocks: MdBlock[];
  /** Checklist items found. */
  tasks: number;
}

/** Links the panel may open: web pages and mail. */
export const safeHref = (href: string | null | undefined): string | null => {
  const value = (href ?? '').trim();
  return /^(https?:\/\/|mailto:)/i.test(value) ? value : null;
};

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Decode the character references Markdown text may hold (&amp;, &#169;, &#x2014;). */
export const decodeEntities = (text: string): string =>
  text.replace(/&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[A-Za-z]{2,8});/g, (match, name: string) => {
    if (name[0] !== '#') return NAMED[name.toLowerCase()] ?? match;
    const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : match;
  });

const textOf = (tokens: Token[] | undefined): string =>
  (tokens ?? []).map((token) => ('tokens' in token && token.tokens ? textOf(token.tokens) : 'text' in token ? String(token.text) : '')).join('');

const inline = (tokens: Token[] | undefined): MdInline[] => {
  const out: MdInline[] = [];
  for (const token of tokens ?? []) {
    switch (token.type) {
      case 'text':
        if ('tokens' in token && token.tokens?.length) out.push(...inline(token.tokens));
        else out.push({ kind: 'text', text: decodeEntities((token as Tokens.Text).text) });
        break;
      case 'escape':
        out.push({ kind: 'text', text: (token as Tokens.Escape).text });
        break;
      case 'strong':
      case 'em':
      case 'del':
        out.push({ kind: token.type, children: inline((token as Tokens.Strong).tokens) });
        break;
      case 'codespan':
        out.push({ kind: 'code', text: (token as Tokens.Codespan).text });
        break;
      case 'link': {
        const link = token as Tokens.Link;
        const href = safeHref(link.href);
        const children = inline(link.tokens);
        if (href) out.push({ kind: 'link', href, children });
        else out.push(...children);
        break;
      }
      case 'image': {
        const image = token as Tokens.Image;
        out.push({ kind: 'image', href: safeHref(image.href), alt: image.text || 'image' });
        break;
      }
      case 'br':
        out.push({ kind: 'br' });
        break;
      case 'checkbox':
        break;
      default:
        // Inline HTML and anything unknown stay visible as their own text.
        out.push({ kind: 'text', text: 'raw' in token ? String(token.raw) : '' });
    }
  }
  return out;
};

const blocks = (tokens: Token[], counter: { tasks: number }): MdBlock[] => {
  const out: MdBlock[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case 'space':
      case 'def':
        break;
      case 'heading': {
        const heading = token as Tokens.Heading;
        out.push({ kind: 'heading', depth: Math.min(6, Math.max(1, heading.depth)), children: inline(heading.tokens) });
        break;
      }
      case 'paragraph':
      case 'text':
        out.push({ kind: 'paragraph', children: 'tokens' in token && token.tokens ? inline(token.tokens) : [{ kind: 'text', text: decodeEntities(String((token as Tokens.Text).text)) }] });
        break;
      case 'code': {
        const code = token as Tokens.Code;
        out.push({ kind: 'code', lang: code.lang ?? '', text: code.text });
        break;
      }
      case 'blockquote':
        out.push({ kind: 'quote', children: blocks((token as Tokens.Blockquote).tokens, counter) });
        break;
      case 'list': {
        const list = token as Tokens.List;
        const start = typeof list.start === 'number' ? list.start : 1;
        out.push({
          kind: 'list',
          ordered: list.ordered,
          start,
          items: list.items.map((item) => {
            const task = item.task ? counter.tasks++ : null;
            return { checked: item.task ? Boolean(item.checked) : null, task, children: blocks(item.tokens.filter((child) => child.type !== 'checkbox'), counter) };
          }),
        });
        break;
      }
      case 'table': {
        const table = token as Tokens.Table;
        out.push({
          kind: 'table',
          align: table.align.map((value) => (value === 'left' || value === 'center' || value === 'right' ? value : null)),
          header: table.header.map((cell) => inline(cell.tokens)),
          rows: table.rows.map((row) => row.map((cell) => inline(cell.tokens))),
        });
        break;
      }
      case 'hr':
        out.push({ kind: 'hr' });
        break;
      default:
        // Block HTML and anything unknown show as text, never as markup.
        out.push({ kind: 'paragraph', children: [{ kind: 'text', text: 'raw' in token ? String(token.raw).trim() : textOf([token]) }] });
    }
  }
  return out;
};

/** Parse GitHub-flavored Markdown; single newlines are line breaks, as in Linear and GitHub comments. */
export const parseMarkdown = (text: string): MdDocument => {
  const counter = { tasks: 0 };
  const result = blocks(lexer(text, { gfm: true, breaks: true }), counter);
  return { blocks: result, tasks: counter.tasks };
};

const FENCE = /^(?:[ \t]*>)*[ \t]{0,3}(`{3,}|~{3,})/;
const TASK = /^((?:[ \t]*>)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[)([ xX])(\](?=[ \t]))/;

/** Checklist lines outside fenced code, as `[line, checked]`, in document order. */
export const taskLines = (text: string): { line: number; checked: boolean }[] => {
  const out: { line: number; checked: boolean }[] = [];
  let fence: string | null = null;
  text.split('\n').forEach((line, index) => {
    const marker = FENCE.exec(line)?.[1];
    if (marker) {
      if (fence === null) fence = marker[0]!;
      else if (marker[0] === fence) fence = null;
      return;
    }
    if (fence !== null) return;
    const match = TASK.exec(line);
    if (match) out.push({ line: index, checked: match[2] !== ' ' });
  });
  return out;
};

/**
 * Tick or untick the `index`-th checklist item. Null when the lines do not line
 * up with the parsed checklist, so a click never edits the wrong line.
 */
export const toggleTask = (text: string, index: number): string | null => {
  const lines = taskLines(text);
  if (lines.length !== parseMarkdown(text).tasks || !lines[index]) return null;
  const all = text.split('\n');
  const target = lines[index]!;
  all[target.line] = all[target.line]!.replace(TASK, (_match, before: string, _mark: string, after: string) => `${before}${target.checked ? ' ' : 'x'}${after}`);
  return all.join('\n');
};
