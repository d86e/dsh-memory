// tests/extract.test.js
// 单元测试：extractKeyPoints 的过滤与归类
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractKeyPoints } from '../lib/index.js';

function findByCat(points, cat) {
  return points.find(p => p.cat === cat);
}

test('extractKeyPoints: 偏好正确归到 L4/user', () => {
  const out = extractKeyPoints('我偏好用 vim 编辑器，习惯用 hjkl 移动光标。');
  const p = findByCat(out, 'pref');
  assert.ok(p, '应该有一条 pref');
  assert.equal(p.layer, 4);
  assert.equal(p.track, 'user');
  assert.match(p.content, /vim/);
});

test('extractKeyPoints: 决策归到 L4/project', () => {
  const out = extractKeyPoints('我们决定采用 SQLite + FTS5 作为存储方案，不再考虑 MySQL。');
  const d = findByCat(out, 'decision');
  assert.ok(d);
  assert.equal(d.layer, 4);
  assert.equal(d.track, 'project');
  assert.match(d.content, /SQLite/);
});

test('extractKeyPoints: 错误归到 L3/project', () => {
  const out = extractKeyPoints('之前的 bug 是因为 ONNX 模型没加载完成，已经修复。');
  const e = findByCat(out, 'error');
  assert.ok(e);
  assert.equal(e.layer, 3);
  assert.equal(e.track, 'project');
  assert.match(e.content, /ONNX/);
});

test('extractKeyPoints: 事实参数归到 L3/project', () => {
  const out = extractKeyPoints('项目的端口是 3080，默认数据库路径是 ~/.dsh/memory.db。');
  const f = findByCat(out, 'fact');
  assert.ok(f);
  assert.equal(f.layer, 3);
  assert.equal(f.track, 'project');
});

test('extractKeyPoints: 过滤元思考（我需要/打算/得/正在）', () => {
  const out = extractKeyPoints(`
    我需要先确认 ONNX 模型是否真的加载到了新进程。
    我打算看一下 autoSaveMemories 的节流设计是否合理。
    我得先重启 DSH 进程让 dsh-memory 重新加载。
    我正在想怎么让保存更精准。
  `);
  // 全部都是元思考，不应产出
  assert.equal(out.length, 0);
});

test('extractKeyPoints: 过滤 API key / 日志 / 调试信息', () => {
  const out = extractKeyPoints(`
    [dsh-memory] apply START
    [memory-api] DB path: memory.db
    My key is sk-abc123def456789012345
    [INFO] health probe OK
  `);
  assert.equal(out.length, 0);
});

test('extractKeyPoints: 过滤记忆条目回显行（id=N Lx/yy pz）', () => {
  const out = extractKeyPoints(`
    **id=20** L4/project p3 | 架构"是 source 里的引用，原文应该是"我偏好"这样的中文人称）
    **id=19** L3/project p3 | 错误地**作为项目记忆**记录了（"错误/架构"是 source 里的引用
  `);
  assert.equal(out.length, 0);
});

test('extractKeyPoints: 过滤引号内"我偏好"（讨论/引文）', () => {
  const out = extractKeyPoints(`
    原文应该是"我偏好"这样的中文人称，会被误抓。
    这行 \`我偏好\` 也是讨论。
  `);
  assert.equal(out.length, 0);
});

test('extractKeyPoints: 英文偏好 I like/prefer', () => {
  const out = extractKeyPoints('I prefer using TypeScript with strict mode.');
  const p = findByCat(out, 'pref');
  assert.ok(p, '应该识别 I prefer');
  assert.equal(p.layer, 4);
  assert.equal(p.track, 'user');
});

test('extractKeyPoints: 英文 prefer', () => {
  const out = extractKeyPoints('Prefer to use vitest over jest for new projects.');
  const p = findByCat(out, 'pref');
  assert.ok(p, '应该识别 Prefer');
});

test('extractKeyPoints: 否定偏好（我不要）', () => {
  const out = extractKeyPoints('我不要用 jQuery，新项目请用原生 DOM 或框架。');
  const p = findByCat(out, 'pref');
  assert.ok(p, '应该识别 "不要" 否定偏好');
  assert.equal(p.layer, 4);
  assert.equal(p.track, 'user');
});

test('extractKeyPoints: maxPoints 限制', () => {
  const text = `
    我偏好用 vim。
    我习惯用 markdown。
    我喜欢 PR review。
    我总是先写测试。
    我不要用 jQuery。
    我经常用 docker。
  `;
  const out = extractKeyPoints(text, { maxPoints: 3 });
  assert.equal(out.length, 3);
});

test('extractKeyPoints: 短文本返回空', () => {
  assert.equal(extractKeyPoints('hi').length, 0);
  assert.equal(extractKeyPoints('').length, 0);
  assert.equal(extractKeyPoints(null).length, 0);
});

test('extractKeyPoints: 同一类别去重', () => {
  const out = extractKeyPoints(`
    我偏好用 vim 编辑器。
    我偏好用 vim 编辑器。
    我偏好用 vim 编辑器。
  `);
  // 重复内容应只产出一条
  assert.equal(out.length, 1);
});

test('extractKeyPoints: 复杂真实场景', () => {
  const text = `
# 总结
我偏好用 TypeScript 写项目，习惯先写测试再写实现。
我们决定采用 SQLite + FTS5 作为存储方案，不再考虑 MySQL。
之前的 bug 是因为 ONNX 模型没加载完成，已经修复。
项目的端口是 3080，默认数据库路径是 ~/.dsh/memory.db。

# 元分析（应被过滤）
我需要先确认 ONNX 模型是否真的加载到了新进程。
我打算看一下 autoSaveMemories 的节流设计是否合理。
  `;
  const out = extractKeyPoints(text);
  const cats = out.map(p => p.cat).sort();
  assert.ok(cats.includes('pref'), '应有 pref');
  assert.ok(cats.includes('decision'), '应有 decision');
  assert.ok(cats.includes('error'), '应有 error');
  assert.ok(cats.includes('fact'), '应有 fact');
  // 元思考不应被产出
  for (const p of out) {
    assert.ok(!/我需要|我打算/.test(p.content), `不应含元思考: ${p.content}`);
  }
});

// ─── v0.4.1 META_THOUGHT_RE 扩展黑名单 ────────────────────────────────────────

test('extractKeyPoints: 拦住"我用/我用了"等 AI 自语 (v0.4.1)', () => {
  const metaLines = [
    '我用 runcode 写：',
    '我用了 Node 全局类型但没声明依赖',
    '我用 plan 模式先和你确认设计方向：',
    '我用更严格的方式查找插件自己的 logger 输出：',
    '我先写一个 regex',
    '我尝试了 ONNX 推理',
    '我选了 sqlite-vec',
    '我选择 sqlite-vec',
    '我准备接下来用 LLM 二次过滤',
  ];
  for (const line of metaLines) {
    const out = extractKeyPoints(line + '\n');
    // 整行都应被过滤掉
    assert.equal(out.length, 0, `不应抽出: "${line}" 实际: ${JSON.stringify(out.map(p => p.content))}`);
  }
});

test('extractKeyPoints: 保留"我们决定/采用/选定"等已发生决策', () => {
  const keep = [
    '我们决定采用 sqlite-vec 作为向量存储',
    '我们决定将 active auto-memory 加上',
    '我们选定 sqlite-vec 作为向量存储',
  ];
  for (const line of keep) {
    const out = extractKeyPoints(line + '\n');
    assert.ok(out.length > 0, `应保留: "${line}"`);
    const dec = out.find(p => p.cat === 'decision');
    assert.ok(dec, `应归类为 decision: "${line}"`);
  }
});

test('extractKeyPoints: 真实事实/事实摘要在 META 黑名单下仍能命中', () => {
  const text = `
项目的端口是 3080，默认数据库路径是 ~/.dsh/memory.db。
我偏好用 vim 编辑器。
我们决定采用 sqlite-vec 作为向量存储。
`;
  const out = extractKeyPoints(text);
  const cats = out.map(p => p.cat).sort();
  assert.ok(cats.includes('pref'), '应有 pref');
  assert.ok(cats.includes('decision'), '应有 decision');
  assert.ok(cats.includes('fact'), '应有 fact');
});
