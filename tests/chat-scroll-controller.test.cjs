const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// 结构契约测试：源码断言只固定滚动职责归属；滚动计算 helper 在本文件首个测试中直接跑行为。
const root = path.resolve(__dirname, '..');

require.extensions['.ts'] = function loadTs(module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('scroll controller exposes behavior helpers for target jumps, bottom checks, and prepend anchoring', () => {
  const {
    getPrependAnchorScrollTop,
    getTargetMessageIndex,
    isScrollMetricsNearBottom,
  } = require(path.join(root, 'src/hooks/chat/useChatScrollController.ts'));

  const messages = [{ id: 'm-1' }, { id: 'target' }, { id: 'm-3' }];

  assert.equal(getTargetMessageIndex(messages, 'target'), 1);
  assert.equal(getTargetMessageIndex(messages, 'missing'), -1);
  assert.equal(isScrollMetricsNearBottom({ scrollHeight: 1000, scrollTop: 750, clientHeight: 100 }, 180), true);
  assert.equal(isScrollMetricsNearBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 100 }, 180), false);
  assert.equal(getPrependAnchorScrollTop({
    currentScrollTop: 240,
    previousFirstId: 'm-20',
    previousTotalSize: 800,
    nextFirstId: 'm-1',
    nextIds: ['m-1', 'm-2', 'm-20', 'm-21'],
    nextTotalSize: 1160,
  }), 600);
  assert.equal(getPrependAnchorScrollTop({
    currentScrollTop: 240,
    previousFirstId: 'm-20',
    previousTotalSize: 800,
    nextFirstId: 'm-20',
    nextIds: ['m-20', 'm-21'],
    nextTotalSize: 800,
  }), 240);
});

test('ChatView delegates scroll, memory polling, and image generation responsibilities to focused hooks', () => {
  const source = readProjectFile('src/components/chat/ChatView.tsx');

  assert.match(source, /useChatScrollController\(/);
  assert.match(source, /useMemoryTaskPolling\(/);
  assert.match(source, /useChatImageGeneration\(/);
  assert.ok(!source.includes('const pollMemoryTask = useCallback'), 'memory task polling should live outside ChatView');
  assert.ok(!source.includes('const handleGenerateImage = useCallback'), 'generated image metadata updates should live outside ChatView');
  assert.ok(!source.includes('autoImagedMsgIdsRef'), 'automatic image dedupe should live outside ChatView');
  assert.ok(!source.includes('messagesEndRef.current?.parentElement'), 'ChatView should not infer the scroll container from the end sentinel parent');
  assert.ok(!source.includes('messagesEndRef.current.parentElement'), 'ChatView should not infer the scroll container from the end sentinel parent');
});

test('useChatScrollController owns target jump, initial bottom, ResizeObserver, and top sentinel behavior', () => {
  const hook = readProjectFile('src/hooks/chat/useChatScrollController.ts');

  assert.match(hook, /export function useChatScrollController/);
  assert.match(hook, /pendingScrollRef/);
  assert.match(hook, /setHighlightedId/);
  assert.match(hook, /scrollIntoView\(\{ behavior: 'smooth', block: 'center' \}\)/);
  assert.match(hook, /scrollToBottomOnLoadRef\.current = false/);
  assert.match(hook, /new ResizeObserver/);
  assert.match(hook, /addEventListener\('load', onAssetLoad, true\)/);
  assert.match(hook, /IntersectionObserver/);
  assert.match(hook, /loadOlderMessages/);
  assert.ok(!hook.includes('messagesEndRef.current.parentElement'));
  assert.ok(!hook.includes('messagesEndRef.current?.parentElement'));
});

test('top sentinel observer stays stable when only message count changes', () => {
  const hook = readProjectFile('src/hooks/chat/useChatScrollController.ts');
  const observerStart = hook.indexOf('new IntersectionObserver');
  assert.notEqual(observerStart, -1, 'missing top sentinel IntersectionObserver');
  const effectStart = hook.lastIndexOf('useEffect(() => {', observerStart);
  const effectEnd = hook.indexOf('return {', observerStart);
  assert.notEqual(effectStart, -1, 'missing observer effect start');
  assert.notEqual(effectEnd, -1, 'missing observer effect end');

  const observerEffect = hook.slice(effectStart, effectEnd);
  assert.match(observerEffect, /loadOlderMessagesRef\.current\(\)/);
  assert.doesNotMatch(
    observerEffect,
    /messages\.length/,
    'loading older messages should not rebuild the top sentinel observer just because the list length changed',
  );
  assert.doesNotMatch(
    observerEffect,
    /\[[^\]]*loadOlderMessages[^\]]*\]/,
    'the observer should read the latest loader through a ref instead of depending on the callback identity',
  );
});

test('ChatMessageList uses explicit scroll refs and delegates virtualizer scroll anchoring to the scroll hook', () => {
  const source = readProjectFile('src/components/chat/ChatMessageList.tsx');

  assert.match(source, /scrollContainerRef/);
  assert.match(source, /messagesEndRef/);
  assert.match(source, /usePrependScrollAnchor\(/);
  assert.match(source, /useScrollTargetVirtualizer\(/);
  assert.ok(!source.includes('messagesEndRef.current.parentElement'));
  assert.ok(!source.includes('endRef must keep'));
  assert.ok(!source.includes('parentElement ==='));
});
