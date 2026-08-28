// tests/store-page.test.js
// 单元测试：MemoryStore.listPage / stats / batchUpdate / batchTag / batchRemove
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/memory-store.js';

function seed(store) {
  store.add({ content: '我偏好用 vim 编辑器', layer: 4, track: 'user', priority: 4, tags: ['pref', 'editor'] });
  store.add({ content: '我们决定用 SQLite + FTS5', layer: 4, track: 'project', priority: 5, tags: ['arch', 'decision'] });
  store.add({ content: '之前的 bug 是因为 ONNX 加载失败', layer: 3, track: 'project', priority: 3, tags: ['bug'] });
  store.add({ content: '端口 3080，DB 在 ~/.dsh/memory.db', layer: 3, track: 'project', priority: 2, tags: ['config'] });
  store.add({ content: '软删除项', layer: 2, track: 'global', priority: 1 });
  store.update(5, { priority: 0 });
}

test('listPage: 默认隐藏软删除', () => {
  const s = new MemoryStore(':memory:');
  seed(s);
  const { rows, total } = s.listPage();
  assert.equal(total, 4, '软删除项应被隐藏');
  assert.equal(rows.length, 4);
  for (const r of rows) assert.ok(r.priority > 0);
  s.close();
});

test('listPage: includeDeleted=true 显示软删除', () => {
  const s = new MemoryStore(':memory:');
  seed(s);
  // 我们的 listPage 默认 minPriority=1；要看到 priority=0，需传 minPriority=0
  const { total } = s.listPage({ minPriority: 0 });
  assert.equal(total, 5);
  s.close();
});

test('listPage: 按 layer 过滤', () => {
  const s = new MemoryStore(':memory:');
  seed(s);
  const { rows, total } = s.listPage({ layers: [4] });
  assert.equal(total, 2);
  for (const r of rows) assert.equal(r.layer, 4);
  s.close();
});

test('listPage: 多 layer (OR)', () => {
  const s = new MemoryStore(':memory:');
  seed(s);
  const { rows } = s.listPage({ layers: [3, 4] });
  assert.equal(rows.length, 4);
  s.close();
});

test('listPage: 按 track 过滤', () => {
  const s = new MemoryStore(':memory:');
  seed(s);
  const { rows } = s.listPage({ tracks: ['user'] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].track, 'user');
  s.close();
});

test('listPage: 按 tag 过滤（必须包含）', () => {
  const s = new MemoryStore(':memory:');
  seed(s);
  const { rows } = s.listPage({ tags: ['arch'] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 2);
  s.close();
});

test('listPage: 多 tag (AND)', () => {
  const s = new MemoryStore(':memory:');
  seed(s);
  const { rows } = s.listPage({ tags: ['pref', 'editor'] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 1);
  s.close();
});

test('listPage: 关键词搜索（FTS5）', () => {
  const s = new MemoryStore(':memory:');
  seed(s);
  const { rows } = s.listPage({ q: 'vim' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 1);
  s.close();
});

test('listPage: 排序 priority asc', () => {
  const s = new MemoryStore(':memory:');
  seed(s);
  const { rows } = s.listPage({ sort: 'priority', order: 'asc', limit: 10 });
  // 期望按 priority 升序：2, 3, 4, 5
  const prios = rows.map(r => r.priority);
  assert.deepEqual(prios, [2, 3, 4, 5]);
  s.close();
});

test('listPage: 分页', () => {
  const s = new MemoryStore(':memory:');
  seed(s);
  const page1 = s.listPage({ offset: 0, limit: 2, sort: 'id', order: 'asc' });
  const page2 = s.listPage({ offset: 2, limit: 2, sort: 'id', order: 'asc' });
  assert.equal(page1.rows.length, 2);
  assert.equal(page2.rows.length, 2);
  assert.equal(page1.total, 4);
  // 无重叠
  const ids1 = new Set(page1.rows.map(r => r.id));
  for (const r of page2.rows) assert.ok(!ids1.has(r.id));
  s.close();
});

test('listPage: rows 不含 embedding 字段', () => {
  const s = new MemoryStore(':memory:');
  seed(s);
  const { rows } = s.listPage();
  for (const r of rows) {
    assert.equal(r.embedding, undefined, `行不应含 embedding: ${r.id}`);
  }
  s.close();
});

test('stats: 分组与 topTags', () => {
  const s = new MemoryStore(':memory:');
  seed(s);
  const stats = s.stats();
  assert.equal(stats.total, 4);
  assert.ok(Array.isArray(stats.byLayer));
  assert.ok(Array.isArray(stats.byTrack));
  assert.ok(Array.isArray(stats.byPriority));
  assert.ok(Array.isArray(stats.topTags));
  // 验证 byLayer 数字合计
  const layerSum = stats.byLayer.reduce((acc, x) => acc + x.n, 0);
  assert.equal(layerSum, 4);
  s.close();
});

test('batchUpdate: 改 priority', () => {
  const s = new MemoryStore(':memory:');
  seed(s);
  const r = s.batchUpdate([1, 2], { priority: 5 });
  assert.equal(r.updated, 2);
  assert.equal(s.get(1).priority, 5);
  assert.equal(s.get(2).priority, 5);
  s.close();
});

test('batchUpdate: 改 tags', () => {
  const s = new MemoryStore(':memory:');
  seed(s);
  const r = s.batchUpdate([1, 2], { tags: ['foo', 'bar'] });
  assert.equal(r.updated, 2);
  assert.deepEqual(s.get(1).tags, ['foo', 'bar']);
  s.close();
});

test('batchUpdate: 空 ids 不报错', () => {
  const s = new MemoryStore(':memory:');
  seed(s);
  const r = s.batchUpdate([], { priority: 1 });
  assert.equal(r.updated, 0);
  s.close();
});

test('batchTag: add + remove 合并', () => {
  const s = new MemoryStore(':memory:');
  seed(s);
  // id=1 tags = ['pref', 'editor']
  const r = s.batchTag([1], { add: ['new'], remove: ['pref'] });
  assert.equal(r.updated, 1);
  const after = s.get(1).tags;
  assert.ok(after.includes('new'));
  assert.ok(after.includes('editor'));
  assert.ok(!after.includes('pref'));
  s.close();
});

test('batchRemove: 软删除（priority=0）', () => {
  const s = new MemoryStore(':memory:');
  seed(s);
  const r = s.batchRemove([1, 2]);
  assert.equal(r.removed, 2);
  assert.equal(s.get(1).priority, 0);
  assert.equal(s.get(2).priority, 0);
  // listPage 默认隐藏 priority=0
  assert.equal(s.listPage().total, 2);
  s.close();
});

test('batchRemove: hard=true 物理删除', () => {
  const s = new MemoryStore(':memory:');
  seed(s);
  const r = s.batchRemove([4], { hard: true });
  assert.equal(r.removed, 1);
  assert.equal(s.get(4), null);
  s.close();
});

test('listPage: 通配符字符在 tag 里不破坏 LIKE', () => {
  const s = new MemoryStore(':memory:');
  s.add({ content: '百分号%测试', layer: 3, track: 'project', priority: 3, tags: ['100%', 'normal'] });
  s.add({ content: '下划线_测试', layer: 3, track: 'project', priority: 3, tags: ['a_b', 'normal'] });
  // 搜索 '100%' 应只命中第一个
  const r1 = s.listPage({ tags: ['100%'] });
  assert.equal(r1.rows.length, 1);
  assert.equal(r1.rows[0].id, 1);
  // 搜索 'a_b' 应只命中第二个
  const r2 = s.listPage({ tags: ['a_b'] });
  assert.equal(r2.rows.length, 1);
  assert.equal(r2.rows[0].id, 2);
  s.close();
});
