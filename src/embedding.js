// src/embedding.js
// Embedding 客户端：纯 Node.js，使用本地 ONNX 模型（nomic-embed-text-v1.5-int8）。
// 无需 Ollama、无需 API key、无需网络。
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as ort from 'onnxruntime-node';

const MODEL_DIR = join(dirname(fileURLToPath(import.meta.url)), '../models');
const MODEL_PATH = join(MODEL_DIR, 'nomic-embed-text-v1.5-int8.onnx');
const VOCAB_PATH = join(MODEL_DIR, 'vocab.txt');
const MAX_SEQ_LEN = 512;

// ─── Tokenizer ────────────────────────────────────────────────────────────────

/** 加载 WordPiece vocab。 */
function loadVocab() {
  const lines = fs.readFileSync(VOCAB_PATH, 'utf8').split('\n');
  const vocab = new Map();
  for (let i = 0; i < lines.length; i++) {
    const w = lines[i].trim();
    if (w) vocab.set(w, i);
  }
  return vocab;
}

const VOCAB = loadVocab();
const PAD_ID = 0;
const UNK_ID = 100;
const CLS_ID = 101;
const SEP_ID = 102;

/** BertPreTokenizer：在 CJK 字符前后加空格，然后按空白分割。 */
function bertPreTokenize(text) {
  return text
    .toLowerCase()
    .replace(/([\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff])/g, ' $1 ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/** WordPiece 子词切分：优先匹配带 ## 前缀的子词。 */
function wordPieceTokenize(word) {
  const tokens = [];
  let remaining = word;
  while (remaining.length > 0) {
    let matched = false;
    // 最长匹配优先（最多 100 字符）
    for (let len = Math.min(remaining.length, 100); len >= 1; len--) {
      const sub = remaining.slice(0, len);
      const candidate = tokens.length > 0 ? '##' + sub : sub;
      if (VOCAB.has(candidate)) {
        tokens.push(VOCAB.get(candidate));
        remaining = remaining.slice(len);
        matched = true;
        break;
      }
    }
    if (!matched) {
      // CJK 字符单独处理
      const ch = remaining[0];
      if (/[\u4e00-\u9fff]/.test(ch)) {
        tokens.push(VOCAB.get(ch) ?? UNK_ID);
      } else {
        tokens.push(UNK_ID);
      }
      remaining = remaining.slice(1);
    }
  }
  return tokens;
}

/** 编码文本为模型输入。 */
function encode(text) {
  const words = bertPreTokenize(text);
  const tokenIds = [CLS_ID];
  for (const word of words) {
    const wts = wordPieceTokenize(word);
    tokenIds.push(...wts);
    if (tokenIds.length >= MAX_SEQ_LEN - 2) break;
  }
  tokenIds.push(SEP_ID);
  // 截断 / 填充
  const seqLen = Math.min(tokenIds.length, MAX_SEQ_LEN);
  const ids = tokenIds.slice(0, seqLen);
  while (ids.length < seqLen) ids.push(PAD_ID);

  const input_ids = new BigInt64Array(ids.map(BigInt));
  const token_type_ids = new BigInt64Array(seqLen);
  const attention_mask = new BigInt64Array(Array(seqLen).fill(1n));
  return { input_ids, token_type_ids, attention_mask, seqLen, ids };
}

// ─── ONNX 会话缓存 ────────────────────────────────────────────────────────────

let _session = null;

async function getSession() {
  if (_session) return _session;
  if (!fs.existsSync(MODEL_PATH)) {
    throw new Error(
      `ONNX 模型文件不存在: ${MODEL_PATH}\n` +
      '请先下载模型：curl -L https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/resolve/main/onnx/model_int8.onnx -o models/nomic-embed-text-v1.5-int8.onnx'
    );
  }
  const buf = fs.readFileSync(MODEL_PATH);
  _session = await ort.InferenceSession.create(buf, { executionProviders: ['cpu'] });
  return _session;
}

// ─── Mean Pooling + L2 Normalize ──────────────────────────────────────────────

/**
 * 从 last_hidden_state 中提取有效 token 的均值池化，然后 L2 归一化。
 * @param {Float32Array} hiddenState  shape=[seqLen, hiddenSize] 展平为一维
 * @param {number} seqLen  实际序列长度（不含 padding）
 * @param {BigInt64Array} attentionMask
 * @returns {Float32Array} 归一化后的 embedding
 */
function meanPoolAndNormalize(hiddenState, seqLen, attentionMask) {
  // hiddenState 是 [seqLen, hiddenSize] 展平的，但实际可能是 [batch, seqLen, hiddenSize]
  const flat = hiddenState.data;
  const dims = hiddenState.dims;
  const hiddenSize = dims[dims.length - 1];
  const effectiveLen = Array.from(attentionMask).filter(v => v === 1n).length;
  if (effectiveLen === 0) return new Float32Array(hiddenSize).fill(0);

  const result = new Float32Array(hiddenSize);
  for (let s = 0; s < seqLen; s++) {
    if (attentionMask[s] === 0n) continue;
    const offset = s * hiddenSize;
    for (let d = 0; d < hiddenSize; d++) {
      result[d] += flat[offset + d];
    }
  }
  // 均值
  for (let d = 0; d < hiddenSize; d++) {
    result[d] /= effectiveLen;
  }
  // L2 归一化
  let norm = 0;
  for (let d = 0; d < hiddenSize; d++) norm += result[d] * result[d];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let d = 0; d < hiddenSize; d++) result[d] /= norm;
  }
  return result;
}

// ─── 导出类 ───────────────────────────────────────────────────────────────────

export const DEFAULT_DIMENSIONS = 768;

export class EmbeddingClient {
  constructor(config = {}) {
    this.dimensions = config.dimensions || DEFAULT_DIMENSIONS;
    this.modelPath = config.modelPath || MODEL_PATH;
    this._session = null;
  }

  async _ensureSession() {
    if (!this._session) {
      this._session = await getSession();
    }
    return this._session;
  }

  /** 生成单条文本的 embedding。 */
  async embedSingle(text) {
    const { input_ids, token_type_ids, attention_mask, seqLen } = encode(text);
    const session = await this._ensureSession();
    const result = await session.run({
      input_ids: new ort.Tensor('int64', input_ids, [1, seqLen]),
      token_type_ids: new ort.Tensor('int64', token_type_ids, [1, seqLen]),
      attention_mask: new ort.Tensor('int64', attention_mask, [1, seqLen]),
    });
    // last_hidden_state: [1, seqLen, hiddenSize]
    const hidden = meanPoolAndNormalize(result.last_hidden_state, seqLen, attention_mask);
    return hidden;
  }

  /** 批量生成 embeddings。 */
  async embed(texts) {
    if (texts.length === 0) return [];
    return Promise.all(texts.map(t => this.embedSingle(t)));
  }

  isAvailable() {
    return fs.existsSync(this.modelPath);
  }

  getBackend() {
    return 'local-onnx';
  }

  /** 释放 ONNX 会话。 */
  dispose() {
    this._session = null;
  }
}
