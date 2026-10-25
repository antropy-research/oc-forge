import type { ComponentChildren } from 'preact';
import { useMemo, useRef, useState } from 'preact/hooks';
import { parseMarkdown, type MdBlock, type MdInline } from '../lib/markdown.ts';

interface RenderOptions {
  onLink: (href: string) => void;
  /** Tick or untick a checklist item; without it the boxes are read-only. */
  onToggleTask?: (index: number) => void;
}

const renderInline = (nodes: MdInline[], options: RenderOptions): ComponentChildren =>
  nodes.map((node, index) => {
    switch (node.kind) {
      case 'text':
        return node.text;
      case 'strong':
        return <strong key={index}>{renderInline(node.children, options)}</strong>;
      case 'em':
        return <em key={index}>{renderInline(node.children, options)}</em>;
      case 'del':
        return <del key={index}>{renderInline(node.children, options)}</del>;
      case 'code':
        return <code key={index}>{node.text}</code>;
      case 'br':
        return <br key={index} />;
      case 'link':
        return (
          <a
            key={index}
            href={node.href}
            title={node.href}
            rel="noreferrer noopener"
            onClick={(event) => {
              event.preventDefault();
              options.onLink(node.href);
            }}
          >
            {renderInline(node.children, options)}
          </a>
        );
      case 'image':
        // Linear's uploads need a signed-in browser; open them there instead of loading them here.
        return node.href ? (
          <a key={index} class="md-image" href={node.href} title={node.href} rel="noreferrer noopener" onClick={(event) => { event.preventDefault(); options.onLink(node.href!); }}>
            Image: {node.alt}
          </a>
        ) : (
          <span key={index} class="md-image">Image: {node.alt}</span>
        );
    }
  });

const renderBlocks = (nodes: MdBlock[], options: RenderOptions): ComponentChildren =>
  nodes.map((node, index) => {
    switch (node.kind) {
      case 'heading': {
        const Tag = `h${Math.min(6, node.depth + 2)}` as 'h3';
        return <Tag key={index} class={`md-h md-h${node.depth}`}>{renderInline(node.children, options)}</Tag>;
      }
      case 'paragraph':
        return <p key={index}>{renderInline(node.children, options)}</p>;
      case 'code':
        return <pre key={index} data-lang={node.lang || undefined}><code>{node.text}</code></pre>;
      case 'quote':
        return <blockquote key={index}>{renderBlocks(node.children, options)}</blockquote>;
      case 'hr':
        return <hr key={index} />;
      case 'table':
        return (
          <div key={index} class="md-table">
            <table>
              <thead><tr>{node.header.map((cell, at) => <th key={at} style={node.align[at] ? { textAlign: node.align[at]! } : undefined}>{renderInline(cell, options)}</th>)}</tr></thead>
              <tbody>{node.rows.map((row, at) => <tr key={at}>{row.map((cell, col) => <td key={col} style={node.align[col] ? { textAlign: node.align[col]! } : undefined}>{renderInline(cell, options)}</td>)}</tr>)}</tbody>
            </table>
          </div>
        );
      case 'list': {
        const items = node.items.map((item, at) => (
          <li key={at} class={item.checked === null ? undefined : 'md-task'}>
            {item.checked !== null && (
              <input
                type="checkbox"
                checked={item.checked}
                disabled={!options.onToggleTask}
                aria-label={item.checked ? 'Untick this item' : 'Tick this item'}
                onChange={(event) => {
                  // Stay as Linear says until the change comes back.
                  event.currentTarget.checked = Boolean(item.checked);
                  if (item.task !== null) options.onToggleTask?.(item.task);
                }}
              />
            )}
            <div class="md-item">{renderBlocks(item.children, options)}</div>
          </li>
        ));
        return node.ordered ? <ol key={index} start={node.start}>{items}</ol> : <ul key={index} class={node.items.some((item) => item.checked !== null) ? 'md-checklist' : undefined}>{items}</ul>;
      }
    }
  });

/** Markdown drawn with plain elements; see `parseMarkdown` for what it keeps. */
export const Markdown = ({ text, onLink, onToggleTask }: { text: string; onLink: (href: string) => void; onToggleTask?: (index: number) => void }) => {
  const doc = useMemo(() => parseMarkdown(text), [text]);
  return <div class="md">{renderBlocks(doc.blocks, { onLink, onToggleTask })}</div>;
};

/** A Markdown textarea with Write and Preview tabs and a few formatting buttons. */
export const MarkdownEditor = ({
  value,
  onInput,
  label,
  placeholder,
  onLink,
  onSubmit,
  rows = 8,
}: {
  value: string;
  onInput: (value: string) => void;
  label: string;
  placeholder?: string;
  onLink: (href: string) => void;
  /** Ctrl/Cmd+Enter. */
  onSubmit?: () => void;
  rows?: number;
}) => {
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const area = useRef<HTMLTextAreaElement>(null);
  const select = (start: number, end: number) =>
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(start, end);
    });
  /** Surround the selection, or a placeholder word, with `before` and `after`. */
  const wrap = (before: string, after: string, fallback: string) => {
    const element = area.current;
    if (!element) return;
    const { selectionStart: start, selectionEnd: end } = element;
    const chosen = value.slice(start, end) || fallback;
    onInput(value.slice(0, start) + before + chosen + after + value.slice(end));
    select(start + before.length, start + before.length + chosen.length);
  };
  /** Start every selected line with `prefix` (numbered lists count up). */
  const prefix = (marker: string) => {
    const element = area.current;
    if (!element) return;
    const from = value.lastIndexOf('\n', element.selectionStart - 1) + 1;
    const toBreak = value.indexOf('\n', Math.max(element.selectionEnd, from));
    const to = toBreak < 0 ? value.length : toBreak;
    const lines = value.slice(from, to).split('\n').map((line, at) => `${marker === '1. ' ? `${at + 1}. ` : marker}${line}`);
    const block = lines.join('\n');
    onInput(value.slice(0, from) + block + value.slice(to));
    select(from + block.length, from + block.length);
  };
  const tools: { label: string; text: string; run: () => void }[] = [
    { label: 'Bold', text: 'B', run: () => wrap('**', '**', 'bold') },
    { label: 'Italic', text: 'I', run: () => wrap('_', '_', 'italic') },
    { label: 'Strikethrough', text: 'S', run: () => wrap('~~', '~~', 'text') },
    { label: 'Code', text: '</>', run: () => wrap('`', '`', 'code') },
    { label: 'Link', text: 'Link', run: () => wrap('[', '](https://)', 'text') },
    { label: 'Heading', text: 'H', run: () => prefix('### ') },
    { label: 'Bulleted list', text: '•', run: () => prefix('- ') },
    { label: 'Numbered list', text: '1.', run: () => prefix('1. ') },
    { label: 'Checklist', text: '☐', run: () => prefix('- [ ] ') },
    { label: 'Quote', text: '❝', run: () => prefix('> ') },
  ];
  return (
    <div class="md-editor">
      <div class="md-editor-bar">
        <div class="tabs" role="tablist" aria-label={`${label} mode`}>
          <button role="tab" aria-selected={tab === 'write'} onClick={() => setTab('write')}>Write</button>
          <button role="tab" aria-selected={tab === 'preview'} onClick={() => setTab('preview')}>Preview</button>
        </div>
        {tab === 'write' && (
          <div class="md-tools" role="toolbar" aria-label={`${label} formatting`}>
            {tools.map((tool) => <button key={tool.label} class={`md-tool is-${tool.label.toLowerCase().replace(/\s+/g, '-')}`} title={tool.label} aria-label={tool.label} onMouseDown={(event) => event.preventDefault()} onClick={tool.run}>{tool.text}</button>)}
          </div>
        )}
      </div>
      {tab === 'write' ? (
        <textarea
          ref={area}
          class="md-input"
          rows={rows}
          aria-label={label}
          placeholder={placeholder ?? 'Markdown: **bold**, _italic_, `code`, - [ ] checklist, [link](https://…)'}
          value={value}
          onInput={(event) => onInput(event.currentTarget.value)}
          onKeyDown={(event) => {
            const mod = event.metaKey || event.ctrlKey;
            if (!mod) return;
            const key = event.key.toLowerCase();
            if (key === 'b') wrap('**', '**', 'bold');
            else if (key === 'i') wrap('_', '_', 'italic');
            else if (key === 'enter' && onSubmit) onSubmit();
            else return;
            event.preventDefault();
          }}
        />
      ) : (
        <div class="md-preview" aria-label={`${label} preview`}>{value.trim() ? <Markdown text={value} onLink={onLink} /> : <p class="hint">Nothing to preview.</p>}</div>
      )}
    </div>
  );
};
