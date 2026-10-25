import { describe, expect, test } from 'bun:test';
import { decodeEntities, parseMarkdown, safeHref, taskLines, toggleTask, type MdBlock, type MdInline } from '../panel/lib/markdown.ts';

/** Every inline node in a document, depth first. */
const inlines = (blocks: MdBlock[]): MdInline[] => {
  const out: MdInline[] = [];
  const walkInline = (nodes: MdInline[]) => {
    for (const node of nodes) {
      out.push(node);
      if ('children' in node) walkInline(node.children);
    }
  };
  const walk = (list: MdBlock[]) => {
    for (const block of list) {
      if (block.kind === 'heading' || block.kind === 'paragraph') walkInline(block.children);
      else if (block.kind === 'quote') walk(block.children);
      else if (block.kind === 'list') block.items.forEach((item) => walk(item.children));
      else if (block.kind === 'table') [...block.header, ...block.rows.flat()].forEach(walkInline);
    }
  };
  walk(blocks);
  return out;
};

const plain = (blocks: MdBlock[]): string => inlines(blocks).map((node) => (node.kind === 'text' || node.kind === 'code' ? node.text : '')).join('');

describe('Markdown is drawn from a safe tree', () => {
  test('only web and mail links survive', () => {
    expect(safeHref('https://linear.app/x')).toBe('https://linear.app/x');
    expect(safeHref(' mailto:me@example.com')).toBe('mailto:me@example.com');
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('data:text/html,<b>x</b>')).toBeNull();
    expect(safeHref('/relative')).toBeNull();
    const { blocks } = parseMarkdown('See [docs](https://example.com/docs) and [bad](javascript:alert(1)) and <https://auto.example>');
    const links = inlines(blocks).filter((node) => node.kind === 'link');
    expect(links.map((node) => node.kind === 'link' && node.href)).toEqual(['https://example.com/docs', 'https://auto.example']);
    expect(plain(blocks)).toContain('bad');
  });

  test('raw HTML stays text, inline and as a block', () => {
    const { blocks } = parseMarkdown('Hi <img src=x onerror=alert(1)> there\n\n<div onclick="x()">block</div>');
    expect(plain(blocks)).toContain('<img src=x onerror=alert(1)>');
    expect(plain(blocks)).toContain('<div onclick="x()">block</div>');
    expect(inlines(blocks).every((node) => node.kind === 'text' || node.kind === 'br')).toBe(true);
  });

  test('images become links, never loaded', () => {
    const { blocks } = parseMarkdown('![screen](https://uploads.linear.app/a.png) ![x](javascript:1)');
    expect(inlines(blocks).filter((node) => node.kind === 'image')).toEqual([
      { kind: 'image', href: 'https://uploads.linear.app/a.png', alt: 'screen' },
      { kind: 'image', href: null, alt: 'x' },
    ]);
  });

  test('structure: headings, emphasis, code, quotes, tables, breaks', () => {
    const { blocks } = parseMarkdown('### Plan\nline one\nline two\n\n**bold** _it_ ~~gone~~ `a < b` &amp; &#169;\n\n> quoted\n\n```ts\nconst x = 1 < 2;\n```\n\n| a | b |\n|---|:-:|\n| 1 | 2 |');
    expect(blocks.map((block) => block.kind)).toEqual(['heading', 'paragraph', 'paragraph', 'quote', 'code', 'table']);
    expect(blocks[0]).toMatchObject({ kind: 'heading', depth: 3 });
    expect((blocks[1] as { children: MdInline[] }).children.some((node) => node.kind === 'br')).toBe(true);
    const kinds = inlines([blocks[2]!]).map((node) => node.kind);
    expect(kinds).toEqual(expect.arrayContaining(['strong', 'em', 'del', 'code']));
    expect(plain([blocks[2]!])).toContain('a < b');
    expect(plain([blocks[2]!])).toContain('& ©');
    expect(blocks[4]).toEqual({ kind: 'code', lang: 'ts', text: 'const x = 1 < 2;' });
    expect(blocks[5]).toMatchObject({ kind: 'table', align: [null, 'center'] });
    expect(decodeEntities('&lt;b&gt; &unknown; &#0; &#x1F600;')).toBe('<b> &unknown; &#0; 😀');
  });

  test('checklist items are numbered in document order', () => {
    const doc = parseMarkdown('- [ ] one\n- [x] two\n\n> - [ ] quoted\n\n1. [ ] numbered\n   - [x] nested');
    expect(doc.tasks).toBe(5);
    const items: { checked: boolean | null; task: number | null }[] = [];
    const walk = (list: MdBlock[]) => list.forEach((block) => {
      if (block.kind === 'list') block.items.forEach((item) => { items.push({ checked: item.checked, task: item.task }); walk(item.children); });
      if (block.kind === 'quote') walk(block.children);
    });
    walk(doc.blocks);
    expect(items).toEqual([
      { checked: false, task: 0 },
      { checked: true, task: 1 },
      { checked: false, task: 2 },
      { checked: false, task: 3 },
      { checked: true, task: 4 },
    ]);
  });
});

describe('ticking a checklist item edits the right line', () => {
  const text = '- [ ] one\n- [x] two\n\n```md\n- [ ] not a task, it is code\n```\n\n> - [ ] quoted\n\n1. [ ] numbered\n   - [x] nested';
  test('lines outside code fences, in order', () => {
    expect(taskLines(text).map((line) => [line.line, line.checked])).toEqual([[0, false], [1, true], [7, false], [9, false], [10, true]]);
  });
  test('toggle each item', () => {
    expect(toggleTask(text, 0)!.split('\n')[0]).toBe('- [x] one');
    expect(toggleTask(text, 1)!.split('\n')[1]).toBe('- [ ] two');
    expect(toggleTask(text, 2)!.split('\n')[7]).toBe('> - [x] quoted');
    expect(toggleTask(text, 4)!.split('\n')[10]).toBe('   - [ ] nested');
    // The code block is untouched whatever is toggled.
    expect(toggleTask(text, 3)!.split('\n')[4]).toBe('- [ ] not a task, it is code');
    expect(toggleTask(text, 9)).toBeNull();
  });
  test('when the lines and the parsed checklist disagree, nothing changes', () => {
    // An indented code block holds a task-looking line the parser does not count.
    expect(toggleTask('Intro\n\n    - [ ] in indented code\n\n- [ ] real', 0)).toBeNull();
  });
});
