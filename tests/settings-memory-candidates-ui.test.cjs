const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// 结构契约测试：这些源码断言固定 Settings 记忆面板的组件/hook wiring。
// 候选列表 stale guard 和图片生成 abort 等关键路径由 frontend-state-p1.test.cjs 行为测试覆盖。
const root = path.resolve(__dirname, '..');

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function sourceBlock(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test('settings memory tab exposes repairable memory candidates and actions', () => {
  const settingsPage = readProjectFile('src/app/settings/page.tsx');
  const candidatesHook = readProjectFile('src/hooks/settings/useMemoryCandidatesPanel.ts');
  const candidatesPanel = readProjectFile('src/components/settings/memory/MemoryCandidatesPanel.tsx');
  const i18n = readProjectFile('src/lib/i18n.ts');

  assert.ok(settingsPage.includes('<MemoryCandidatesPanel'), 'settings page should render extracted candidates panel');
  assert.match(candidatesHook, /fetch\(`\/api\/memory-candidates\?character_id=\$\{encodeURIComponent\(characterId\)\}&limit=50`\)/);
  assert.match(candidatesHook, /`\/api\/memory-candidates\/\$\{candidate\.id\}`/);

  for (const snippet of [
    "handleMemoryCandidateAction(candidate, 'accept')",
    "handleMemoryCandidateAction(candidate, 'edit-accept')",
    "handleMemoryCandidateAction(candidate, 'ignore')",
    "handleMemoryCandidateAction(candidate, 'discard')",
  ]) {
    assert.ok(candidatesPanel.includes(snippet), `missing candidates panel snippet: ${snippet}`);
  }

  for (const key of [
    'settings.memoryCandidatesTitle',
    'settings.memoryCandidatesEmpty',
    'settings.memoryCandidatesErrorReason',
    'settings.memoryCandidatesRole',
    'settings.memoryCandidatesActionFailed',
  ]) {
    assert.match(i18n, new RegExp(`'${key}'`));
  }
});

test('settings memory candidate actions refresh diagnostics and index status after mutation', () => {
  const settingsPage = readProjectFile('src/app/settings/page.tsx');
  const candidatesHook = readProjectFile('src/hooks/settings/useMemoryCandidatesPanel.ts');
  const hookUsage = sourceBlock(
    settingsPage,
    'const memoryCandidatesPanel = useMemoryCandidatesPanel({',
    'const { loadMemoryManagementCharacters } = memoryManagementPanel;',
  );
  const actionBlock = sourceBlock(
    candidatesHook,
    'const handleMemoryCandidateAction = async (',
    'return {',
  );

  for (const snippet of [
    'loadMemoryDiagnostics',
    'loadMemoryIndexStatus',
  ]) {
    assert.ok(hookUsage.includes(snippet), `settings page does not pass candidate refresh callback: ${snippet}`);
    assert.ok(candidatesHook.includes(`${snippet}: () => Promise<void> | void;`), `candidate hook options missing: ${snippet}`);
  }

  const candidatesReloadIndex = actionBlock.indexOf('await loadMemoryCandidates(requestedCharacterId);');
  const diagnosticsReloadIndex = actionBlock.indexOf('await loadMemoryDiagnostics();');
  const indexStatusReloadIndex = actionBlock.indexOf('await loadMemoryIndexStatus();');

  assert.notEqual(candidatesReloadIndex, -1, 'candidate action should reload candidates');
  assert.notEqual(diagnosticsReloadIndex, -1, 'candidate action should refresh diagnostics');
  assert.notEqual(indexStatusReloadIndex, -1, 'candidate action should refresh memory index status');
  assert.ok(candidatesReloadIndex < diagnosticsReloadIndex, 'diagnostics should refresh after candidate reload');
  assert.ok(diagnosticsReloadIndex < indexStatusReloadIndex, 'index status should refresh after diagnostics');
});

test('settings memory tab exposes diagnostics, profile, and archive management wiring', () => {
  const settingsPage = readProjectFile('src/app/settings/page.tsx');
  const diagnosticsPanel = readProjectFile('src/components/settings/memory/MemoryDiagnosticsPanel.tsx');
  const memoryIndexHook = readProjectFile('src/hooks/settings/useMemoryIndexPanel.ts');
  const profileHook = readProjectFile('src/hooks/settings/useMemoryProfilePanel.ts');
  const profilePanel = readProjectFile('src/components/settings/memory/MemoryProfilePanel.tsx');
  const archiveHook = readProjectFile('src/hooks/settings/useMemoryArchivePanel.ts');
  const i18n = readProjectFile('src/lib/i18n.ts');

  for (const snippet of [
    "fetch('/api/memory-profile?character_id='",
    "fetch('/api/memory-profile',",
    "handleMemoryProfileRollback",
  ]) {
    assert.ok(profileHook.includes(snippet), `missing profile hook snippet: ${snippet}`);
  }
  assert.ok(profilePanel.includes("handleMemoryProfileAction('init_from_memories')"));

  for (const snippet of [
    "fetch('/api/memory-archive',",
    "handleMemoryArchivePreview",
    "handleMemoryArchiveExecute",
    "handleMemoryArchiveUndo",
  ]) {
    assert.ok(archiveHook.includes(snippet), `missing archive hook snippet: ${snippet}`);
  }
  assert.ok(settingsPage.includes('<MemoryDiagnosticsPanel'), 'settings page should render extracted diagnostics panel');
  assert.ok(settingsPage.includes('<MemoryProfilePanel'), 'settings page should render extracted profile panel');
  assert.ok(settingsPage.includes('<MemoryArchivePanel'), 'settings page should render extracted archive panel');
  assert.ok(diagnosticsPanel.includes("t('settings.memoryDiagnosticsTitle')"));
  assert.ok(memoryIndexHook.includes("fetch(`/api/memory-diagnostics${query}`)"));

  for (const key of [
    'settings.memoryDiagnosticsTitle',
    'settings.memoryDiagnosticsTasks',
    'settings.memoryDiagnosticsProfile',
    'settings.memoryProfileTitle',
    'settings.memoryManagementCharacter',
    'settings.memoryProfileInitFromMemories',
    'settings.memoryProfileRollback',
    'settings.memoryArchiveTitle',
    'settings.memoryArchivePreview',
    'settings.memoryArchiveExecute',
    'settings.memoryArchiveUndo',
  ]) {
    assert.match(i18n, new RegExp(`'${key}'`));
  }
});

test('settings memory profile panel hides manual read/create/process controls', () => {
  const profilePanel = readProjectFile('src/components/settings/memory/MemoryProfilePanel.tsx');

  for (const snippet of [
    "handleMemoryProfileAction('init')",
    "handleMemoryProfileAction('process')",
    "t('settings.memoryProfileRead')",
    "t('settings.memoryProfileInit')",
    "t('settings.memoryProfileProcessQueue')",
    "t('settings.memoryProfileInitHint')",
    "t('settings.memoryProfileProcessQueueHint')",
  ]) {
    assert.ok(!profilePanel.includes(snippet), `manual profile control should be hidden: ${snippet}`);
  }

  assert.ok(
    profilePanel.includes("handleMemoryProfileAction('init_from_memories')"),
    'profile panel should keep init-from-memories entry point',
  );
});

test('settings memory mode presets keep chat retrieval timeouts short', () => {
  const settingsPage = readProjectFile('src/app/settings/page.tsx');

  assert.ok(settingsPage.includes('const CHAT_RETRIEVAL_TIMEOUT_MS = 2500;'));
  assert.ok(settingsPage.includes('const CONTINUITY_CHAT_RETRIEVAL_TIMEOUT_MS = 5000;'));
  assert.ok(settingsPage.includes('embedding_timeout_ms: 1500'));
  assert.ok(settingsPage.includes('reranker_timeout_ms: 2000'));
  assert.ok(settingsPage.includes('total_retrieval_timeout_ms: CHAT_RETRIEVAL_TIMEOUT_MS'));
  assert.ok(settingsPage.includes('embedding_timeout_ms: 2500'));
  assert.ok(settingsPage.includes('reranker_timeout_ms: 3500'));
  assert.ok(settingsPage.includes('total_retrieval_timeout_ms: CONTINUITY_CHAT_RETRIEVAL_TIMEOUT_MS'));
  assert.doesNotMatch(settingsPage, /total_retrieval_timeout_ms:\s*BACKGROUND_EMBEDDING_TIMEOUT_MS\s*\+\s*1000/);
  assert.doesNotMatch(settingsPage, /total_retrieval_timeout_ms:\s*16000/);
});

test('settings memory diagnostics requests include selected management character id', () => {
  const memoryIndexHook = readProjectFile('src/hooks/settings/useMemoryIndexPanel.ts');

  assert.ok(memoryIndexHook.includes('const diagnosticsCharacterId = memoryManagementCharacterIdRef.current.trim();'));
  assert.ok(memoryIndexHook.includes("const query = diagnosticsCharacterId ? `?character_id=${encodeURIComponent(diagnosticsCharacterId)}` : '';"));
  assert.ok(memoryIndexHook.includes('fetch(`/api/memory-diagnostics${query}`)'));
});

test('settings memory tab shows latest memory index failure reason', () => {
  const memoryIndexPanel = readProjectFile('src/components/settings/memory/MemoryIndexPanel.tsx');
  const i18n = readProjectFile('src/lib/i18n.ts');

  assert.ok(memoryIndexPanel.includes('status?.latest_error'));
  assert.ok(memoryIndexPanel.includes("t('settings.memoryIndexLatestError')"));
  assert.match(i18n, /'settings\.memoryIndexLatestError'/);
});

test('settings memory tab surfaces blocked memory index processing reasons', () => {
  const memoryIndexHook = readProjectFile('src/hooks/settings/useMemoryIndexPanel.ts');
  const memoryIndexPanel = readProjectFile('src/components/settings/memory/MemoryIndexPanel.tsx');
  const i18n = readProjectFile('src/lib/i18n.ts');

  assert.ok(memoryIndexHook.includes('processing_blocked_reason?: MemoryIndexProcessingBlockedReason'));
  assert.ok(memoryIndexHook.includes('formatMemoryIndexBlockedReason'));
  assert.ok(memoryIndexHook.includes('result.processing_blocked_reason'));
  assert.ok(memoryIndexHook.includes('status?.processing_blocked_reason'));
  assert.ok(memoryIndexPanel.includes("t('settings.memoryIndexProcessingBlocked')"));

  for (const key of [
    'settings.memoryIndexProcessingBlocked',
    'settings.memoryIndexBlocked.memory_engine_disabled',
    'settings.memoryIndexBlocked.external_memory_payloads_disabled',
    'settings.memoryIndexBlocked.embedding_disabled',
    'settings.memoryIndexBlocked.embedding_api_base_missing',
    'settings.memoryIndexBlocked.embedding_model_missing',
  ]) {
    assert.match(i18n, new RegExp(`'${key}'`));
  }
});

test('settings memory tab exposes separate retry failed index action', () => {
  const settingsPage = readProjectFile('src/app/settings/page.tsx');
  const memoryIndexHook = readProjectFile('src/hooks/settings/useMemoryIndexPanel.ts');
  const memoryIndexPanel = readProjectFile('src/components/settings/memory/MemoryIndexPanel.tsx');
  const i18n = readProjectFile('src/lib/i18n.ts');

  assert.ok(settingsPage.includes('memoryIndexPanel.handleRetryFailedMemoryIndex'));
  assert.ok(memoryIndexHook.includes("body: JSON.stringify({ action: 'retry_failed' })"));
  assert.ok(memoryIndexHook.includes('retrying'));
  assert.ok(memoryIndexPanel.includes('(status?.failed ?? 0) === 0'));
  assert.ok(memoryIndexPanel.includes("t('settings.memoryIndexRetryFailed')"));
  assert.match(i18n, /'settings\.memoryIndexRetryFailed'/);
  assert.match(i18n, /'settings\.memoryIndexRetryFailedQueued'/);
});

test('settings memory tab exposes clear index and stop current index actions', () => {
  const memoryIndexHook = readProjectFile('src/hooks/settings/useMemoryIndexPanel.ts');
  const memoryIndexPanel = readProjectFile('src/components/settings/memory/MemoryIndexPanel.tsx');
  const i18n = readProjectFile('src/lib/i18n.ts');

  for (const snippet of [
    'handleClearMemoryIndex',
    "body: JSON.stringify({ action: 'clear_index' })",
    'handleStopCurrentMemoryTask',
    "body: JSON.stringify({ action: 'stop_current' })",
  ]) {
    assert.ok(memoryIndexHook.includes(snippet), `missing hook snippet: ${snippet}`);
  }

  for (const snippet of [
    'clearing',
    'stopping',
    'activeTasks === 0',
  ]) {
    assert.ok(memoryIndexPanel.includes(snippet), `missing panel snippet: ${snippet}`);
  }

  for (const key of [
    'settings.memoryIndexClear',
    'settings.memoryIndexClearing',
    'settings.memoryIndexClearSuccess',
    'settings.memoryIndexClearFailed',
    'settings.memoryIndexStopCurrent',
    'settings.memoryIndexStopping',
    'settings.memoryIndexStopCurrentSuccess',
    'settings.memoryIndexStopCurrentFailed',
  ]) {
    assert.match(i18n, new RegExp(`'${key}'`));
  }

  assert.ok(memoryIndexHook.includes('const activeTasks ='));
  assert.ok(memoryIndexHook.includes('(status?.pending ?? status?.queued ?? 0) + (status?.processing ?? 0)'));
});

test('settings memory tab exposes unindexed index action, AI archive stop, and profile version deletion', () => {
  const settingsPage = readProjectFile('src/app/settings/page.tsx');
  const memoryIndexHook = readProjectFile('src/hooks/settings/useMemoryIndexPanel.ts');
  const memoryIndexPanel = readProjectFile('src/components/settings/memory/MemoryIndexPanel.tsx');
  const archiveHook = readProjectFile('src/hooks/settings/useMemoryArchivePanel.ts');
  const archivePanel = readProjectFile('src/components/settings/memory/MemoryArchivePanel.tsx');
  const profileHook = readProjectFile('src/hooks/settings/useMemoryProfilePanel.ts');
  const profilePanel = readProjectFile('src/components/settings/memory/MemoryProfilePanel.tsx');
  const i18n = readProjectFile('src/lib/i18n.ts');

  for (const snippet of [
    'handleIndexUnindexedMemoryIndex',
    "body: JSON.stringify({ action: 'index_unindexed' })",
  ]) {
    assert.ok(memoryIndexHook.includes(snippet), `missing memory index hook snippet: ${snippet}`);
  }

  for (const snippet of [
    'indexingUnindexed',
    "t('settings.memoryIndexIndexUnindexed')",
  ]) {
    assert.ok(memoryIndexPanel.includes(snippet), `missing memory index panel snippet: ${snippet}`);
  }

  for (const snippet of [
    'memoryArchiveAiControllerRef',
    'handleStopMemoryArchiveAi',
    'signal: controller.signal',
    'memoryArchiveAiRunning',
  ]) {
    assert.ok(archiveHook.includes(snippet), `missing archive hook snippet: ${snippet}`);
  }

  for (const snippet of [
    "t('settings.memoryArchiveAiStop')",
  ]) {
    assert.ok(archivePanel.includes(snippet), `missing archive panel snippet: ${snippet}`);
  }

  for (const snippet of [
    'handleMemoryProfileDeleteVersion',
    "body: JSON.stringify({ action: 'delete_version', character_id: characterId, version_id: versionId })",
  ]) {
    assert.ok(profileHook.includes(snippet), `missing profile hook snippet: ${snippet}`);
  }

  for (const snippet of [
    "t('settings.memoryProfileDeleteVersion')",
    'TrashIcon',
  ]) {
    assert.ok(profilePanel.includes(snippet), `missing profile panel snippet: ${snippet}`);
  }

  assert.ok(settingsPage.includes('<MemoryProfilePanel'));
  assert.doesNotMatch(profilePanel, /memoryProfile\.versions\.slice\(0,\s*3\)/);
  assert.ok(profilePanel.includes('memoryProfile.versions.map(version => {'));

  for (const key of [
    'settings.memoryIndexIndexUnindexed',
    'settings.memoryIndexIndexingUnindexed',
    'settings.memoryIndexIndexUnindexedQueued',
    'settings.memoryIndexIndexUnindexedFailed',
    'settings.memoryArchiveAiStop',
    'settings.memoryArchiveAiStopping',
    'settings.memoryProfileDeleteVersion',
    'settings.memoryProfileDeleteVersionConfirm',
    'settings.memoryProfileVersionDeleted',
  ]) {
    assert.match(i18n, new RegExp(`'${key}'`));
  }
});

test('settings memory tab polls index status while rebuild or queue is active', () => {
  const memoryIndexHook = readProjectFile('src/hooks/settings/useMemoryIndexPanel.ts');

  assert.ok(memoryIndexHook.includes('const shouldPollMemoryIndexStatus ='));
  assert.ok(memoryIndexHook.includes('setInterval(() => {'));
  assert.ok(memoryIndexHook.includes('void loadMemoryIndexStatus({ silent: true });'));
  assert.ok(memoryIndexHook.includes('void loadMemoryDiagnostics({ silent: true });'));
  assert.ok(memoryIndexHook.includes('return () => clearInterval(interval);'));
  assert.ok(memoryIndexHook.includes('rebuilding'));
  assert.ok(memoryIndexHook.includes('retrying'));
  assert.ok(memoryIndexHook.includes('(status?.queued ?? 0) > 0'));
  assert.ok(memoryIndexHook.includes('(status?.processing ?? 0) > 0'));
});

test('settings memory tab hides advanced memory controls until enhanced memory is enabled', () => {
  const settingsPage = readProjectFile('src/app/settings/page.tsx');
  const memoryEngineSection = readProjectFile('src/components/settings/memory/MemoryEngineSection.tsx');
  const memoryIndexPanel = readProjectFile('src/components/settings/memory/MemoryIndexPanel.tsx');
  const diagnosticsPanel = readProjectFile('src/components/settings/memory/MemoryDiagnosticsPanel.tsx');
  const profilePanel = readProjectFile('src/components/settings/memory/MemoryProfilePanel.tsx');
  const archivePanel = readProjectFile('src/components/settings/memory/MemoryArchivePanel.tsx');
  const candidatesPanel = readProjectFile('src/components/settings/memory/MemoryCandidatesPanel.tsx');
  const i18n = readProjectFile('src/lib/i18n.ts');

  const memoryEngineSectionStart = settingsPage.indexOf('<MemoryEngineSection');
  const memoryEngineSectionEnd = settingsPage.indexOf('</MemoryEngineSection>', memoryEngineSectionStart);

  assert.notEqual(memoryEngineSectionStart, -1, 'settings page should render extracted memory engine section');
  assert.notEqual(memoryEngineSectionEnd, -1, 'settings page should close extracted memory engine section');
  assert.ok(memoryEngineSection.includes('const memoryEngineEnabled = settings.memory_engine.enabled;'));
  assert.ok(memoryEngineSection.includes('{memoryEngineEnabled && ('));
  assert.ok(memoryEngineSection.includes('{!memoryEngineEnabled && ('));
  assert.ok(memoryEngineSection.includes("t('settings.memoryEngineDisabledHint')"));
  assert.match(i18n, /'settings\.memoryEngineDisabledHint'/);

  const advancedKeys = [
    "t('settings.memoryPrivacy')",
    "t('settings.memoryRetrievalMode')",
  ];
  const gatedBlockStart = memoryEngineSection.indexOf('{memoryEngineEnabled && (');
  assert.notEqual(gatedBlockStart, -1, 'missing memoryEngineEnabled gate');
  for (const key of advancedKeys) {
    const keyIndex = memoryEngineSection.indexOf(key, gatedBlockStart);
    assert.notEqual(keyIndex, -1, `advanced memory UI is not gated: ${key}`);
  }

  const memoryEngineSectionUsage = settingsPage.slice(memoryEngineSectionStart, memoryEngineSectionEnd);
  for (const component of [
    '<MemoryIndexPanel',
    '<MemoryDiagnosticsPanel',
    '<MemoryProfilePanel',
    '<MemoryArchivePanel',
    '<MemoryCandidatesPanel',
  ]) {
    const componentIndex = memoryEngineSectionUsage.indexOf(component);
    assert.notEqual(componentIndex, -1, `advanced memory component should remain a MemoryEngineSection child: ${component}`);
  }

  assert.ok(memoryIndexPanel.includes("t('settings.memoryIndexStatus')"));
  assert.ok(diagnosticsPanel.includes("t('settings.memoryDiagnosticsTitle')"));
  assert.ok(profilePanel.includes("t('settings.memoryProfileTitle')"));
  assert.ok(archivePanel.includes("t('settings.memoryArchiveTitle')"));
  assert.ok(candidatesPanel.includes("t('settings.memoryCandidatesTitle')"));
});

test('settings memory mode appears directly below enhanced memory toggle', () => {
  const memoryEngineSection = readProjectFile('src/components/settings/memory/MemoryEngineSection.tsx');

  const toggleIndex = memoryEngineSection.indexOf("t('settings.memoryEngineEnabled')");
  const modeIndex = memoryEngineSection.indexOf("t('settings.memoryRetrievalMode')", toggleIndex);
  const privacyIndex = memoryEngineSection.indexOf("t('settings.memoryPrivacy')", toggleIndex);

  assert.notEqual(toggleIndex, -1, 'missing enhanced memory toggle');
  assert.notEqual(modeIndex, -1, 'missing memory mode selector after enhanced memory toggle');
  assert.notEqual(privacyIndex, -1, 'missing memory privacy block after enhanced memory toggle');
  assert.ok(modeIndex < privacyIndex, 'memory mode selector should appear before memory privacy controls');
});

test('settings memory management uses selectable characters, memories, and archive batches instead of raw ids', () => {
  const managementHook = readProjectFile('src/hooks/settings/useMemoryManagementCharacters.ts');
  const archiveHook = readProjectFile('src/hooks/settings/useMemoryArchivePanel.ts');
  const archivePanel = readProjectFile('src/components/settings/memory/MemoryArchivePanel.tsx');
  const profilePanel = readProjectFile('src/components/settings/memory/MemoryProfilePanel.tsx');
  const i18n = readProjectFile('src/lib/i18n.ts');

  for (const snippet of [
    "fetch('/api/characters')",
    'memoryManagementCharacterId',
  ]) {
    assert.ok(managementHook.includes(snippet), `missing management hook snippet: ${snippet}`);
  }

  for (const snippet of [
    "const MEMORY_ARCHIVE_MEMORY_LIMIT = 200;",
    "const memoryArchiveNextOffset = append ? options.offset ?? 0 : 0;",
    "fetch(`/api/memories?character_id=${encodeURIComponent(characterId)}&status=active&exclude_archive_summary=1&limit=${MEMORY_ARCHIVE_MEMORY_LIMIT}&offset=${memoryArchiveNextOffset}`)",
    "setMemoryArchiveMemories(prev => (append ? [...prev, ...memories] : memories));",
    "setMemoryArchiveHasMore(Boolean(data.hasMore));",
    "setMemoryArchiveTotal(data.total ?? memories.length);",
    "fetch(`/api/memory-archive?character_id=${encodeURIComponent(characterId)}`)",
    'selectedMemoryArchiveIds',
    'memoryArchiveBatches',
    'memoryArchiveHasMore',
    'memoryArchiveTotal',
  ]) {
    assert.ok(archiveHook.includes(snippet), `missing archive hook snippet: ${snippet}`);
  }

  for (const snippet of [
    "const memoryArchiveNextOffset = archive.memoryArchiveMemories.length;",
    "loadMemoryArchiveMemories(memoryManagementCharacterId, { append: true, offset: memoryArchiveNextOffset })",
    "t('settings.memoryArchiveLoadMore')",
    "t('settings.memoryArchiveShownCount')",
  ]) {
    assert.ok(archivePanel.includes(snippet), `missing archive panel snippet: ${snippet}`);
  }

  for (const snippet of [
    "t('settings.memoryManagementCharacter')",
    "t('settings.memoryManagementChooseCharacter')",
  ]) {
    assert.ok(profilePanel.includes(snippet), `missing profile panel snippet: ${snippet}`);
  }

  for (const rawIdKey of [
    'settings.memoryProfileCharacterId',
    'settings.memoryArchiveCoveredIds',
    'settings.memoryArchiveBatchId',
  ]) {
    assert.doesNotMatch(i18n, new RegExp(`'${rawIdKey}'`));
  }

  for (const key of [
    'settings.memoryManagementCharacter',
    'settings.memoryManagementChooseCharacter',
    'settings.memoryArchiveSelectMemories',
    'settings.memoryArchiveNoMemories',
    'settings.memoryArchiveLoadMore',
    'settings.memoryArchiveShownCount',
    'settings.memoryArchiveSelectBatch',
    'settings.memoryArchiveNoBatches',
  ]) {
    assert.match(i18n, new RegExp(`'${key}'`));
  }
});

test('settings memory archive list ignores stale role responses and clears pagination on role change', () => {
  const managementHook = readProjectFile('src/hooks/settings/useMemoryManagementCharacters.ts');
  const archiveHook = readProjectFile('src/hooks/settings/useMemoryArchivePanel.ts');

  for (const snippet of [
    'useRef',
    'memoryManagementCharacterIdRef',
  ]) {
    assert.ok(managementHook.includes(snippet), `missing management hook snippet: ${snippet}`);
  }

  for (const snippet of [
    'memoryArchiveRequestSeqRef',
    'const requestSeq = memoryArchiveRequestSeqRef.current;',
    'memoryManagementCharacterIdRef.current !== characterId',
    'requestSeq !== memoryArchiveRequestSeqRef.current',
    'setMemoryArchiveHasMore(false);',
    'setMemoryArchiveTotal(0);',
    'setMemoryArchiveOffset(0);',
    'setSelectedMemoryArchiveIds([]);',
    'setMemoryArchivePlan(null);',
    'setMemoryArchiveError(null);',
  ]) {
    assert.ok(archiveHook.includes(snippet), `missing archive hook snippet: ${snippet}`);
  }

  const characterChangeStart = managementHook.indexOf('const handleMemoryManagementCharacterChange = (characterId: string, callbacks: MemoryManagementCharacterChangeCallbacks) => {');
  assert.notEqual(characterChangeStart, -1, 'missing character change handler');
  const characterChangeEnd = managementHook.indexOf('void callbacks.loadMemoryDiagnostics();', characterChangeStart);
  assert.notEqual(characterChangeEnd, -1, 'missing character change handler end marker');
  const characterChangeBlock = managementHook.slice(characterChangeStart, characterChangeEnd);

  for (const snippet of [
    'memoryManagementCharacterIdRef.current = characterId;',
    'callbacks.resetProfile();',
    'callbacks.resetArchiveForCharacterChange();',
  ]) {
    assert.ok(characterChangeBlock.includes(snippet), `character change does not clear: ${snippet}`);
  }
});

test('settings memory archive non-AI responses are bound to the initiating character', () => {
  const archiveHook = readProjectFile('src/hooks/settings/useMemoryArchivePanel.ts');

  for (const snippet of [
    'memoryArchiveActionRequestSeqRef',
    'memoryArchiveDetailRequestSeqRef',
    'const isCurrentMemoryArchiveActionRequest = (requestedCharacterId: string, requestSeq: number) => (',
    'const isCurrentMemoryArchiveDetailRequest = (requestedCharacterId: string, requestSeq: number) => (',
    'setMemoryArchiveLoading(false);',
  ]) {
    assert.ok(archiveHook.includes(snippet), `missing archive action stale guard support: ${snippet}`);
  }

  for (const [handler, nextMarker] of [
    ['handleMemoryArchivePreview', 'const handleMemoryArchiveExecute'],
    ['handleMemoryArchiveExecute', 'const handleMemoryArchiveUndo'],
    ['handleMemoryArchiveUndo', 'const handleMemoryArchiveAi'],
  ]) {
    const handlerBlock = sourceBlock(
      archiveHook,
      `const ${handler} = async`,
      nextMarker,
    );

    for (const snippet of [
      'memoryArchiveActionRequestSeqRef.current += 1;',
      'const requestSeq = memoryArchiveActionRequestSeqRef.current;',
      'isCurrentMemoryArchiveActionRequest(requestedCharacterId, requestSeq)',
    ]) {
      assert.ok(handlerBlock.includes(snippet), `${handler} is missing stale response guard: ${snippet}`);
    }
    assert.ok(
      handlerBlock.includes('const requestedCharacterId = body.character_id;')
        || handlerBlock.includes('const requestedCharacterId = characterId;'),
      `${handler} should bind the request to the initiating character`,
    );
  }

  const detailBlock = sourceBlock(
    archiveHook,
    'const loadMemoryArchiveBatchDetail = async',
    'return {',
  );
  for (const snippet of [
    'if (!batchId) { memoryArchiveDetailRequestSeqRef.current += 1; setMemoryArchiveBatchDetail(null); return; }',
    'if (!characterId) { memoryArchiveDetailRequestSeqRef.current += 1; return; }',
    'const requestedCharacterId = body.character_id;',
    'memoryArchiveDetailRequestSeqRef.current += 1;',
    'const requestSeq = memoryArchiveDetailRequestSeqRef.current;',
    'isCurrentMemoryArchiveDetailRequest(requestedCharacterId, requestSeq)',
  ]) {
    assert.ok(detailBlock.includes(snippet), `loadMemoryArchiveBatchDetail is missing stale response guard: ${snippet}`);
  }

  for (const [handler, nextMarker] of [
    ['handleMemoryArchivePreview', 'const handleMemoryArchiveExecute'],
    ['handleMemoryArchiveExecute', 'const handleMemoryArchiveUndo'],
  ]) {
    const handlerBlock = sourceBlock(
      archiveHook,
      `const ${handler} = async`,
      nextMarker,
    );
    assert.ok(
      handlerBlock.includes('if (isCurrentMemoryArchiveActionRequest(requestedCharacterId, requestSeq)) {\n        setMemoryArchiveLoading(false);\n      }'),
      `${handler} should only clear loading for the active archive request`,
    );
  }
});

test('settings memory profile actions show automatic init feedback', () => {
  const profileHook = readProjectFile('src/hooks/settings/useMemoryProfilePanel.ts');
  const i18n = readProjectFile('src/lib/i18n.ts');

  for (const snippet of [
    "showToast(t('settings.memoryProfileInitFromMemoriesStarted'), 'success')",
    "const response = await fetch('/api/memory-profile',",
    'const data = await parseJsonResponse<unknown>(response)',
    "throw new HttpResponseError('Invalid memory profile action response'",
    'err instanceof HttpResponseError',
    "err.data.error === 'no_active_memories'",
    "result.status === 'no_changes'",
    "setEditingProfile(false);",
    "setEditingProfileDraft({});",
    "showToast(t('settings.memoryProfileInitFromMemoriesDone').replace('{count}'",
  ]) {
    assert.ok(profileHook.includes(snippet), `missing profile hook snippet: ${snippet}`);
  }

  for (const key of [
    'settings.memoryProfileInitFromMemoriesStarted',
    'settings.memoryProfileInitFromMemoriesDone',
    'settings.memoryProfileInitFromMemoriesNoMemories',
    'settings.memoryProfileInitFromMemoriesNoChanges',
  ]) {
    assert.match(i18n, new RegExp(`'${key}'`));
  }
});

test('settings memory profile panel omits task and history count headings', () => {
  const profilePanel = readProjectFile('src/components/settings/memory/MemoryProfilePanel.tsx');
  const i18n = readProjectFile('src/lib/i18n.ts');

  for (const snippet of [
    "t('settings.memoryProfileCurrent')",
    'memoryProfile.versions.map(version => {',
  ]) {
    assert.ok(profilePanel.includes(snippet), `missing profile panel snippet: ${snippet}`);
  }

  assert.ok(!profilePanel.includes("{t('settings.memoryProfileTasks')}: {memoryProfile.tasks.length}"));
  assert.ok(!profilePanel.includes('const memoryProfileTaskStats ='));
  assert.ok(!profilePanel.includes("t('settings.memoryProfileTaskStatus')"));
  assert.ok(!profilePanel.includes("formatTemplate(t('settings.memoryProfileTaskSummary')"));
  assert.ok(!profilePanel.includes("t('settings.memoryProfileHistoryVersions')"));

  assert.match(i18n, /'settings\.memoryProfileCurrent'/);
  assert.doesNotMatch(i18n, /'settings\.memoryProfileTaskStatus'/);
  assert.doesNotMatch(i18n, /'settings\.memoryProfileTaskSummary'/);
  assert.doesNotMatch(i18n, /'settings\.memoryProfileTaskDoneCount'/);
  assert.doesNotMatch(i18n, /'settings\.memoryProfileHistoryVersions'/);
  assert.doesNotMatch(i18n, /'settings\.memoryProfileLatestFailure'/);
});

test('settings memory profile edit submits changed empty fields instead of dropping clears', () => {
  const profileHook = readProjectFile('src/hooks/settings/useMemoryProfilePanel.ts');
  const profilePanel = readProjectFile('src/components/settings/memory/MemoryProfilePanel.tsx');
  const i18n = readProjectFile('src/lib/i18n.ts');

  for (const snippet of [
    'const currentProfile = memoryProfile.profile;',
    "profile_name: p.profile_name ?? ''",
    "'profile_name'",
    "if (trimmedValue !== (currentProfile[key] ?? '').trim()) {",
    'patch[key] = trimmedValue;',
    'const currentThreads = Array.isArray(currentProfile.open_threads) ? currentProfile.open_threads : [];',
    'if (threads.join(\'\\n\') !== currentThreads.join(\'\\n\')) {',
    'patch.open_threads = threads;',
    "showToast(t('settings.memoryProfileEditNoChanges'), 'info')",
  ]) {
    assert.ok(profileHook.includes(snippet), `missing profile hook snippet: ${snippet}`);
  }

  assert.ok(profilePanel.includes("t('settings.memoryProfileFieldName')"));

  assert.match(i18n, /'settings\.memoryProfileEditNoChanges'/);
  assert.match(i18n, /'settings\.memoryProfileFieldName'/);
});

test('settings memory profile display and model fetch errors use i18n keys', () => {
  const settingsPage = readProjectFile('src/app/settings/page.tsx');
  const profilePanel = readProjectFile('src/components/settings/memory/MemoryProfilePanel.tsx');
  const i18n = readProjectFile('src/lib/i18n.ts');

  for (const snippet of [
    "setBgModelError(t('settings.apiBaseRequired'))",
    "setEmbeddingModelError(t('settings.memoryEmbeddingApiBaseRequired'))",
    "setRerankerModelError(t('settings.memoryRerankerApiBaseRequired'))",
  ]) {
    assert.ok(settingsPage.includes(snippet), `missing localized settings snippet: ${snippet}`);
  }

  for (const snippet of [
    "formatTemplate(t('settings.memoryProfileDisplayRelationship')",
    "formatTemplate(t('settings.memoryProfileDisplayStory')",
    "formatTemplate(t('settings.memoryProfileDisplayEmotion')",
    "formatTemplate(t('settings.memoryProfileDisplayThreads')",
    "formatTemplate(t('settings.memoryProfileDisplayUser')",
    "formatTemplate(t('settings.memoryProfileDisplayPinned')",
    "version.snapshot?.profile_name?.trim()",
  ]) {
    assert.ok(profilePanel.includes(snippet), `missing localized profile panel snippet: ${snippet}`);
  }

  for (const hardcoded of [
    '请先配置 API 地址',
    '请先配置 Embedding API 地址',
    '请先配置 Reranker API 地址',
    '关系状态：',
    '近期故事：',
    '情绪基线：',
    '进行中的话题：',
    '用户摘要：',
    '钉选摘要：',
  ]) {
    assert.ok(!settingsPage.includes(hardcoded), `settings page still contains hardcoded text: ${hardcoded}`);
  }

  for (const key of [
    'settings.apiBaseRequired',
    'settings.memoryEmbeddingApiBaseRequired',
    'settings.memoryRerankerApiBaseRequired',
    'settings.memoryProfileDisplayRelationship',
    'settings.memoryProfileDisplayStory',
    'settings.memoryProfileDisplayEmotion',
    'settings.memoryProfileDisplayThreads',
    'settings.memoryProfileDisplayUser',
    'settings.memoryProfileDisplayPinned',
    'settings.memoryProfileFieldName',
  ]) {
    assert.match(i18n, new RegExp(`'${key}'`));
  }
});

test('settings memory archive actions refresh index status after changing archive summaries', () => {
  const archiveHook = readProjectFile('src/hooks/settings/useMemoryArchivePanel.ts');

  for (const [handler, nextMarker] of [
    ['handleMemoryArchiveExecute', 'const handleMemoryArchiveUndo'],
    ['handleMemoryArchiveUndo', 'const handleMemoryArchiveAi'],
    ['handleMemoryArchiveAi', 'const loadMemoryArchiveBatchDetail'],
  ]) {
    const handlerStart = archiveHook.indexOf(`const ${handler} = async () => {`);
    assert.notEqual(handlerStart, -1, `missing handler: ${handler}`);
    const handlerEnd = archiveHook.indexOf(nextMarker, handlerStart);
    assert.notEqual(handlerEnd, -1, `missing end marker for handler: ${handler}`);
    const handlerBlock = archiveHook.slice(handlerStart, handlerEnd);

    assert.ok(
      handlerBlock.includes('await loadMemoryIndexStatus();'),
      `${handler} does not refresh memory index status`,
    );
  }
});

test('settings memory AI archive binds results to the initiating character', () => {
  const archiveHook = readProjectFile('src/hooks/settings/useMemoryArchivePanel.ts');

  const handlerStart = archiveHook.indexOf('const handleMemoryArchiveAi = async () => {');
  assert.notEqual(handlerStart, -1, 'missing handleMemoryArchiveAi');
  const handlerEnd = archiveHook.indexOf('const handleStopMemoryArchiveAi', handlerStart);
  assert.notEqual(handlerEnd, -1, 'missing handleMemoryArchiveAi end marker');
  const handlerBlock = archiveHook.slice(handlerStart, handlerEnd);

  for (const snippet of [
    'const requestedCharacterId = characterId;',
    "body: JSON.stringify({ action: 'ai_archive', character_id: requestedCharacterId })",
    'isCurrentMemoryArchiveAiRequest(requestedCharacterId, requestSeq, controller)',
    'await loadMemoryArchiveMemories(requestedCharacterId);',
    'await loadMemoryArchiveBatches(requestedCharacterId);',
  ]) {
    assert.ok(handlerBlock.includes(snippet), `missing snippet: ${snippet}`);
  }
});

test('settings memory diagnostics no longer owns AI review entry point', () => {
  const settingsPage = readProjectFile('src/app/settings/page.tsx');

  assert.doesNotMatch(settingsPage, /fetch\('\/api\/memory-review'/);
  assert.doesNotMatch(settingsPage, /t\('settings\.memoryAiReview'\)/);
});

test('settings memory tab exposes DeepSeek background thinking toggle and backend tasks wire it', () => {
  const memoryEngineSection = readProjectFile('src/components/settings/memory/MemoryEngineSection.tsx');
  const i18n = readProjectFile('src/lib/i18n.ts');
  const settingsTypes = readProjectFile('src/types/index.ts');

  assert.ok(memoryEngineSection.includes('settings.disable_deepseek_thinking_for_background'));
  assert.ok(memoryEngineSection.includes("update('disable_deepseek_thinking_for_background', e.target.checked)"));
  assert.ok(memoryEngineSection.includes("t('settings.disableDeepseekThinkingForBackground')"));
  assert.ok(memoryEngineSection.includes("t('settings.disableDeepseekThinkingForBackgroundHint')"));
  assert.match(i18n, /'settings\.disableDeepseekThinkingForBackground'/);
  assert.match(i18n, /'settings\.disableDeepseekThinkingForBackgroundHint'/);
  assert.match(settingsTypes, /disable_deepseek_thinking_for_background:\s*boolean/);
  assert.match(settingsTypes, /disable_deepseek_thinking_for_background:\s*false/);

  for (const relativePath of [
    'src/app/api/image-gen/prompt/route.ts',
    'src/app/api/memory-review/route.ts',
    'src/lib/memory-profile.ts',
    'src/app/api/memory-archive/route.ts',
  ]) {
    const source = readProjectFile(relativePath);
    assert.ok(source.includes('buildBackgroundChatExtraBody'), `${relativePath} does not import background extra body helper`);
    assert.ok(source.includes('backgroundExtraBody'), `${relativePath} does not pass background extra body to chatCompletion`);
  }
});
