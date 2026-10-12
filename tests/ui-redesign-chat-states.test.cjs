const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const React = require('react');
const { installDomTestEnvironment } = require('./helpers/dom-test-environment.cjs');
const { registerTsLoader } = require('./helpers/register-ts-loader.cjs');

registerTsLoader({ jsx: true });
require.extensions['.tsx'] = require.extensions['.ts'];
const restoreDom = installDomTestEnvironment();
global.IS_REACT_ACT_ENVIRONMENT = true;
const { cleanup, render } = require('@testing-library/react');
const originalLoad = Module._load;
const t = key => key;

Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === '@/lib/i18n-context') return { useTranslation: () => ({ t }) };
  if (request === '@tanstack/react-virtual') return {
    useVirtualizer: () => ({ getVirtualItems: () => [], getTotalSize: () => 0, measureElement() {}, scrollToIndex() {} }),
  };
  if (request === '@/hooks/chat/useChatScrollController') return { usePrependScrollAnchor() {}, useScrollTargetVirtualizer() {} };
  if (request === '@/lib/image-blob-cache') return { warmImageBlobs() {} };
  if (request === './MessageBubble') return { __esModule: true, default: () => null };
  return originalLoad.call(this, request, parent, isMain);
};
let ChatMessageList;
try {
  ChatMessageList = require('../src/components/chat/ChatMessageList.tsx').default;
} finally {
  Module._load = originalLoad;
}

function props(overrides = {}) {
  return {
    visibleMessages: [],
    hiddenMessageId: null,
    streamingTargetId: null,
    streamingInsertAfterUserId: null,
    highlightedId: null,
    activeScrollTargetId: null,
    searchHighlight: null,
    isStreamingHere: false,
    hasOlderMessages: false,
    loadingOlderMessages: false,
    showTimestamps: false,
    activeConvId: 'saved-empty-conversation',
    streamingText: '',
    character: { id: 'character', name: 'Example' },
    streamingBubble: null,
    versionInfoByMessageId: new Map(),
    messagesEndRef: { current: null },
    topSentinelRef: { current: null },
    scrollContainerRef: { current: null },
    generatingImageMessageIds: new Set(),
    onLoadOlder() {}, onEdit() {}, onDelete() {}, onRegenerate() {},
    onRegenerateFromHere() {}, onSwitchVersion() {}, onGenerateImage() {},
    onDeleteImage() {}, onEditImagePrompt() {}, onSetPrimaryImage() {},
    ...overrides,
  };
}

test.afterEach(cleanup);
test.after(() => {
  delete global.IS_REACT_ACT_ENVIRONMENT;
  restoreDom();
});

test('saved empty conversation transitions from loading to a genuine empty state', () => {
  const view = render(React.createElement(ChatMessageList, props({ loadingThread: true })));
  assert.ok(view.getByRole('status', { name: 'common.loading' }));
  assert.equal(view.queryByText('chat.emptyConversation'), null);
  view.rerender(React.createElement(ChatMessageList, props({ loadingThread: false })));
  assert.equal(view.queryByRole('status'), null);
  assert.ok(view.getByText('chat.emptyConversation'));
});

test('failed loading does not masquerade as either loading or an empty conversation', () => {
  const view = render(React.createElement(ChatMessageList, props({ loadingThread: false, loadFailed: true })));
  assert.equal(view.queryByRole('status'), null);
  assert.equal(view.queryByText('chat.emptyConversation'), null);
});

test('a stream in an empty conversation never displays an empty-state hint', () => {
  const view = render(React.createElement(ChatMessageList, props({ isStreamingHere: true, streamingText: 'Starting reply' })));
  assert.equal(view.queryByText('chat.emptyConversation'), null);
  assert.equal(view.queryByRole('status'), null);
});

test('chat view treats pending message loads and new-chat creation as loading, not as an empty conversation', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/components/chat/ChatView.tsx'), 'utf8');
  assert.match(source, /loadingThread=\{loadingThread \|\| initialMessagesLoading \|\| creating\}/);
  assert.match(source, /loadFailed=\{Boolean\(conversationLoadError \|\| initialMessagesError\)\}/);
  assert.match(source, /initialMessagesError && \(\s*<div role="alert"/);
});
