const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const allowedDirectJsonRoutes = [
  'src/app/api/auth/route.ts',
  'src/app/api/characters/[id]/route.ts',
  'src/app/api/characters/route.ts',
  'src/app/api/chat/route.ts',
  'src/app/api/conversations/[id]/messages/route.ts',
  'src/app/api/conversations/[id]/route.ts',
  'src/app/api/conversations/route.ts',
  'src/app/api/image-gen/prompt/route.ts',
  'src/app/api/image-gen/route.ts',
  'src/app/api/memories/[id]/route.ts',
  'src/app/api/memories/route.ts',
  'src/app/api/memory-archive/route.ts',
  'src/app/api/memory-candidates/[id]/route.ts',
  'src/app/api/memory-profile/route.ts',
  'src/app/api/memory-review/route.ts',
  'src/app/api/messages/[id]/route.ts',
  'src/app/api/messages/route.ts',
  'src/app/api/providers/route.ts',
  'src/app/api/settings/route.ts',
  'src/app/api/summarize/route.ts',
];

function collectRouteFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectRouteFiles(target));
    else if (entry.name === 'route.ts') files.push(target);
  }
  return files;
}

test('new API routes cannot expand the direct request.json baseline without review', () => {
  const directJsonRoutes = collectRouteFiles(path.join(root, 'src/app/api'))
    .filter(file => /\b(?:request|req)\.json\s*\(/.test(fs.readFileSync(file, 'utf8')))
    .map(file => path.relative(root, file).split(path.sep).join('/'))
    .sort();

  assert.deepEqual(directJsonRoutes, [...allowedDirectJsonRoutes].sort());
});

test('message metadata documents its intentionally mixed legacy wire names', () => {
  const types = fs.readFileSync(path.join(root, 'src/types/index.ts'), 'utf8');
  const metadataStart = types.indexOf('export interface MessageMetadata');
  const metadataBlock = types.slice(metadataStart, types.indexOf('\nexport interface Message {', metadataStart));

  assert.match(metadataBlock, /Wire compatibility/);
  assert.match(metadataBlock, /memory_extracted/);
  assert.match(metadataBlock, /summarizedIds/);
  assert.match(metadataBlock, /Do not rename/);
});
