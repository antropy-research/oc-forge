// Supplied by scripts/build.ts.

/** Monaco's editor features without its languages: a module the build makes from Monaco's own entry. */
declare module 'virtual:monaco-features' {}

/** The source of Monaco's helper worker, built first and inlined. */
declare const __WORKER_SOURCE__: string;

/** vscode-oniguruma's WASM, base64. */
declare const __ONIG_WASM__: string;
