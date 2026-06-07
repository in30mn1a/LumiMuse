const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// 结构契约测试：保留这些源码断言用于固定错误展示入口与 UI wiring。
// hook 级错误保留行为由 frontend-state-p1.test.cjs 的运行时行为测试覆盖。
const root = path.resolve(__dirname, '..');

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function sliceBetween(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  assert.notEqual(start, -1, `missing start marker: ${startNeedle}`);
  const end = source.indexOf(endNeedle, start);
  assert.notEqual(end, -1, `missing end marker: ${endNeedle}`);
  return source.slice(start, end);
}

function firstResponseValidationIndex(block) {
  const expectIndex = block.indexOf('await expectOkResponse');
  const parseIndex = block.indexOf('await parseJsonResponse');
  return [expectIndex, parseIndex].filter(index => index !== -1).sort((a, b) => a - b)[0] ?? -1;
}

test('useMessagePaging exposes message load failures instead of swallowing /api/messages errors', () => {
  const hook = readProjectFile('src/hooks/chat/useMessagePaging.ts');

  assert.match(hook, /onError\?: \(message: string\) => void;/);
  assert.match(hook, /const \[messagePagingError, setMessagePagingError\] = useState<string \| null>\(null\);/);
  assert.match(hook, /const reportMessagePagingError = useCallback/);
  assert.match(hook, /messagePagingError,/);

  assert.ok(
    !hook.includes('.catch(() => {});'),
    'message fetch failures should update hook state or notify the caller, not be swallowed',
  );
  assert.match(
    hook,
    /if \(isAbortError\(error\)\) return;\s*reportMessagePagingError\(error\);/,
    'aborted requests may stay quiet, but real failures should be reported',
  );
});

test('ChatView surfaces /api/messages and /api/settings failures to users', () => {
  const source = readProjectFile('src/components/chat/ChatView.tsx');

  const pagingCall = sliceBetween(source, 'useMessagePaging({', '  clearMessagesRef.current = clearMessages;');
  assert.match(pagingCall, /onError: message => showToast\(`\$\{t\('chat\.messageLoadFailed'\)\}: \$\{message\}`, 'error'\),/);

  const initialSettingsEffect = sliceBetween(source, "fetch('/api/settings')", '}, []);');
  assert.match(initialSettingsEffect, /parseJsonResponse<Partial<Settings>>/);
  assert.match(initialSettingsEffect, /showToast\(`\$\{t\('settings.loadFailed'\)\}: \$\{[^}]+\}`, 'error'\)/);

  const imageHook = readProjectFile('src/hooks/chat/useChatImageGeneration.ts');
  const autoImageBlock = sliceBetween(imageHook, 'const maybeAutoGenerateImageFromMessages = useCallback', '  const handleDeleteImage');
  assert.match(autoImageBlock, /parseJsonResponse<Partial<Settings>>/);
  assert.match(autoImageBlock, /showToast\(`\$\{t\('chat.autoImageGenFailed'\)\}: \$\{[^}]+\}`, 'error'\)/);
  assert.ok(!autoImageBlock.includes('catch {\r\n      // 自动生图失败不影响主流程\r\n    }'));
  assert.match(source, /useChatImageGeneration\(/);
  assert.match(source, /maybeAutoGenerateImageFromMessages/);
});

test('ChatView write handlers validate failed responses before local mutation or refresh', () => {
  const source = readProjectFile('src/components/chat/ChatView.tsx');

  const renameBlock = sliceBetween(source, 'const handleRenameConv = async', '  const handleDeleteConv');
  const renameValidationIndex = firstResponseValidationIndex(renameBlock);
  assert.notEqual(renameValidationIndex, -1, 'rename should validate the write response');
  assert.ok(
    renameValidationIndex < renameBlock.indexOf('setConversations(prev => prev.map'),
    'rename should not update the local conversation title before validating the write response',
  );
  assert.match(renameBlock, /catch \(err\) \{\s*showToast\(err instanceof Error \? err\.message : t\('common\.operationFailed'\), 'error'\);/);

  const editBlock = sliceBetween(source, 'const handleEditMessage = useCallback', '  const handleDeleteMessage');
  const editValidationIndex = firstResponseValidationIndex(editBlock);
  assert.notEqual(editValidationIndex, -1, 'message edit should validate the write response');
  assert.ok(
    editValidationIndex < editBlock.indexOf('await refreshMessages();'),
    'message edits should not refresh messages before validating the write response',
  );
  assert.match(editBlock, /catch \(err\) \{\s*showToast\(err instanceof Error \? err\.message : t\('common\.operationFailed'\), 'error'\);/);

  const switchBlock = sliceBetween(source, 'const handleSwitchVersion = useCallback', '  const handleSummarize');
  const switchValidationIndex = firstResponseValidationIndex(switchBlock);
  assert.notEqual(switchValidationIndex, -1, 'version switch should validate the write response');
  assert.ok(
    switchValidationIndex < switchBlock.indexOf('await refreshMessages();'),
    'version switches should not refresh messages before validating the write response',
  );
  assert.match(switchBlock, /catch \(err\) \{\s*showToast\(err instanceof Error \? err\.message : t\('common\.operationFailed'\), 'error'\);/);
});

test('automatic image generation records inline failure state without blocking chat flow', () => {
  const source = readProjectFile('src/hooks/chat/useChatImageGeneration.ts');
  const chatView = readProjectFile('src/components/chat/ChatView.tsx');
  const generateBlock = sliceBetween(source, 'const handleGenerateImage = useCallback', '  useEffect(() => {');

  assert.match(generateBlock, /status: 'failed'/);
  assert.match(generateBlock, /error: message/);
  assert.match(generateBlock, /showToast\(message, 'error'\)/);
  assert.match(
    generateBlock,
    /catch \(persistErr\) \{\s*console\.warn\('\[image-gen\] 写入失败状态失败：', persistErr\);\s*showToast\(`\$\{t\('chat\.autoImageGenFailed'\)\}: \$\{message\}`, 'error'\);\s*\}/,
    'even when the inline placeholder cannot be persisted, the image error should still be visible',
  );
  assert.match(chatView, /handleGenerateImage/);
  assert.match(chatView, /onGenerateImage=\{handleGenerateImage\}/);
});

test('maintenance preview and cleanup failures show inline errors and do not report success', () => {
  const source = readProjectFile('src/app/settings/page.tsx');
  const maintenanceStart = source.indexOf('function MaintenanceSection');
  assert.notEqual(maintenanceStart, -1, 'missing MaintenanceSection');
  const maintenance = source.slice(maintenanceStart);

  assert.match(maintenance, /const \[errorMessage, setErrorMessage\] = useState<string \| null>\(null\);/);
  assert.match(maintenance, /await parseJsonResponse<\{ total: number; orphanFiles: Record<string, OrphanFileInfo> \}>\(res\);/);
  assert.match(maintenance, /await parseJsonResponse<\{ dbDeleted: number; fileResults: Record<string, \{ deleted: number; errors: number \}> \}>\(res\);/);
  assert.match(maintenance, /setErrorMessage\(`\$\{t\('settings\.cleanupPreviewFailed'\)\}: \$\{getErrorMessage\(err\)\}`\);/);
  assert.match(maintenance, /setErrorMessage\(`\$\{t\('settings\.cleanupFailed'\)\}: \$\{getErrorMessage\(err\)\}`\);/);
  assert.match(maintenance, /status === 'error' \? 'text-red-600'/);

  assert.ok(
    !maintenance.includes('const data = await res.json()'),
    'maintenance should not parse failed responses as successful payloads',
  );
});

test('settings page initial /api/settings failure has a visible error path', () => {
  const source = readProjectFile('src/app/settings/page.tsx');
  const loadEffect = sliceBetween(source, "fetch('/api/settings')", '  const handleLogout = async');

  assert.match(loadEffect, /parseJsonResponse<Partial<SettingsWithMemoryEngine>>/);
  assert.match(loadEffect, /showToast\(`\$\{tRef\.current\('settings.loadFailed'\)\}: \$\{getErrorMessage\(err\)\}`, 'error'\)/);
});
