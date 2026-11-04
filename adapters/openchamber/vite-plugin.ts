// Rewrites OpenChamber's UI sources in memory while Vite builds the web
// package: each module an adapter targets is transformed as it loads, before
// any other plugin sees it. The build fails if an anchor is gone, or if an
// adapted module was never loaded (upstream stopped using it); type-only
// files are exempt, their edits only matter to the type-check.
import { realpathSync } from "node:fs"
import type { Plugin } from "vite"
import { adaptSource, adaptedFiles, relativeToRoot } from "./apply"
import { adapters, isServerFile, typeOnlyFiles } from "./index"

export const ocForgeAdapters = (options: { root: string }): Plugin => {
  const root = realpathSync(options.root)
  const targets = new Set(adaptedFiles(adapters).filter((file) => !isServerFile(file)))
  const required = [...targets].filter((file) => !typeOnlyFiles.has(file))
  const applied = new Set<string>()
  return {
    name: "oc-forge-openchamber-adapters",
    enforce: "pre",
    transform(code, id) {
      const file = relativeToRoot(root, id)
      if (!file || !targets.has(file)) return null
      applied.add(file)
      return { code: adaptSource(adapters, file, code), map: null }
    },
    buildEnd(error) {
      if (error) return
      const missing = required.filter((file) => !applied.has(file))
      if (missing.length > 0) this.error(`openchamber adapters matched no module of this build: ${missing.join(", ")}`)
    },
  }
}
