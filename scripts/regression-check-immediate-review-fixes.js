const fs = require('fs');
const path = require('path');

const root = process.cwd();
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const assert = (condition, message) => {
  if (!condition) {
    console.error('❌ ' + message);
    process.exitCode = 1;
  } else {
    console.log('✅ ' + message);
  }
};

const providersRoute = read('src/app/api/providers/route.ts');
assert(providersRoute.includes('isUuid'), 'providers 路由校验 provider id 格式');
assert(providersRoute.includes('const id = randomUUID();'), 'providers POST 不再信任客户端传入 id');
assert((providersRoute.match(/const unauthorized = await requireAuth\(request\);/g) || []).length >= 3, 'providers 写操作都会先做路由内鉴权');

const importRoute = read('src/app/api/import/route.ts');
assert(importRoute.includes('const importAll = db.transaction'), '导入角色、记忆、对话和消息使用一个整体事务');
assert(!importRoute.includes('const importConversations = db.transaction'), '导入接口不再只给对话和消息单独包事务');
assert(importRoute.indexOf('for (const char of charactersToImport)') > importRoute.indexOf('const importAll = db.transaction'), '角色导入在整体事务内部执行');
assert(importRoute.indexOf('for (const mem of memoriesToImport)') > importRoute.indexOf('const importAll = db.transaction'), '记忆导入在整体事务内部执行');

const messageRoute = read('src/app/api/messages/[id]/route.ts');
assert(messageRoute.includes('mergeMessageMetadata'), '消息更新会合并 metadata 而不是直接覆盖');
assert(!messageRoute.includes("UPDATE messages SET metadata = ? WHERE id = ?').run(JSON.stringify(body.metadata), id)"), '消息 PUT 不再用传入 metadata 覆盖整份 metadata');
assert(messageRoute.includes('body.content !== undefined && body.metadata !== undefined'), '消息 PUT 覆盖 content + metadata 同传场景');

const memoryQueue = read('src/lib/memory-queue.ts');
assert(!memoryQueue.includes('MAX_EXTRACTION_TOKENS'), '记忆提取不再设置 token 上限');
assert(memoryQueue.includes('buildExtractionText'), '记忆提取通过统一函数构建文本');
assert(!memoryQueue.includes('estimateTokens'), '记忆提取不再按 token 估算裁剪');
assert(memoryQueue.includes('for (const message of messages)'), '记忆提取会遍历全部待提取消息');

if (process.exitCode) process.exit(process.exitCode);
console.log('立即修复回归检查通过');
