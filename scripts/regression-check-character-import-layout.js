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

const memoriesPage = read('src/app/memories/page.tsx');
assert(!memoriesPage.includes('memories.export'), '记忆管理页不再显示导出按钮');
assert(!memoriesPage.includes('memories.import'), '记忆管理页不再显示导入按钮');
assert(!memoriesPage.includes('/api/import'), '记忆管理页不再直接导入备份');
assert(!memoriesPage.includes('/api/export'), '记忆管理页不再直接导出备份');

const editorPage = read('src/app/characters/[id]/page.tsx');
assert(editorPage.includes('ExportDialog'), '角色编辑页包含导出弹窗');
assert(editorPage.includes("type: 'character'"), '角色编辑页导出当前角色');
assert(editorPage.includes('include_characters'), '当前角色导出可勾选角色资料');
assert(editorPage.includes('include_memories'), '当前角色导出可勾选角色记忆');
assert(editorPage.includes('include_conversations'), '当前角色导出可勾选角色对话');
assert(editorPage.includes('handleImportCharacterCard'), '角色编辑页包含角色卡导入处理');
assert(editorPage.includes('function ImportDialog'), '角色编辑页包含当前角色导入弹窗');
assert(editorPage.includes('pendingImport'), 'LumiMuse 角色备份导入会先进入选项确认');
assert(editorPage.includes('includeCharacter'), '导入当前角色备份可勾选角色资料');
assert(editorPage.includes('includeMemories'), '导入当前角色备份可勾选角色记忆');
assert(editorPage.includes('includeConversations'), '导入当前角色备份可勾选角色对话');
assert(editorPage.includes("fetch('/api/import'"), '导入当前角色备份可追加记忆和对话');
assert(editorPage.includes('normalizeCharacterCard'), '角色编辑页导入使用统一角色卡解析');
assert(editorPage.includes("t('editor.identityInfo')"), '角色编辑页包含身份信息分组');
assert(editorPage.includes("t('editor.basicInfo')"), '角色编辑页包含独立基本信息分组');
assert(editorPage.includes("update('basic_info'"), '基本信息分组包含可编辑文本框');
assert(editorPage.includes("t('editor.personality')"), '角色编辑页包含性格分组');
assert(editorPage.includes("t('editor.scenario')"), '角色编辑页包含场景/世界观分组');
assert(editorPage.includes("t('editor.greeting')"), '角色编辑页包含开场白分组');
assert(editorPage.includes("t('editor.other')"), '角色编辑页包含其他分组');
assert(editorPage.includes("update('other_info'"), '其他分组编辑角色补充信息字段');
assert(editorPage.includes("t('editor.advanced')"), '系统提示词和生图标签保留在高级设置');
assert(editorPage.includes("t('editor.exampleDialogue')"), '角色编辑页包含示例对话分组');
assert(editorPage.indexOf("fetch('/api/import'") > editorPage.indexOf('applyPendingImport'), '只有确认导入备份时才调用导入接口');
assert(!editorPage.slice(editorPage.indexOf('handleImportCharacterCard'), editorPage.indexOf('applyPendingImport')).includes("method: 'PUT'"), '第三方角色卡导入不调用保存接口');

const parser = read('src/lib/character-card-import.ts');
assert(parser.includes('root.data'), '角色卡解析支持第三方 data 格式');
assert(parser.includes('basic_info'), '角色卡解析映射基本信息');
assert(parser.includes('first_mes'), '角色卡解析映射第三方开场白');
assert(parser.includes("basic_info: joinSections"), '角色卡解析映射第三方描述到基本信息');
assert(!parser.includes('text(data.personality) || text(data.description)'), '第三方 description 不重复写入性格');
assert(parser.includes('other_info'), '角色卡解析映射其他补充信息');
assert(parser.includes('post_history_instructions'), '角色卡解析保留第三方后置指令');
assert(parser.includes('creator_notes'), '角色卡解析保留第三方作者备注');

const chatEngine = read('src/lib/chat-engine.ts');
assert(chatEngine.includes('character.name'), '聊天提示词包含角色名称');
assert(chatEngine.includes('## 角色名称'), '聊天提示词包含角色名称标题');
assert(chatEngine.includes('character.basic_info'), '聊天提示词包含基本信息');
assert(chatEngine.includes('character.other_info'), '聊天提示词包含其他补充信息');

const generateRoute = read('src/app/api/characters/generate/route.ts');
assert(generateRoute.includes('basic_info'), 'AI 生成接口要求 basic_info');
assert(generateRoute.includes('不要重复 basic_info'), 'AI 生成接口要求性格不重复基本信息');

const importRoute = read('src/app/api/import/route.ts');
assert(importRoute.includes('normalizeCharacterCard'), '后端导入也支持第三方角色卡格式');
assert(importRoute.includes('newConvId'), '导入对话生成新的对话 ID');
assert(importRoute.includes('newMsgId'), '导入消息生成新的消息 ID');

const chatView = read('src/components/chat/ChatView.tsx');
assert(chatView.includes('uniqueMessagesById'), '聊天消息列表渲染前会去重');

if (process.exitCode) process.exit(process.exitCode);
console.log('角色导入与编辑布局回归检查通过');
