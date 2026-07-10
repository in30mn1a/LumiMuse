const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// 结构契约测试：这里固定 ChatView 与拆分 hook 的职责边界。
// stale guard / abort / error 可见性等关键行为由 frontend-state-p1.test.cjs 等行为测试覆盖。
const root = path.resolve(__dirname, '..');

function readChatView() {
  return fs.readFileSync(path.join(root, 'src/components/chat/ChatView.tsx'), 'utf8');
}

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('ChatView delegates fetched message responses to the cache-aware state helper', () => {
  const source = readChatView();
  const hook = readProjectFile('src/hooks/chat/useMessagePaging.ts');
  const applyStart = hook.indexOf('const applyMessagesResponse = useCallback');
  assert.notEqual(applyStart, -1, 'missing applyMessagesResponse helper');

  const helperCall = hook.indexOf('applyMessagesResponseToState(conversationIdToApply, response', applyStart);
  const activeReader = hook.indexOf('getActiveConversationId: () => activeConvIdRef.current', applyStart);

  assert.match(source, /useMessagePaging\(/);
  assert.ok(helperCall !== -1, 'applyMessagesResponse should delegate fetched responses to the cache helper');
  assert.ok(activeReader !== -1, 'applyMessagesResponse should give the helper the active conversation reader');
  assert.ok(!hook.includes('activeConvIdRef.current !== conversationIdToApply'));
});

test('ChatView routes local message mutations through the cache-aware updater', () => {
  const source = readChatView();
  const hook = readProjectFile('src/hooks/chat/useMessagePaging.ts');

  assert.match(source, /updateMessagesForConversation/);
  assert.match(hook, /updateMessagesForConversationState/);
  assert.ok(!source.includes('setMessages(prev => prev.map(m => m.id === id ? data.message! : m));'));
  assert.ok(!source.includes('setMessages(prev => prev.filter(m => m.id !== id));'));
  assert.ok(!source.includes('setMessages(prev => prev.map(m => m.id === messageId ? { ...m, metadata: nextMeta } : m));'));
  assert.ok(!source.includes('setMessages(prev => prev.map(m => m.id === messageId ? { ...m, metadata: meta } : m));'));
  assert.ok(!source.includes('setMessages(prev => prev.map(updateMeta));'));
});

test('ChatView delegates streaming state, frame throttling, and abort maps to useChatStreaming', () => {
  const source = readChatView();
  const hook = readProjectFile('src/hooks/chat/useChatStreaming.ts');

  assert.match(source, /useChatStreaming\(/);
  assert.ok(!source.includes("const [streamingText, setStreamingText] = useState('');"));
  assert.ok(!source.includes('const abortControllersRef = useRef<Map<string, AbortController>>(new Map());'));

  assert.match(hook, /requestAnimationFrame/);
  assert.match(hook, /activeStreamConvRef/);
  assert.match(hook, /abortControllersRef/);
  assert.match(hook, /activeStreamsRef/);
  assert.match(hook, /beginStream/);
  assert.match(hook, /finishStream/);
  assert.match(hook, /handleStop/);
});

test('ChatView keeps stream chunks scoped to the active conversation and refreshes final messages', () => {
  const source = readChatView();
  const messageActionsHook = readProjectFile('src/hooks/chat/useChatMessageActions.ts');

  const callStreamStart = messageActionsHook.indexOf('const callChatStream = useCallback');
  const regenerateStart = messageActionsHook.indexOf('const handleRegenerate = useCallback', callStreamStart);
  const sendStart = source.indexOf('const handleSend = async');
  const noCharacterStart = source.indexOf('if (!hasCharacter)', sendStart);

  assert.notEqual(callStreamStart, -1, 'missing callChatStream');
  assert.notEqual(regenerateStart, -1, 'missing callChatStream end marker');
  assert.notEqual(sendStart, -1, 'missing handleSend');
  assert.notEqual(noCharacterStart, -1, 'missing handleSend end marker');

  const callStreamBlock = messageActionsHook.slice(callStreamStart, regenerateStart);
  const sendBlock = source.slice(sendStart, noCharacterStart);
  const actionActiveConversationGuard = 'activeStreamConvRef.current === streamConversationId';
  const sendActiveConversationGuard = 'activeStreamConvRef.current === myConvId && activeConvIdRef.current === myConvId';

  assert.ok(callStreamBlock.includes(actionActiveConversationGuard), 'regeneration stream chunks should be guarded by active stream ownership');
  assert.ok(callStreamBlock.includes('activeConvIdRef.current === streamConversationId'), 'regeneration stream chunks should be guarded by active conversation');
  assert.ok(sendBlock.includes(sendActiveConversationGuard), 'send stream chunks should be guarded by active stream and active conversation');
  assert.ok(callStreamBlock.includes('void pollMemoryTask(streamConversationId);'), 'regeneration stream should still poll memory extraction tasks');
  assert.ok(sendBlock.includes('void pollMemoryTask(myConvId);'), 'send stream should still poll memory extraction tasks');
  assert.ok(callStreamBlock.includes('await refreshMessages();'), 'regeneration stream should refresh the active message list when finished');
  assert.ok(sendBlock.includes('await refreshMessagesForConversation(myConvId);'), 'send stream should refresh the generated conversation when finished');
  assert.ok(callStreamBlock.includes('void refreshConversationState(undefined);'), 'regeneration stream should refresh conversations without changing active conversation');
  assert.ok(sendBlock.includes('void refreshConversationState(undefined);'), 'send stream should refresh conversations without changing active conversation');
});

test('useChatStreaming only clears visible streaming state for the finished display owner', () => {
  const hook = readProjectFile('src/hooks/chat/useChatStreaming.ts');

  const finishStart = hook.indexOf('const finishStream = useCallback');
  const returnStart = hook.indexOf('return {', finishStart);
  assert.notEqual(finishStart, -1, 'missing finishStream');
  assert.notEqual(returnStart, -1, 'missing finishStream end marker');

  const finishBlock = hook.slice(finishStart, returnStart);
  assert.match(
    finishBlock,
    /if \(activeStreamConvRef\.current === convId\) \{\s*activeStreamConvRef\.current = null;\s*setIsLoading\(false\);\s*setStreamingText\(''\);\s*setStreamingConvId\(null\);\s*\}/,
    'a completed background stream must not clear another conversation stream that currently owns the visible streaming state',
  );
});

test('useChatStreaming mirrors active streams into the ref during begin and finish updates', () => {
  const hook = readProjectFile('src/hooks/chat/useChatStreaming.ts');

  const beginStart = hook.indexOf('const beginStream = useCallback');
  const finishStart = hook.indexOf('const finishStream = useCallback', beginStart);
  const returnStart = hook.indexOf('return {', finishStart);
  assert.notEqual(beginStart, -1, 'missing beginStream');
  assert.notEqual(finishStart, -1, 'missing finishStream');
  assert.notEqual(returnStart, -1, 'missing finishStream end marker');

  const beginBlock = hook.slice(beginStart, finishStart);
  const finishBlock = hook.slice(finishStart, returnStart);

  assert.match(
    beginBlock,
    /activeStreamsRef\.current = next;/,
    'beginStream should synchronously mirror the new active stream set into activeStreamsRef',
  );
  assert.match(
    finishBlock,
    /activeStreamsRef\.current = next;/,
    'finishStream should synchronously mirror removals into activeStreamsRef',
  );
});

test('ChatView prevents duplicate new-conversation sends before React state catches up', () => {
  const source = readChatView();
  const sendStart = source.indexOf('const handleSend = async');
  const noCharacterStart = source.indexOf('if (!hasCharacter)', sendStart);
  assert.notEqual(sendStart, -1, 'missing handleSend');
  assert.notEqual(noCharacterStart, -1, 'missing handleSend end marker');

  const sendBlock = source.slice(sendStart, noCharacterStart);
  assert.match(source, /const creatingConversationRef = useRef\(false\);/);
  assert.match(sendBlock, /if \(!activeConvId && creatingConversationRef\.current\) return;/);
  assert.match(sendBlock, /creatingConversationRef\.current = true;/);
  assert.match(sendBlock, /creatingConversationRef\.current = false;/);
});

test('ChatView prevents duplicate existing-conversation sends with the synchronous active stream ref', () => {
  const source = readChatView();
  const sendStart = source.indexOf('const handleSend = async');
  const noCharacterStart = source.indexOf('if (!hasCharacter)', sendStart);
  assert.notEqual(sendStart, -1, 'missing handleSend');
  assert.notEqual(noCharacterStart, -1, 'missing handleSend end marker');

  const sendBlock = source.slice(sendStart, noCharacterStart);
  assert.match(sendBlock, /if \(activeConvId && activeStreamsRef\.current\.has\(activeConvId\)\) return;/);
  assert.doesNotMatch(
    sendBlock,
    /if \(activeConvId && activeStreams\.has\(activeConvId\)\) return;/,
    'handleSend must not use React state as the duplicate-submit guard because it lags behind beginStream',
  );
});

test('ChatView delegates message actions and the hook owns a dependency-aware stream callback', () => {
  const source = readChatView();
  const hook = readProjectFile('src/hooks/chat/useChatMessageActions.ts');
  const callStreamStart = hook.indexOf('const callChatStream = useCallback');
  const regenerateStart = hook.indexOf('const handleRegenerate = useCallback', callStreamStart);
  assert.notEqual(callStreamStart, -1, 'missing callChatStream');
  assert.notEqual(regenerateStart, -1, 'missing callChatStream end marker');

  const callStreamBlock = hook.slice(callStreamStart, regenerateStart);
  assert.match(source, /useChatMessageActions\(/);
  assert.ok(!source.includes('const handleRegenerate = useCallback'));
  assert.ok(!hook.includes('ref-only helper'));
  assert.ok(!hook.includes('eslint-disable-next-line react-hooks/exhaustive-deps'));
  assert.match(callStreamBlock, /beginStream\(convId, \{ regenerateAssistantId \}\)/);
  assert.match(callStreamBlock, /showToast,/);
  assert.match(callStreamBlock, /t,/);
});

test('useChatStreaming scopes regeneration hidden targets by conversation', () => {
  const hook = readProjectFile('src/hooks/chat/useChatStreaming.ts');

  assert.match(
    hook,
    /const streamingTargetId = activeConvId\s*\?\s*regenerationTargetIdsByConv\[activeConvId\] \?\? null\s*:\s*null;/,
    'the active conversation should derive its visible regeneration target from a per-conversation map',
  );
  assert.match(
    hook,
    /const hiddenMessageId = streamingTargetId;/,
    'ChatMessageList should only receive the active conversation regeneration target',
  );

  const beginStart = hook.indexOf('const beginStream = useCallback');
  const finishStart = hook.indexOf('const finishStream = useCallback', beginStart);
  const returnStart = hook.indexOf('return {', finishStart);
  assert.notEqual(beginStart, -1, 'missing beginStream');
  assert.notEqual(finishStart, -1, 'missing finishStream');
  assert.notEqual(returnStart, -1, 'missing finishStream end marker');

  const beginBlock = hook.slice(beginStart, finishStart);
  const finishBlock = hook.slice(finishStart, returnStart);

  assert.ok(
    beginBlock.includes('const targetId = options?.regenerateAssistantId;') && beginBlock.includes('if (targetId)'),
    'beginStream should narrow the requested regeneration target before storing it',
  );
  assert.ok(
    beginBlock.includes('[convId]: targetId'),
    'starting a regeneration stream should record the target for that conversation',
  );
  assert.ok(
    beginBlock.includes('delete next[convId];'),
    'starting a normal stream should clear only stale regeneration state for the same conversation',
  );
  assert.ok(
    !beginBlock.includes('setHiddenMessageId(null)') && !beginBlock.includes('setStreamingTargetId(null)'),
    'starting a normal stream in another conversation must not globally unhide an active regeneration target',
  );
  assert.ok(
    finishBlock.includes('if (options?.clearRegenerationState)') && finishBlock.includes('delete next[convId];'),
    'finishing a regeneration stream should clear its own hidden target even if it no longer owns visible streaming state',
  );
});

test('ChatView rechecks the active conversation before applying memory task count refreshes', () => {
  const source = readProjectFile('src/hooks/chat/useMemoryTaskPolling.ts');

  const refreshStart = source.indexOf('const refreshCounts = useCallback');
  const pollStart = source.indexOf('const pollMemoryTask = useCallback', refreshStart);
  assert.notEqual(refreshStart, -1, 'missing refreshCounts');
  assert.notEqual(pollStart, -1, 'missing pollMemoryTask');

  const refreshBlock = source.slice(refreshStart, pollStart);
  assert.match(refreshBlock, /fetchMessagesPage\(convId, \{ limit: Math\.max\(pageSize, getLoadedMessageCount\(\)\) \}\)/);
  assert.match(refreshBlock, /if \(activeConvIdRef\.current !== convId\) return;/);

  const pollBlock = source.slice(pollStart);
  assert.match(pollBlock, /refreshCounts\(convId\);/);
  assert.match(pollBlock, /scheduleStatusReset\(\);/);
});

test('ChatView delegates message paging and cache-aware updates to useMessagePaging', () => {
  const source = readChatView();
  const hook = readProjectFile('src/hooks/chat/useMessagePaging.ts');

  assert.match(source, /useMessagePaging\(/);
  assert.ok(!source.includes('const [messages, setMessages] = useState<Message[]>([]);'));
  assert.ok(!source.includes('const [hasOlderMessages, setHasOlderMessages] = useState(false);'));
  assert.ok(!source.includes('const messagesRef = useRef<Message[]>(messages);'));

  assert.match(hook, /applyMessagesResponseToState/);
  assert.match(hook, /updateMessagesForConversationState/);
  assert.match(hook, /readCachedMessages/);
  assert.match(hook, /fetchMessagesPage/);
  assert.match(hook, /loadOlderMessages/);
  assert.match(hook, /serverUnextractedCountRef/);
});

test('ChatView delegates conversation loading and stale request guards to useConversationLoader', () => {
  const source = readChatView();
  const hook = readProjectFile('src/hooks/chat/useConversationLoader.ts');

  assert.match(source, /useConversationLoader\(/);
  assert.ok(!source.includes('const [conversations, setConversations] = useState<Conversation[]>([]);'));
  assert.ok(!source.includes('const [memories, setMemories] = useState<Memory[]>([]);'));
  assert.ok(!source.includes('const loadCharacterStateSeqRef = useRef(0);'));
  assert.ok(!source.includes('const refreshConversationStateSeqRef = useRef(0);'));

  assert.match(hook, /loadCharacterStateSeqRef/);
  assert.match(hook, /refreshConversationStateSeqRef/);
  assert.match(hook, /characterRef/);
  assert.match(hook, /selectActiveConvId/);
  assert.match(hook, /refreshConversationState/);
});
