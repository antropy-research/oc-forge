// Time-ordered ids: sortable by creation time, unique enough for one person's planner.
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

export const newId = (now: number = Date.now()): string => {
  const random = new Uint8Array(10);
  crypto.getRandomValues(random);
  let suffix = '';
  for (const byte of random) suffix += ALPHABET[byte % 36];
  return now.toString(36).padStart(9, '0') + suffix;
};
