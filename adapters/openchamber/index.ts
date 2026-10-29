// Every change oc-forge makes to OpenChamber. Edits to upstream files live in
// edits/; the code they call is new and lives in host/ (the UI) and server/.
// How they are applied: vite-plugin.ts (UI, in memory during the web build),
// cli.ts (server files staged for the package, and the type-check tree).
import type { Adapter } from "./apply"
import { core } from "./edits/core"
import { links } from "./edits/links"
import { pages } from "./edits/pages"
import { fixes } from "./edits/fixes"
import { rail } from "./edits/rail"
import { tabs } from "./edits/tabs"

export type { Adapter, Edit } from "./apply"

// The OpenChamber release the anchors were written against.
export const TARGET = { version: "2.5.2", commit: "c4919abc1e7a0a3beeaa126666487806bf79cfe0" } as const

export const adapters: readonly Adapter[] = [core, rail, tabs, links, pages, fixes]

// Files the adapters add: path in the OpenChamber tree -> path under adapters/openchamber.
export const addedFiles: Readonly<Record<string, string>> = {
  "packages/ui/src/oc-forge/protocol.ts": "host/protocol.ts",
  "packages/ui/src/oc-forge/ids.ts": "host/ids.ts",
  "packages/ui/src/oc-forge/store.ts": "host/store.ts",
  "packages/ui/src/oc-forge/bus.ts": "host/bus.ts",
  "packages/ui/src/oc-forge/keys.ts": "host/keys.ts",
  "packages/ui/src/oc-forge/rail.ts": "host/rail.ts",
  "packages/ui/src/oc-forge/routes.ts": "host/routes.ts",
  "packages/ui/src/oc-forge/pages.ts": "host/pages.ts",
  "packages/ui/src/oc-forge/commands.ts": "host/commands.ts",
  "packages/ui/src/oc-forge/tabs-state.ts": "host/tabs-state.ts",
  "packages/ui/src/oc-forge/tabs-ui.tsx": "host/tabs-ui.tsx",
  "packages/ui/src/oc-forge/frames.ts": "host/frames.ts",
  "packages/ui/src/oc-forge/manifest-schema.ts": "host/manifest-schema.ts",
  "packages/ui/src/oc-forge/host.tsx": "host/host.tsx",
  "packages/web/server/lib/oc-forge/manifest.js": "server/manifest.js",
}

// Upstream server sources ship as they are (no build step), so their edits are
// applied when the package is staged; everything else is rewritten by Vite.
export const isServerFile = (file: string): boolean => file.startsWith("packages/web/server/")

// Declarations only: every import of them is `import type`, so Vite never
// loads them. Their edits matter to the type-check, not to the bundle.
export const typeOnlyFiles: ReadonlySet<string> = new Set(["packages/ui/src/lib/guests/types.ts"])
