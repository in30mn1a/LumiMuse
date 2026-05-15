/**
 * 孤儿数据清理脚本
 *
 * 用法：node scripts/cleanup-orphans.js
 * 加 --dry-run 参数只预览不实际删除：node scripts/cleanup-orphans.js --dry-run
 *
 * 清理范围：
 *   1. 孤儿消息（conversation_id 不存在于 conversations 表）
 *   2. 孤儿对话（character_id 不存在于 characters 表）
 *   3. 孤儿记忆（character_id 不存在于 characters 表）
 *   4. 孤儿记忆任务（conversation_id 不存在于 conversations 表）
 *   5. 孤儿 FTS 索引（id 不存在于 messages 表）
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(process.cwd(), 'data', 'lumimuse.db');
const isDryRun = process.argv.includes('--dry-run');

console.log(`\n🔍 LumiMuse 孤儿数据清理工具`);
console.log(`📂 数据库路径：${DB_PATH}`);
console.log(isDryRun ? `🔎 模式：预览（不实际删除）\n` : `⚠️  模式：实际删除\n`);

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── 统计当前数据量 ──────────────────────────────────────────────
const stats = {
  characters: db.prepare('SELECT COUNT(*) as n FROM characters').get().n,
  conversations: db.prepare('SELECT COUNT(*) as n FROM conversations').get().n,
  messages: db.prepare('SELECT COUNT(*) as n FROM messages').get().n,
  memories: db.prepare('SELECT COUNT(*) as n FROM memories').get().n,
  memory_tasks: db.prepare('SELECT COUNT(*) as n FROM memory_tasks').get().n,
};

console.log('📊 当前数据量：');
console.log(`   角色：${stats.characters} 条`);
console.log(`   对话：${stats.conversations} 条`);
console.log(`   消息：${stats.messages} 条`);
console.log(`   记忆：${stats.memories} 条`);
console.log(`   记忆任务：${stats.memory_tasks} 条\n`);

// ── 检测孤儿数据 ────────────────────────────────────────────────
const orphanMessages = db.prepare(`
  SELECT COUNT(*) as n FROM messages
  WHERE conversation_id NOT IN (SELECT id FROM conversations)
`).get().n;

const orphanConversations = db.prepare(`
  SELECT COUNT(*) as n FROM conversations
  WHERE character_id NOT IN (SELECT id FROM characters)
`).get().n;

const orphanMemories = db.prepare(`
  SELECT COUNT(*) as n FROM memories
  WHERE character_id NOT IN (SELECT id FROM characters)
`).get().n;

const orphanMemoryTasks = db.prepare(`
  SELECT COUNT(*) as n FROM memory_tasks
  WHERE conversation_id NOT IN (SELECT id FROM conversations)
`).get().n;

// FTS 孤儿（messages_fts 中有但 messages 中没有的）
let orphanFts = 0;
try {
  orphanFts = db.prepare(`
    SELECT COUNT(*) as n FROM messages_fts
    WHERE id NOT IN (SELECT id FROM messages)
  `).get().n;
} catch {
  // messages_fts 可能不存在
}

console.log('🔎 检测结果：');
console.log(`   孤儿消息（对话已删除）：${orphanMessages} 条`);
console.log(`   孤儿对话（角色已删除）：${orphanConversations} 条`);
console.log(`   孤儿记忆（角色已删除）：${orphanMemories} 条`);
console.log(`   孤儿记忆任务：${orphanMemoryTasks} 条`);
console.log(`   孤儿 FTS 索引：${orphanFts} 条\n`);

const totalOrphans = orphanMessages + orphanConversations + orphanMemories + orphanMemoryTasks + orphanFts;

if (totalOrphans === 0) {
  console.log('✅ 数据库干净，没有孤儿数据！');
  db.close();
  process.exit(0);
}

if (isDryRun) {
  console.log(`📋 预览：共发现 ${totalOrphans} 条孤儿数据，运行不带 --dry-run 参数可实际清理。`);
  db.close();
  process.exit(0);
}

// ── 实际清理 ────────────────────────────────────────────────────
console.log('🧹 开始清理...');

const cleanup = db.transaction(() => {
  let deleted = 0;

  // 1. 孤儿消息
  if (orphanMessages > 0) {
    const r = db.prepare(`
      DELETE FROM messages
      WHERE conversation_id NOT IN (SELECT id FROM conversations)
    `).run();
    console.log(`   ✓ 删除孤儿消息：${r.changes} 条`);
    deleted += r.changes;
  }

  // 2. 孤儿对话（先删消息再删对话，避免外键冲突）
  if (orphanConversations > 0) {
    const orphanConvIds = db.prepare(`
      SELECT id FROM conversations
      WHERE character_id NOT IN (SELECT id FROM characters)
    `).all().map(r => r.id);

    if (orphanConvIds.length > 0) {
      // 先删这些对话下的消息
      const placeholders = orphanConvIds.map(() => '?').join(',');
      const msgR = db.prepare(`DELETE FROM messages WHERE conversation_id IN (${placeholders})`).run(...orphanConvIds);
      if (msgR.changes > 0) console.log(`   ✓ 删除孤儿对话下的消息：${msgR.changes} 条`);

      // 再删记忆任务
      const taskR = db.prepare(`DELETE FROM memory_tasks WHERE conversation_id IN (${placeholders})`).run(...orphanConvIds);
      if (taskR.changes > 0) console.log(`   ✓ 删除孤儿对话的记忆任务：${taskR.changes} 条`);

      // 最后删对话
      const convR = db.prepare(`DELETE FROM conversations WHERE id IN (${placeholders})`).run(...orphanConvIds);
      console.log(`   ✓ 删除孤儿对话：${convR.changes} 条`);
      deleted += convR.changes;
    }
  }

  // 3. 孤儿记忆
  if (orphanMemories > 0) {
    const r = db.prepare(`
      DELETE FROM memories
      WHERE character_id NOT IN (SELECT id FROM characters)
    `).run();
    console.log(`   ✓ 删除孤儿记忆：${r.changes} 条`);
    deleted += r.changes;
  }

  // 4. 孤儿记忆任务
  if (orphanMemoryTasks > 0) {
    const r = db.prepare(`
      DELETE FROM memory_tasks
      WHERE conversation_id NOT IN (SELECT id FROM conversations)
    `).run();
    console.log(`   ✓ 删除孤儿记忆任务：${r.changes} 条`);
    deleted += r.changes;
  }

  // 5. 孤儿 FTS 索引
  if (orphanFts > 0) {
    try {
      const r = db.prepare(`
        DELETE FROM messages_fts
        WHERE id NOT IN (SELECT id FROM messages)
      `).run();
      console.log(`   ✓ 删除孤儿 FTS 索引：${r.changes} 条`);
      deleted += r.changes;
    } catch (e) {
      console.log(`   ⚠️  FTS 清理跳过：${e.message}`);
    }
  }

  return deleted;
});

const totalDeleted = cleanup();

// ── 统计清理后数据量 ────────────────────────────────────────────
const afterStats = {
  conversations: db.prepare('SELECT COUNT(*) as n FROM conversations').get().n,
  messages: db.prepare('SELECT COUNT(*) as n FROM messages').get().n,
  memories: db.prepare('SELECT COUNT(*) as n FROM memories').get().n,
  memory_tasks: db.prepare('SELECT COUNT(*) as n FROM memory_tasks').get().n,
};

console.log(`\n✅ 清理完成，共删除 ${totalDeleted} 条孤儿数据`);
console.log('\n📊 清理后数据量：');
console.log(`   对话：${afterStats.conversations} 条（减少 ${stats.conversations - afterStats.conversations} 条）`);
console.log(`   消息：${afterStats.messages} 条（减少 ${stats.messages - afterStats.messages} 条）`);
console.log(`   记忆：${afterStats.memories} 条（减少 ${stats.memories - afterStats.memories} 条）`);
console.log(`   记忆任务：${afterStats.memory_tasks} 条（减少 ${stats.memory_tasks - afterStats.memory_tasks} 条）`);

db.close();
