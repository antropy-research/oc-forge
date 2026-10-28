// The shared ground every API stands on: extension frames get the oc-forge
// channel, the catalog carries a package's `ocForge` block from package.json to
// the UI, and the main layout mounts the oc-forge host and its pages.
import { insertAfter, replace, type Adapter } from "../apply"

export const core: Adapter = {
  name: "core",
  summary: "oc-forge channel for every visible extension frame; `ocForge` manifest block in the catalog; host mounted in the main layout",
  edits: {
    "packages/ui/src/components/layout/PluginPane.tsx": [
      insertAfter(
        "import { DockedPanelSurfaceContext, usePageColors } from '@/hooks/usePageColors';",
        "\nimport { useOcForgeFrame } from '@/oc-forge/frames';",
      ),
      insertAfter(
        "  const guestId = pluginIdFromMode(mode);",
        "\n  // oc-forge: the frame's own channel (rail entries, header tabs, keys, routes).\n" +
          "  useOcForgeFrame({ iframeRef, mode, surface, enabled: !headless && !popover && !popoverHost });",
      ),
    ],
    "packages/ui/src/lib/guests/types.ts": [
      insertAfter("} from '@openchamber/sdk';", "\nimport type { OcForgeManifest } from '@/oc-forge/protocol';"),
      insertAfter(
        "  update?: GuestUpdate;",
        "\n  /** oc-forge: the package.json `ocForge` block (rail entry source, default zone). */\n  ocForge?: OcForgeManifest;",
      ),
    ],
    "packages/ui/src/lib/guests/parse.ts": [
      insertAfter(
        "import type { GuestCatalog, InstalledGuest } from './types.ts';",
        "\nimport { ocForgeManifestField } from '@/oc-forge/manifest-schema';",
      ),
      insertAfter("  update: guestUpdateSchema.optional(),", "\n  ocForge: ocForgeManifestField,"),
    ],
    "packages/web/server/lib/guests/catalog.js": [
      insertAfter(
        "import { isReservedBuiltInId, readBuiltInRegistry } from './builtins.js';",
        "\nimport { parseOcForgeManifest } from '../oc-forge/manifest.js';",
      ),
      insertAfter(
        "    icon: panel.icon,\n    packageRoot,\n  };",
        "\n  // oc-forge: OpenChamber's parser drops keys it does not know; read the block from the same file.\n" +
          "  const ocForge = parseOcForgeManifest(raw, parsed.manifest);\n  if (ocForge) guest.ocForge = ocForge;",
      ),
      insertAfter("    enabled: guest.enabled !== false,\n  };", "\n  if (guest.ocForge) row.ocForge = guest.ocForge;"),
    ],
    "packages/ui/src/components/layout/MainLayout.tsx": [
      replace("import { PluginPane } from './PluginPane';", "import { OcForgeGuestPages, OcForgeHost } from '@/oc-forge/host';"),
      replace(
        "                                            {guestPage && <div className=\"absolute inset-0 z-10 bg-background\">\n" +
          "                                                <ErrorBoundary><PluginPane mode={`plugin:${guestPage.id}`} surface=\"page\" item={null}\n" +
          "                                                    onDismiss={() => useUIStore.getState().setOpenGuestPage(null)} /></ErrorBoundary>\n" +
          "                                            </div>}",
        "                                            {/* oc-forge: the open page, and pages kept mounted behind header tabs. */}\n" +
          "                                            <OcForgeGuestPages openPage={guestPage} />",
      ),
      insertAfter("                            <ErrorBoundary><GuestHosts /></ErrorBoundary>", "\n                            <ErrorBoundary><OcForgeHost /></ErrorBoundary>"),
    ],
  },
}
