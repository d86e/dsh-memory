/**
 * @file src/service.d.ts
 * @description TypeScript declarations for `@d86e/dsh-memory/service` subpath.
 *
 * Mirrors the relevant subset of `lib/index.d.ts` so that
 * `package.json#exports["./service"].types` resolves to a real .d.ts.
 */

import {
  MemoryService,
  type ServiceConfig,
  type ServiceLogger,
  type MemoryServiceOptions,
  type AddOptions,
  type UpdateOptions,
  type RemoveOptions,
  type SearchOptions,
  type ListOptions,
  type ListPageOptions,
  type ListPageResult,
  type MixedSearchOutput,
  type StatsResult,
  type BatchUpdateResult,
  type BatchRemoveOptions,
  type BatchRemoveResult,
  type BatchTagOptions,
  type BatchTagResult,
  type InjectForSessionOptions,
} from '../lib/index.js';

export { MemoryService };

export type {
  ServiceConfig,
  ServiceLogger,
  MemoryServiceOptions,
  AddOptions,
  UpdateOptions,
  RemoveOptions,
  SearchOptions,
  ListOptions,
  ListPageOptions,
  ListPageResult,
  MixedSearchOutput,
  StatsResult,
  BatchUpdateResult,
  BatchRemoveOptions,
  BatchRemoveResult,
  BatchTagOptions,
  BatchTagResult,
  InjectForSessionOptions,
};

/** Default service config: vector 0.6 / fts 0.4 / topK 5 / maxInject 15 / threshold 0.15 / autoEmbed true. */
export const DEFAULT_CONFIG: Required<ServiceConfig>;
