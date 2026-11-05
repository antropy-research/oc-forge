// Small helpers for values of unknown shape, for every layer: an error's message, a plain object.

/** What went wrong, for a message: an Error's message, or the value itself. */
export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A plain object (not null, not an array): something to read fields of. */
export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
