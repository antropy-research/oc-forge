// What the editor takes from a compiled VS Code: its languages (file names and
// extensions, comment and bracket rules), the TextMate grammars that color
// them, and its default themes. scripts/collect-vscode.ts writes these from a
// VS Code installation; the editor reads them. Pure: no file system here.

/** One language, as a built-in VS Code extension contributes it. */
export interface VscodeLanguage {
  id: string;
  aliases: string[];
  /** With the dot, lower case: ".ts". */
  extensions: string[];
  /** Exact file names, lower case: "dockerfile". */
  filenames: string[];
  /** File name globs, as VS Code has them: "*.config.js". */
  filenamePatterns: string[];
  /** The TextMate scope that colors it, when VS Code ships a grammar for it. */
  scopeName: string | null;
  /** Whether a language configuration file came with it. */
  configuration: boolean;
}

/** One TextMate grammar: its file, the grammars it injects into, and the languages embedded in it. */
export interface VscodeGrammar {
  scopeName: string;
  file: string;
  injectTo: string[];
  embeddedLanguages: Record<string, string>;
}

/** What scripts/collect-vscode.ts writes as index.json. */
export interface VscodeIndex {
  vscode: { version: string; commit: string | null };
  languages: VscodeLanguage[];
  grammars: VscodeGrammar[];
  themes: { id: string; label: string; type: 'dark' | 'light' }[];
}

/** A built-in extension's package.json, the parts that matter here. */
export interface ExtensionManifest {
  name?: string;
  contributes?: {
    languages?: { id?: string; aliases?: string[]; extensions?: string[]; filenames?: string[]; filenamePatterns?: string[]; configuration?: string }[];
    grammars?: { language?: string; scopeName?: string; path?: string; injectTo?: string[]; embeddedLanguages?: Record<string, string> }[];
    themes?: { id?: string; label?: string; uiTheme?: string; path?: string }[];
  };
}

const lower = (items: readonly string[] | undefined): string[] => [...new Set((items ?? []).map((item) => item.toLowerCase()))];

/** A grammar file's name in the collection: its scope, made safe for a file name. */
export const grammarFile = (scopeName: string): string => `${scopeName.replace(/[^A-Za-z0-9._-]/g, '_')}.json`;

/**
 * Languages and grammars from built-in extensions' manifests. Several
 * extensions can contribute to one language (one gives the grammar, another
 * more file names); their parts are merged, first come first kept.
 */
export const collectLanguages = (manifests: readonly ExtensionManifest[]): { languages: VscodeLanguage[]; grammars: VscodeGrammar[]; grammarPaths: Map<string, { manifest: ExtensionManifest; path: string }>; configurationPaths: Map<string, { manifest: ExtensionManifest; path: string }> } => {
  const languages = new Map<string, VscodeLanguage>();
  const grammars = new Map<string, VscodeGrammar>();
  const grammarPaths = new Map<string, { manifest: ExtensionManifest; path: string }>();
  const configurationPaths = new Map<string, { manifest: ExtensionManifest; path: string }>();
  for (const manifest of manifests) {
    for (const language of manifest.contributes?.languages ?? []) {
      if (!language.id) continue;
      const current = languages.get(language.id) ?? { id: language.id, aliases: [], extensions: [], filenames: [], filenamePatterns: [], scopeName: null, configuration: false };
      current.aliases = [...new Set([...current.aliases, ...(language.aliases ?? [])])];
      current.extensions = [...new Set([...current.extensions, ...lower(language.extensions)])];
      current.filenames = [...new Set([...current.filenames, ...lower(language.filenames)])];
      current.filenamePatterns = [...new Set([...current.filenamePatterns, ...(language.filenamePatterns ?? [])])];
      if (language.configuration && !configurationPaths.has(language.id)) {
        configurationPaths.set(language.id, { manifest, path: language.configuration });
        current.configuration = true;
      }
      languages.set(language.id, current);
    }
    for (const grammar of manifest.contributes?.grammars ?? []) {
      if (!grammar.scopeName || !grammar.path || grammars.has(grammar.scopeName)) continue;
      grammars.set(grammar.scopeName, { scopeName: grammar.scopeName, file: grammarFile(grammar.scopeName), injectTo: grammar.injectTo ?? [], embeddedLanguages: grammar.embeddedLanguages ?? {} });
      grammarPaths.set(grammar.scopeName, { manifest, path: grammar.path });
      if (grammar.language) {
        const language = languages.get(grammar.language);
        if (language && !language.scopeName) language.scopeName = grammar.scopeName;
      }
    }
  }
  // A grammar may name its language before the extension that declares the language is read.
  for (const manifest of manifests) {
    for (const grammar of manifest.contributes?.grammars ?? []) {
      const language = grammar.language ? languages.get(grammar.language) : undefined;
      if (language && !language.scopeName && grammar.scopeName && grammars.has(grammar.scopeName)) language.scopeName = grammar.scopeName;
    }
  }
  return { languages: [...languages.values()].sort((a, b) => a.id.localeCompare(b.id)), grammars: [...grammars.values()].sort((a, b) => a.scopeName.localeCompare(b.scopeName)), grammarPaths, configurationPaths };
};

/** VS Code's theme files: `include` names a parent whose colors and token colors come first. */
export interface VscodeThemeFile {
  name?: string;
  type?: string;
  include?: string;
  colors?: Record<string, string>;
  tokenColors?: { name?: string; scope?: string | string[]; settings: { foreground?: string; background?: string; fontStyle?: string } }[];
  semanticHighlighting?: boolean;
}

/** A theme with its `include` chain resolved: the parent's settings, then this file's on top. */
export const resolveTheme = (file: VscodeThemeFile, readInclude: (path: string) => VscodeThemeFile): VscodeThemeFile => {
  const chain: VscodeThemeFile[] = [file];
  let current = file;
  for (let depth = 0; current.include && depth < 8; depth++) {
    current = readInclude(current.include);
    chain.unshift(current);
  }
  return {
    name: file.name,
    type: file.type ?? chain.find((item) => item.type)?.type,
    colors: Object.assign({}, ...chain.map((item) => item.colors ?? {})),
    tokenColors: chain.flatMap((item) => item.tokenColors ?? []),
  };
};

/** The language VS Code would pick for a file name: an exact file name first, then the longest extension, then a pattern. */
export const languageFor = (index: Pick<VscodeIndex, 'languages'>, fileName: string): VscodeLanguage | null => {
  const name = fileName.toLowerCase();
  const byName = index.languages.find((language) => language.filenames.includes(name));
  if (byName) return byName;
  let best: { language: VscodeLanguage; length: number } | null = null;
  for (const language of index.languages) {
    for (const extension of language.extensions) {
      // As VS Code's `*${extension}` glob: a file named just ".gitignore" has the extension ".gitignore".
      if (name.endsWith(extension) && (!best || extension.length > best.length)) best = { language, length: extension.length };
    }
  }
  if (best) return best.language;
  for (const language of index.languages) {
    if (language.filenamePatterns.some((pattern) => globMatches(pattern.toLowerCase(), name))) return language;
  }
  return null;
};

/** JSON with comments and trailing commas, as VS Code writes its configuration and theme files. */
export const parseJsonc = (text: string): unknown => {
  const out: string[] = [];
  let inString = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (inString) {
      out.push(char);
      if (char === '\\') out.push(text[++index] ?? '');
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out.push(char);
    } else if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index++;
      out.push('\n');
    } else if (char === '/' && text[index + 1] === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index++;
      index++;
    } else if (char === '}' || char === ']') {
      // A trailing comma before the close goes; strings are already past.
      let back = out.length - 1;
      while (back >= 0 && /\s/.test(out[back]!)) back--;
      if (out[back] === ',') out[back] = '';
      out.push(char);
    } else out.push(char);
  }
  return JSON.parse(out.join(''));
};

/** A file-name glob: `*` any run of characters except `/`, `?` one; `**\/` any folders. */
export const globMatches = (pattern: string, name: string): boolean => {
  const base = pattern.replace(/^\*\*\//, '');
  const source = base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  return new RegExp(`^${source}$`).test(name);
};
