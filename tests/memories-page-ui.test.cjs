const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('/memories page places AI review beside character selector and exposes latest changes', () => {
  const memoriesPage = readProjectFile('src/app/memories/page.tsx');
  const settingsPage = readProjectFile('src/app/settings/page.tsx');
  const i18n = readProjectFile('src/lib/i18n.ts');

  for (const snippet of [
    "fetch('/api/memory-review'",
    'handleMemoryAiReview',
    'memoryAiReviewRunning',
    'lastMemoryAiReviewResult',
    'showMemoryAiReviewChanges',
    'let nextOffset: number | null = 0;',
    'while (nextOffset !== null)',
    'offset: nextOffset',
    'aggregateResult.reviewed += result.reviewed ?? 0;',
    'aggregateResult.changes.push(...(result.changes ?? []));',
    'changes: Array<{ id: string; fields: string[]; content: string }>',
    "t('memory.aiReview')",
    "t('memory.viewLatestAiReviewChanges')",
    "t('memory.hideLatestAiReviewChanges')",
    "t('memory.aiReviewMemoryContent')",
    "setMemoryRefreshNonce(prev => prev + 1)",
    '<MemoryList characterId={selectedCharId} refreshNonce={memoryRefreshNonce} />',
  ]) {
    assert.ok(memoriesPage.includes(snippet), `missing snippet: ${snippet}`);
  }

  assert.match(
    memoriesPage,
    /\{change\.id\}[\s\S]*?\{t\('memory\.aiReviewChangedFields'\)\}: \{change\.fields\.join\('；'\)\}[\s\S]*?<details[\s\S]*?\{change\.content\}/,
    'AI review changes should keep changed fields visible and collapse only memory content',
  );

  const controlsStart = memoriesPage.indexOf('<div className="flex flex-wrap items-center gap-3">');
  assert.notEqual(controlsStart, -1, 'missing header controls');
  const controlsEnd = memoriesPage.indexOf('<select', controlsStart);
  assert.notEqual(controlsEnd, -1, 'missing character select after controls');
  const controlsBeforeSelect = memoriesPage.slice(controlsStart, controlsEnd);
  assert.ok(controlsBeforeSelect.includes("t('memory.aiReview')"), 'AI review button is not before character selector');

  assert.doesNotMatch(settingsPage, /fetch\('\/api\/memory-review'/);
  assert.doesNotMatch(settingsPage, /t\('settings\.memoryAiReview'\)/);

  for (const key of [
    'memory.aiReview',
    'memory.aiReviewRunning',
    'memory.aiReviewDone',
    'memory.aiReviewFailed',
    'memory.viewLatestAiReviewChanges',
    'memory.hideLatestAiReviewChanges',
    'memory.aiReviewNoChanges',
    'memory.aiReviewChangedFields',
    'memory.aiReviewMemoryContent',
  ]) {
    assert.match(i18n, new RegExp(`'${key}'`));
  }
});

test('/memories page binds AI review results to the initiating character', () => {
  const memoriesPage = readProjectFile('src/app/memories/page.tsx');

  for (const snippet of [
    'const selectedCharIdRef = useRef<string | null>(null);',
    'const requestedCharacterId = selectedCharId;',
    'body: JSON.stringify({ character_id: requestedCharacterId, offset: nextOffset })',
    'if (selectedCharIdRef.current !== requestedCharacterId) return;',
  ]) {
    assert.ok(memoriesPage.includes(snippet), `missing snippet: ${snippet}`);
  }
});

test('/memories page keeps AI review loading scoped to the initiating character', () => {
  const memoriesPage = readProjectFile('src/app/memories/page.tsx');
  const handlerStart = memoriesPage.indexOf('const handleMemoryAiReview = async () => {');
  assert.notEqual(handlerStart, -1, 'missing handleMemoryAiReview');
  const handlerEnd = memoriesPage.indexOf('return (', handlerStart);
  assert.notEqual(handlerEnd, -1, 'missing handleMemoryAiReview end marker');
  const handlerBlock = memoriesPage.slice(handlerStart, handlerEnd);

  assert.match(
    handlerBlock,
    /finally \{\s*if \(selectedCharIdRef\.current === requestedCharacterId\) \{\s*setMemoryAiReviewRunning\(false\);\s*\}\s*\}/,
    'an old AI review request must not clear the loading state for a newly selected character',
  );
});

test('/memories page clears AI review running and old result state when changing characters', () => {
  const memoriesPage = readProjectFile('src/app/memories/page.tsx');
  const selectStart = memoriesPage.indexOf('<select');
  assert.notEqual(selectStart, -1, 'missing character select');
  const selectEnd = memoriesPage.indexOf('className="select-rich min-w-56"', selectStart);
  assert.notEqual(selectEnd, -1, 'missing character select end marker');
  const selectBlock = memoriesPage.slice(selectStart, selectEnd);

  for (const snippet of [
    'selectedCharIdRef.current = nextCharacterId;',
    'setSelectedCharId(nextCharacterId);',
    'setMemoryAiReviewRunning(false);',
    'setLastMemoryAiReviewResult(null);',
    'setShowMemoryAiReviewChanges(false);',
  ]) {
    assert.ok(selectBlock.includes(snippet), `character change does not clear AI review state: ${snippet}`);
  }

  assert.ok(
    selectBlock.indexOf('setMemoryAiReviewRunning(false);') < selectBlock.indexOf('setLastMemoryAiReviewResult(null);'),
    'character change should clear running before resetting old review result state',
  );
});

test('memory list accumulates clicked tag filters and shows removable tag chips without label text', () => {
  const memoryList = readProjectFile('src/components/memories/MemoryList.tsx');
  const memoryCard = readProjectFile('src/components/memories/MemoryCard.tsx');
  const i18n = readProjectFile('src/lib/i18n.ts');

  for (const snippet of [
    'refreshNonce?: number;',
    'const [tagFilters, setTagFilters] = useState<string[]>([]);',
    "tagFilters.forEach(tag => params.append('tag', tag));",
    'const handleTagFilterClick = useCallback((tag: string) => {',
    'setTagFilters(prev => (prev.includes(tag) ? prev : [...prev, tag]));',
    'const clearTagFilter = useCallback((tag: string) => {',
    'setTagFilters(prev => prev.filter(item => item !== tag));',
    'setPage(1);',
    'onTagClick={handleTagFilterClick}',
    "t('memory.clearTagFilter')",
  ]) {
    assert.ok(memoryList.includes(snippet), `missing snippet: ${snippet}`);
  }

  assert.ok(memoryList.includes('refreshNonce'), 'MemoryList does not accept external refresh trigger');
  assert.doesNotMatch(memoryList, /memory\.activeTagFilter/);
  assert.doesNotMatch(i18n, /'memory\.activeTagFilter'/);
  assert.ok(memoryCard.includes('onTagClick?: (tag: string) => void;'));
  assert.ok(memoryCard.includes('onClick={e => { e.stopPropagation(); onTagClick?.(tag); }}'));
  assert.ok(memoryCard.includes("title={t('memory.filterByTag').replace('{tag}', tag)}"));

  for (const key of [
    'memory.clearTagFilter',
    'memory.filterByTag',
  ]) {
    assert.match(i18n, new RegExp(`'${key}'`));
  }
});

test('memory list guards stale loads and sends character_id for single delete', () => {
  const memoryList = readProjectFile('src/components/memories/MemoryList.tsx');

  for (const snippet of [
    'useRef',
    'const requestSeqRef = useRef(0);',
    'signal?: AbortSignal',
    'const requestSeq = ++requestSeqRef.current;',
    "fetch(`/api/memories?${params}`, { signal })",
    'signal?.aborted || requestSeq !== requestSeqRef.current',
    "error instanceof DOMException && error.name === 'AbortError'",
    'const controller = new AbortController();',
    'void fetchMemories(page, controller.signal);',
    'return () => controller.abort();',
    "body: JSON.stringify({ character_id: characterId || undefined })",
  ]) {
    assert.ok(memoryList.includes(snippet), `missing snippet: ${snippet}`);
  }

  assert.match(
    memoryList,
    /fetch\(`\/api\/memories\/\$\{id\}`,\s*\{\s*method: 'DELETE',\s*headers: \{ 'Content-Type': 'application\/json' \},\s*body: JSON\.stringify\(\{ character_id: characterId \|\| undefined \}\),/s,
    'single delete must send character_id while preserving JSON Content-Type',
  );
});

test('memory list refetches after write operations and disables in-flight write buttons', () => {
  const memoryList = readProjectFile('src/components/memories/MemoryList.tsx');
  const memoryCard = readProjectFile('src/components/memories/MemoryCard.tsx');
  const i18n = readProjectFile('src/lib/i18n.ts');

  assert.doesNotMatch(memoryList, /setMemories\(prev => prev\.map/);
  assert.doesNotMatch(memoryList, /setMemories\(prev => \[newMemory, \.\.\.prev\]/);
  assert.doesNotMatch(memoryList, /setSortOrder\('newest'\)/);

  for (const snippet of [
    'const [addingMemory, setAddingMemory] = useState(false);',
    'const [batchDeleting, setBatchDeleting] = useState(false);',
    'await fetchMemories(page);',
    'await fetchMemories(1);',
    "disabled={!characterId || selectMode || addingMemory}",
    "addingMemory ? t('memory.adding') : t('memory.add')",
    'disabled={batchDeleting}',
    "batchDeleting ? t('memory.deleting') : t('memory.batchDelete')",
  ]) {
    assert.ok(memoryList.includes(snippet), `missing MemoryList snippet: ${snippet}`);
  }

  for (const snippet of [
    "const [pendingAction, setPendingAction] = useState<'save' | 'delete' | 'pin' | null>(null);",
    'const isPending = pendingAction !== null;',
    "setPendingAction('save');",
    "setPendingAction('delete');",
    "setPendingAction('pin');",
    'disabled={isPending}',
    "pendingAction === 'save' ? t('memory.saving') : t('memory.save')",
    "pendingAction === 'delete' ? t('memory.deleting') : t('memory.delete')",
    "pendingAction === 'pin' ? t('memory.updating')",
    'aria-busy={pendingAction ===',
  ]) {
    assert.ok(memoryCard.includes(snippet), `missing MemoryCard snippet: ${snippet}`);
  }

  for (const key of [
    'memory.adding',
    'memory.saving',
    'memory.deleting',
    'memory.updating',
  ]) {
    assert.match(i18n, new RegExp(`'${key}'`));
  }
});
