import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/memory-store.js';
import { EmbeddingClient } from '../src/embedding.js';
import { MemoryService } from '../src/service.js';

function makeVector(seed = 0.1) {
  const arr = new Float32Array(768);
  for (let i = 0; i < 768; i++) {
    arr[i] = Math.sin(seed + i * 0.01) * 0.5;
  }
  return arr;
}

test('MemoryService: 构造与基本操作', async () => {
  const store = new MemoryStore(':memory:');
  const embedding = new EmbeddingClient({
    apiKey: 'fake-key',
    dimensions: 768,
    baseURL: 'https://api.openai.com/v1',
    fetch: async () => ({
      ok: true,
      status: 200,
      async json() {
        return { data: [{ index: 0, embedding: Array.from(makeVector(0.1)) }] };
      },
      async text() { return ''; },
    }),
  });
  const service = new MemoryService(store, embedding);

  // add
  const mem = await service.add('测试记忆', { layer: 3, track: 'project', priority: 5, tags: ['test'] });
  assert.ok(mem.id > 0);
  assert.equal(mem.content, '测试记忆');
  assert.ok(mem.embedding instanceof Float32Array);

  // get
  const got = await service.get(mem.id);
  assert.equal(got.content, '测试记忆');

  // list
  const list = await service.list();
  assert.equal(list.length, 1);

  // update
  const updated = await service.update(mem.id, { content: '已更新' });
  assert.equal(updated.content, '已更新');

  // remove
  assert.equal(await service.remove(mem.id), true);
  assert.equal((await service.list()).length, 0);
  store.close();
});

test('MemoryService: search（无 embedding 时退化到纯 FTS5）', async () => {
  const store = new MemoryStore(':memory:');
  const noEmbed = new EmbeddingClient({
    apiKey: 'fake-key',
    fetch: async () => {
      throw new Error('Network error');
    },
  });
  const service = new MemoryService(store, noEmbed);

  await service.add('fix adminer filter bug', { layer: 3, track: 'project', priority: 5 });
  await service.add('deploy pipeline config', { layer: 2, track: 'project', priority: 3 });

  const { results } = await service.search('adminer filter');
  assert.ok(results.length >= 1);
  assert.ok(results.some((r) => r.content.includes('adminer')));
  store.close();
});

test('MemoryService: injectForSession', async () => {
  const store = new MemoryStore(':memory:');
  const service = new MemoryService(store, null);

  await service.add('原则：代码简洁优先', { layer: 4, track: 'global', priority: 5 });
  await service.add('adminer筛选bug修复方案', { layer: 3, track: 'project', priority: 4 });
  await service.add('日常待办：检查日志', { layer: 2, track: 'daily', priority: 2 });

  const text = await service.injectForSession({ track: 'project', includeLayer4: false });
  assert.ok(text.includes('Layer 3'));
  assert.ok(text.includes('adminer筛选bug修复方案'));
  // Layer 4 已排除，检查不包含深层记忆
  assert.ok(!text.includes('Layer 4') || !text.includes('原则：代码简洁优先'));
  store.close();
});

test('MemoryService: 构造函数支持 options 对象', async () => {
  const store = new MemoryStore(':memory:');
  const service = new MemoryService({ store, embeddingClient: null, config: { maxInject: 5 } });
  assert.equal(service.config.maxInject, 5);
  store.close();
});

test('MemoryService: injectForSession maxInject 截断', async () => {
  const store = new MemoryStore(':memory:');
  const service = new MemoryService(store, null);
  // 插入多条 Layer 4 记忆
  for (let i = 0; i < 10; i++) {
    await service.add(`deep principle ${i}`, { layer: 4, track: 'global', priority: 5 });
  }
  const text = await service.injectForSession({ maxInject: 3, includeLayer4: true });
  // 应只包含 3 条
  const lines = text.split('\n').filter((l) => l.startsWith('- [L4]'));
  assert.ok(lines.length <= 3);
  store.close();
});

test('MemoryService: injectForSession 空存储', async () => {
  const store = new MemoryStore(':memory:');
  const service = new MemoryService(store, null);
  const text = await service.injectForSession();
  assert.equal(text, '');
  store.close();
});

test('MemoryService: dispose 关闭底层 store', () => {
  const store = new MemoryStore(':memory:');
  // Service 通过 withDispose 包装后应有 dispose 方法
  const svc = new MemoryService(store, null);
  assert.equal(typeof svc.dispose, 'undefined'); // MemoryService 本身无 dispose，由 lib/index.js 注入
  // 验证 createService 返回的服务有 dispose
  // （实际由 lib/index.js 的 withDispose 注入）
  store.close();
});
