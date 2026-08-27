import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, EmbeddingClient, MemoryService, createService, getMemoryService, name, inject, VEC_DIMENSIONS } from '../lib/index.js';

function makeVector(seed = 0.1) {
  const arr = new Float32Array(768);
  for (let i = 0; i < 768; i++) {
    arr[i] = Math.sin(seed + i * 0.01) * 0.5;
  }
  return arr;
}

test('lib/index.js: 导出检查', () => {
  assert.equal(name, 'dsh-memory');
  assert.deepEqual(inject, ['tools', 'webServer']);
  assert.equal(VEC_DIMENSIONS, 768);
  assert.ok(typeof createService === 'function');
  assert.ok(typeof getMemoryService === 'function');
  assert.ok(typeof MemoryStore === 'function');
  assert.ok(typeof EmbeddingClient === 'function');
  assert.ok(typeof MemoryService === 'function');
});

test('lib/index.js: getMemoryService 返回带 dispose 的服务', () => {
  const svc = getMemoryService(':memory:');
  assert.ok(svc instanceof MemoryService);
  assert.ok(typeof svc.dispose === 'function');
  // dispose 不应抛错
  assert.doesNotThrow(() => svc.dispose());
});

test('lib/index.js: createService 接受 MemoryStore 实例', () => {
  const store = new MemoryStore(':memory:');
  const svc = createService({ store });
  assert.ok(svc instanceof MemoryService);
  assert.ok(typeof svc.dispose === 'function');
  svc.dispose();
});

test('lib/index.js: createService 接受 EmbeddingClient 实例', async () => {
  const emb = new EmbeddingClient({ modelPath: ':memory:' });
  const svc = createService({ embeddingClient: emb });
  assert.ok(svc instanceof MemoryService);
  assert.equal(svc.embedding.getBackend(), 'local-onnx');
  svc.dispose();
});

test('lib/index.js: createService 不接受非 MemoryStore 实例', () => {
  assert.throws(() => createService({ store: 'not-a-store' }), /MemoryStore/);
});

test('lib/index.js: createService 支持 config 覆盖', () => {
  const svc = createService({ config: { vectorWeight: 0.8, maxInject: 30 } });
  assert.equal(svc.config.vectorWeight, 0.8);
  assert.equal(svc.config.maxInject, 30);
  svc.dispose();
});
