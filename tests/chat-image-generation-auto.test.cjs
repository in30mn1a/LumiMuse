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
const chatViewSource = fs.readFileSync(
  path.join(root, 'src/components/chat/ChatView.tsx'),
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
    /maybeAutoGenerateImageFromMessages\(streamConversationId, page\.messages, \{\s*assistantMessageId: targetAssistantId,\s*retry: mode === 'regenerate',/,
  );
});

test('sendChatStream targets auto image by explicit assistant id for all modes without mark protocol', () => {
  assert.match(messageActionsSource, /const sendChatStream = useCallback/);
  assert.match(messageActionsSource, /mode === 'regenerate'/);
  assert.match(messageActionsSource, /mode === 'insert'/);
  assert.match(messageActionsSource, /findAssistantInsertedAfterUser/);
  assert.match(messageActionsSource, /findLastAssistantId/);
  assert.match(
    messageActionsSource,
    /assistantMessageId: targetAssistantId,\s*retry: mode === 'regenerate'/,
  );
  // 共享 Set 暗协议已删除
  assert.doesNotMatch(messageActionsSource, /markStreamAutoImageHandled/);
  assert.doesNotMatch(messageActionsSource, /clearStreamAutoImageHandled/);
  assert.doesNotMatch(hookSource, /streamAutoImageHandledConvIdsRef/);
  assert.doesNotMatch(hookSource, /markStreamAutoImageHandled/);
  assert.doesNotMatch(chatViewSource, /streamAutoImageHandledConvIdsRef/);
  assert.doesNotMatch(chatViewSource, /prevActiveStreamsRef/);
  // 无目标 id 时不猜末尾气泡
  assert.match(hookSource, /if \(!options\?\.assistantMessageId\) return;/);
  assert.doesNotMatch(
    hookSource,
    /reverse\(\)\.find\(m => m\.role === 'assistant'\)/,
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

test('inlineImagePrompt is one-shot: cleared after successful image gen and when last image is deleted', () => {
  // 成功出图时一律清掉 metadata.inlineImagePrompt（含自动出图把内联词当 existingPrompt 传入的路径）
  assert.match(hookSource, /clearInlinePrompt/);
  assert.match(hookSource, /clearInlinePrompt: true/);
  // PUT /api/messages 对 metadata 是浅合并，delete 不落库：必须写显式空值
  assert.match(hookSource, /nextMeta\.inlineImagePrompt = ''/);
  assert.doesNotMatch(hookSource, /delete nextMeta\.inlineImagePrompt/);
  assert.doesNotMatch(hookSource, /delete meta\.generatedImages/);
  // 气泡内删光最后一张图时也清（同样必须显式空值：generatedImages: [] + inlineImagePrompt: ''）
  assert.match(
    hookSource,
    /meta\.generatedImages = nextImages;\s*if \(nextImages\.length === 0\) \{\s*meta\.inlineImagePrompt = '';/,
  );
  // 图片管理批量删除走服务端 removeGeneratedImageReferences（整体重写 metadata，delete 生效），同样在图删光时清
  const assetsSource = fs.readFileSync(
    path.join(root, 'src/lib/generated-image-assets.ts'),
    'utf8',
  );
  assert.match(
    assetsSource,
    /delete meta\.generatedImages;\s*[\s\S]*?delete meta\.inlineImagePrompt;/,
  );
});
