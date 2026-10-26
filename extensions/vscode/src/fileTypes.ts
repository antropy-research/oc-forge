// The files VS Code's editor opens in OpenChamber's Files view: code VS Code
// has a grammar for. Files OpenChamber previews itself (Markdown, JSON, HTML,
// SVG, CSV, draw.io, Mermaid, images) are left to it. The manifest's
// `contributes.fileEditors` must say the same; a test holds them together.

export interface FileEditorEntry {
  id: string;
  title: string;
  match: string[];
}

export const FILE_EDITORS: FileEditorEntry[] = [
  { id: 'web', title: 'VS Code', match: ['*.ts', '*.tsx', '*.mts', '*.cts', '*.js', '*.jsx', '*.mjs', '*.cjs', '*.css', '*.scss', '*.less', '*.hbs', '*.handlebars', '*.pug'] },
  { id: 'systems', title: 'VS Code', match: ['*.c', '*.h', '*.cc', '*.cpp', '*.cxx', '*.hpp', '*.hh', '*.cs', '*.go', '*.rs', '*.java', '*.swift', '*.m', '*.mm', '*.cu', '*.dart'] },
  { id: 'scripts', title: 'VS Code', match: ['*.py', '*.pyi', '*.rb', '*.php', '*.pl', '*.pm', '*.lua', '*.r', '*.jl', '*.ps1', '*.psm1', '*.sh', '*.bash', '*.zsh', '*.groovy', '*.gradle'] },
  { id: 'more', title: 'VS Code', match: ['*.fs', '*.fsx', '*.clj', '*.cljs', '*.coffee', '*.vb', '*.sql', '*.bat', '*.cmd', '*.raku', '*.hlsl', '*.shader', '*.tex', '*.bib', '*.rst', '*.wat'] },
  { id: 'config', title: 'VS Code', match: ['*.yaml', '*.yml', '*.xml', '*.xsl', '*.ini', '*.properties', '*.cfg', '.env', '*.env', 'Dockerfile', '*.dockerfile', 'Makefile', '*.mk', '*.diff', '*.patch', '.gitignore'] },
];

/** Every pattern, for the panel to list. */
export const allPatterns = (): string[] => FILE_EDITORS.flatMap((entry) => entry.match);
