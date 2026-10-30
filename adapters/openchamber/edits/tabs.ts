// R2: extension tabs in the header's strip, after the session tabs. The page
// opened from a tab keeps the strip (the release swaps it for "← title"), and
// OpenChamber's own tab shortcuts reach the extension tabs too. The strip keeps
// the selected extension tab in view as it keeps the selected session's, and
// while extension tabs overflow it a button at its end lists every tab. The
// page staying mounted behind its tabs is the core adapter's OcForgeGuestPages.
import { insertAfter, insertBefore, replace, type Adapter } from "../apply"

export const tabs: Adapter = {
  name: "tabs",
  summary: "extension tabs in the header strip beside the session tabs, kept-alive pages, tab shortcuts across both",
  edits: {
    "packages/ui/src/lib/sessionTabs.ts": [
      insertAfter(
        "import { useSessionUIStore } from '@/sync/session-ui-store';",
        "\nimport { ocForgeActivateAdjacentTab, ocForgeActivateTabByIndex } from '@/oc-forge/tabs-state';",
      ),
      replace(
        "export const activateSessionTabByIndex = (index: number): boolean => {",
        "const activateSessionTabByIndexInStrip = (index: number): boolean => {",
      ),
      replace(
        "export const activateAdjacentSessionTab = (delta: -1 | 1): boolean => {",
        "const activateAdjacentSessionTabInStrip = (delta: -1 | 1): boolean => {",
      ),
      insertBefore(
        "/**\n * Close one header session tab. Closing the active tab activates its right",
        "/** oc-forge: digits and previous/next go on past the session tabs into the extension tabs. */\n" +
          "export const activateSessionTabByIndex = (index: number): boolean => (\n" +
          "  ocForgeActivateTabByIndex(index, activateSessionTabByIndexInStrip)\n" +
          ");\n\n" +
          "export const activateAdjacentSessionTab = (delta: -1 | 1): boolean => (\n" +
          "  ocForgeActivateAdjacentTab(delta, activateAdjacentSessionTabInStrip)\n" +
          ");\n\n",
      ),
    ],
    "packages/ui/src/components/layout/SessionTabsStrip.tsx": [
      insertAfter(
        "import { closeSessionTabAndActivateNeighbour } from '@/lib/sessionTabs';",
        "\nimport { leaveOcForgeTab, useOcForgeActiveTabKey, useOcForgeTabActive, useOcForgeTabCount } from '@/oc-forge/tabs-state';\nimport { OcForgeAllTabs, OcForgeHeaderTabs } from '@/oc-forge/tabs-ui';",
      ),
      insertAfter(
        "  const activeSessions = useGlobalSessionsStore((state) => state.activeSessions);",
        "\n  // oc-forge: while an extension tab is selected no session tab is.\n  const ocForgeTabActive = useOcForgeTabActive();" +
          "\n  // oc-forge: the selected extension tab is kept in view too, and the fades follow extension tabs as they come and go." +
          "\n  const ocForgeActiveTabKey = useOcForgeActiveTabKey();\n  const ocForgeTabCount = useOcForgeTabCount();",
      ),
      insertAfter("  const handleSelect = React.useCallback((tab: SessionTab) => {", "\n    leaveOcForgeTab();"),
      replace("                isActive={tab.id === currentSessionId}", "                isActive={tab.id === currentSessionId && !ocForgeTabActive}"),
      replace(
        "  const showPendingTab = Boolean(currentSessionId) && !tabs.some((tab) => tab.id === currentSessionId);",
        "  const showPendingTab = Boolean(currentSessionId) && !tabs.some((tab) => tab.id === currentSessionId) && !ocForgeTabActive;",
      ),
      insertAfter(
        "            <div className=\"min-w-0 flex-1\">{children}</div>\n          </div>\n        ) : null}",
        "\n        <OcForgeHeaderTabs />",
      ),
      replace("  }, [updateEdges, tabs.length]);", "  }, [updateEdges, tabs.length, ocForgeTabCount]);"),
      replace("  }, [currentSessionId, updateEdges]);", "  }, [currentSessionId, ocForgeActiveTabKey, updateEdges]);"),
      // After the scroller, so it stays at the strip's end.
      insertAfter(
        "        <OcForgeHeaderTabs />\n      </div>",
        "\n      <OcForgeAllTabs\n" +
          "        overflowing={edges.left || edges.right}\n" +
          "        sessions={tabs.map((tab) => ({ id: tab.id, title: tab.session.title?.trim() || t('sessions.sidebar.session.untitled'), active: tab.id === currentSessionId && !ocForgeTabActive }))}\n" +
          "        onSelectSession={(id) => {\n" +
          "          const tab = tabs.find((entry) => entry.id === id);\n" +
          "          if (tab) handleSelect(tab);\n" +
          "        }}\n" +
          "      />",
      ),
    ],
    "packages/ui/src/components/layout/Header.tsx": [
      insertAfter(
        "import { SessionTabsStrip, type SessionTabMenuArgs } from './SessionTabsStrip';",
        "\nimport { useOcForgeTabbedPage } from '@/oc-forge/tabs-state';",
      ),
      replace(
        "  const guestPage = useGuestsStore((state) => state.guests.find((guest) => guest.id === openGuestPageId));",
        "  // oc-forge: a page shown on one of its header tabs keeps the tab strip instead of \"← title\".\n" +
          "  const ocForgeTabbedPage = useOcForgeTabbedPage(openGuestPageId);\n" +
          "  const guestPage = useGuestsStore((state) => (ocForgeTabbedPage ? undefined : state.guests.find((guest) => guest.id === openGuestPageId)));",
      ),
    ],
    "packages/ui/src/hooks/useKeyboardShortcuts.ts": [
      insertAfter(
        "import { activateAdjacentSessionTab, activateSessionTabByIndex, closeSessionTabAndActivateNeighbour } from '@/lib/sessionTabs';",
        "\nimport { ocForgeCloseActiveTab } from '@/oc-forge/tabs-state';",
      ),
      insertBefore(
        "      if (currentSessionId) {\n        closeSessionTabAndActivateNeighbour(currentSessionId);",
        "      if (ocForgeCloseActiveTab()) return;\n",
      ),
    ],
  },
}
