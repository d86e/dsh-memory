import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EmbeddingClient, DEFAULT_DIMENSIONS } from '../src/embedding.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODEL_DIR = join(__dirname, '..', 'models');
const MODEL_PATH = join(MODEL_DIR, 'nomic-embed-text-v1.5-int8.onnx');

test('EmbeddingClient: 默认配置', () => {
  const client = new EmbeddingClient();
  assert.equal(client.dimensions, DEFAULT_DIMENSIONS);
  assert.equal(client.getBackend(), 'local-onnx');
  assert.ok(typeof client.modelPath === 'string');
});

test('EmbeddingClient: 自定义路径', () => {
  const client = new EmbeddingClient({ modelPath: '/custom/model.onnx', dimensions: 512 });
  assert.equal(client.dimensions, 512);
  assert.equal(client.modelPath, '/custom/model.onnx');
});

test('EmbeddingClient: isAvailable', () => {
  const withModel = new EmbeddingClient({ modelPath: MODEL_PATH });
  assert.equal(withModel.isAvailable(), fs.existsSync(MODEL_PATH));
  const noModel = new EmbeddingClient({ modelPath: '/nonexistent/model.onnx' });
  assert.equal(noModel.isAvailable(), false);
});

test('EmbeddingClient: embedSingle 返回 768 维向量', async () => {
  const client = new EmbeddingClient({ modelPath: MODEL_PATH });
  const v = await client.embedSingle('测试记忆功能');
  assert.ok(v instanceof Float32Array);
  assert.equal(v.length, 768);
  // L2 归一化：范数应接近 1
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  assert.ok(Math.abs(Math.sqrt(norm) - 1) < 0.01, 'vector should be L2 normalized');
}, { skip: !fs.existsSync(MODEL_PATH) });

test('EmbeddingClient: embed 批量', async () => {
  const client = new EmbeddingClient({ modelPath: MODEL_PATH });
  const [v1, v2] = await client.embed(['hello', 'world']);
  assert.ok(v1 instanceof Float32Array);
  assert.ok(v2 instanceof Float32Array);
  assert.equal(v1.length, 768);
  assert.equal(v2.length, 768);
}, { skip: !fs.existsSync(MODEL_PATH) });

test('EmbeddingClient: embed 空数组', async () => {
  const client = new EmbeddingClient({ modelPath: MODEL_PATH });
  const out = await client.embed([]);
  assert.deepEqual(out, []);
});

test('EmbeddingClient: 语义相似度', async () => {
  const client = new EmbeddingClient({ modelPath: MODEL_PATH });
  const v1 = await client.embedSingle('向量检索功能');
  const v2 = await client.embedSingle('语义搜索验证');
  const v3 = await client.embedSingle('今天天气很好');

  function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  const simSame = cosine(v1, v2);
  const simDiff = cosine(v1, v3);
  assert.ok(simSame > simDiff, `相似句相似度(${simSame.toFixed(3)}) 应大于不同主题(${simDiff.toFixed(3)})`);
}, { skip: !fs.existsSync(MODEL_PATH) });

test('EmbeddingClient: dispose 不抛错', async () => {
  const client = new EmbeddingClient({ modelPath: MODEL_PATH });
  await client.embedSingle('test');
  assert.doesNotThrow(() => client.dispose());
}, { skip: !fs.existsSync(MODEL_PATH) });
