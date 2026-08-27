/**
 * @typedef {Object} Memory
 * @property {number} id
 * @property {string} content
 * @property {1|2|3|4} layer
 * @property {'global'|'project'|'user'|'daily'} track
 * @property {1|2|3|4|5} priority
 * @property {string[]} [tags]
 * @property {Float32Array|null} embedding
 * @property {string|null} source
 * @property {string} created
 * @property {string|null} updated
 */

/**
 * @typedef {Object} FtsSearchResult
 * @property {number} id
 * @property {string} content
 * @property {number} rank
 * @property {number} layer
 * @property {string} track
 * @property {number} priority
 */

/**
 * @typedef {Object} VecSearchResult
 * @property {number} id
 * @property {string} content
 * @property {number} dist
 * @property {number} layer
 * @property {string} track
 * @property {number} priority
 */

/**
 * @typedef {Object} MixedSearchResult
 * @property {number} id
 * @property {string} content
 * @property {number|null} dist
 * @property {number|null} rank
 * @property {number} layer
 * @property {string} track
 * @property {number} priority
 * @property {number} score
 * @property {string[]} matchedBy
 */

/**
 * @typedef {Object} MixedSearchStats
 * @property {number} vectorHits
 * @property {number} ftsHits
 * @property {number} total
 */

/**
 * @typedef {Object} SearchOptions
 * @property {number} [limit]
 * @property {1|2|3|4} [layer]
 * @property {Array<1|2|3|4>} [layers]
 * @property {'global'|'project'|'user'|'daily'} [track]
 * @property {boolean} [includeDeleted]
 */

/**
 * @typedef {Object} ListOptions
 * @property {number} [limit]
 * @property {number} [offset]
 * @property {string} [orderBy]
 * @property {1|2|3|4} [layer]
 * @property {'global'|'project'|'user'|'daily'} [track]
 * @property {number} [priority]
 * @property {number} [minPriority]
 * @property {string|Date} [since]
 * @property {boolean} [includeDeleted]
 */

/**
 * @typedef {Object} AddOptions
 * @property {1|2|3|4} [layer]
 * @property {'global'|'project'|'user'|'daily'} [track]
 * @property {1|2|3|4|5} [priority]
 * @property {string[]} [tags]
 * @property {string} [source]
 * @property {Float32Array} [embedding]
 */

/**
 * @typedef {Object} UpdateOptions
 * @property {string} [content]
 * @property {1|2|3|4} [layer]
 * @property {'global'|'project'|'user'|'daily'} [track]
 * @property {1|2|3|4|5} [priority]
 * @property {string[]} [tags]
 * @property {string} [source]
 * @property {Float32Array|null} [embedding]
 */

/**
 * @typedef {Object} RemoveOptions
 * @property {boolean} [hard]
 */

/**
 * @typedef {Object} EmbeddingConfig
 * @property {string} [apiKey]
 * @property {string} [baseURL]
 * @property {string} [model]
 * @property {number} [dimensions]
 * @property {number} [timeout]
 */

/**
 * @typedef {Object} ServiceConfig
 * @property {number} [vectorWeight]
 * @property {number} [ftsWeight]
 * @property {number} [topKVector]
 * @property {number} [topKFts5]
 * @property {number} [maxInject]
 * @property {number} [similarityThreshold]
 * @property {boolean} [autoEmbed]
 */

/**
 * @typedef {Object} MemoryServiceOptions
 * @property {MemoryStore} [store]
 * @property {EmbeddingClient} [embeddingClient]
 * @property {ServiceConfig} [config]
 */

/**
 * @typedef {Object} MixedSearchOutput
 * @property {MixedSearchResult[]} results
 * @property {MixedSearchStats} stats
 */

/**
 * @typedef {Object} PluginConfig
 * @property {string} [dbPath]
 * @property {string} [apiKey]
 * @property {string} [baseURL]
 * @property {string} [model]
 * @property {number} [vectorWeight]
 * @property {number} [ftsWeight]
 * @property {number} [topKVector]
 * @property {number} [topKFts5]
 * @property {number} [maxInject]
 * @property {number} [similarityThreshold]
 * @property {boolean} [autoEmbed]
 */

/**
 * 核心 SQLite 存储层：memories 主表 + FTS5 全文索引 + sqlite-vec 向量索引。
 */
export class MemoryStore {
  /** @param {string} [dbPath] */
  constructor(dbPath) {}
  /** @param {string} [dbPath] */
  open(dbPath) {}
  close() {}
  init() {}
  /** @param {Object} params */
  add(params) {}
  /** @param {number} id */
  get(id) {}
  /** @param {ListOptions} [filters] */
  list(filters) {}
  /** @param {number} id @param {UpdateOptions} [changes] */
  update(id, changes) {}
  /** @param {number} id @param {RemoveOptions} [options] */
  remove(id, options) {}
  /** @param {string} query @param {SearchOptions} [options] */
  ftsSearch(query, options) {}
  /** @param {Float32Array} vector @param {SearchOptions} [options] */
  vecSearch(vector, options) {}
  /** @param {string|null} query @param {Float32Array|null} vector @param {Object} [options] */
  mixedSearch(query, vector, options) {}
  getDatabase() {}
}

/**
 * Embedding API 客户端：兼容 DeepSeek 与 OpenAI 的 /embeddings 格式。
 */
export class EmbeddingClient {
  /** @param {EmbeddingConfig} [config] */
  constructor(config) {}
  /** @param {string|string[]} texts */
  embed(texts) {}
  /** @param {string} text */
  embedSingle(text) {}
}

/**
 * 高层记忆服务：组合存储层与 embedding 客户端。
 */
export class MemoryService {
  /** @param {MemoryStore|MemoryServiceOptions} storeOrOptions @param {EmbeddingClient} [embeddingClient] @param {ServiceConfig} [config] */
  constructor(storeOrOptions, embeddingClient, config) {}
  /** @param {string} content @param {AddOptions} [options] */
  async add(content, options) {}
  /** @param {string} query @param {SearchOptions} [options] */
  async search(query, options) {}
  /** @param {number} id */
  async get(id) {}
  /** @param {ListOptions} [options] */
  async list(options) {}
  /** @param {number} id @param {UpdateOptions} [changes] */
  async update(id, changes) {}
  /** @param {number} id @param {RemoveOptions} [options] */
  async remove(id, options) {}
  /** @param {Object} [options] */
  async injectForSession(options) {}
  dispose() {}
}

/** 向量维度常量（1024）。 */
export const VEC_DIMENSIONS = 1024;

/** 默认数据库路径。 */
export const DEFAULT_DB_PATH = '';

/**
 * DSH Cordis 插件名称。
 */
export const name = 'dsh-memory';

/**
 * DSH Cordis 插件注入目标。
 */
export const inject = ['tools'];

/**
 * DSH Cordis 插件配置 schema（需要 @deepseek-ai/schemastery）。
 */
export const Config = null;

/**
 * DSH Cordis 插件生命周期函数。
 * @param {Object} ctx
 * @param {PluginConfig} [config]
 */
export async function apply(ctx, config) {}

/**
 * 工厂函数：创建 MemoryService 实例。
 * @param {MemoryServiceOptions} [options]
 */
export function createService(options) {}

/**
 * 便捷函数：获取默认路径的 MemoryService。
 * @param {string} [dbPath]
 */
export function getMemoryService(dbPath) {}
