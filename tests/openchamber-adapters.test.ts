// The OpenChamber adapters against the pinned upstream source: every edit
// applies, the adapted files call the oc-forge modules the build adds, and a
// source the anchors no longer match stops with a message naming what moved.
// OPENCHAMBER_SOURCE points at another checkout (default: vendors/openchamber).
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { adaptSource, adaptedFiles, AdapterMismatchError, editsFor } from "../adapters/openchamber/apply"
import { adapters, addedFiles, isServerFile } from "../adapters/openchamber/index"
import { ocForgeAdapters } from "../adapters/openchamber/vite-plugin"

const source = process.env.OPENCHAMBER_SOURCE ?? join(import.meta.dir, "../vendors/openchamber")
const read = (file: string) => readFileSync(join(source, file), "utf8")
const adapted = (file: string) => adaptSource(adapters, file, read(file))

describe("openchamber adapters", () => {
  test("the pinned source is checked out", () => {
    expect(existsSync(join(source, "packages/web/package.json"))).toBe(true)
  })

  test("every edit applies exactly once to the pinned source", () => {
    for (const file of adaptedFiles(adapters)) {
      const output = adapted(file)
      for (const { edit } of editsFor(adapters, file)) expect(output).toContain(edit.replace)
    }
  })

  test("adapted files import only oc-forge modules the build adds", () => {
    const added = new Set(Object.keys(addedFiles))
    for (const file of adaptedFiles(adapters)) {
      const output = adapted(file)
      for (const [, module] of output.matchAll(/from '@\/oc-forge\/([a-z-]+)'/g)) {
        expect([`packages/ui/src/oc-forge/${module}.ts`, `packages/ui/src/oc-forge/${module}.tsx`].some((path) => added.has(path))).toBe(true)
      }
      if (isServerFile(file)) {
        // Each adapted server file imports oc-forge's server modules, and each resolves to a file the build adds.
        const imports = [...output.matchAll(/from '(\.{1,2}\/[a-z/.-]*oc-forge\/[a-z-]+\.js)'/g)].map(([, path]) => join(dirname(file), path!))
        expect(imports.length).toBeGreaterThan(0)
        for (const path of imports) expect(added.has(path)).toBe(true)
      }
    }
    for (const path of Object.values(addedFiles)) expect(existsSync(join(import.meta.dir, "../adapters/openchamber", path))).toBe(true)
  })

  test("extension frames get the oc-forge channel", () => {
    const pane = adapted("packages/ui/src/components/layout/PluginPane.tsx")
    expect(pane).toContain(
      "  const guestId = pluginIdFromMode(mode);\n  // oc-forge: the frame's own channel (keys, routes).\n" +
        "  useOcForgeFrame({ iframeRef, mode, surface, enabled: !headless && !popover && !popoverHost });",
    )
  })

  test("the catalog carries the ocForge block from package.json to the UI", () => {
    const catalog = adapted("packages/web/server/lib/guests/catalog.js")
    expect(catalog).toContain("const ocForge = parseOcForgeManifest(raw, parsed.manifest);\n  if (ocForge) guest.ocForge = ocForge;")
    expect(catalog).toContain("if (guest.ocForge) row.ocForge = guest.ocForge;")
    expect(adapted("packages/ui/src/lib/guests/parse.ts")).toContain("  update: guestUpdateSchema.optional(),\n  ocForge: ocForgeManifestField,\n});")
  })

  test("an extension's frames keep the release's sandbox unless the extension asks for allow-modals", () => {
    const pane = adapted("packages/ui/src/components/layout/PluginPane.tsx")
    expect(pane).toContain("import { ocForgeFrameSandbox, useOcForgeFrame } from '@/oc-forge/frames';")
    expect(pane).toContain("      srcDoc={srcDoc}\n      sandbox={ocForgeFrameSandbox(guest)}\n")
    expect(pane).not.toContain('sandbox="allow-scripts"')
    // The server's CSP sandbox on the document must allow it too: the browser applies both.
    expect(adapted("packages/web/server/lib/guests/routes.js")).toContain(
      "res.setHeader('Content-Security-Policy', `${ocForgeDocumentSandbox(guest)}; ${guestFramePolicy(connectSource, origins)}`);",
    )
  })

  test("the main layout mounts the host and renders pages as the release does", () => {
    const layout = adapted("packages/ui/src/components/layout/MainLayout.tsx")
    expect(layout).toContain("import { PluginPane } from './PluginPane';\nimport { OcForgeHost } from '@/oc-forge/host';")
    expect(layout).toContain("{guestPage && <div className=\"absolute inset-0 z-10 bg-background\">")
    expect(layout).toContain("<ErrorBoundary><GuestHosts /></ErrorBoundary>\n                            <ErrorBoundary><OcForgeHost /></ErrorBoundary>")
  })

  test("the release's rail, header tabs, zones and guest service requests are left as they are", () => {
    const files = adaptedFiles(adapters)
    for (const file of [
      "packages/ui/src/components/layout/ContextPanelRail.tsx",
      "packages/ui/src/components/layout/SessionTabsStrip.tsx",
      "packages/ui/src/components/layout/Header.tsx",
      "packages/ui/src/components/layout/ContextSurfacePanes.tsx",
      "packages/ui/src/lib/sessionTabs.ts",
      "packages/ui/src/lib/guests/service.ts",
      "packages/web/server/index.js",
    ]) expect(files).not.toContain(file)
  })

  test("deep links: the router keeps, applies and writes ?extension=&route=", () => {
    expect(adapted("packages/ui/src/lib/router/parseRoute.ts")).toContain("params.has(ROUTE_PARAMS.FILE) ||\n      hasOcForgeRouteParams(params)")
    // Before serializeRoute's last return, not the settings one: with Settings open the URL names only Settings.
    expect(adapted("packages/ui/src/lib/router/serializeRoute.ts")).toContain(
      "  for (const [key, value] of ocForgeRouteParams()) params.set(key, value);\n\n  return params;\n}\n\n/**\n * Convert URLSearchParams",
    )
    // The last step of each route the router applies, before it writes the address bar.
    expect(adapted("packages/ui/src/hooks/useRouter.ts")).toContain(
      "        navigateToDiff(route.diffFile);\n      }\n\n      // 5. oc-forge: an extension page deep link (`?extension=<id>&route=<route>`).\n      applyOcForgeRoute();\n    },",
    )
  })

  test("the README's inventory counts the edits there are", () => {
    const files = adaptedFiles(adapters)
    const edits = files.reduce((count, file) => count + editsFor(adapters, file).length, 0)
    const readme = readFileSync(join(import.meta.dir, "../adapters/openchamber/README.md"), "utf8")
    expect(/(\d+) edits in (\d+) files/.exec(readme)?.slice(1).map(Number)).toEqual([edits, files.length])
  })

  test("a moved or doubled anchor stops the build with a message naming it", () => {
    const file = "packages/ui/src/lib/router/parseRoute.ts"
    const original = read(file)
    const anchor = "      params.has(ROUTE_PARAMS.FILE)\n    );"
    const moved = original.replace(anchor, "      params.has(ROUTE_PARAMS.FILE));")
    expect(() => adaptSource(adapters, file, moved)).toThrow(AdapterMismatchError)
    expect(() => adaptSource(adapters, file, moved)).toThrow(`openchamber adapter "links" no longer applies to ${file}`)
    expect(() => adaptSource(adapters, file, moved)).toThrow("found 0")
    expect(() => adaptSource(adapters, file, `${original}\n${anchor}\n`)).toThrow("found 2")
  })

  test("the Vite plugin rewrites targeted modules and fails a build that never loaded one", () => {
    const root = source
    const plugin = ocForgeAdapters({ root })
    const transform = plugin.transform as (code: string, id: string) => { code: string } | null
    const file = "packages/ui/src/lib/router/parseRoute.ts"
    const result = transform(read(file), `${join(root, file)}?v=1`)
    expect(result?.code).toContain("hasOcForgeRouteParams(params)")
    expect(transform("export {}", join(root, "packages/ui/src/main.tsx"))).toBeNull()
    const errors: string[] = []
    const buildEnd = plugin.buildEnd as (this: { error: (message: string) => void }, error?: Error) => void
    buildEnd.call({ error: (message: string) => errors.push(message) })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain("matched no module of this build")
    expect(errors[0]).not.toContain(file)
  })
})
