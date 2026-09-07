#!/usr/bin/env node
/**
 * 记忆搜索工具
 * 用法: node scripts/memory-search.cjs <关键词> [--limit 5]
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DSH_HOME 
  ? path.join(process.env.DSH_HOME, 'memory.db')
  : path.join(require('os').homedir(), '.dsh', 'memory.db');

const args = process.argv.slice(2);
const query = args.find(a => !a.startsWith('--'));
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 && limitIdx < args.length - 1 
  ? parseInt(args[limitIdx + 1]) || 10 
  : 10;

if (!query) {
  console.log('用法: node scripts/memory-search.cjs <关键词> [--limit N]');
  process.exit(1);
}

console.log(`\n🔍 搜索记忆: "${query}" (最多 ${limit} 条)\n`);

const db = Database(DB_PATH);

// FTS5 搜索
const ftsQuery = `${query}*`;
const results = db.prepare(`
  SELECT m.id, m.content, m.priority, m.layer, m.track, fts.rank
  FROM memories_fts fts
  JOIN memories m ON m.id = fts.rowid
  WHERE memories_fts MATCH ?
  AND m.priority > 0
  ORDER BY fts.rank
  LIMIT ?
`).all(ftsQuery, limit);

if (results.length === 0) {
  console.log('未找到匹配的记忆');
  db.close();
  process.exit(0);
}

console.log(`找到 ${results.length} 条结果:\n`);
results.forEach((r, i) => {
  const priority = '⭐'.repeat(r.priority || 1);
  const track = r.track ? `[${r.track}]` : '';
  console.log(`${i + 1}. ${priority} ${r.content.slice(0, 60)} ${track}`);
});

console.log('\n');
db.close();
