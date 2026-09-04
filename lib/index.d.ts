/**
 * @file lib/index.d.ts
 * @description TypeScript declarations for @d86e/dsh-memory
 *
 * Aligned with v0.4.0 (commit 3715a2e). v0.3.0/v0.4.0 introduced:
 *   - Local ONNX embedding (nomic-embed-text-v1.5-int8, 768-dim)
 *   - listPage / stats / batchUpdate / batchRemove / batchTag
 *   - Active auto-memory via session/event listener
 *   - memory_save_decision tool (mandatory per-turn save)
 *   - systemPrompt.context auto-injection
 *   - HTTP API: /api/memory/{page,stats,batch}
 *   - logger injection on MemoryService
 */

/// <reference types="node" />

// ─── Memory record ────────────────────────────────────────────────────────────

/** Layer of a memory: 1=Raw 2=Key 3=Organized 4=Deep. */
export type MemoryLayer = 1 | 2 | 3 | 4;

/** Track / scope of a memory. */
export type MemoryTrack = 'global' | 'project' | 'user' | 'daily';

/** Priority of a memory (1-5; 0 = soft-deleted). */
export type MemoryPriority = 0 | 1 | 2 | 3 | 4 | 5;

/**
 * A persisted memory record. `embedding` is the raw 768-d Float32 vector
 * for rows returned from `MemoryStore.get/list`. `listPage` strips it to
 * reduce bandwidth.
 */
export interface Memory {
  id: number;
  content: string;
  layer: MemoryLayer;
  track: MemoryTrack;
  priority: MemoryPriority;
  tags: string[] | null;
  embedding: Float32Array | null;
  source: string | null;
  created: string;
  updated: string | null;
}

// ─── Search result shapes ─────────────────────────────────────────────────────

/** FTS5 search hit. `rank` is the BM25 score (lower = more relevant). */
export interface FtsSearchResult {
  id: number;
  content: string;
  rank: number;
  layer: MemoryLayer;
  track: MemoryTrack;
  priority: MemoryPriority;
  tags?: string[];
  /** Normalized 0-1 similarity, derived from `1 / (1 + |rank|)`. */
  score?: number;
}

/** Vector search hit. `dist` is cosine distance (lower = more similar). */
export interface VecSearchResult {
  id: number;
  content: string;
  dist: number;
  layer: MemoryLayer;
  track: MemoryTrack;
  priority: MemoryPriority;
  tags?: string[];
  /** Normalized 0-1 similarity, derived from `1 - dist`. */
  score?: number;
}

/** Result entry from `mixedSearch` / `search`. */
export interface MixedSearchResult {
  id: number;
  content: string;
  dist: number | null;
  rank: number | null;
  layer: MemoryLayer;
  track: MemoryTrack;
  priority: MemoryPriority;
  tags?: string[];
  score: number;
  matchedBy: ('vector' | 'fts5' | 'fts5-like')[];
}

export interface MixedSearchStats {
  vectorHits: number;
  ftsHits: number;
  total: number;
}

export interface MixedSearchOutput {
  results: MixedSearchResult[];
  stats: MixedSearchStats;
}

// ─── Add / update / remove options ────────────────────────────────────────────

export interface AddOptions {
  layer?: MemoryLayer;
  track?: MemoryTrack;
  priority?: MemoryPriority;
  tags?: string[];
  source?: string;
  embedding?: Float32Array | null;
}

export interface UpdateOptions {
  content?: string;
  layer?: MemoryLayer;
  track?: MemoryTrack;
  priority?: MemoryPriority;
  tags?: string[];
  source?: string;
  embedding?: Float32Array | null;
}

export interface RemoveOptions {
  /** When `true`, physically DELETE the row; default `false` is a soft delete (priority=0). */
  hard?: boolean;
}

// ─── List / search options ────────────────────────────────────────────────────

/** Sort column for `listPage`. */
export type ListPageSort = 'id' | 'content' | 'layer' | 'track' | 'priority' | 'created' | 'updated';
export type ListOrder = 'asc' | 'desc';

export interface ListPageOptions {
  offset?: number;
  limit?: number;
  sort?: ListPageSort;
  order?: ListOrder;
  layers?: MemoryLayer[];
  tracks?: MemoryTrack[];
  /** Hide soft-deleted rows. Default 1 (i.e. priority >= 1). */
  minPriority?: number;
  /** FTS5 keyword filter. */
  q?: string;
  /** Rows must contain ALL given tags. */
  tags?: string[];
}

export interface ListPageResult<T = Omit<Memory, 'embedding'>> {
  rows: T[];
  total: number;
  offset: number;
  limit: number;
}

export interface ListOptions {
  layer?: MemoryLayer;
  track?: MemoryTrack;
  priority?: MemoryPriority;
  minPriority?: number;
  limit?: number;
  offset?: number;
  orderBy?: string;
  includeDeleted?: boolean;
}

export interface SearchOptions {
  limit?: number;
  track?: MemoryTrack;
  layers?: MemoryLayer[];
  layer?: MemoryLayer;
  includeDeleted?: boolean;
  useVector?: boolean;
  useFts5?: boolean;
}

export interface FindSimilarOptions {
  track?: MemoryTrack;
  layer?: MemoryLayer;
  limit?: number;
  threshold?: number;
}

// ─── Stats ────────────────────────────────────────────────────────────────────

export interface StatsBucket {
  layer?: MemoryLayer;
  track?: MemoryTrack;
  priority?: MemoryPriority;
  n: number;
}

export interface TagCount {
  tag: string;
  count: number;
}

export interface StatsResult {
  total: number;
  byLayer: StatsBucket[];
  byTrack: StatsBucket[];
  byPriority: StatsBucket[];
  topTags: TagCount[];
}

// ─── Batch operations ─────────────────────────────────────────────────────────

export interface BatchUpdateResult {
  updated: number;
}

export interface BatchRemoveOptions {
  hard?: boolean;
}

export interface BatchRemoveResult {
  removed: number;
}

export interface BatchTagOptions {
  add?: string[];
  remove?: string[];
}

export interface BatchTagResult {
  updated: number;
}

// ─── Inject for session ───────────────────────────────────────────────────────

export interface InjectForSessionOptions {
  track?: MemoryTrack;
  maxInject?: number;
  includeLayer4?: boolean;
  topKLayer3?: number;
  topKLayer2?: number;
  orderBy?: string;
}

// ─── MemoryStore ──────────────────────────────────────────────────────────────

export interface MemoryStoreOptions {
  dimensions?: number;
}

/** Core SQLite storage: `memories` + FTS5 + sqlite-vec. */
export declare class MemoryStore {
  /** Default vector dimensions (768 = nomic-embed-text-v1.5-int8). */
  static readonly VEC_DIMENSIONS: number;

  /** Default DB path: `~/.dsh/memory.db`. */
  static readonly DEFAULT_DB_PATH: string;

  dimensions: number;
  dbPath: string;

  constructor(dbPath?: string, options?: MemoryStoreOptions);

  /** Open / connect the database; auto-creates dir, loads sqlite-vec, initializes schema. */
  open(dbPath?: string): this;
  close(): void;

  add(params: {
    content: string;
    layer?: MemoryLayer;
    track?: MemoryTrack;
    priority?: MemoryPriority;
    tags?: string[];
    source?: string;
    embedding?: Float32Array | null;
  }): Memory;

  get(id: number): Memory | null;
  list(filters?: ListOptions): Memory[];

  /** Paginated query with filter + sort. `rows` excludes `embedding` field. */
  listPage(opts?: ListPageOptions): ListPageResult;

  update(id: number, changes?: UpdateOptions): Memory | null;
  remove(id: number, options?: RemoveOptions): Memory | null;

  ftsSearch(query: string, options?: SearchOptions): FtsSearchResult[];
  vecSearch(vector: Float32Array, options?: SearchOptions): VecSearchResult[];
  mixedSearch(
    query: string | null,
    vector: Float32Array | null,
    options?: SearchOptions & {
      vectorWeight?: number;
      ftsWeight?: number;
      topKVector?: number;
      topKFts5?: number;
    },
  ): MixedSearchOutput;
  findSimilar(vector: Float32Array, options?: FindSimilarOptions): VecSearchResult[];

  stats(): StatsResult;

  batchUpdate(ids: number[], changes: UpdateOptions): BatchUpdateResult;
  batchRemove(ids: number[], options?: BatchRemoveOptions): BatchRemoveResult;
  /** @param changes `{ add?: string[]; remove?: string[] }` */
  batchTag(ids: number[], changes: BatchTagOptions): BatchTagResult;

  /** Expose the raw `better-sqlite3` Database instance. */
  getDatabase(): unknown;
}

// ─── EmbeddingClient ──────────────────────────────────────────────────────────

/**
 * Local ONNX embedding client (nomic-embed-text-v1.5-int8).
 * No API key, no network, no external service.
 */
export interface EmbeddingConfig {
  /** Override model path. Default: `<pkg>/models/nomic-embed-text-v1.5-int8.onnx`. */
  modelPath?: string;
  /** Vector dimensions. Default 768. */
  dimensions?: number;
}

export declare class EmbeddingClient {
  static readonly DEFAULT_DIMENSIONS: number;
  dimensions: number;
  modelPath: string;

  constructor(config?: EmbeddingConfig);

  /** Encode one text → 768-d Float32Array (L2-normalized). */
  embedSingle(text: string): Promise<Float32Array>;
  /** Encode many texts. Each element is a 768-d Float32Array. */
  embed(texts: string[]): Promise<Float32Array[]>;
  isAvailable(): boolean;
  getBackend(): 'local-onnx';
  /** Release the ONNX session (free memory). */
  dispose(): void;
}

// ─── MemoryService ────────────────────────────────────────────────────────────

export interface ServiceConfig {
  vectorWeight?: number;
  ftsWeight?: number;
  topKVector?: number;
  topKFts5?: number;
  maxInject?: number;
  /** Cosine distance threshold for dedup; rows with `dist <= threshold` are merged. Default 0.15. */
  similarityThreshold?: number;
  autoEmbed?: boolean;
}

/**
 * Minimal logger interface compatible with Cordis / DSH ctx.logger.
 * Any object with optional `info` / `warn` / `debug` / `error` methods works.
 */
export interface ServiceLogger {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  debug?: (msg: string) => void;
  error?: (msg: string) => void;
}

export interface MemoryServiceOptions {
  store?: MemoryStore;
  embeddingClient?: EmbeddingClient;
  config?: ServiceConfig;
  logger?: ServiceLogger | null;
}

export declare class MemoryService {
  static readonly DEFAULT_CONFIG: Required<ServiceConfig>;
  store: MemoryStore;
  embedding: EmbeddingClient | null;
  config: Required<ServiceConfig>;
  logger: ServiceLogger | null;

  /** Accepts either positional `(store, embeddingClient?, config?)` or single options object. */
  constructor(
    storeOrOptions: MemoryStore | MemoryServiceOptions,
    embeddingClient?: EmbeddingClient,
    config?: ServiceConfig,
  );

  add(content: string, options?: AddOptions): Promise<Memory>;
  search(query: string, options?: SearchOptions): Promise<MixedSearchOutput>;
  get(id: number): Promise<Memory | null>;
  list(options?: ListOptions): Promise<Memory[]>;
  update(id: number, changes?: UpdateOptions): Promise<Memory | null>;
  remove(id: number, options?: RemoveOptions): Promise<Memory | null>;

  listPage(opts?: ListPageOptions): Promise<ListPageResult>;
  stats(): Promise<StatsResult>;
  batchUpdate(ids: number[], changes: UpdateOptions): Promise<BatchUpdateResult>;
  batchRemove(ids: number[], options?: BatchRemoveOptions): Promise<BatchRemoveResult>;
  batchTag(ids: number[], changes: BatchTagOptions): Promise<BatchTagResult>;

  /** Build a markdown block of Layer 4 + Layer 3 + Layer 2 memories for system prompt. */
  injectForSession(options?: InjectForSessionOptions): Promise<string>;

  /** Close the underlying store. */
  dispose(): void;
}

// ─── Encoding helpers ─────────────────────────────────────────────────────────

/** Encode a Float32Array (or number[]) into the Buffer shape sqlite-vec expects. */
export declare function encodeEmbedding(value: Float32Array | number[] | Buffer | null): Buffer | null;
/** Decode a sqlite-vec BLOB back into a Float32Array. */
export declare function decodeEmbedding(value: Buffer | Float32Array | number[] | null): Float32Array | null;

// ─── Top-level constants ──────────────────────────────────────────────────────

/** Vector dimensions for the local nomic-embed model (768). */
export const VEC_DIMENSIONS: number;
/** Default DB path: `~/.dsh/memory.db`. */
export const DEFAULT_DB_PATH: string;

// ─── Active memory helpers ────────────────────────────────────────────────────

/** Category of an extracted key point. */
export type KeyPointCategory = 'pref' | 'decision' | 'error' | 'fact';

export interface KeyPoint {
  content: string;
  layer: MemoryLayer;
  track: MemoryTrack;
  cat: KeyPointCategory;
}

/** Options for `extractKeyPoints`. */
export interface ExtractKeyPointsOptions {
  /** Max input length to scan. Default 12000 chars. */
  maxLen?: number;
  /** Max key points to return. Default 5. */
  maxPoints?: number;
}

/**
 * Heuristically extract key memory points from an AI reply:
 *   preferences → layer 4 / user
 *   decisions   → layer 4 / project
 *   errors/fixes → layer 3 / project
 *   facts       → layer 3 / project
 * Filters markdown noise, meta-thoughts, low-signal lines.
 */
export declare function extractKeyPoints(
  rawText: string,
  opts?: ExtractKeyPointsOptions,
): KeyPoint[];

/**
 * Extract 2-8-char CJK phrases and 3+-letter English words from a user text,
 * for FTS5 keyword recall.
 */
export declare function extractKeywordsForRecall(text: string, max?: number): string[];

// ─── Factory functions ────────────────────────────────────────────────────────

export declare function createService(options?: {
  store?: MemoryStore;
  embeddingClient?: EmbeddingClient;
  dbPath?: string;
  dimensions?: number;
  config?: ServiceConfig;
  logger?: ServiceLogger | null;
}): MemoryService;

export declare function getMemoryService(dbPath?: string): MemoryService;

// ─── DSH Cordis plugin surface ────────────────────────────────────────────────

/** Cordis plugin name. */
export const name: 'dsh-memory';

/** Cordis injection targets. */
export const inject: readonly ['tools', 'webServer', 'sessions', 'systemPrompt'];

/**
 * Optional schemastery Config object. `null` when `@deepseek-ai/schemastery`
 * is not installed (e.g. for plain Node consumers).
 */
export const Config: unknown | null;

export interface PluginConfig {
  dbPath?: string;
  /** Default 0.6. */
  vectorWeight?: number;
  /** Default 0.4. */
  ftsWeight?: number;
  /** Default 5. */
  topKVector?: number;
  /** Default 5. */
  topKFts5?: number;
  /** Default 15. */
  maxInject?: number;
  /** Default 0.15. */
  similarityThreshold?: number;
  /** Default true. */
  autoEmbed?: boolean;
  /** Default 768. */
  dimensions?: number;
}

/** DSH Cordis plugin lifecycle. */
export declare function apply(ctx: unknown, config?: PluginConfig): Promise<void>;

// (No re-export block needed: MemoryStore / EmbeddingClient / MemoryService
//  are already declared and exported as classes above.)
