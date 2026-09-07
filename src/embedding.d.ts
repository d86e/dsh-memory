/**
 * @file src/embedding.d.ts
 * @description TypeScript declarations for `@d86e/dsh-memory/embedding` subpath.
 *
 * Mirrors the relevant subset of `lib/index.d.ts` so that
 * `package.json#exports["./embedding"].types` resolves to a real .d.ts.
 */

import {
  EmbeddingClient,
  type EmbeddingConfig,
} from '../lib/index.js';

export { EmbeddingClient };
export type { EmbeddingConfig };

/** Default vector dimensions for the local nomic-embed model (768). */
export const DEFAULT_DIMENSIONS: number;
