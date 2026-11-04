// Run by scripts/build-openchamber.py with Bun, always on the scratch build
// tree (a copy of vendors/openchamber), never on the vendor itself.
//
//   bun adapters/openchamber/cli.ts verify <tree>        every edit applies to the tree's upstream sources
//   bun adapters/openchamber/cli.ts stage <tree> added   copy the new host/ and server/ files in
//   bun adapters/openchamber/cli.ts stage <tree> server  write the adapted server sources (they ship unbuilt)
//   bun adapters/openchamber/cli.ts stage <tree> ui      write the adapted UI sources (for the type-check only)
//   bun adapters/openchamber/cli.ts vite-config <tree>   write packages/web/vite.oc-forge.config.ts
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { adaptSource, adaptedFiles, AdapterMismatchError } from "./apply"
import { adapters, addedFiles, isServerFile, TARGET } from "./index"

const here = import.meta.dir
const [command, treeArgument, part] = process.argv.slice(2)
if (!command || !treeArgument) {
  console.error("usage: cli.ts verify <tree> | stage <tree> added|server|ui | vite-config <tree>")
  process.exit(2)
}
const tree = resolve(treeArgument)

const writeAdapted = (files: string[]) => {
  for (const file of files) {
    const path = join(tree, file)
    writeFileSync(path, adaptSource(adapters, file, readFileSync(path, "utf8")))
  }
}

try {
  if (command === "verify") {
    const version = JSON.parse(readFileSync(join(tree, "packages/web/package.json"), "utf8")).version
    if (version !== TARGET.version) {
      console.warn(`note: the adapters were written against OpenChamber ${TARGET.version}; this tree is ${version}`)
    }
    for (const adapter of adapters) {
      for (const file of Object.keys(adapter.edits)) adaptSource([adapter], file, readFileSync(join(tree, file), "utf8"))
    }
    // Together, in order: later edits may sit next to earlier ones.
    for (const file of adaptedFiles(adapters)) adaptSource(adapters, file, readFileSync(join(tree, file), "utf8"))
    const edits = adapters.reduce((count, adapter) => count + Object.values(adapter.edits).flat().length, 0)
    console.log(`openchamber adapters apply to ${version}: ${adapters.map((adapter) => adapter.name).join(", ")} (${edits} edits in ${adaptedFiles(adapters).length} files)`)
  } else if (command === "stage" && part === "added") {
    for (const [target, source] of Object.entries(addedFiles)) {
      mkdirSync(dirname(join(tree, target)), { recursive: true })
      copyFileSync(join(here, source), join(tree, target))
    }
  } else if (command === "stage" && part === "server") {
    writeAdapted(adaptedFiles(adapters).filter(isServerFile))
  } else if (command === "stage" && part === "ui") {
    writeAdapted(adaptedFiles(adapters).filter((file) => !isServerFile(file)))
  } else if (command === "vite-config") {
    const config = [
      "// Written by oc-forge's scripts/build-openchamber.py into its scratch build tree:",
      "// OpenChamber's own config plus the oc-forge adapters, which rewrite UI sources in memory.",
      "import base from './vite.config.ts';",
      `import { ocForgeAdapters } from ${JSON.stringify(join(here, "vite-plugin.ts"))};`,
      "",
      "const plugins = (base as { plugins?: unknown[] }).plugins ?? [];",
      `export default { ...base, plugins: [ocForgeAdapters({ root: ${JSON.stringify(tree)} }), ...plugins] };`,
      "",
    ].join("\n")
    writeFileSync(join(tree, "packages/web/vite.oc-forge.config.ts"), config)
  } else {
    console.error(`unknown command: ${command} ${part ?? ""}`)
    process.exit(2)
  }
} catch (error) {
  if (error instanceof AdapterMismatchError) {
    console.error(`error: ${error.message}`)
    process.exit(1)
  }
  throw error
}
