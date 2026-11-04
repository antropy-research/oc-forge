// The sources' marks, for the source rail and for a linked task's card (Sunsama: an integrated task card shows its
// tool's icon, and clicking it opens the item there).
import type { JSX } from 'preact';
import type { TaskSourceRef } from '../../src/domain/types.ts';

export const CalendarIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
    <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
    <path d="M3.5 10h17M8 3v4M16 3v4" />
  </svg>
);
export const BacklogIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round">
    <path d="M3.5 13.5l2.2-7.4A2 2 0 0 1 7.6 4.7h8.8a2 2 0 0 1 1.9 1.4l2.2 7.4v4.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
    <path d="M3.5 13.5h5l1.2 2h4.6l1.2-2h5" />
  </svg>
);
// Linear's mark: a disc cut by four parallel lines.
export const LinearIcon = () => (
  <svg viewBox="0 0 100 100" aria-hidden="true" fill="#5e6ad2">
    <path d="M1.2 61.5c-.2-1 1-1.6 1.6-.9l36.6 36.6c.7.7.1 1.8-.9 1.6A50 50 0 0 1 1.2 61.5z" />
    <path d="M0 46.9a1.5 1.5 0 0 0 .4 1.1l51.6 51.6c.3.3.7.4 1.1.4a50 50 0 0 0 6.9-.9c.8-.2 1-1.1.5-1.7L2.6 39.5c-.6-.6-1.5-.3-1.7.5A50 50 0 0 0 0 46.9z" />
    <path d="M4.2 29.7c-.2.4-.1.8.2 1.1l64.8 64.8c.3.3.7.4 1.1.2a50 50 0 0 0 5.2-2.7c.6-.3.6-1.1.2-1.5L8.4 24.3c-.5-.5-1.2-.4-1.5.2a50 50 0 0 0-2.7 5.2z" />
    <path d="M12.7 18.1a1.5 1.5 0 0 1-.1-2A50 50 0 1 1 84 87.4c-.6.5-1.4.5-2-.1z" />
  </svg>
);
export const GitHubIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
  </svg>
);
export const GmailIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path fill="#4285f4" d="M3.5 19.5h3.3v-8.1L2 7.8v10.2c0 .8.7 1.5 1.5 1.5z" />
    <path fill="#34a853" d="M17.2 19.5h3.3c.8 0 1.5-.7 1.5-1.5V7.8l-4.8 3.6z" />
    <path fill="#fbbc04" d="M17.2 5.3v6.1L22 7.8V5.9c0-1.8-2-2.8-3.4-1.7z" />
    <path fill="#ea4335" d="M6.8 11.4V5.3L12 9.2l5.2-3.9v6.1L12 15.3z" />
    <path fill="#c5221f" d="M2 5.9v1.9l4.8 3.6V5.3L5.4 4.2C4 3.1 2 4.1 2 5.9z" />
  </svg>
);
export const TasksIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="9.5" fill="#1a73e8" />
    <path d="M7.8 12.3l2.9 2.9 5.6-6.1" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
);

// Google Calendar's: its blue calendar.
export const GoogleCalendarIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="#1a73e8" stroke-width="1.9" stroke-linecap="round">
    <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
    <path d="M3.5 10h17M8 3v4M16 3v4" />
    <path d="M9.5 14.5h5" />
  </svg>
);
export const LinkIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round">
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
    <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
  </svg>
);

const ICONS: Record<TaskSourceRef['kind'], () => JSX.Element> = {
  linear: LinearIcon,
  github: GitHubIcon,
  email: GmailIcon,
  gtask: TasksIcon,
  event: GoogleCalendarIcon,
  link: LinkIcon,
};

export const SourceIcon = ({ kind }: { kind: TaskSourceRef['kind'] }) => {
  const Icon = ICONS[kind];
  return <Icon />;
};
