const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('settings memory tab exposes repairable memory candidates and actions', () => {
  const settingsPage = readProjectFile('src/app/settings/page.tsx');
  const i18n = readProjectFile('src/lib/i18n.ts');

  assert.match(settingsPage, /fetch\('\/api\/memory-candidates\?limit=50'\)/);
  assert.match(settingsPage, /`\/api\/memory-candidates\/\$\{candidate\.id\}`/);

  for (const snippet of [
    "handleMemoryCandidateAction(candidate, 'accept')",
    "handleMemoryCandidateAction(candidate, 'edit-accept')",
    "handleMemoryCandidateAction(candidate, 'ignore')",
    "handleMemoryCandidateAction(candidate, 'discard')",
  ]) {
    assert.ok(settingsPage.includes(snippet), `missing snippet: ${snippet}`);
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

test('settings memory tab exposes diagnostics, profile, and archive management wiring', () => {
  const settingsPage = readProjectFile('src/app/settings/page.tsx');
  const i18n = readProjectFile('src/lib/i18n.ts');

  for (const snippet of [
    "fetch(`/api/memory-diagnostics${query}`)",
    "fetch('/api/memory-profile?character_id='",
    "fetch('/api/memory-profile',",
    "fetch('/api/memory-archive',",
    "handleMemoryProfileAction('init_from_memories')",
    "handleMemoryProfileRollback",
    "handleMemoryArchivePreview",
    "handleMemoryArchiveExecute",
    "handleMemoryArchiveUndo",
  ]) {
    assert.ok(settingsPage.includes(snippet), `missing snippet: ${snippet}`);
  }

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
  const settingsPage = readProjectFile('src/app/settings/page.tsx');

  for (const snippet of [
    "handleMemoryProfileAction('init')",
    "handleMemoryProfileAction('process')",
    "t('settings.memoryProfileRead')",
    "t('settings.memoryProfileInit')",
    "t('settings.memoryProfileProcessQueue')",
    "t('settings.memoryProfileInitHint')",
    "t('settings.memoryProfileProcessQueueHint')",
  ]) {
    assert.ok(!settingsPage.includes(snippet), `manual profile control should be hidden: ${snippet}`);
  }

  assert.ok(
    settingsPage.includes("handleMemoryProfileAction('init_from_memories')"),
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
  const settingsPage = readProjectFile('src/app/settings/page.tsx');

  assert.ok(settingsPage.includes('const diagnosticsCharacterId = memoryManagementCharacterIdRef.current.trim();'));
  assert.ok(settingsPage.includes("const query = diagnosticsCharacterId ? `?character_id=${encodeURIComponent(diagnosticsCharacterId)}` : '';"));
  assert.ok(settingsPage.includes('fetch(`/api/memory-diagnostics${query}`)'));
});

test('settings memory tab shows latest memory index failure reason', () => {
  const settingsPage = readProjectFile('src/app/settings/page.tsx');
  const i18n = readProjectFile('src/lib/i18n.ts');

  assert.ok(settingsPage.includes('memoryIndexStatus?.latest_error'));
  assert.ok(settingsPage.includes("t('settings.memoryIndexLatestError')"));
  assert.match(i18n, /'settings\.memoryIndexLatestError'/);
});

test('settings memory tab surfaces blocked memory index processing reasons', () => {
  const settingsPage = readProjectFile('src/app/settings/page.tsx');
  const i18n = readProjectFile('src/lib/i18n.ts');

  assert.ok(settingsPage.includes('processing_blocked_reason?: MemoryIndexProcessingBlockedReason'));
  assert.ok(settingsPage.includes('formatMemoryIndexBlockedReason'));
  assert.ok(settingsPage.includes('result.processing_blocked_reason'));
  assert.ok(settingsPage.includes('memoryIndexStatus?.processing_blocked_reason'));
  assert.ok(settingsPage.includes("t('settings.memoryIndexProcessingBlocked')"));

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
  const i18n = readProjectFile('src/lib/i18n.ts');

  assert.ok(settingsPage.includes('handleRetryFailedMemoryIndex'));
  assert.ok(settingsPage.includes("body: JSON.stringify({ action: 'retry_failed' })"));
  assert.ok(settingsPage.includes('memoryIndexRetrying'));
  assert.ok(settingsPage.includes('(memoryIndexStatus?.failed ?? 0) === 0'));
  assert.ok(settingsPage.includes("t('settings.memoryIndexRetryFailed')"));
  assert.match(i18n, /'settings\.memoryIndexRetryFailed'/);
  assert.match(i18n, /'settings\.memoryIndexRetryFailedQueued'/);
});

test('settings memory tab exposes clear index and stop current index actions', () => {
  const settingsPage = readProjectFile('src/app/settings/page.tsx');
  const i18n = readProjectFile('src/lib/i18n.ts');

  for (const snippet of [
    'handleClearMemoryIndex',
    "body: JSON.stringify({ action: 'clear_index' })",
    'memoryIndexClearing',
    'handleStopCurrentMemoryTask',
    "body: JSON.stringify({ action: 'stop_current' })",
    'memoryIndexStopping',
  ]) {
    assert.ok(settingsPage.includes(snippet), `missing snippet: ${snippet}`);
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

  assert.ok(settingsPage.includes('const memoryIndexActiveTasks ='));
  assert.ok(settingsPage.includes('(memoryIndexStatus?.pending ?? memoryIndexStatus?.queued ?? 0) + (memoryIndexStatus?.processing ?? 0)'));
  assert.ok(settingsPage.includes('memoryIndexActiveTasks === 0'));
});

test('settings memory tab exposes unindexed index action, AI archive stop, and profile version deletion', () => {
  const settingsPage = readProjectFile('src/app/settings/page.tsx');
  const i18n = readProjectFile('src/lib/i18n.ts');

  for (const snippet of [
    'handleIndexUnindexedMemoryIndex',
    "body: JSON.stringify({ action: 'index_unindexed' })",
    'memoryIndexIndexingUnindexed',
    "t('settings.memoryIndexIndexUnindexed')",
    'memoryArchiveAiControllerRef',
    'handleStopMemoryArchiveAi',
    'signal: controller.signal',
    'memoryArchiveAiRunning',
    "t('settings.memoryArchiveAiStop')",
    'handleMemoryProfileDeleteVersion',
    "body: JSON.stringify({ action: 'delete_version', character_id: characterId, version_id: versionId })",
    "t('settings.memoryProfileDeleteVersion')",
    'TrashIcon',
  ]) {
    assert.ok(settingsPage.includes(snippet), `missing snippet: ${snippet}`);
  }

  assert.doesNotMatch(settingsPage, /memoryProfile\.versions\.slice\(0,\s*3\)/);
  assert.ok(settingsPage.includes('memoryProfile.versions.map(version => ('));

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
  const settingsPage = readProjectFile('src/app/settings/page.tsx');

  assert.ok(settingsPage.includes('const shouldPollMemoryIndexStatus ='));
  assert.ok(settingsPage.includes('setInterval(() => {'));
  assert.ok(settingsPage.includes('void loadMemoryIndexStatus({ silent: true });'));
  assert.ok(settingsPage.includes('void loadMemoryDiagnostics({ silent: true });'));
  assert.ok(settingsPage.includes('return () => clearInterval(interval);'));
  assert.ok(settingsPage.includes('memoryIndexRebuilding'));
  assert.ok(settingsPage.includes('memoryIndexRetrying'));
  assert.ok(settingsPage.includes('(memoryIndexStatus?.queued ?? 0) > 0'));
  assert.ok(settingsPage.includes('(memoryIndexStatus?.processing ?? 0) > 0'));
});

test('settings memory tab hides advanced memory controls until enhanced memory is enabled', () => {
  const settingsPage = readProjectFile('src/app/settings/page.tsx');
  const i18n = readProjectFile('src/lib/i18n.ts');

  assert.ok(settingsPage.includes('const memoryEngineEnabled = settings.memory_engine.enabled;'));
  assert.ok(settingsPage.includes('{memoryEngineEnabled && ('));
  assert.ok(settingsPage.includes('{!memoryEngineEnabled && ('));
  assert.ok(settingsPage.includes("t('settings.memoryEngineDisabledHint')"));
  assert.match(i18n, /'settings\.memoryEngineDisabledHint'/);

  const advancedKeys = [
    "t('settings.memoryPrivacy')",
    "t('settings.memoryRetrievalMode')",
    "t('settings.memoryIndexStatus')",
    "t('settings.memoryDiagnosticsTitle')",
    "t('settings.memoryProfileTitle')",
    "t('settings.memoryArchiveTitle')",
    "t('settings.memoryCandidatesTitle')",
  ];
  const gatedBlockStart = settingsPage.indexOf('{memoryEngineEnabled && (');
  assert.notEqual(gatedBlockStart, -1, 'missing memoryEngineEnabled gate');
  for (const key of advancedKeys) {
    const keyIndex = settingsPage.indexOf(key, gatedBlockStart);
    assert.notEqual(keyIndex, -1, `advanced memory UI is not gated: ${key}`);
  }
});

test('settings memory mode appears directly below enhanced memory toggle', () => {
  const settingsPage = readProjectFile('src/app/settings/page.tsx');

  const toggleIndex = settingsPage.indexOf("t('settings.memoryEngineEnabled')");
  const modeIndex = settingsPage.indexOf("t('settings.memoryRetrievalMode')", toggleIndex);
  const privacyIndex = settingsPage.indexOf("t('settings.memoryPrivacy')", toggleIndex);

  assert.notEqual(toggleIndex, -1, 'missing enhanced memory toggle');
  assert.notEqual(modeIndex, -1, 'missing memory mode selector after enhanced memory toggle');
  assert.notEqual(privacyIndex, -1, 'missing memory privacy block after enhanced memory toggle');
  assert.ok(modeIndex < privacyIndex, 'memory mode selector should appear before memory privacy controls');
});

test('settings memory management uses selectable characters, memories, and archive batches instead of raw ids', () => {
  const settingsPage = readProjectFile('src/app/settings/page.tsx');
  const i18n = readProjectFile('src/lib/i18n.ts');

  for (const snippet of [
    "fetch('/api/characters')",
    "const MEMORY_ARCHIVE_MEMORY_LIMIT = 200;",
    "const memoryArchiveNextOffset = append ? options.offset ?? 0 : 0;",
    "const memoryArchiveNextOffset = memoryArchiveMemories.length;",
    "fetch(`/api/memories?character_id=${encodeURIComponent(characterId)}&status=active&exclude_archive_summary=1&limit=${MEMORY_ARCHIVE_MEMORY_LIMIT}&offset=${memoryArchiveNextOffset}`)",
    "setMemoryArchiveMemories(prev => (append ? [...prev, ...memories] : memories));",
    "setMemoryArchiveHasMore(Boolean(data.hasMore));",
    "setMemoryArchiveTotal(data.total ?? memories.length);",
    "loadMemoryArchiveMemories(memoryManagementCharacterId, { append: true, offset: memoryArchiveNextOffset })",
    "t('settings.memoryArchiveLoadMore')",
    "t('settings.memoryArchiveShownCount')",
    "fetch(`/api/memory-archive?character_id=${encodeURIComponent(characterId)}`)",
    'memoryManagementCharacterId',
    'selectedMemoryArchiveIds',
    'memoryArchiveBatches',
    'memoryArchiveHasMore',
    'memoryArchiveTotal',
  ]) {
    assert.ok(settingsPage.includes(snippet), `missing snippet: ${snippet}`);
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
  const settingsPage = readProjectFile('src/app/settings/page.tsx');

  for (const snippet of [
    'useRef',
    'memoryManagementCharacterIdRef',
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
    assert.ok(settingsPage.includes(snippet), `missing snippet: ${snippet}`);
  }

  const characterChangeStart = settingsPage.indexOf('const handleMemoryManagementCharacterChange = (characterId: string) => {');
  assert.notEqual(characterChangeStart, -1, 'missing character change handler');
  const characterChangeEnd = settingsPage.indexOf('const toggleMemoryArchiveSelection =', characterChangeStart);
  assert.notEqual(characterChangeEnd, -1, 'missing character change handler end marker');
  const characterChangeBlock = settingsPage.slice(characterChangeStart, characterChangeEnd);

  for (const snippet of [
    'memoryManagementCharacterIdRef.current = characterId;',
    'memoryArchiveRequestSeqRef.current += 1;',
    'setMemoryArchiveMemories([]);',
    'setMemoryArchiveHasMore(false);',
    'setMemoryArchiveTotal(0);',
    'setMemoryArchiveOffset(0);',
    'setSelectedMemoryArchiveIds([]);',
    'setMemoryArchivePlan(null);',
    'setMemoryArchiveError(null);',
  ]) {
    assert.ok(characterChangeBlock.includes(snippet), `character change does not clear: ${snippet}`);
  }
});

test('settings memory profile actions show automatic init feedback', () => {
  const settingsPage = readProjectFile('src/app/settings/page.tsx');
  const i18n = readProjectFile('src/lib/i18n.ts');

  for (const snippet of [
    "showToast(t('settings.memoryProfileInitFromMemoriesStarted'), 'success')",
    "const response = await fetch('/api/memory-profile',",
    "const result = await response.json().catch(() => null)",
    "!response.ok || !result || result.ok === false || result.error === 'no_active_memories'",
    "result.status === 'no_changes'",
    "typeof result?.detail === 'string' && result.detail ? result.detail",
    "setEditingProfile(false);",
    "setEditingProfileDraft({});",
    "showToast(t('settings.memoryProfileInitFromMemoriesDone').replace('{count}'",
  ]) {
    assert.ok(settingsPage.includes(snippet), `missing snippet: ${snippet}`);
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
  const settingsPage = readProjectFile('src/app/settings/page.tsx');
  const i18n = readProjectFile('src/lib/i18n.ts');

  for (const snippet of [
    "t('settings.memoryProfileCurrent')",
    'memoryProfile.versions.map(version => (',
  ]) {
    assert.ok(settingsPage.includes(snippet), `missing snippet: ${snippet}`);
  }

  assert.ok(!settingsPage.includes("{t('settings.memoryProfileTasks')}: {memoryProfile.tasks.length}"));
  assert.ok(!settingsPage.includes('const memoryProfileTaskStats ='));
  assert.ok(!settingsPage.includes("t('settings.memoryProfileTaskStatus')"));
  assert.ok(!settingsPage.includes("formatTemplate(t('settings.memoryProfileTaskSummary')"));
  assert.ok(!settingsPage.includes("t('settings.memoryProfileHistoryVersions')"));

  assert.match(i18n, /'settings\.memoryProfileCurrent'/);
  assert.doesNotMatch(i18n, /'settings\.memoryProfileTaskStatus'/);
  assert.doesNotMatch(i18n, /'settings\.memoryProfileTaskSummary'/);
  assert.doesNotMatch(i18n, /'settings\.memoryProfileTaskDoneCount'/);
  assert.doesNotMatch(i18n, /'settings\.memoryProfileHistoryVersions'/);
  assert.doesNotMatch(i18n, /'settings\.memoryProfileLatestFailure'/);
});

test('settings memory profile edit submits changed empty fields instead of dropping clears', () => {
  const settingsPage = readProjectFile('src/app/settings/page.tsx');
  const i18n = readProjectFile('src/lib/i18n.ts');

  for (const snippet of [
    'const currentProfile = memoryProfile.profile;',
    "if (trimmedValue !== (currentProfile[key] ?? '').trim()) {",
    'patch[key] = trimmedValue;',
    'const currentThreads = Array.isArray(currentProfile.open_threads) ? currentProfile.open_threads : [];',
    'if (threads.join(\'\\n\') !== currentThreads.join(\'\\n\')) {',
    'patch.open_threads = threads;',
    "showToast(t('settings.memoryProfileEditNoChanges'), 'info')",
  ]) {
    assert.ok(settingsPage.includes(snippet), `missing snippet: ${snippet}`);
  }

  assert.match(i18n, /'settings\.memoryProfileEditNoChanges'/);
});

test('settings memory profile display and model fetch errors use i18n keys', () => {
  const settingsPage = readProjectFile('src/app/settings/page.tsx');
  const i18n = readProjectFile('src/lib/i18n.ts');

  for (const snippet of [
    "setBgModelError(t('settings.apiBaseRequired'))",
    "setEmbeddingModelError(t('settings.memoryEmbeddingApiBaseRequired'))",
    "setRerankerModelError(t('settings.memoryRerankerApiBaseRequired'))",
    "formatTemplate(t('settings.memoryProfileDisplayRelationship')",
    "formatTemplate(t('settings.memoryProfileDisplayStory')",
    "formatTemplate(t('settings.memoryProfileDisplayEmotion')",
    "formatTemplate(t('settings.memoryProfileDisplayThreads')",
    "formatTemplate(t('settings.memoryProfileDisplayUser')",
    "formatTemplate(t('settings.memoryProfileDisplayPinned')",
  ]) {
    assert.ok(settingsPage.includes(snippet), `missing localized settings snippet: ${snippet}`);
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
  ]) {
    assert.match(i18n, new RegExp(`'${key}'`));
  }
});

test('settings memory archive actions refresh index status after changing archive summaries', () => {
  const settingsPage = readProjectFile('src/app/settings/page.tsx');

  for (const [handler, nextMarker] of [
    ['handleMemoryArchiveExecute', 'const handleMemoryArchiveUndo'],
    ['handleMemoryArchiveUndo', 'const handleMemoryArchiveAi'],
    ['handleMemoryArchiveAi', 'const loadMemoryArchiveBatchDetail'],
  ]) {
    const handlerStart = settingsPage.indexOf(`const ${handler} = async () => {`);
    assert.notEqual(handlerStart, -1, `missing handler: ${handler}`);
    const handlerEnd = settingsPage.indexOf(nextMarker, handlerStart);
    assert.notEqual(handlerEnd, -1, `missing end marker for handler: ${handler}`);
    const handlerBlock = settingsPage.slice(handlerStart, handlerEnd);

    assert.ok(
      handlerBlock.includes('await loadMemoryIndexStatus();'),
      `${handler} does not refresh memory index status`,
    );
  }
});

test('settings memory AI archive binds results to the initiating character', () => {
  const settingsPage = readProjectFile('src/app/settings/page.tsx');

  const handlerStart = settingsPage.indexOf('const handleMemoryArchiveAi = async () => {');
  assert.notEqual(handlerStart, -1, 'missing handleMemoryArchiveAi');
  const handlerEnd = settingsPage.indexOf('const handleStopMemoryArchiveAi', handlerStart);
  assert.notEqual(handlerEnd, -1, 'missing handleMemoryArchiveAi end marker');
  const handlerBlock = settingsPage.slice(handlerStart, handlerEnd);

  for (const snippet of [
    'const requestedCharacterId = characterId;',
    "body: JSON.stringify({ action: 'ai_archive', character_id: requestedCharacterId })",
    'if (memoryManagementCharacterIdRef.current !== requestedCharacterId) return;',
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
  const settingsPage = readProjectFile('src/app/settings/page.tsx');
  const i18n = readProjectFile('src/lib/i18n.ts');
  const settingsTypes = readProjectFile('src/types/index.ts');

  assert.ok(settingsPage.includes('settings.disable_deepseek_thinking_for_background'));
  assert.ok(settingsPage.includes("update('disable_deepseek_thinking_for_background', e.target.checked)"));
  assert.ok(settingsPage.includes("t('settings.disableDeepseekThinkingForBackground')"));
  assert.ok(settingsPage.includes("t('settings.disableDeepseekThinkingForBackgroundHint')"));
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
