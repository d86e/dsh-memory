// src/service.js
// 高层记忆服务：组合存储层与 embedding 客户端，提供 add/search/inject 等能力。
export const DEFAULT_CONFIG = {
  vectorWeight: 0.6,
  ftsWeight: 0.4,
  topKVector: 5,
  topKFts5: 5,
  maxInject: 15,
  similarityThreshold: 0.15,
  autoEmbed: true,
};

const LAYER_TITLES = {
  4: 'Layer 4 · 深层记忆',
  3: 'Layer 3 · 整理后记忆',
  2: 'Layer 2 · 关键记忆',
};

export class MemoryService {
  // 支持 new MemoryService(store, embeddingClient, config)
  // 也支持 new MemoryService({ store, embeddingClient, config, logger })
  constructor(storeOrOptions, embeddingClient, config) {
    let store;
    let emb;
    let cfg;
    let logger;
    if (storeOrOptions && typeof storeOrOptions === 'object' && !storeOrOptions.store
        && typeof embeddingClient === 'undefined' && typeof config === 'undefined') {
      // 单个 options 对象形式
      ({ store, embeddingClient: emb, config: cfg, logger } = storeOrOptions);
    } else if (storeOrOptions && storeOrOptions.store) {
      ({ store, embeddingClient: emb, config: cfg, logger } = storeOrOptions);
    } else {
      store = storeOrOptions;
      emb = embeddingClient;
      cfg = config;
    }
    if (!store) throw new TypeError('MemoryService 需要 store 实例');
    this.store = store;
    this.embedding = emb || null;
    this.config = { ...DEFAULT_CONFIG, ...cfg };
    this.logger = logger || null;
  }

  // 添加记忆。options: { layer?, track?, priority?, tags?, source?, embedding? }
  async add(content, options = {}) {
    const { layer, track, priority, tags, source, embedding } = options;

    // 写入去重：检查 embedding 余弦相似度，超过阈值则更新已有记忆而非新增。
    if (this.embedding && this.config.autoEmbed && !embedding) {
      try {
        const newEmb = await this.embedding.embedSingle(content);
        if (newEmb) {
          const existing = this.store.findSimilar(newEmb, {
            track, layer, limit: 5,
            threshold: this.config.similarityThreshold,
          });
          if (existing.length > 0) {
            // 找到相似记忆，合并更新而非新增
            const best = existing[0];
            const updated = await this.update(best.id, {
              content: this._mergeContent(best.content, content),
              layer: layer ?? best.layer,
              track: track ?? best.track,
              priority: Math.max(priority ?? best.priority, best.priority),
            });
            this._log('info', `记忆去重：与 id=${best.id} 相似度 ${(1 - best.dist).toFixed(3)}，已合并更新`);
            return updated;
          }
        }
      } catch (err) {
        this._log('warn', `生成 embedding 失败（已跳过向量索引）: ${err.message}`);
      }
    }

    let emb = embedding;
    if (!emb && this.config.autoEmbed && this.embedding) {
      try {
        emb = await this.embedding.embedSingle(content);
      } catch (err) {
        this._log('warn', `生成 embedding 失败（已跳过向量索引）: ${err.message}`);
      }
    }
    return this.store.add({ content, layer, track, priority, tags, source, embedding: emb });
  }

  // 内部日志：注入的 logger 优先，否则静默
  _log(level, msg) {
    const l = this.logger;
    if (l && typeof l[level] === 'function') {
      try { l[level](`[dsh-memory] ${msg}`); return; } catch { /* fall through */ }
    }
    // fallback: 仅 warn 级别允许到 stderr（避免 process 信息丢失），其余忽略
    if (level === 'warn' && !l) {
      // eslint-disable-next-line no-console
      console.warn(`[dsh-memory] ${msg}`);
    }
  }

  /** 合并两条相似记忆内容：保留较长/较新的版本，附加差异信息。 */
  _mergeContent(oldContent, newContent) {
    if (oldContent.length >= newContent.length) return oldContent;
    // 简单策略：追加新内容片段，避免完全覆盖
    const suffix = newContent.replace(oldContent, '').trim();
    return suffix ? `${oldContent} [补充: ${suffix}]` : oldContent;
  }

  // 搜索记忆。options: { track?, layers?, limit?, useVector?, useFts5? }
  async search(query, options = {}) {
    const {
      track, layers, limit = 10,
      useVector = true, useFts5 = true,
    } = options;

    let vector = null;
    if (useVector && this.embedding && query) {
      try {
        vector = await this.embedding.embedSingle(query);
      } catch {
        vector = null;
      }
    }

    const canFts = useFts5 && Boolean(query);
    const canVec = useVector && Boolean(vector);
    if (!canFts && !canVec) {
      return { results: [], stats: { vectorHits: 0, ftsHits: 0, total: 0 } };
    }

    return this.store.mixedSearch(query, vector, {
      track, layers, limit,
      vectorWeight: this.config.vectorWeight,
      ftsWeight: this.config.ftsWeight,
      topKVector: this.config.topKVector,
      topKFts5: this.config.topKFts5,
      similarityThreshold: this.config.similarityThreshold,
      useFts5: canFts,
      useVector: canVec,
    });
  }

  async get(id) {
    return this.store.get(id);
  }

  async list(options = {}) {
    return this.store.list(options);
  }

  async update(id, changes = {}) {
    return this.store.update(id, changes);
  }

  async remove(id, options = {}) {
    return this.store.remove(id, options);
  }

  // 分页 + 过滤 + 排序（rows 不含 embedding）
  async listPage(opts = {}) {
    return this.store.listPage(opts);
  }

  // 统计：总数 + byLayer/Track/Priority + topTags
  async stats() {
    return this.store.stats();
  }

  // 批量操作
  async batchUpdate(ids, changes) {
    return this.store.batchUpdate(ids, changes);
  }
  async batchRemove(ids, options) {
    return this.store.batchRemove(ids, options);
  }
  async batchTag(ids, changes) {
    return this.store.batchTag(ids, changes);
  }

  // 会话注入：Layer 4 全部 + Layer 3 top-K + Layer 2 top-K（按 priority）。
  async injectForSession(options = {}) {
    const {
      track,
      maxInject = this.config.maxInject,
      includeLayer4 = true,
      topKLayer3 = 5,
      topKLayer2 = 10,
      orderBy = 'priority DESC, created DESC',
    } = options;

    const chunks = [];
    let count = 0;

    const addLayer = (layer, memories) => {
      const items = memories.slice(0, maxInject - count);
      if (items.length) {
        chunks.push(`## ${LAYER_TITLES[layer] || `Layer ${layer}`}`);
        for (const m of items) {
          chunks.push(this._formatMemory(m));
          count++;
        }
      }
    };

    if (includeLayer4) {
      addLayer(4, this.store.list({ layer: 4, track, limit: 100, orderBy }));
    }
    addLayer(3, this.store.list({ layer: 3, track, limit: topKLayer3, orderBy }));
    addLayer(2, this.store.list({ layer: 2, track, limit: topKLayer2, orderBy }));

    return chunks.join('\n');
  }

  _formatMemory(m) {
    const tags = Array.isArray(m.tags) && m.tags.length ? ` #${m.tags.join(' #')}` : '';
    const source = m.source ? ` (${m.source})` : '';
    return `- [L${m.layer}][${m.track}] ${m.content}${tags}${source}`;
  }
}
