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

test('chat omits the input placeholder and remote Markdown image privacy notice', () => {
  const chatInput = read('src/components/chat/ChatInput.tsx');
  const messageBubble = read('src/components/chat/MessageBubble.tsx');
  const i18n = read('src/lib/i18n.ts');

  assert.doesNotMatch(chatInput, /placeholder=\{t\('input\.placeholder'\)\}/);
  assert.doesNotMatch(chatInput, /t\('input\.remoteMarkdownImagePrivacy'\)/);
  assert.doesNotMatch(i18n, /'input\.placeholder':/);
  assert.doesNotMatch(i18n, /'input\.remoteMarkdownImagePrivacy':/);
  assert.match(messageBubble, /<ReactMarkdown remarkPlugins=\{\[remarkGfm\]\} components=\{MD_COMPONENTS_(?:USER|ASSISTANT)\}>/);
  assert.doesNotMatch(messageBubble, /\bimg\s*:\s*\(/);
});
