import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, VEC_DIMENSIONS } from '../src/memory-store.js';

function makeVector(seed = 0.1) {
  const arr = new Float32Array(VEC_DIMENSIONS);
  for (let i = 0; i < VEC_DIMENSIONS; i++) {
    arr[i] = Math.sin(seed + i * 0.01) * 0.5;
  }
  return arr;
}

test('MemoryStore: schema 初始化（幂等）', () => {
  const store = new MemoryStore(':memory:');
  store.init(); // 再次初始化不应抛错

  const tables = store.getDatabase()
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name IN ('memories','memories_fts','memories_vec') ORDER BY name")
    .all();
  assert.equal(tables.length, 3);

  const triggers = store.getDatabase()
    .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'memories_%'")
    .all();
  assert.equal(triggers.length, 3);
  store.close();
});

test('MemoryStore: CRUD 与软删除', () => {
  const store = new MemoryStore(':memory:');

  const mem = store.add({
    content: '测试记忆内容',
    layer: 3,
    track: 'project',
    priority: 5,
    tags: ['adminer', 'bug'],
    source: 'session-1',
  });
  assert.ok(mem.id > 0);
  assert.equal(mem.content, '测试记忆内容');
  assert.equal(mem.layer, 3);
  assert.equal(mem.track, 'project');
  assert.equal(mem.priority, 5);
  assert.deepEqual(mem.tags, ['adminer', 'bug']);
  assert.equal(mem.embedding, null);

  const got = store.get(mem.id);
  assert.equal(got.content, '测试记忆内容');
  assert.deepEqual(got.tags, ['adminer', 'bug']);

  const updated = store.update(mem.id, { content: '更新后的内容', priority: 4 });
  assert.equal(updated.content, '更新后的内容');
  assert.equal(updated.priority, 4);
  assert.ok(updated.updated);

  assert.equal(store.remove(mem.id), true);
  assert.equal(store.get(mem.id).priority, 0); // 软删除
  assert.equal(store.list({}).length, 0); // 默认隐藏软删除
  assert.equal(store.list({ includeDeleted: true }).length, 1); // 显式可见

  assert.equal(store.remove(mem.id, { hard: true }), true);
  assert.equal(store.get(mem.id), null);
  store.close();
});

test('MemoryStore: FTS5 关键词检索', () => {
  const store = new MemoryStore(':memory:');
  store.add({ content: 'fix adminer filter bug', layer: 3, track: 'project', priority: 5 });
  store.add({ content: 'user prefers minimal code comments', layer: 4, track: 'global', priority: 5 });
  store.add({ content: 'deploy pipeline config change', layer: 2, track: 'project', priority: 3 });

  const one = store.ftsSearch('adminer');
  assert.equal(one.length, 1);
  assert.equal(one[0].content, 'fix adminer filter bug');
  assert.ok(typeof one[0].rank === 'number');

  const multi = store.ftsSearch('filter bug');
  assert.equal(multi.length, 1);

  const trackFiltered = store.ftsSearch('project', { limit: 5, track: 'project' });
  assert.ok(trackFiltered.every((r) => r.track === 'project'));
  store.close();
});

test('MemoryStore: 向量检索', () => {
  const store = new MemoryStore(':memory:');
  store.add({ content: 'vector test one', layer: 3, embedding: makeVector(0.1) });
  store.add({ content: 'vector test two', layer: 3, embedding: makeVector(0.2) });
  store.add({ content: 'other topic', layer: 4, embedding: makeVector(1.0) });

  const top = store.vecSearch(makeVector(0.12), { limit: 2 });
  assert.equal(top.length, 2);
  assert.equal(top[0].content, 'vector test one');
  assert.ok(top[0].dist <= top[1].dist);

  const layer4 = store.vecSearch(makeVector(0.12), { layer: 4, limit: 5 });
  assert.equal(layer4.length, 1);
  assert.equal(layer4[0].content, 'other topic');
  store.close();
});

test('MemoryStore: 混合检索（FTS5 + 向量加权融合）', () => {
  const store = new MemoryStore(':memory:');
  store.add({ content: 'fix adminer filter bug in form', layer: 3, embedding: makeVector(0.1) });
  store.add({ content: 'user preference for minimal code', layer: 4, embedding: makeVector(0.2) });
  store.add({ content: 'adminer screen filter issue', layer: 3, embedding: makeVector(0.15) });

  const { results, stats } = store.mixedSearch('adminer filter', makeVector(0.11), {
    topKVector: 5,
    topKFts5: 5,
    limit: 5,
  });
  assert.ok(results.length >= 2);
  assert.equal(stats.total, results.length);
  assert.ok(results[0].score >= results[results.length - 1].score);
  assert.ok(results[0].matchedBy.length >= 1);
  store.close();
});

test('MemoryStore: layer/track/priority/since 过滤', () => {
  const store = new MemoryStore(':memory:');
  store.add({ content: 'a', layer: 2, track: 'global', priority: 1 });
  store.add({ content: 'b', layer: 3, track: 'project', priority: 3 });
  store.add({ content: 'c', layer: 4, track: 'daily', priority: 5 });

  assert.deepEqual(store.list({ layer: 3 }).map((m) => m.content), ['b']);
  assert.deepEqual(store.list({ track: 'project' }).map((m) => m.content), ['b']);
  assert.deepEqual(store.list({ minPriority: 3 }).map((m) => m.content).sort(), ['b', 'c']);
  assert.equal(store.list({ since: new Date(Date.now() - 86400000) }).length, 3);
  store.close();
});

test('MemoryStore: 向量维度校验', () => {
  const store = new MemoryStore(':memory:');
  assert.throws(() => store.add({ content: 'x', embedding: new Float32Array(16) }), /维度|dimension/);
  assert.throws(() => store.vecSearch(new Float32Array(16)), /维度|dimension/);
  store.close();
});

test('MemoryStore: update embedding 也触发向量索引同步', () => {
  const store = new MemoryStore(':memory:');
  const mem = store.add({ content: 'initial content', layer: 3, embedding: makeVector(0.1) });
  assert.ok(mem.embedding instanceof Float32Array);

  // 更新 content 应触发 FTS5 更新
  const updated = store.update(mem.id, { content: 'new content' });
  const ftsResults = store.ftsSearch('new');
  assert.equal(ftsResults.length, 1);
  assert.equal(ftsResults[0].content, 'new content');

  // 更新 embedding 应触发向量索引更新
  const updated2 = store.update(mem.id, { embedding: makeVector(0.5) });
  assert.ok(updated2.embedding instanceof Float32Array);
  store.close();
});

test('MemoryStore: remove 软删除后 FTS5 和向量索引也应同步清理', () => {
  const store = new MemoryStore(':memory:');
  const mem = store.add({ content: 'to delete', layer: 3, embedding: makeVector(0.1) });
  store.remove(mem.id); // 软删除

  // 软删除后优先级变为 0，list 默认隐藏
  assert.equal(store.list({}).length, 0);
  // 软删除后 FTS5 和向量检索也应被过滤（priority > 0）
  assert.equal(store.ftsSearch('to delete').length, 0);
  assert.equal(store.vecSearch(makeVector(0.1)).length, 0);
  // 硬删除才真正清理索引（软删除后行仍存在，硬删会成功）
  assert.equal(store.remove(mem.id, { hard: true }), true);
  store.close();
});

test('MemoryStore: add() 参数校验', () => {
  const store = new MemoryStore(':memory:');
  // 缺 content
  assert.throws(() => store.add({}), /content/);
  assert.throws(() => store.add({ content: 123 }), /content/);
  // 无效 track
  assert.throws(() => store.add({ content: 'x', track: 'invalid' }), /track/);
  // 向量维度不对
  assert.throws(() => store.add({ content: 'x', embedding: new Float32Array(8) }), /维度/);
  store.close();
});

test('MemoryStore: list() 分页与 limit 钳制', () => {
  const store = new MemoryStore(':memory:');
  for (let i = 0; i < 5; i++) {
    store.add({ content: `item ${i}`, layer: 2, track: 'global' });
  }
  const page1 = store.list({ limit: 2, offset: 0 });
  const page2 = store.list({ limit: 2, offset: 2 });
  assert.equal(page1.length, 2);
  assert.equal(page2.length, 2);
  assert.notDeepEqual(page1[0].id, page2[0].id);
  // limit 为负数应钳制到 1
  assert.ok(store.list({ limit: -5 }).length >= 1);
  store.close();
});

test('MemoryStore: list() orderBy 白名单', () => {
  const store = new MemoryStore(':memory:');
  store.add({ content: 'a' });
  assert.throws(() => store.list({ orderBy: 'evil; DROP TABLE' }), /不支持的 orderBy/);
  store.close();
});

test('MemoryStore: update() 边界情况', () => {
  const store = new MemoryStore(':memory:');
  // 不存在的 id
  assert.equal(store.update(9999, { content: 'x' }), null);
  // 空 changes 返回原记录
  const mem = store.add({ content: 'original' });
  const same = store.update(mem.id, {});
  assert.equal(same.content, 'original');
  // 未知字段被跳过，仍更新其他字段
  const updated = store.update(mem.id, { content: 'changed', unknownField: true });
  assert.equal(updated.content, 'changed');
  store.close();
});

test('MemoryStore: 软删除后搜索应排除', () => {
  const store = new MemoryStore(':memory:');
  const mem = store.add({ content: 'searchable content', layer: 2, track: 'project', embedding: makeVector(0.1) });
  // 搜索前能命中
  assert.ok(store.ftsSearch('searchable').length === 1);
  assert.ok(store.vecSearch(makeVector(0.1)).length === 1);
  // 软删除
  store.remove(mem.id);
  // 搜索应返回空
  assert.equal(store.ftsSearch('searchable').length, 0);
  assert.equal(store.vecSearch(makeVector(0.1)).length, 0);
  // 含 includeDeleted 时可搜到
  assert.equal(store.ftsSearch('searchable', { includeDeleted: true }).length, 1);
  store.close();
});

test('MemoryStore: mixedSearch 含 soft-deleted 记忆时应排除', () => {
  const store = new MemoryStore(':memory:');
  store.add({ content: 'active content', layer: 3, embedding: makeVector(0.1) });
  const mem = store.add({ content: 'deleted content', layer: 3, embedding: makeVector(0.2) });
  store.remove(mem.id); // 软删除

  const { results } = store.mixedSearch('deleted', makeVector(0.22), { limit: 5 });
  // 软删除的记忆不应出现在结果中
  const deletedResult = results.find((r) => r.id === mem.id);
  assert.equal(deletedResult, undefined);
  // 但其他活跃记忆可能因向量相似性被返回
  store.close();
});
