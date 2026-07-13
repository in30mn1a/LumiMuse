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

  const initialSettingsEffect = sliceBetween(source, "fetch('/api/settings')", '  }, [showToast, t]);');
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
  const messageActionsHook = readProjectFile('src/hooks/chat/useChatMessageActions.ts');

  const renameBlock = sliceBetween(source, 'const handleRenameConv = async', '  const handleDeleteConv');
  const renameValidationIndex = firstResponseValidationIndex(renameBlock);
  assert.notEqual(renameValidationIndex, -1, 'rename should validate the write response');
  assert.ok(
    renameValidationIndex < renameBlock.indexOf('setConversations(prev => prev.map'),
    'rename should not update the local conversation title before validating the write response',
  );
  assert.match(renameBlock, /catch \(err\) \{\s*showToast\(err instanceof Error \? err\.message : t\('common\.operationFailed'\), 'error'\);/);

  const editBlock = sliceBetween(messageActionsHook, 'const handleEditMessage = useCallback', '  const handleDeleteMessage');
  const editValidationIndex = firstResponseValidationIndex(editBlock);
  assert.notEqual(editValidationIndex, -1, 'message edit should validate the write response');
  assert.ok(
    editValidationIndex < editBlock.indexOf('await refreshMessagesForConversation(updated.conversation_id);'),
    'message edits should not refresh messages before validating the write response',
  );
  assert.match(editBlock, /catch \(err\) \{\s*showToast\(err instanceof Error \? err\.message : t\('common\.operationFailed'\), 'error'\);/);

  const switchBlock = sliceBetween(messageActionsHook, 'const handleSwitchVersion = useCallback', '  return {');
  const switchValidationIndex = firstResponseValidationIndex(switchBlock);
  assert.notEqual(switchValidationIndex, -1, 'version switch should validate the write response');
  assert.ok(
    switchValidationIndex < switchBlock.indexOf('await refreshMessagesForConversation(updated.conversation_id);'),
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
  const loadEffect = sliceBetween(source, "fetch('/api/settings')", '  const loadMemoryPanelState');

  assert.match(loadEffect, /parseJsonResponse<Partial<SettingsWithMemoryEngine>>/);
  assert.match(loadEffect, /showToast\(`\$\{tRef\.current\('settings.loadFailed'\)\}: \$\{getErrorMessage\(err\)\}`, 'error'\)/);
});

test('character and memories pages validate initial loads and surface failures', () => {
  const characterPage = readProjectFile('src/app/characters/[id]/page.tsx');
  const memoriesPage = readProjectFile('src/app/memories/page.tsx');

  const characterLoad = sliceBetween(characterPage, 'useEffect(() => {', '  // beforeunload');
  assert.match(characterLoad, /parseJsonResponse<Character>/);
  assert.match(characterLoad, /showToast\(`\$\{t\('common\.loadFailed'\)\}: \$\{getErrorMessage\(error\)\}`, 'error'\)/);
  assert.doesNotMatch(characterLoad, /\.then\(r => r\.json\(\)\)\.then\(setCharacter\)/);

  const memoriesLoad = sliceBetween(memoriesPage, 'useEffect(() => {', '  useEffect(() => {\n    selectedCharIdRef.current');
  assert.match(memoriesLoad, /parseJsonArrayResponse<Character>/);
  assert.match(memoriesLoad, /showToast\(`\$\{t\('common\.loadFailed'\)\}: \$\{getErrorMessage\(error\)\}`, 'error'\)/);
  assert.doesNotMatch(memoriesLoad, /\.then\(r => r\.json\(\)\)/);
});

test('global message search surfaces non-abort failures instead of empty results', () => {
  const hook = readProjectFile('src/hooks/use-message-search.ts');
  const searchUi = readProjectFile('src/components/search/GlobalSearch.tsx');

  assert.match(hook, /import \{ getErrorMessage, parseJsonResponse \} from '@\/lib\/http'/);
  assert.match(hook, /const \[error, setError\] = useState<string \| null>\(null\);/);
  assert.match(hook, /const data = await parseJsonResponse<unknown>\(response\);/);
  assert.match(hook, /parseSearchPayload\(data\)/);
  assert.match(hook, /if \(isAbortError\(err\)\) return;/);
  assert.match(hook, /setError\(getErrorMessage\(err\)\);/);
  assert.match(hook, /return \{ results, loading, loadingMore, hasMore, error, loadMore, clearSearch \};/);
  // loadMore 重试前清旧错误，避免 loadingMore 期间错误条残留
  assert.match(hook, /setLoadingMore\(true\);\s*setError\(null\);/);
  assert.match(
    hook,
    /error instanceof DOMException \|\| error instanceof Error/,
    'AbortError should also match plain Error instances',
  );

  assert.match(searchUi, /error,/);
  assert.match(searchUi, /role="alert"/);
  assert.match(searchUi, /\$\{t\('common\.loadFailed'\)\}: \$\{error\}/);
  assert.match(searchUi, /!loading && !error && query && results\.length === 0/);
});

test('theme and language bootstrap retry once and log permanent settings failures', () => {
  const i18n = readProjectFile('src/lib/i18n-context.tsx');
  const theme = readProjectFile('src/lib/theme-provider.tsx');
  const events = readProjectFile('src/lib/settings-bootstrap-events.ts');
  const toastListener = readProjectFile('src/components/ui/SettingsBootstrapToast.tsx');
  const layout = readProjectFile('src/app/layout.tsx');

  assert.match(i18n, /SETTINGS_BOOTSTRAP_MAX_ATTEMPTS = 2/);
  assert.match(i18n, /console\.warn\('\[i18n\] failed to load language from \/api\/settings; using default'/);
  assert.match(i18n, /notifySettingsBootstrapFailed\('i18n'\)/);
  assert.doesNotMatch(i18n, /\.catch\(\(\) => \{\}\)/);

  assert.match(theme, /SETTINGS_BOOTSTRAP_MAX_ATTEMPTS = 2/);
  assert.match(theme, /console\.warn\("\[theme\] failed to load theme from \/api\/settings; using current defaults"/);
  assert.match(theme, /notifySettingsBootstrapFailed\("theme"\)/);
  assert.doesNotMatch(theme, /\.catch\(\(\) => \{\}\)/);

  assert.match(events, /SETTINGS_BOOTSTRAP_FAILED_EVENT/);
  assert.match(toastListener, /showToast\(t\('settings\.loadFailed'\), 'error'\)/);
  assert.match(layout, /SettingsBootstrapToast/);
});
