const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function readChatView() {
  return fs.readFileSync(path.join(root, 'src/components/chat/ChatView.tsx'), 'utf8');
}

test('ChatView delegates fetched message responses to the cache-aware state helper', () => {
  const source = readChatView();
  const applyStart = source.indexOf('const applyMessagesResponse = useCallback');
  assert.notEqual(applyStart, -1, 'missing applyMessagesResponse helper');

  const helperCall = source.indexOf('applyMessagesResponseToState(conversationIdToApply, response', applyStart);
  const activeReader = source.indexOf('getActiveConversationId: () => activeConvIdRef.current', applyStart);

  assert.ok(helperCall !== -1, 'applyMessagesResponse should delegate fetched responses to the cache helper');
  assert.ok(activeReader !== -1, 'applyMessagesResponse should give the helper the active conversation reader');
  assert.ok(!source.includes('activeConvIdRef.current !== conversationIdToApply'));
});

test('ChatView routes local message mutations through the cache-aware updater', () => {
  const source = readChatView();

  assert.match(source, /updateMessagesForConversation/);
  assert.match(source, /updateMessagesForConversationState/);
  assert.ok(!source.includes('setMessages(prev => prev.map(m => m.id === id ? data.message! : m));'));
  assert.ok(!source.includes('setMessages(prev => prev.filter(m => m.id !== id));'));
  assert.ok(!source.includes('setMessages(prev => prev.map(m => m.id === messageId ? { ...m, metadata: nextMeta } : m));'));
  assert.ok(!source.includes('setMessages(prev => prev.map(m => m.id === messageId ? { ...m, metadata: meta } : m));'));
  assert.ok(!source.includes('setMessages(prev => prev.map(updateMeta));'));
});
