// Linear's small glyphs, drawn with CSS and SVG in the host's colours: a
// state's circle (dashed for backlog, half for started, a tick for done), the
// priority bars, initials for people, label and project dots.

/** A workflow state's icon, by its type and colour, as Linear draws it. */
export const StatusIcon = ({ type, color, title }: { type: string; color: string; title?: string }) => (
  <span class={`lin-status is-${type}`} style={{ '--item-color': color }} title={title} aria-hidden="true">
    {type === 'completed' && (
      <svg viewBox="0 0 14 14" width="14" height="14"><path d="M4 7.2 6.1 9.3 10.2 5" fill="none" stroke="var(--oc-bg, #fff)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
    )}
    {type === 'canceled' && (
      <svg viewBox="0 0 14 14" width="14" height="14"><path d="M5 5l4 4M9 5l-4 4" fill="none" stroke="var(--oc-bg, #fff)" stroke-width="1.6" stroke-linecap="round" /></svg>
    )}
  </span>
);

/** Priority as Linear shows it: no priority dashes, bars for low to high, a square for urgent. */
export const PriorityIcon = ({ priority, title }: { priority: number; title?: string }) => {
  if (priority === 1) {
    return (
      <span class="lin-priority is-urgent" title={title} aria-hidden="true">
        <svg viewBox="0 0 14 14" width="14" height="14"><rect x="1" y="1" width="12" height="12" rx="3" fill="currentColor" /><path d="M7 3.8v4" stroke="var(--oc-bg, #fff)" stroke-width="1.6" stroke-linecap="round" /><circle cx="7" cy="10.2" r="0.95" fill="var(--oc-bg, #fff)" /></svg>
      </span>
    );
  }
  const level = priority === 2 ? 3 : priority === 3 ? 2 : priority === 4 ? 1 : 0;
  return (
    <span class={`lin-priority${level ? '' : ' is-none'}`} title={title} aria-hidden="true">
      <svg viewBox="0 0 14 14" width="14" height="14">
        {level === 0 ? (
          [2, 6, 10].map((x) => <rect key={x} x={x} y="6.4" width="2.2" height="1.4" rx="0.6" fill="currentColor" />)
        ) : (
          [0, 1, 2].map((bar) => <rect key={bar} x={1.5 + bar * 4} y={9 - bar * 3} width="2.6" height={3 + bar * 3} rx="0.7" fill="currentColor" opacity={bar < level ? 1 : 0.28} />)
        )}
      </svg>
    </span>
  );
};

const HUES = [210, 25, 145, 280, 340, 50, 180, 0, 95, 250];
const hueOf = (name: string): number => HUES[[...name].reduce((sum, char) => sum + char.charCodeAt(0), 0) % HUES.length]!;
const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('') || '?';

/** A person as their initials in a colour of their own; nobody as a dashed circle. */
export const Avatar = ({ name, size = 18 }: { name: string | null | undefined; size?: number }) =>
  name ? (
    <span class="lin-avatar" style={{ '--avatar-hue': String(hueOf(name)), width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.45)}px` }} title={name} aria-hidden="true">
      {initials(name)}
    </span>
  ) : (
    <span class="lin-avatar is-none" style={{ width: `${size}px`, height: `${size}px` }} title="No assignee" aria-hidden="true" />
  );

export const Dot = ({ color }: { color?: string | null }) => <span class="lin-dot" style={{ '--item-color': color ?? 'var(--oc-muted)' }} aria-hidden="true" />;

/** A project's mark: its colour in a small rounded square. */
export const ProjectIcon = ({ color }: { color?: string | null }) => <span class="lin-project-icon" style={{ '--item-color': color ?? 'var(--oc-muted)' }} aria-hidden="true" />;

export const CycleIcon = () => (
  <span class="lin-cycle-icon" aria-hidden="true">
    <svg viewBox="0 0 14 14" width="14" height="14"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-dasharray="2.2 1.6" /><circle cx="7" cy="7" r="2" fill="currentColor" /></svg>
  </span>
);

/** A saved view's mark: issues (a stack) or projects (a box). */
export const ViewIcon = ({ projects, color }: { projects?: boolean; color?: string | null }) => (
  <span class="lin-view-icon" style={{ '--item-color': color ?? 'currentColor' }} aria-hidden="true">
    {projects ? (
      <svg viewBox="0 0 14 14" width="14" height="14"><rect x="2" y="2.5" width="10" height="9" rx="2" fill="none" stroke="currentColor" stroke-width="1.4" /><path d="M2 6h10" stroke="currentColor" stroke-width="1.4" /></svg>
    ) : (
      <svg viewBox="0 0 14 14" width="14" height="14"><path d="M2.5 4.5h9M2.5 7h9M2.5 9.5h6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" /></svg>
    )}
  </span>
);

export const Kbd = ({ children }: { children: string }) => <kbd class="lin-kbd">{children}</kbd>;
