import { z } from 'zod';

import { readOcForgeManifest } from './protocol.ts';

/**
 * The catalog row's `ocForge` field. Malformed reads as absent: like the rest
 * of the catalog, a slice this build cannot read never drops the row.
 */
export const ocForgeManifestField = z.unknown().transform((value) => readOcForgeManifest(value)).optional();
