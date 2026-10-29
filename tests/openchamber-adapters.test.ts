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
      "  const guestId = pluginIdFromMode(mode);\n  // oc-forge: the frame's own channel (rail entries, header tabs, keys, routes).\n" +
        "  useOcForgeFrame({ iframeRef, mode, surface, enabled: !headless && !popover && !popoverHost });",
    )
  })

  test("the catalog carries the ocForge block from package.json to the UI", () => {
    const catalog = adapted("packages/web/server/lib/guests/catalog.js")
    expect(catalog).toContain("const ocForge = parseOcForgeManifest(raw, parsed.manifest);\n  if (ocForge) guest.ocForge = ocForge;")
    expect(catalog).toContain("if (guest.ocForge) row.ocForge = guest.ocForge;")
    expect(adapted("packages/ui/src/lib/guests/parse.ts")).toContain("  update: guestUpdateSchema.optional(),\n  ocForge: ocForgeManifestField,\n});")
  })

  test("the main layout mounts the host and renders pages through it", () => {
    const layout = adapted("packages/ui/src/components/layout/MainLayout.tsx")
    expect(layout).not.toContain("import { PluginPane }")
    expect(layout).not.toContain("{guestPage && <div")
    expect(layout).toContain("<OcForgeGuestPages openPage={guestPage} />")
    expect(layout).toContain("<ErrorBoundary><GuestHosts /></ErrorBoundary>\n                            <ErrorBoundary><OcForgeHost /></ErrorBoundary>")
  })

  test("rail entries: surfaces, highlight and selection go through oc-forge", () => {
    expect(adapted("packages/ui/src/lib/surfaces/modes.ts")).toContain("=> ocForgeGuestIdOf(mode.slice('plugin:'.length));")
    // OpenChamber builds with the React Compiler: a render passes the rail state it read, so a change re-renders.
    const surfaces = adapted("packages/ui/src/lib/guests/surfaces.ts")
    expect(surfaces).toContain("ocForgeRail: OcForgeRailState = currentOcForgeRail(),\n): ContextSurfaceDescriptor[] => ocForgeExpandRailSurfaces(guests")
    expect(surfaces).toContain(".map((guest) => guestSurfaceFromInstalled(guest, authenticatedAsset)), ocForgeRail);")
    expect(adapted("packages/ui/src/hooks/useGuestSurfaces.ts")).toContain("enabledGuestSurfaces(guests, getRuntimeUrlResolver().authenticatedAsset, ocForgeRail);")
    const rail = adapted("packages/ui/src/components/layout/ContextPanelRail.tsx")
    expect(rail).toContain("isActive={ocForgeRailSurfaceActive(surface, shownModes, ocForgeRail)}")
    expect(rail).toContain("if (!ocForgeSelectRailSurface(directoryKey, selected)) openContextSurface(directoryKey, selected.mode);")
    expect(adapted("packages/ui/src/hooks/useKeyboardShortcuts.ts")).toContain(
      "if (!ocForgeSelectRailSurface(directory, target)) state.openContextSurface(directory, target.mode);",
    )
  })

  test("header tabs: shortcuts, strip and header see the extension tabs", () => {
    const tabs = adapted("packages/ui/src/lib/sessionTabs.ts")
    expect(tabs).toContain("const activateSessionTabByIndexInStrip = (index: number): boolean => {")
    expect(tabs).toContain("ocForgeActivateTabByIndex(index, activateSessionTabByIndexInStrip)")
    expect(tabs).toContain("ocForgeActivateAdjacentTab(delta, activateAdjacentSessionTabInStrip)")
    const strip = adapted("packages/ui/src/components/layout/SessionTabsStrip.tsx")
    expect(strip).toContain("isActive={tab.id === currentSessionId && !ocForgeTabActive}")
    expect(strip).toContain(") : null}\n        <OcForgeHeaderTabs />")
    expect(adapted("packages/ui/src/components/layout/Header.tsx")).toContain("(ocForgeTabbedPage ? undefined : state.guests.find(")
    expect(adapted("packages/ui/src/hooks/useKeyboardShortcuts.ts")).toContain(
      "      if (ocForgeCloseActiveTab()) return;\n      if (currentSessionId) {",
    )
  })

  test("deep links: the router keeps, applies and writes ?extension=&route=", () => {
    expect(adapted("packages/ui/src/lib/router/parseRoute.ts")).toContain("params.has(ROUTE_PARAMS.FILE) ||\n      hasOcForgeRouteParams(params)")
    // Before serializeRoute's last return, not the settings one: with Settings open the URL names only Settings.
    expect(adapted("packages/ui/src/lib/router/serializeRoute.ts")).toContain(
      "  for (const [key, value] of ocForgeRouteParams()) params.set(key, value);\n\n  return params;\n}\n\n/**\n * Convert URLSearchParams",
    )
    expect(adapted("packages/ui/src/hooks/useRouter.ts")).toContain("        applyOcForgeRoute();\n      } finally {")
  })

  test("a moved or doubled anchor stops the build with a message naming it", () => {
    const file = "packages/ui/src/lib/surfaces/modes.ts"
    const original = read(file)
    const anchor = "export const pluginIdFromMode = (mode: PluginContextPanelMode): string => mode.slice('plugin:'.length);"
    const moved = original.replace(anchor, "export const pluginIdFromMode = (mode: PluginContextPanelMode) => mode.slice(7);")
    expect(() => adaptSource(adapters, file, moved)).toThrow(AdapterMismatchError)
    expect(() => adaptSource(adapters, file, moved)).toThrow(`openchamber adapter "rail" no longer applies to ${file}`)
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
