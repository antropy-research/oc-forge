// A panel that is the window's, not a folder's (`ocForge.globalPanel`): its
// pane is mounted in every folder, before it is first shown, so its frame
// loads at startup and lives through every change of chat or folder. Which
// folder shows it is host/panels.ts's (mounted with the host, no edit).
import { insertAfter, replace, type Adapter } from "../apply"

export const panels: Adapter = {
  name: "panels",
  summary: "a global panel (`ocForge.globalPanel`) is mounted once for the window, at startup, in every folder",
  edits: {
    "packages/ui/src/components/layout/ContextSurfacePanes.tsx": [
      insertAfter(
        "import { isPluginContextPanelMode, pluginIdFromMode, type PluginContextPanelMode } from '@/lib/surfaces/modes';",
        "\nimport { ocForgeWithGlobalPanels, useOcForgeGlobalPanelModes } from '@/oc-forge/panels';",
      ),
      replace(
        "  const pluginTabs = React.useMemo(() => tabs.filter((tab) => isPluginContextPanelMode(tab.mode)), [tabs]);",
        "  // oc-forge: a global panel's pane is mounted in every folder, whether or not the folder has its tab.\n" +
          "  const ocForgeGlobalModes = useOcForgeGlobalPanelModes();\n" +
          "  const pluginTabs = React.useMemo(\n" +
          "    () => ocForgeWithGlobalPanels(tabs.filter((tab) => isPluginContextPanelMode(tab.mode)), ocForgeGlobalModes),\n" +
          "    [ocForgeGlobalModes, tabs],\n" +
          "  );",
      ),
    ],
  },
}
