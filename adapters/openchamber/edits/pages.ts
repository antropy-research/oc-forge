// The bottom zone under an extension page that asks for it (`ocForge.page.
// keepBottomZone`): the release hides the bottom zone whenever a page covers
// the chat; such a page leaves it shown, its frames and panes included.
import { insertAfter, replace, type Adapter } from "../apply"

export const pages: Adapter = {
  name: "pages",
  summary: "an extension page may keep OpenChamber's bottom zone shown under it (an editor over its terminal)",
  edits: {
    "packages/ui/src/components/layout/ContextPanel.tsx": [
      insertAfter(
        "import { DockedPanelSurfaceContext } from '@/hooks/usePageColors';",
        "\nimport { useOcForgePageKeepsBottomZone } from '@/oc-forge/pages';",
      ),
      replace(
        "  const coveredByPage = zone === 'bottom' && chatCovered;",
        "  // oc-forge: unless the page on screen keeps the bottom zone under it.\n" +
          "  const ocForgeKeepsBottom = useOcForgePageKeepsBottomZone();\n" +
          "  const coveredByPage = zone === 'bottom' && chatCovered && !ocForgeKeepsBottom;",
      ),
    ],
    "packages/ui/src/components/layout/ContextSurfacePanes.tsx": [
      insertAfter(
        "import { DockedPanelSurfaceContext } from '@/hooks/usePageColors';",
        "\nimport { useOcForgePageKeepsBottomZone } from '@/oc-forge/pages';",
      ),
      replace(
        "  const chatCovered = useRightSlotStore((state) => state.chatCovered);\n\n  // What each zone shows.",
        "  const chatCovered = useRightSlotStore((state) => state.chatCovered);\n" +
          "  // oc-forge: a page that keeps the bottom zone under it leaves its panes there.\n" +
          "  const ocForgeKeepsBottom = useOcForgePageKeepsBottomZone();\n\n  // What each zone shows.",
      ),
      replace(
        "      const covered = zone === 'bottom' && chatCovered;",
        "      const covered = zone === 'bottom' && chatCovered && !ocForgeKeepsBottom;",
      ),
      replace(
        "  }, [chatCovered, panelState, placement]);",
        "  }, [chatCovered, ocForgeKeepsBottom, panelState, placement]);",
      ),
    ],
  },
}
