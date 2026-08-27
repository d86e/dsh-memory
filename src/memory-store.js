// src/memory-store.js
// 核心 SQLite 存储层：memories 主表 + FTS5 全文索引 + sqlite-vec 向量索引。
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import * as vec from 'sqlite-vec';

export const VEC_DIMENSIONS = 768;
export const DEFAULT_DB_PATH = join(homedir(), '.dsh', 'memory.db');

// 将向量编码为 sqlite-vec 要求的 float32 BLOB（小端，每元素 4 字节）。
export function encodeEmbedding(value) {
  if (value == null) return null;
  if (Buffer.isBuffer(value)) return value;
  const f32 = value instanceof Float32Array ? value : new Float32Array(value);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

// 将 BLOB 解码回 Float32Array。
export function decodeEmbedding(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return new Float32Array(value);
  if (value instanceof Float32Array) return value;
  if (Buffer.isBuffer(value)) {
    return new Float32Array(value.buffer, value.byteOffset, value.byteLength / 4);
  }
  return null;
}

// SCHEMA_SQL 由 init(dimensions) 动态生成，避免硬编码维度。

const TRIGGERS_SQL = `
CREATE TRIGGER IF NOT EXISTS memories_ai_fts AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad_fts AFTER DELETE ON memories BEGIN
  DELETE FROM memories_fts WHERE rowid = old.id;
END;

CREATE TRIGGER IF NOT EXISTS memories_au_fts AFTER UPDATE ON memories BEGIN
  UPDATE memories_fts SET content = new.content WHERE rowid = old.id;
END;
`;

// orderBy 白名单，防止 SQL 注入。
const ALLOWED_ORDER_BY = new Set([
  'id DESC', 'id ASC',
  'created DESC', 'created ASC',
  'updated DESC', 'updated ASC',
  'priority DESC', 'priority ASC',
  'layer DESC', 'layer ASC',
  'priority DESC, created DESC',
  'priority DESC, created ASC',
  'priority ASC, created DESC',
  'priority ASC, created ASC',
  'created DESC, priority DESC',
  'created ASC, priority ASC',
]);

function validateOrderBy(orderBy) {
  const key = String(orderBy).trim();
  if (!ALLOWED_ORDER_BY.has(key)) {
    throw new Error(`不支持的 orderBy: ${orderBy}`);
  }
  return key;
}

// 将自由文本查询转为 FTS5 查询串：按非字母/数字切分 token，逐个加引号后用 AND 连接。
function toFtsQuery(query) {
  const cleaned = String(query).replace(/["']/g, ' ').trim();
  if (!cleaned) return null;
  const tokens = cleaned.split(/[^\p{L}\p{N}]+/gu).filter(Boolean);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"`).join(' AND ');
}

export class MemoryStore {
  // options: { dimensions?: number } — 默认 1024，可与 embedding 模型维度对齐。
  constructor(dbPath = DEFAULT_DB_PATH, options = {}) {
    this.dimensions = options.dimensions || VEC_DIMENSIONS;
    this.dbPath = dbPath;
    this.db = null;
    this.open(dbPath);
  }

  // 打开/连接数据库；自动建目录、加载 sqlite-vec、初始化 schema。
  open(dbPath = this.dbPath) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.dbPath = dbPath;
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    vec.load(this.db);
    this.init(this.dimensions);
    return this;
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  // 初始化 schema 与触发器（幂等）。
  init(dimensions) {
    const dim = dimensions || this.dimensions;
    const schemaSql = `
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  layer INTEGER NOT NULL DEFAULT 2,
  track TEXT NOT NULL DEFAULT 'global',
  priority INTEGER NOT NULL DEFAULT 3,
  tags TEXT,
  embedding BLOB,
  source TEXT,
  created DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated DATETIME
);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  content='memories',
  content_rowid='id'
);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(
  embedding float[${dim}]
);

CREATE INDEX IF NOT EXISTS idx_memories_layer ON memories(layer);
CREATE INDEX IF NOT EXISTS idx_memories_track ON memories(track);
CREATE INDEX IF NOT EXISTS idx_memories_priority ON memories(priority);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created);
`;
    this.db.exec(schemaSql);
    this.db.exec(TRIGGERS_SQL);
  }

  // 新增一条记忆，返回完整记录（含 id）。
  add(params = {}) {
    const {
      content, layer = 2, track = 'global', priority = 3,
      tags, source, embedding,
    } = params;
    if (!content || typeof content !== 'string') {
      throw new TypeError('内容字段 content 必填且需为字符串');
    }
    // 参数校验
    const safeLayer = Math.min(4, Math.max(1, Number(layer) || 2));
    const validTracks = ['global', 'project', 'user', 'daily'];
    if (!validTracks.includes(String(track))) {
      throw new TypeError(`无效的 track "${track}"，可选值：${validTracks.join(', ')}`);
    }
    const safePriority = Math.min(5, Math.max(1, Number(priority) || 3));
    const tagsJson = this._encodeTags(tags);
    const emb = encodeEmbedding(embedding);
    if (emb && emb.byteLength / 4 !== this.dimensions) {
      throw new Error(`向量维度不匹配：期望 ${this.dimensions} 维，实际 ${emb.byteLength / 4} 维`);
    }
    // 事务：INSERT 主表 + 同步向量索引原子执行
    const addTx = this.db.transaction((p) => {
      const info = this.db.prepare(`
        INSERT INTO memories (content, layer, track, priority, tags, embedding, source)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(p.content, p.layer, p.track, p.priority, p.tagsJson, p.emb, p.source ?? null);
      if (p.emb) this._syncVecInsert(Number(info.lastInsertRowid), p.emb);
      return info.lastInsertRowid;
    });
    const id = addTx({ content, layer: safeLayer, track, priority: safePriority, tagsJson, emb, source });
    return this.get(id);
  }

  // 按 id 读取，无则返回 null。
  get(id) {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
    return this._toMemory(row);
  }

  // 列表查询，支持 layer/track/priority/minPriority/since 过滤。
  list(filters = {}) {
    const {
      layer, track, priority, minPriority,
      since, limit = 50, offset = 0, orderBy = 'created DESC',
      includeDeleted = false,
    } = filters;
    // 参数校验与兜底
    const clampedLimit = Math.max(1, Math.min(Number(limit) || 50, 1000));
    const clampedOffset = Math.max(0, Number(offset) || 0);
    const clampedMinPriority = minPriority !== undefined ? Math.min(5, Math.max(0, Number(minPriority) || 0)) : undefined;
    const clampedPriority = priority !== undefined ? Math.min(5, Math.max(0, Number(priority) || 0)) : undefined;
    const clampedLayer = layer !== undefined ? Math.min(4, Math.max(1, Number(layer) || 0)) : undefined;

    const where = [];
    const params = [];
    if (clampedLayer !== undefined) { where.push('layer = ?'); params.push(clampedLayer); }
    if (track !== undefined) { where.push('track = ?'); params.push(track); }
    if (clampedPriority !== undefined) { where.push('priority = ?'); params.push(clampedPriority); }
    if (clampedMinPriority !== undefined) { where.push('priority >= ?'); params.push(clampedMinPriority); }
    if (since !== undefined) {
      const sinceStr = since instanceof Date
        ? since.toISOString().replace('T', ' ').slice(0, 19)
        : String(since);
      where.push('created >= ?');
      params.push(sinceStr);
    }
    // 默认隐藏软删除（priority=0）的记忆。
    if (!includeDeleted && priority === undefined) {
      where.push('priority > 0');
    }

    const sql = `SELECT * FROM memories
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY ${validateOrderBy(orderBy)}
      LIMIT ? OFFSET ?`;
    const rows = this.db.prepare(sql).all(...params, clampedLimit, clampedOffset);
    return rows.map((r) => this._toMemory(r));
  }

  // 更新字段；自动设置 updated 时间戳，返回更新后的记录（无则 null）。
  update(id, changes = {}) {
    const fields = [];
    const params = [];
    const allowed = ['content', 'layer', 'track', 'priority', 'tags', 'source', 'embedding'];
    for (const key of Object.keys(changes)) {
      if (!allowed.includes(key)) continue;
      if (key === 'embedding') {
        const emb = encodeEmbedding(changes.embedding);
        if (emb && emb.byteLength / 4 !== VEC_DIMENSIONS) {
          throw new Error(`向量维度不匹配：期望 ${VEC_DIMENSIONS} 维，实际 ${emb.byteLength / 4} 维`);
        }
        fields.push('embedding = ?');
        params.push(emb);
      } else if (key === 'tags') {
        fields.push('tags = ?');
        params.push(this._encodeTags(changes.tags));
      } else {
        fields.push(`${key} = ?`);
        params.push(changes[key]);
      }
    }
    if (fields.length === 0) return this.get(id);
    // 事务：获取旧状态 + UPDATE + 向量索引同步
    const updateTx = this.db.transaction(() => {
      const oldRow = this.get(id);
      const oldEmb = encodeEmbedding(oldRow?.embedding);
      this.db.prepare(
        `UPDATE memories SET ${fields.join(', ')}, updated = CURRENT_TIMESTAMP WHERE id = ?`
      ).run(...params, id);
      const newEmb = encodeEmbedding(changes.embedding);
      if (newEmb || oldEmb) {
        this.db.prepare('DELETE FROM memories_vec WHERE rowid = ?').run(BigInt(id));
        if (newEmb) this._syncVecInsert(id, newEmb);
      }
      return this.get(id);
    });
    return updateTx();
  }

  // 删除：默认软删除（priority=0），hard=true 时物理删除并清理 FTS/向量索引。
  remove(id, options = {}) {
    const { hard = false } = options;
    if (hard) {
      // 物理删除：清理所有索引
      this.db.prepare('DELETE FROM memories_vec WHERE rowid = ?').run(id);
      const info = this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
      return info.changes > 0;
    }
    const info = this.db.prepare(
      'UPDATE memories SET priority = 0, updated = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(id);
    return info.changes > 0;
  }

  // FTS5 关键词检索。
  ftsSearch(query, options = {}) {
    const limit = typeof options === 'number' ? options : (options.limit ?? 10);
    return this._ftsSearch(query, { ...options, limit });
  }

  _ftsSearch(query, options = {}) {
    const { limit = 10, layer, layers, track, includeDeleted = false } = options;
    const ftsQuery = toFtsQuery(query);
    if (!ftsQuery) return [];

    let sql = `SELECT m.id, m.content, m.layer, m.track, m.priority, fts.rank AS rank
      FROM (SELECT rowid, rank FROM memories_fts WHERE memories_fts MATCH ?) fts
      JOIN memories m ON m.id = fts.rowid
      WHERE 1=1`;
    const params = [ftsQuery];
    if (!includeDeleted) { sql += ' AND m.priority > 0'; }
    if (layer !== undefined) { sql += ' AND m.layer = ?'; params.push(layer); }
    if (layers && layers.length) {
      sql += ` AND m.layer IN (${layers.map(() => '?').join(',')})`;
      params.push(...layers);
    }
    if (track !== undefined) { sql += ' AND m.track = ?'; params.push(track); }
    sql += ' ORDER BY fts.rank LIMIT ?';
    params.push(Number(limit) || 10);

    const rows = this.db.prepare(sql).all(...params);
    if (rows.length > 0) {
      return rows.map((r) => ({
        id: r.id, content: r.content, rank: r.rank,
        layer: r.layer, track: r.track, priority: r.priority,
      }));
    }

    // FTS5 unicode61/trigram tokenizers 无法索引 CJK（中日韩）字符，
    // 当 MATCH 无结果时回退到 SQL LIKE 查询。
    if (/[\u4e00-\u9fff]/.test(query)) {
      return this._ftsSearchLike(query, { limit, layer, layers, track, includeDeleted });
    }
    return rows;
  }

  /** FTS MATCH 无结果时的 LIKE 回退（用于中文等 CJK 文本）。 */
  _ftsSearchLike(query, options = {}) {
    const { limit = 10, layer, layers, track, includeDeleted = false } = options;
    let sql = 'SELECT id, content, layer, track, priority FROM memories WHERE 1=1';
    const params = [];
    if (!includeDeleted) { sql += ' AND priority > 0'; }
    if (layer !== undefined) { sql += ' AND layer = ?'; params.push(layer); }
    if (layers && layers.length) {
      sql += ` AND layer IN (${layers.map(() => '?').join(',')})`;
      params.push(...layers);
    }
    if (track !== undefined) { sql += ' AND track = ?'; params.push(track); }
    // 多关键词：每个词用 OR 连接，LIKE 模糊匹配
    const tokens = query.split(/[^\p{L}\p{N}]+/gu).filter(Boolean);
    if (tokens.length > 0) {
      const likeConditions = tokens.map(() => 'content LIKE ?').join(' OR ');
      sql += ` AND (${likeConditions})`;
      params.push(...tokens.map((t) => `%${t}%`));
    } else {
      sql += ' AND content LIKE ?';
      params.push(`%${query}%`);
    }
    sql += ' ORDER BY priority DESC, id DESC LIMIT ?';
    params.push(Number(limit) || 10);
    const rows = this.db.prepare(sql).all(...params);
    return rows.map((r) => ({ ...r, rank: 0 }));
  }

  // 向量检索（余弦距离）。
  vecSearch(vector, options = {}) {
    const opts = typeof options === 'number' ? { limit: options } : options;
    const { layer, layers, track, limit = 5, includeDeleted = false } = opts;
    const v = encodeEmbedding(vector);
    if (!v) throw new TypeError('缺少向量 vector');
    const dim = v.byteLength / 4;
    if (dim !== this.dimensions) {
      throw new Error(`向量维度不匹配：期望 ${this.dimensions} 维，实际 ${dim} 维`);
    }

    let sql = `SELECT m.id, m.content, m.layer, m.track, m.priority,
        vec_distance_cosine(mv.embedding, ?) AS dist
      FROM memories_vec mv
      JOIN memories m ON m.id = mv.rowid
      WHERE 1=1`;
    const params = [v];
    if (!includeDeleted) { sql += ' AND m.priority > 0'; }
    if (layer !== undefined) { sql += ' AND m.layer = ?'; params.push(layer); }
    if (layers && layers.length) {
      sql += ` AND m.layer IN (${layers.map(() => '?').join(',')})`;
      params.push(...layers);
    }
    if (track !== undefined) { sql += ' AND m.track = ?'; params.push(track); }
    sql += ' ORDER BY dist ASC LIMIT ?';
    params.push(Number(limit) || 5);

    const rows = this.db.prepare(sql).all(...params);
    return rows.map((r) => ({
      id: r.id, content: r.content, dist: r.dist,
      layer: r.layer, track: r.track, priority: r.priority,
    }));
  }

  // 查找相似记忆（用于写入去重）。返回距离最小的前 N 条。
  findSimilar(vector, options = {}) {
    const opts = typeof options === 'number' ? { limit: options } : options;
    const { limit = 5, threshold = 0.15, layer, track } = opts;
    const v = encodeEmbedding(vector);
    if (!v) return [];
    const dim = v.byteLength / 4;
    if (dim !== this.dimensions) return [];

    let sql = `SELECT m.id, m.content, m.layer, m.track, m.priority,
        vec_distance_cosine(mv.embedding, ?) AS dist
      FROM memories_vec mv
      JOIN memories m ON m.id = mv.rowid
      WHERE m.priority > 0`;
    const params = [v];
    if (layer !== undefined) { sql += ' AND m.layer = ?'; params.push(layer); }
    if (track !== undefined) { sql += ' AND m.track = ?'; params.push(track); }
    sql += ' ORDER BY dist ASC LIMIT ?';
    params.push(Number(limit) || 5);

    const rows = this.db.prepare(sql).all(...params);
    // 过滤掉距离过大（相似度太低）的结果
    return rows.filter((r) => r.dist <= threshold).map((r) => ({
      id: r.id, content: r.content, dist: r.dist,
      layer: r.layer, track: r.track, priority: r.priority,
    }));
  }

  // 混合检索：FTS5 BM25 + 向量余弦距离，加权融合、去重、排序。
  mixedSearch(query, vector, options = {}) {
    const {
      layer, layers, track,
      limit = 10,
      vectorWeight = 0.6,
      ftsWeight = 0.4,
      topKVector = 5,
      topKFts5 = 5,
      similarityThreshold = 0.15,
      useVector = true,
      useFts5 = true,
      includeDeleted = false,
    } = options;

    let vecResults = [];
    let ftsResults = [];
    if (useVector && vector) {
      try {
        vecResults = this.vecSearch(vector, { layer, layers, track, limit: topKVector, includeDeleted });
      } catch {
        vecResults = [];
      }
    }
    if (useFts5 && query) {
      ftsResults = this._ftsSearch(query, { layer, layers, track, limit: topKFts5, includeDeleted });
    }

    // 向量：余弦距离 -> 相似度 1 - dist，低于阈值丢弃。
    const vecById = new Map();
    for (const r of vecResults) {
      const sim = 1 - r.dist;
      if (sim >= similarityThreshold) {
        vecById.set(r.id, { ...r, sim });
      }
    }
    // FTS5：rank 为负（越小越相关），取负转正。
    const ftsById = new Map();
    for (const r of ftsResults) {
      ftsById.set(r.id, { ...r, ftsScore: -r.rank });
    }

    const vecVals = [...vecById.values()].map((r) => r.sim);
    const ftsVals = [...ftsById.values()].map((r) => r.ftsScore);
    const vecMin = vecVals.length ? Math.min(...vecVals) : 0;
    const vecMax = vecVals.length ? Math.max(...vecVals) : 0;
    const ftsMin = ftsVals.length ? Math.min(...ftsVals) : 0;
    const ftsMax = ftsVals.length ? Math.max(...ftsVals) : 0;

    const norm = (v, min, max) => (max === min ? 1 : (v - min) / (max - min));

    const combined = new Map();
    for (const [id, r] of vecById) {
      const normVec = norm(r.sim, vecMin, vecMax);
      const ftsEntry = ftsById.get(id);
      const normFts = ftsEntry ? norm(ftsEntry.ftsScore, ftsMin, ftsMax) : 0;
      combined.set(id, {
        id, content: r.content, layer: r.layer, track: r.track, priority: r.priority,
        dist: r.dist, rank: ftsEntry ? ftsEntry.rank : null,
        vecScore: normVec, ftsScore: normFts,
        score: vectorWeight * normVec + ftsWeight * normFts,
        matchedBy: ftsEntry ? ['vector', 'fts5'] : ['vector'],
      });
    }
    for (const [id, r] of ftsById) {
      if (combined.has(id)) continue;
      const normFts = norm(r.ftsScore, ftsMin, ftsMax);
      combined.set(id, {
        id, content: r.content, layer: r.layer, track: r.track, priority: r.priority,
        dist: null, rank: r.rank,
        vecScore: 0, ftsScore: normFts,
        score: ftsWeight * normFts,
        matchedBy: ['fts5'],
      });
    }

    const results = [...combined.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    return {
      results,
      stats: { vectorHits: vecById.size, ftsHits: ftsById.size, total: results.length },
    };
  }

  // 暴露底层 db，供高级用法。
  getDatabase() {
    return this.db;
  }

  // 手动将向量写入 memories_vec（触发器不处理向量索引）。
  _syncVecInsert(id, embedding) {
    this.db.prepare('INSERT INTO memories_vec(rowid, embedding) VALUES (?, ?)').run(BigInt(id), embedding);
  }

  _encodeTags(tags) {
    if (tags == null) return null;
    if (Array.isArray(tags)) return JSON.stringify(tags);
    return String(tags);
  }

  _parseTags(tags) {
    if (tags == null) return null;
    try {
      const parsed = JSON.parse(tags);
      return Array.isArray(parsed) ? parsed : [tags];
    } catch {
      return [tags];
    }
  }

  _toMemory(row) {
    if (!row) return null;
    return {
      ...row,
      tags: this._parseTags(row.tags),
      embedding: decodeEmbedding(row.embedding),
    };
  }
}
