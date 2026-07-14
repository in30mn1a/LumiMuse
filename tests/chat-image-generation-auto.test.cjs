const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const hookSource = fs.readFileSync(
  path.join(root, 'src/hooks/chat/useChatImageGeneration.ts'),
  'utf8',
);
const messageActionsSource = fs.readFileSync(
  path.join(root, 'src/hooks/chat/useChatMessageActions.ts'),
  'utf8',
);
const chatEngineSource = fs.readFileSync(
  path.join(root, 'src/lib/chat-engine.ts'),
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
    /const started = await generateImageRef\.current\?\.\([\s\S]*targetAssistant,/,
  );
  assert.match(
    hookSource,
    /if \(started\) \{\s*autoImagedMsgIdsRef\.current\.add\(targetAssistant\.id\);/,
  );
  assert.doesNotMatch(
    hookSource,
    /autoImagedMsgIdsRef\.current\.add\(targetAssistant\.id\);\s*generateImageRef/,
  );
});

test('auto image gen can target a specific assistant message on regenerate retry', () => {
  assert.match(hookSource, /assistantMessageId\?: string/);
  assert.match(hookSource, /options\?\.assistantMessageId/);
  assert.match(hookSource, /if \(options\?\.retry\) \{\s*autoImagedMsgIdsRef\.current\.delete\(targetAssistant\.id\);/);
  assert.match(
    messageActionsSource,
    /maybeAutoGenerateImageFromMessages\(streamConversationId, response\.messages, \{\s*assistantMessageId: targetAssistantId,\s*retry: Boolean\(regenerateAssistantId\),/,
  );
});

test('mid-insert and regenerate both target auto image by assistant id and mark stream handled', () => {
  assert.match(
    messageActionsSource,
    /if \(regenerateAssistantId \|\| insertAssistantAfterUserId\)/,
  );
  assert.match(messageActionsSource, /findAssistantInsertedAfterUser/);
  assert.match(messageActionsSource, /markStreamAutoImageHandled\(streamConversationId\)/);
  assert.match(messageActionsSource, /clearStreamAutoImageHandled\(streamConversationId\)/);
  assert.match(hookSource, /streamAutoImageHandledConvIdsRef/);
  assert.match(
    hookSource,
    /if \(!options\?\.assistantMessageId && streamAutoImageHandledConvIdsRef\.current\.has\(cid\)\)/,
  );
  // 有目标 id 的调用不得清 mark（留给 ChatView 无目标 effect 消费）
  assert.doesNotMatch(
    hookSource,
    /if \(options\?\.assistantMessageId\) \{\s*streamAutoImageHandledConvIdsRef\.current\.delete/,
  );
});

test('regenerate retry keeps old images but still allows a new auto image run', () => {
  assert.doesNotMatch(chatEngineSource, /delete meta\.generatedImages;/);
  assert.match(
    hookSource,
    /if \(!options\?\.retry && existingImgs\.length > 0\) return;/,
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