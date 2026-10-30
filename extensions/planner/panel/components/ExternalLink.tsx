// A link to a page outside OpenChamber (GitHub, Gmail…): it opens through the host, in a new browser tab, on a plain,
// Cmd/Ctrl or middle click alike, as the Planner's other links to such pages do.
import type { ComponentChildren } from 'preact';
import { usePlanner } from '../lib/context.ts';

export const ExternalLink = ({ href, label, className, children }: { href: string; label?: string; className?: string; children: ComponentChildren }) => {
  const { host, client } = usePlanner();
  const open = (event: MouseEvent) => {
    event.preventDefault();
    void host.openUrl(href).catch((error: unknown) => client.notify(`Could not open the link: ${error instanceof Error ? error.message : String(error)}`));
  };
  return (
    <a
      class={className}
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      title={href}
      {...(label ? { 'aria-label': label } : {})}
      onClick={open}
      onAuxClick={(event) => event.button === 1 && open(event)}
    >
      {children}
    </a>
  );
};
