/**
 * @file src/memory-store.d.ts
 * @description TypeScript declarations for `@d86e/dsh-memory/memory-store` subpath.
 *
 * Mirrors the relevant subset of `lib/index.d.ts` so that
 * `package.json#exports["./memory-store"].types` resolves to a real .d.ts
 * for downstream TypeScript consumers.
 */

/// <reference types="node" />

import {
  MemoryStore,
  VEC_DIMENSIONS,
  DEFAULT_DB_PATH,
  type MemoryLayer,
  type MemoryTrack,
  type MemoryPriority,
  type Memory,
  type ListOptions,
  type ListPageOptions,
  type ListPageResult,
  type ListPageSort,
  type ListOrder,
  type UpdateOptions,
  type RemoveOptions,
  type SearchOptions,
  type FtsSearchResult,
  type VecSearchResult,
  type MixedSearchOutput,
  type MixedSearchResult,
  type MixedSearchStats,
  type FindSimilarOptions,
  type StatsResult,
  type StatsBucket,
  type TagCount,
  type BatchUpdateResult,
  type BatchRemoveOptions,
  type BatchRemoveResult,
  type BatchTagOptions,
  type BatchTagResult,
  type MemoryStoreOptions,
  type AddOptions,
} from '../lib/index.js';

export {
  MemoryStore,
  VEC_DIMENSIONS,
  DEFAULT_DB_PATH,
};

export type {
  MemoryLayer,
  MemoryTrack,
  MemoryPriority,
  Memory,
  AddOptions,
  ListOptions,
  ListPageOptions,
  ListPageResult,
  ListPageSort,
  ListOrder,
  UpdateOptions,
  RemoveOptions,
  SearchOptions,
  FtsSearchResult,
  VecSearchResult,
  MixedSearchOutput,
  MixedSearchResult,
  MixedSearchStats,
  FindSimilarOptions,
  StatsResult,
  StatsBucket,
  TagCount,
  BatchUpdateResult,
  BatchRemoveOptions,
  BatchRemoveResult,
  BatchTagOptions,
  BatchTagResult,
  MemoryStoreOptions,
};

/** Encode a Float32Array (or number[]) into the Buffer shape sqlite-vec expects. */
export function encodeEmbedding(
  value: Float32Array | number[] | Buffer | null,
): Buffer | null;

/** Decode a sqlite-vec BLOB back into a Float32Array. */
export function decodeEmbedding(
  value: Buffer | Float32Array | number[] | null,
): Float32Array | null;
