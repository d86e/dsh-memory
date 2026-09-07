#!/usr/bin/env node
/**
 * 手动触发记忆合并和清理
 * 用法: node scripts/consolidate.js [--threshold 0.8] [--dry-run]
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DSH_HOME 
  ? path.join(process.env.DSH_HOME, 'memory.db')
  : path.join(require('os').homedir(), '.dsh', 'memory.db');

const args = process.argv.slice(2);
const threshold = parseFloat(args.find(a => a === '--threshold' && args[args.indexOf(a) + 1]) || '0.8');
const dryRun = args.includes('--dry-run');

console.log(`\n🧠 记忆合并工具 v0.4.15`);
console.log(`   相似度阈值: ${threshold}`);
console.log(`   数据库: ${DB_PATH}\n`);

const db = Database(DB_PATH);

// 获取所有活跃记忆
const all = db.prepare('SELECT id, content, priority FROM memories WHERE priority > 0 ORDER BY id').all();
console.log(`📊 当前记忆数: ${all.length}`);

if (all.length < 2) {
  console.log('✅ 无需合并');
  db.close();
  process.exit(0);
}

// 计算相似度并找出可合并的记忆
let merged = 0;
const used = new Set();

for (let i = 0; i < all.length; i++) {
  if (used.has(i)) continue;
  
  for (let j = i + 1; j < all.length; j++) {
    if (used.has(j)) continue;
    
    const words1 = new Set(all[i].content.split(/\s+/).filter(w => w.length > 2));
    const words2 = new Set(all[j].content.split(/\s+/).filter(w => w.length > 2));
    const common = [...words1].filter(w => words2.has(w)).length;
    const maxWords = Math.max(words1.size, words2.size);
    const similarity = maxWords > 0 ? common / maxWords : 0;
    
    if (similarity >= threshold) {
      if (dryRun) {
        console.log(`  📌 建议合并: #${all[i].id} & #${all[j].id} (${(similarity * 100).toFixed(0)}% 相似)`);
      } else {
        // 合并
        const mergedContent = all[i].content.length >= all[j].content.length 
          ? all[i].content 
          : all[j].content;
        const mergedPriority = Math.max(all[i].priority || 1, all[j].priority || 1);
        
        db.prepare('UPDATE memories SET content = ?, priority = ? WHERE id = ?').run(
          mergedContent, mergedPriority, all[i].id
        );
        db.prepare('DELETE FROM memories WHERE id = ?').run(all[j].id);
        used.add(j);
        merged++;
        console.log(`  ✅ 合并: #${all[i].id} + #${all[j].id}`);
      }
    }
  }
  used.add(i);
}

console.log(`\n${dryRun ? '📋 ' : '✅ '}共 ${merged} 组记忆可合并`);
console.log('');

db.close();
