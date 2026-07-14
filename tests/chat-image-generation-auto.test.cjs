const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const hookSource = fs.readFileSync(
  path.join(root, 'src/hooks/chat/useChatImageGeneration.ts'),
  'utf8',
);

test('auto image gen uses server message snapshot and only marks autoImaged after start', () => {
  assert.match(hookSource, /messageSnapshot\?: Message/);
  assert.match(
    hookSource,
    /targetFromList[\s\S]*messageSnapshot\?\.id === messageId \? messageSnapshot/,
  );
  assert.match(
    hookSource,
    /const started = await generateImageRef\.current\?\.\([\s\S]*lastAssistant,/,
  );
  assert.match(
    hookSource,
    /if \(started\) \{\s*autoImagedMsgIdsRef\.current\.add\(lastAssistant\.id\);/,
  );
  assert.doesNotMatch(
    hookSource,
    /autoImagedMsgIdsRef\.current\.add\(lastAssistant\.id\);\s*generateImageRef/,
  );
});

test('image placeholder update can inject snapshot when message list lags', () => {
  assert.match(
    hookSource,
    /if \(!found && messageSnapshot\?\.id === messageId\) \{\s*return \[\.\.\.next, \{ \.\.\.messageSnapshot, metadata: nextMeta \}\];/,
  );
});

test('handleGenerateImage no longer hard-depends on characterRef for starting', () => {
  assert.doesNotMatch(hookSource, /if \(!targetConversationId \|\| !characterRef\.current\) return/);
  assert.match(hookSource, /if \(!targetConversationId\) return false;/);
});
