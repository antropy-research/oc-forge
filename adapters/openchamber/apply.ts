// How an OpenChamber adapter changes upstream source: each edit names exact
// upstream text that must occur exactly once and what replaces it. Shared by
// the Vite plugin (UI sources, rewritten in memory while the web package is
// built), the staging CLI (server sources, which ship unbuilt) and the tests.

export type Edit = {
  // Exact upstream text. It must occur exactly once when the edit runs.
  readonly find: string
  readonly replace: string
}

export type Adapter = {
  readonly name: string
  // One line: what the adapter adds, for logs and the README.
  readonly summary: string
  // Upstream path relative to the OpenChamber repository root -> edits, applied in order.
  readonly edits: Readonly<Record<string, readonly Edit[]>>
}

export class AdapterMismatchError extends Error {
  constructor(
    readonly adapter: string,
    readonly file: string,
    readonly find: string,
    readonly count: number,
  ) {
    const excerpt = find.length > 160 ? `${find.slice(0, 160)}…` : find
    super(
      `openchamber adapter "${adapter}" no longer applies to ${file}: expected exactly 1 occurrence of ` +
        `${JSON.stringify(excerpt)}, found ${count}. Upstream changed this code; update adapters/openchamber/edits/.`,
    )
    this.name = "AdapterMismatchError"
  }
}

export const insertBefore = (find: string, text: string): Edit => ({ find, replace: `${text}${find}` })
export const insertAfter = (find: string, text: string): Edit => ({ find, replace: `${find}${text}` })
export const replace = (find: string, text: string): Edit => ({ find, replace: text })

const occurrences = (source: string, find: string): number => {
  if (!find) return 0
  let count = 0
  for (let index = source.indexOf(find); index !== -1; index = source.indexOf(find, index + find.length)) count += 1
  return count
}

// Every adapter's edits for one file, in adapter order.
export const editsFor = (adapters: readonly Adapter[], file: string): { adapter: string; edit: Edit }[] =>
  adapters.flatMap((adapter) => (adapter.edits[file] ?? []).map((edit) => ({ adapter: adapter.name, edit })))

export const adaptedFiles = (adapters: readonly Adapter[]): string[] => [
  ...new Set(adapters.flatMap((adapter) => Object.keys(adapter.edits))),
]

// The upstream file with every adapter's edits applied; throws AdapterMismatchError
// when an anchor is missing or ambiguous, so a moved pin stops the build.
export const adaptSource = (adapters: readonly Adapter[], file: string, source: string): string => {
  let text = source
  for (const { adapter, edit } of editsFor(adapters, file)) {
    const count = occurrences(text, edit.find)
    if (count !== 1) throw new AdapterMismatchError(adapter, file, edit.find, count)
    const index = text.indexOf(edit.find)
    text = text.slice(0, index) + edit.replace + text.slice(index + edit.find.length)
  }
  return text
}

// Normalizes a module id or absolute path to a path relative to the
// OpenChamber root, or null when it lies outside it.
export const relativeToRoot = (root: string, id: string): string | null => {
  const path = id.split("?")[0].replaceAll("\\", "/")
  const base = root.replaceAll("\\", "/").replace(/\/+$/, "")
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : null
}
