#!/usr/bin/env node
// scripts/cleanup-noise.mjs
// 交互式清理 dsh-memory 噪音记忆。
//
// 用法：
//   node scripts/cleanup-noise.mjs --dry-run        # 列出候选，不改
//   node scripts/cleanup-noise.mjs --db ~/.dsh/memory.db
//   node scripts/cleanup-noise.mjs --hard           # 物理删除（默认软删除）
//
// 噪音判定规则：
//   1. 内容触发 META_THOUGHT_RE 扩展黑名单
//   2. 内容短于 10 字符
//   3. 内容含 dedup 空壳
//   4. 内容是 markdown 列表项

import { readFileSync, statSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import Database from 'better-sqlite3';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const hard = args.includes('--hard');
const dbArg = args.find(a => a.startsWith('--db='));
const dbPath = dbArg ? dbArg.slice('--db='.length) : join(homedir(), '.dsh', 'memory.db');
const yes = args.includes('--yes');

// 检查 DB 存在
try { statSync(dbPath); } catch { console.error(`[err] DB 不存在: ${dbPath}`); process.exit(1); }

const db = new Database(dbPath);

// 启发式规则
const META_RE = /(我|咱们|我们)(需要|打算|想|要|得|应该|先|正在|看下|看看|检查|确认|验证|测试|搜|找|读|写|查|思考|分析|认为|觉得|考虑|用了?|选(择|了|取|用)|准备|接下来|下面|来|尝试|开始|继续|用|使用|改|改用|改成)/;
const SHELL_RE = /\[补充: \||\[补充: \]$/;
const MD_RE = /^[-*•] /;

function isNoise(c) {
  if (c.length < 10) return 'short';
  if (META_RE.test(c)) return 'meta';
  if (SHELL_RE.test(c)) return 'dedup-shell';
  if (MD_RE.test(c)) return 'md-list';
  return null;
}

// SQL 不支持完整正则，所以先拉所有活跃记忆再用 JS 全量判定
const all = db.prepare(`
  SELECT id, layer, track, priority, content
  FROM memories
  WHERE priority > 0
  ORDER BY id
`).all();
const final = all.filter(r => isNoise(r.content) !== null);

if (final.length === 0) {
  console.log('✓ 没有发现噪音记忆。');
  db.close();
  process.exit(0);
}

console.log(`发现 ${final.length} 条候选噪音记忆：\n`);
for (const r of final) {
  const reason = isNoise(r.content);
  console.log(`  #${String(r.id).padStart(3)} [${reason.padEnd(12)}] L${r.layer} ${r.track} p${r.priority} | ${r.content.slice(0, 70)}`);
}

if (dryRun) {
  console.log('\n[--dry-run] 跳过实际修改。');
  db.close();
  process.exit(0);
}

// 备份
const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const backupPath = `${dbPath}.pre-cleanup-${ts}`;
copyFileSync(dbPath, backupPath);
console.log(`\n已备份到 ${backupPath}`);

// 确认
if (!yes) {
  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = await rl.question(hard ? `确认物理删除 ${final.length} 条？(yes/no) ` : `确认软删除（priority=0）${final.length} 条？(yes/no) `);
  rl.close();
  if (ans.trim().toLowerCase() !== 'yes') {
    console.log('已取消。');
    db.close();
    process.exit(0);
  }
}

// 执行
const ids = final.map(r => r.id);
const placeholders = ids.map(() => '?').join(',');
if (hard) {
  const tx = db.transaction((idList) => {
    const delVec = db.prepare('DELETE FROM memories_vec WHERE rowid = ?');
    const del = db.prepare('DELETE FROM memories WHERE id = ?');
    let n = 0;
    for (const id of idList) {
      delVec.run(id);
      const r = del.run(id);
      if (r.changes) n++;
    }
    return n;
  });
  const removed = tx(ids);
  console.log(`✓ 物理删除 ${removed} 条`);
} else {
  const upd = db.prepare('UPDATE memories SET priority = 0, updated = CURRENT_TIMESTAMP WHERE id = ?');
  const tx = db.transaction((idList) => {
    let n = 0;
    for (const id of idList) { const r = upd.run(id); if (r.changes) n++; }
    return n;
  });
  const updated = tx(ids);
  console.log(`✓ 软删除 ${updated} 条（priority=0，可在 DSH UI 恢复）`);
}

db.close();
