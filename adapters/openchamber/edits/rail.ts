// R1: an extension's service lists rail entries; each is its own rail icon
// with its own highlight. Entries without a zone are views of the extension's
// one panel; an entry with a zone is a panel of its own (`plugin:<id>--<entry>`).
import { insertAfter, insertBefore, replace, type Adapter } from "../apply"

export const rail: Adapter = {
  name: "rail",
  summary: "rail entries polled from an extension's service: one icon per entry, its own highlight, the frame told which entry",
  edits: {
    "packages/ui/src/lib/surfaces/modes.ts": [
      insertBefore("const BUILT_IN_CONTEXT_PANEL_MODES = [", "import { ocForgeGuestIdOf } from '@/oc-forge/ids';\n\n"),
      replace(
        "export const pluginIdFromMode = (mode: PluginContextPanelMode): string => mode.slice('plugin:'.length);",
        "// oc-forge: `plugin:<extension>--<entry>` is a rail entry's own panel of that extension.\n" +
          "export const pluginIdFromMode = (mode: PluginContextPanelMode): string => ocForgeGuestIdOf(mode.slice('plugin:'.length));",
      ),
    ],
    "packages/ui/src/lib/guests/surfaces.ts": [
      insertAfter(
        "import type { InstalledGuest } from './types.ts';",
        "\nimport { currentOcForgeRail, ocForgeExpandRailSurfaces, type OcForgeRailState } from '@/oc-forge/rail';",
      ),
      replace(
        "  authenticatedAsset: (path: string) => string,\n): ContextSurfaceDescriptor[] => guests\n" +
          "  .filter((guest) => isGuestActive(guest) && (hasGuestPage({ panel: guest }) || guestHasSharedSurface(guest)))\n" +
          "  .map((guest) => guestSurfaceFromInstalled(guest, authenticatedAsset));",
        "  authenticatedAsset: (path: string) => string,\n" +
          "  // oc-forge: polled rail entries replace an extension's icon; a render passes the state it read.\n" +
          "  ocForgeRail: OcForgeRailState = currentOcForgeRail(),\n" +
          "): ContextSurfaceDescriptor[] => ocForgeExpandRailSurfaces(guests\n" +
          "  .filter((guest) => isGuestActive(guest) && (hasGuestPage({ panel: guest }) || guestHasSharedSurface(guest)))\n" +
          "  .map((guest) => guestSurfaceFromInstalled(guest, authenticatedAsset)), ocForgeRail);",
      ),
    ],
    "packages/ui/src/hooks/useGuestSurfaces.ts": [
      insertAfter("import { enabledGuestSurfaces } from '@/lib/guests/surfaces';", "\nimport { useOcForgeRailRevision } from '@/oc-forge/rail';"),
      insertAfter(
        "export const useGuestSurfaces = (): ContextSurfaceDescriptor[] => {\n  const { guests, runtimeKey } = useGuestCatalog();",
        "\n  const ocForgeRail = useOcForgeRailRevision();",
      ),
      replace(
        "    return enabledGuestSurfaces(guests, getRuntimeUrlResolver().authenticatedAsset);\n" +
          "    // runtimeKey: the asset resolver answers for the active runtime, so a switch recomputes the list.\n" +
          "    // oxlint-disable-next-line react-hooks/exhaustive-deps\n" +
          "  }, [guests, runtimeKey]);",
        "    return enabledGuestSurfaces(guests, getRuntimeUrlResolver().authenticatedAsset, ocForgeRail);\n" +
          "    // runtimeKey: the asset resolver answers for the active runtime, so a switch recomputes the list.\n" +
          "    // oxlint-disable-next-line react-hooks/exhaustive-deps\n" +
          "  }, [guests, runtimeKey, ocForgeRail]);",
      ),
    ],
    "packages/ui/src/components/layout/ContextPanelRail.tsx": [
      // More icons than the column's height (an extension's many entries, a short window): the column scrolls, its
      // scrollbar hidden, where the release cut the last icons off. While they fit nothing changes.
      replace(
        '      className="flex h-full w-11 flex-shrink-0 flex-col items-center gap-2 bg-background py-2"\n',
        '      className="scrollbar-none flex h-full w-11 flex-shrink-0 flex-col items-center gap-2 overflow-y-auto bg-background py-2"\n',
      ),
      insertAfter(
        "import { shownContextModes, zoneOfMode } from '@/lib/workspace/zones';",
        "\nimport { ocForgeRailSurfaceActive, ocForgeSelectRailSurface, useOcForgeRailRevision } from '@/oc-forge/rail';",
      ),
      insertAfter("  const guestSurfaces = useGuestSurfaces();", "\n  const ocForgeRail = useOcForgeRailRevision();"),
      replace("                isActive={shownModes.has(surface.mode)}", "                isActive={ocForgeRailSurfaceActive(surface, shownModes, ocForgeRail)}"),
      replace(
        "                  openContextSurface(directoryKey, selected.mode);",
        "                  if (!ocForgeSelectRailSurface(directoryKey, selected)) openContextSurface(directoryKey, selected.mode);",
      ),
    ],
    "packages/ui/src/hooks/useKeyboardShortcuts.ts": [
      insertAfter("import { getVisibleContextRailSurfaces } from '@/lib/surfaces/registry';", "\nimport { ocForgeSelectRailSurface } from '@/oc-forge/rail';"),
      replace(
        "            state.openContextSurface(directory, target.mode);",
        "            if (!ocForgeSelectRailSurface(directory, target)) state.openContextSurface(directory, target.mode);",
      ),
    ],
    "packages/ui/src/components/layout/ContextPanel.tsx": [
      insertAfter("import { isPluginContextPanelMode, pluginIdFromMode } from '@/lib/surfaces/modes';", "\nimport { ocForgeSurfaceLabel } from '@/oc-forge/rail';"),
      replace(
        "    return guest?.name ?? t('contextRail.surface.plugin');",
        "    return ocForgeSurfaceLabel(mode) ?? guest?.name ?? t('contextRail.surface.plugin');",
      ),
    ],
  },
}
