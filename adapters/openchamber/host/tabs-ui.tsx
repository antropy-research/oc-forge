import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { GuestIcon } from '@/components/layout/GuestRailIcon';
import { PluginPane } from '@/components/layout/PluginPane';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { isGuestActive } from '@/lib/guests/capabilities';
import { FALLBACK_GUEST_ICON, guestPackageIconSrc, resolveGuestIconName } from '@/lib/guests/icon';
import { useGuestsStore } from '@/lib/guests/store';
import type { InstalledGuest } from '@/lib/guests/types';
import { useI18n } from '@/lib/i18n';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';

import { useOcForgeStore, type OcForgeHeaderTab } from './store.ts';
import { activateOcForgeTab, requestCloseOcForgeTab, useOcForgeTabActive } from './tabs-state.ts';

const stop = (event: React.SyntheticEvent) => event.stopPropagation();

/** A tab's own icon, else its extension's. */
const tabIcon = (tab: OcForgeHeaderTab, guest: InstalledGuest | undefined): { icon: ReturnType<typeof resolveGuestIconName>; iconSrc?: string } => {
  const icon = tab.icon?.trim();
  if (icon?.startsWith('<')) return { icon: FALLBACK_GUEST_ICON, iconSrc: `data:image/svg+xml,${encodeURIComponent(icon)}` };
  if (icon) return { icon: resolveGuestIconName(icon) };
  if (!guest) return { icon: FALLBACK_GUEST_ICON };
  return {
    icon: resolveGuestIconName(guest.icon),
    iconSrc: guestPackageIconSrc(guest.id, guest.icon, getRuntimeUrlResolver().authenticatedAsset),
  };
};

const HeaderTab: React.FC<{ tab: OcForgeHeaderTab; guest: InstalledGuest | undefined; isActive: boolean }> = ({ tab, guest, isActive }) => {
  const { t } = useI18n();
  const select = () => activateOcForgeTab(tab.guestId, tab.id);
  const close = () => requestCloseOcForgeTab(tab.guestId, tab.id);
  const { icon, iconSrc } = tabIcon(tab, guest);
  return (
    <div
      className="app-region-no-drag session-tab-slot flex h-7 w-44 shrink-0"
      data-active={isActive ? 'true' : 'false'}
      data-oc-forge-tab={`${tab.guestId}:${tab.id}`}
      {...(isActive ? { 'data-active-session-tab': true } : {})}
    >
      <div
        role="tab"
        aria-selected={isActive}
        tabIndex={isActive ? undefined : 0}
        title={guest ? `${tab.title} — ${guest.name}` : tab.title}
        onClick={isActive ? undefined : select}
        onKeyDown={isActive ? undefined : (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            select();
          }
        }}
        onAuxClick={(event) => {
          if (event.button === 1) {
            event.preventDefault();
            close();
          }
        }}
        className={cn(
          'session-tab group/session-tab relative flex h-7 w-full min-w-0 select-none items-center rounded-md px-2',
          isActive
            ? 'bg-interactive-selection text-interactive-selection-foreground'
            : 'cursor-pointer text-muted-foreground hover:bg-interactive-hover hover:text-foreground',
        )}
      >
        <div className="flex min-w-0 flex-1 items-center group-hover/session-tab:pe-6">
          <GuestIcon icon={icon} iconSrc={iconSrc} className="me-1.5 size-3.5 shrink-0" />
          <span dir="auto" className="session-tab-title block min-w-0 flex-1 overflow-hidden whitespace-nowrap text-[0.8125rem] font-medium leading-4">
            {tab.title}
          </span>
          {tab.dirty ? (
            <span data-oc-forge-dirty aria-hidden="true" className="ms-1.5 size-2 shrink-0 rounded-full bg-current group-hover/session-tab:opacity-0" />
          ) : null}
        </div>
        <div
          onClick={stop}
          onPointerDown={stop}
          className="absolute inset-e-1 top-1/2 hidden -translate-y-1/2 items-center group-hover/session-tab:flex"
        >
          <button
            type="button"
            aria-label={t('header.sessionTabs.closeTab')}
            onClick={close}
            className="flex size-5 items-center justify-center rounded text-muted-foreground hover:text-foreground"
          >
            <Icon name="close" className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );
};

/** Extension tabs, after the session tabs in the header's strip. */
export const OcForgeHeaderTabs: React.FC = () => {
  const tabs = useOcForgeStore((state) => state.tabs);
  const activeTab = useOcForgeStore((state) => state.activeTab);
  const guests = useGuestsStore((state) => state.guests);
  const page = useUIStore((state) => state.openGuestPageId);
  const tabActive = useOcForgeTabActive();
  const shown = tabs.filter((tab) => {
    const guest = guests.find((entry) => entry.id === tab.guestId);
    return Boolean(guest?.pageEntry && isGuestActive(guest));
  });
  if (shown.length === 0) return null;
  return (
    <>
      {shown.map((tab) => (
        <HeaderTab
          key={`${tab.guestId}:${tab.id}`}
          tab={tab}
          guest={guests.find((entry) => entry.id === tab.guestId)}
          isActive={tabActive && page === tab.guestId && activeTab[tab.guestId] === tab.id}
        />
      ))}
    </>
  );
};

/**
 * Extension pages in the main area. The open one shows; a page whose
 * extension has header tabs stays mounted (hidden) while another tab or a
 * chat is shown, so switching back does not restart it. Without tabs a page
 * mounts and unmounts as in the release.
 */
export const OcForgeGuestPages: React.FC<{ openPage: InstalledGuest | null | undefined }> = ({ openPage }) => {
  const tabs = useOcForgeStore((state) => state.tabs);
  const guests = useGuestsStore((state) => state.guests);
  const kept = React.useMemo(() => {
    const ids = new Set<string>();
    for (const tab of tabs) {
      const guest = guests.find((entry) => entry.id === tab.guestId);
      if (guest?.pageEntry && isGuestActive(guest)) ids.add(guest.id);
    }
    return ids;
  }, [guests, tabs]);
  const ids = [...kept];
  if (openPage && !kept.has(openPage.id)) ids.push(openPage.id);
  return (
    <>
      {ids.map((id) => {
        const visible = id === openPage?.id;
        return (
          <div
            key={id}
            data-oc-forge-page={id}
            aria-hidden={visible ? undefined : true}
            className={cn('absolute inset-0 z-10 bg-background', !visible && 'invisible pointer-events-none')}
          >
            <ErrorBoundary>
              <PluginPane
                mode={`plugin:${id}`}
                surface="page"
                item={null}
                onDismiss={() => useUIStore.getState().setOpenGuestPage(null)}
              />
            </ErrorBoundary>
          </div>
        );
      })}
    </>
  );
};
