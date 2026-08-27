// scripts/prepare-models.js
// 安装时自动下载 ONNX 模型（如果不存在）。
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const MODELS_DIR = join(ROOT, 'models');
const MODEL_FILE = join(MODELS_DIR, 'nomic-embed-text-v1.5-int8.onnx');
const MODEL_URL = 'https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/resolve/main/onnx/model_int8.onnx';

if (existsSync(MODEL_FILE)) {
  console.log('[dsh-memory] ONNX 模型已存在，跳过下载');
  process.exit(0);
}

console.log('[dsh-memory] 下载 ONNX 模型...');
mkdirSync(MODELS_DIR, { recursive: true });

try {
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  await import('node:fs').then(fs => fs.promises.writeFile(MODEL_FILE, buffer));
  console.log(`[dsh-memory] 模型已下载: ${(buffer.length / 1024 / 1024).toFixed(1)} MB`);
} catch (err) {
  console.warn(`[dsh-memory] 模型下载失败: ${err.message}`);
  console.warn('[dsh-memory] 向量检索将不可用，仅 FTS 关键词搜索可用。');
  console.warn(`[dsh-memory] 手动下载: curl -L "${MODEL_URL}" -o "${MODEL_FILE}"`);
}
