const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('character-card import warns about trusted sources without adding an import gate', () => {
  const editor = read('src/app/characters/[id]/page.tsx');
  const i18n = read('src/lib/i18n.ts');
  const importDialog = editor.slice(editor.indexOf('function ImportDialog'), editor.indexOf('export default function CharacterEditor'));

  assert.match(importDialog, /t\('import\.characterMemoryRisk'\)/);
  assert.match(i18n, /'import\.characterMemoryRisk': '请仅导入可信来源的角色卡。第三方角色卡中的对话和记忆可能长期保存在本地，并影响后续记忆提取与角色表现。'/);
  assert.match(i18n, /'import\.characterMemoryRisk': 'Only import character cards from sources you trust\.[^']+influence future memory extraction and character behavior\.'/);
  assert.match(importDialog, /onClick=\{\(\) => onConfirm\(\{ includeCharacter, includeMemories, includeConversations, includeProfiles, includeEmbeddings \}\)\}/);
  assert.doesNotMatch(importDialog, /useState[^\n]*(?:trust|risk)/i);
});

test('chat discloses remote Markdown image requests without blocking or proxying image URLs', () => {
  const chatInput = read('src/components/chat/ChatInput.tsx');
  const messageBubble = read('src/components/chat/MessageBubble.tsx');
  const i18n = read('src/lib/i18n.ts');

  assert.match(chatInput, /role="note"[^]*t\('input\.remoteMarkdownImagePrivacy'\)/);
  assert.match(i18n, /'input\.remoteMarkdownImagePrivacy': '隐私提示：聊天消息中的远程 Markdown 图片会让浏览器向第三方地址发起请求，可能暴露 IP 等网络信息。'/);
  assert.match(i18n, /'input\.remoteMarkdownImagePrivacy': 'Privacy notice: remote Markdown images in chat messages make browser requests to third-party addresses and may expose network information such as your IP address\.'/);
  assert.match(messageBubble, /<ReactMarkdown remarkPlugins=\{\[remarkGfm\]\} components=\{MD_COMPONENTS_(?:USER|ASSISTANT)\}>/);
  assert.doesNotMatch(messageBubble, /\bimg\s*:\s*\(/);
});
