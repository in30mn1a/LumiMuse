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

test('streaming follow writes scrollTop directly and stays gated on the near-bottom check', () => {
  const hook = readProjectFile('src/hooks/chat/useChatScrollController.ts');

  // 每帧起一次平滑动画会与流式内容的高度增长竞态：目标位置每帧都在变，动画可能停在过时偏移，
  // 移动端表现为回跳到上一条气泡。直接赋值让每帧只走一小步，不留动画尾巴。
  // 全文唯一 —— usePrependScrollAnchor 写的是 scrollTop = nextScrollTop。
  const marker = hook.search(/scrollTop = \w+\.scrollHeight/);
  assert.notEqual(
    marker,
    -1,
    'streaming follow must jump straight to the bottom instead of animating toward a moving target',
  );

  const effectStart = hook.lastIndexOf('useEffect(() => {', marker);
  const effectEnd = hook.indexOf('}, [', marker);
  assert.notEqual(effectStart, -1, 'missing streaming follow effect start');
  assert.notEqual(effectEnd, -1, 'missing streaming follow effect end');

  const followEffect = hook.slice(effectStart, effectEnd);

  assert.match(followEffect, /streamingText/, 'the direct scrollTop write should live in the streaming follow effect');
  assert.doesNotMatch(
    followEffect,
    /scrollToBottom\(|scrollIntoView\(/,
    'streaming follow must not fall back to animated scrolling',
  );
  // 少了这道判定，用户往上翻看历史时会被每个 chunk 拽回底部。
  assert.match(
    followEffect,
    /isMessageListNearBottom\(\)/,
    'streaming follow must only engage while the viewport is already near the bottom',
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

test('the scroll container opts out of native scroll anchoring', () => {
  const source = readProjectFile('src/components/chat/ChatMessageList.tsx');
  // 文件顶部注释里的结构示意图也含 ref={scrollContainerRef} + overflow-y-auto，必须取真实 JSX 标签。
  const tagStart = source.lastIndexOf('ref={scrollContainerRef}');
  assert.notEqual(tagStart, -1, 'missing scroll container element');
  const tagEnd = source.indexOf('>', tagStart);
  assert.notEqual(tagEnd, -1, 'missing scroll container tag end');

  const scrollerTag = source.slice(tagStart, tagEnd);

  assert.match(scrollerTag, /className=/, 'should have matched the JSX tag, not the doc comment sketch');
  assert.match(scrollerTag, /overflow-y-auto/, 'scrollContainerRef should stay on the scrolling element');
  // 虚拟列表流式期间行高持续变化，原生锚定会把视口钉在上一条稳定气泡上，与跟随滚底互相拉扯；
  // 加载更早消息时它还会在 usePrependScrollAnchor 的手动补偿之上再补一次。
  assert.match(
    scrollerTag,
    /\[overflow-anchor:none\]/,
    'native scroll anchoring must stay disabled on the message scroll container',
  );
});
