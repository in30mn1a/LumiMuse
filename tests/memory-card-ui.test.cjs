const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('memory card edit mode exposes all editable memory metadata fields', () => {
  const memoryCard = readProjectFile('src/components/memories/MemoryCard.tsx');

  for (const snippet of [
    'const [editMemoryKind, setEditMemoryKind]',
    'const [editImportance, setEditImportance]',
    'const [editEmotionalWeight, setEditEmotionalWeight]',
    'const [editConfidence, setEditConfidence]',
    'const [editStatus, setEditStatus]',
    'content: editContent',
    'category: editCategory',
    'tags: nextTags',
    'memory_kind: editMemoryKind',
    'importance: parseBoundedNumber(editImportance, memory.importance)',
    'emotional_weight: parseBoundedNumber(editEmotionalWeight, memory.emotional_weight)',
    'confidence: parseBoundedNumber(editConfidence, memory.confidence)',
    'status: editStatus',
    "t('memory.kind')",
    "t('memory.importance')",
    "t('memory.emotionalWeight')",
    "t('memory.status')",
  ]) {
    assert.ok(memoryCard.includes(snippet), `missing snippet: ${snippet}`);
  }
});

test('unpin button label is shortened to cancel', () => {
  const i18n = readProjectFile('src/lib/i18n.ts');

  assert.match(i18n, /'memory\.unpin': '取消'/);
  assert.match(i18n, /'memory\.unpin': 'Cancel'/);
  assert.doesNotMatch(i18n, /'memory\.unpin': '取消钉选'/);
});

test('memory card select mode uses a label root so the whole row is keyboard-accessible with the checkbox', () => {
  const memoryCard = readProjectFile('src/components/memories/MemoryCard.tsx');

  assert.match(memoryCard, /const Root = selectMode \? 'label' : 'div'/);
  assert.match(memoryCard, /<Root\b/);
  assert.match(memoryCard, /type="checkbox"/);
  assert.match(memoryCard, /onChange=\{\(\) => onSelect\?\.\(memory\.id\)\}/);
  assert.doesNotMatch(
    memoryCard,
    /onClick=\{selectMode \? \(\) => onSelect\?\.\(memory\.id\) : undefined\}/,
    'row-level mouse-only onClick should not be the selection surface',
  );
});
