// tests/inject.test.js
// 单元测试：extractKeywordsForRecall
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractKeywordsForRecall } from '../lib/index.js';

test('extractKeywordsForRecall: 中文 2-8 字片段', () => {
  const kws = extractKeywordsForRecall('我偏好用 vim 编辑器，习惯用 hjkl 移动光标');
  assert.ok(kws.includes('我偏好用'), 'should have 我偏好用');
  assert.ok(kws.includes('vim'), 'should have vim');
  assert.ok(kws.includes('编辑器'), 'should have 编辑器');
});

test('extractKeywordsForRecall: 英文 3+ 字母', () => {
  const kws = extractKeywordsForRecall('I prefer to use TypeScript with strict mode');
  assert.ok(kws.includes('prefer'));
  assert.ok(kws.includes('typescript'));
  assert.ok(kws.includes('strict'));
  assert.ok(kws.includes('mode'));
  // 1-2 字母不取
  assert.ok(!kws.includes('i'));
});

test('extractKeywordsForRecall: 去重', () => {
  const kws = extractKeywordsForRecall('vim vim vim 编辑器 编辑器');
  assert.equal(new Set(kws).size, kws.length);
});

test('extractKeywordsForRecall: 短文本返回空', () => {
  assert.equal(extractKeywordsForRecall('').length, 0);
  assert.equal(extractKeywordsForRecall(null).length, 0);
  assert.equal(extractKeywordsForRecall('hi').length, 0);
});

test('extractKeywordsForRecall: 限制 max 数量', () => {
  const kws = extractKeywordsForRecall('一二三四五六七八九十', 3);
  assert.ok(kws.length <= 3);
});

test('extractKeywordsForRecall: 长字符串被截断（16 字符上限）', () => {
  const kws = extractKeywordsForRecall('一二三四五六七八九十一二三四五六七八九十');
  for (const k of kws) {
    assert.ok(k.length <= 16, `${k} 超长`);
  }
});

test('extractKeywordsForRecall: 混合中英', () => {
  const kws = extractKeywordsForRecall('Configure dsh-memory SQLite FTS5 全文索引');
  const joined = kws.join(' ');
  // 英文 token 用 [a-z]+ 切：dsh-memory -> dsh, memory；FTS5 -> fts
  assert.match(joined, /dsh/);
  assert.match(joined, /memory/);
  assert.match(joined, /sqlite/);
  assert.match(joined, /全文索引/);
});
