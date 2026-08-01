const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const React = require('react');
const ts = require('typescript');
const { installDomTestEnvironment } = require('./helpers/dom-test-environment.cjs');

installDomTestEnvironment();
global.IS_REACT_ACT_ENVIRONMENT = true;

const { act, cleanup, render } = require('@testing-library/react');

const root = path.resolve(__dirname, '..');
const originalResolveFilename = Module._resolveFilename;

Module._resolveFilename = function resolveFilename(request, parent, isMain, options) {
  if (request.startsWith('@/')) {
    const mapped = path.join(root, 'src', request.slice(2));
    for (const candidate of [mapped, `${mapped}.ts`, `${mapped}.tsx`]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

require.extensions['.ts'] = function loadTs(module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const {
  useChatScrollController,
  useScrollTargetVirtualizer,
} = require(path.join(root, 'src/hooks/chat/useChatScrollController.ts'));

/** 手动驱动的 rAF：让「逐帧重试」在测试里可以精确推进 */
function installManualRaf() {
  const previousRaf = global.requestAnimationFrame;
  const previousCancel = global.cancelAnimationFrame;
  let nextId = 1;
  const pending = new Map();

  global.requestAnimationFrame = callback => {
    const id = nextId++;
    pending.set(id, callback);
    return id;
  };
  global.cancelAnimationFrame = id => {
    pending.delete(id);
  };

  return {
    /** 推进一帧：只执行当前排队的回调，回调新排的帧留到下次 */
    flush() {
      const callbacks = [...pending.entries()];
      pending.clear();
      for (const [, callback] of callbacks) callback(0);
    },
    pendingCount: () => pending.size,
    restore() {
      global.requestAnimationFrame = previousRaf;
      global.cancelAnimationFrame = previousCancel;
    },
  };
}

function installManualTimers() {
  const previousSetTimeout = global.setTimeout;
  const previousClearTimeout = global.clearTimeout;
  let nextId = 1;
  const callbacks = new Map();
  const cleared = new Set();

  global.setTimeout = (callback, delay) => {
    const id = nextId++;
    callbacks.set(id, { callback, delay });
    return id;
  };
  global.clearTimeout = id => {
    cleared.add(id);
  };

  return {
    entries: () => [...callbacks.entries()],
    isCleared: id => cleared.has(id),
    invoke(id) {
      callbacks.get(id)?.callback();
    },
    restore() {
      global.setTimeout = previousSetTimeout;
      global.clearTimeout = previousClearTimeout;
    },
  };
}

const items = [{ id: 'a' }, { id: 'b' }, { id: 'target' }, { id: 'd' }];

function renderProbe({ isTargetSettled, targetMessageId = 'target', syncCalls }) {
  const calls = [];
  function Probe() {
    useScrollTargetVirtualizer({
      targetMessageId,
      items,
      scrollToIndex: (index, options) => calls.push({ index, align: options.align }),
      isTargetSettled,
      syncScrollOffset: () => syncCalls?.push(calls.length),
    });
    return null;
  }
  act(() => {
    render(React.createElement(Probe));
  });
  return calls;
}

test('retries scrollToIndex frame by frame while the target is not in view yet', () => {
  const raf = installManualRaf();
  try {
    const calls = renderProbe({ isTargetSettled: () => false });

    assert.equal(calls.length, 1, '挂载时立即尝试一次');
    assert.deepEqual(calls[0], { index: 2, align: 'center' });

    raf.flush();
    assert.equal(calls.length, 2, '目标未就位时继续重试');
    raf.flush();
    assert.equal(calls.length, 3);
  } finally {
    cleanup();
    raf.restore();
  }
});

test('stops retrying as soon as the target row is settled in view', () => {
  const raf = installManualRaf();
  try {
    let rendered = false;
    const calls = renderProbe({ isTargetSettled: () => rendered });

    assert.equal(calls.length, 1);
    raf.flush();
    assert.equal(calls.length, 2);

    rendered = true;
    raf.flush();
    assert.equal(calls.length, 2, '目标就位后不再滚动');
    assert.equal(raf.pendingCount(), 0, '不再排新的帧');
  } finally {
    cleanup();
    raf.restore();
  }
});

test('does not scroll at all when the target is already in view', () => {
  const raf = installManualRaf();
  try {
    const calls = renderProbe({ isTargetSettled: () => true });
    assert.equal(calls.length, 0);
    assert.equal(raf.pendingCount(), 0);
  } finally {
    cleanup();
    raf.restore();
  }
});

test('gives up after the retry budget instead of looping forever', () => {
  const raf = installManualRaf();
  try {
    const calls = renderProbe({ isTargetSettled: () => false });

    for (let i = 0; i < 500 && raf.pendingCount() > 0; i += 1) raf.flush();

    assert.ok(calls.length > 1, '确实重试过');
    assert.ok(calls.length <= 60, `重试次数应受上限约束，实际 ${calls.length}`);
    assert.equal(raf.pendingCount(), 0, '到达上限后不再排帧');
  } finally {
    cleanup();
    raf.restore();
  }
});

// scrollToIndex 靠给 scrollTop 赋值来滚动；重试时赋的是同一个值，浏览器不会派发 scroll 事件，
// 虚拟列表的内部 offset 就追不上 DOM。每次滚动后必须主动同步一次，否则重试只是空转。
test('syncs the virtual list offset after every scroll attempt', () => {
  const raf = installManualRaf();
  try {
    const syncCalls = [];
    const calls = renderProbe({ isTargetSettled: () => false, syncCalls });

    assert.equal(calls.length, 1);
    assert.equal(syncCalls.length, 1, '首次滚动后同步一次');

    raf.flush();
    assert.equal(calls.length, 2);
    assert.equal(syncCalls.length, 2, '每一帧重试都要同步');
    assert.deepEqual(syncCalls, [1, 2], '同步发生在对应的滚动之后');
  } finally {
    cleanup();
    raf.restore();
  }
});

test('does not sync when no scroll attempt happens', () => {
  const raf = installManualRaf();
  try {
    const syncCalls = [];
    renderProbe({ isTargetSettled: () => true, syncCalls });
    assert.equal(syncCalls.length, 0);
  } finally {
    cleanup();
    raf.restore();
  }
});

test('defers the synthetic scroll event beyond the React effect lifecycle', () => {
  const source = fs.readFileSync(
    path.join(root, 'src/components/chat/ChatMessageList.tsx'),
    'utf8',
  );
  const syncStart = source.indexOf('syncScrollOffset:');
  const syncBlock = source.slice(syncStart, source.indexOf('\n  });', syncStart));

  assert.ok(syncStart >= 0, 'ChatMessageList 应显式同步虚拟列表 offset');
  assert.match(syncBlock, /queueMicrotask\(\(\) => \{/);
  assert.ok(
    syncBlock.indexOf('queueMicrotask') < syncBlock.indexOf("dispatchEvent(new Event('scroll'))"),
    'scroll 事件必须在微任务中派发，避免 React lifecycle 内触发 flushSync',
  );
});

test('ignores targets that are not in the current message list', () => {
  const raf = installManualRaf();
  try {
    const calls = renderProbe({ isTargetSettled: () => false, targetMessageId: 'missing' });
    assert.equal(calls.length, 0);
    assert.equal(raf.pendingCount(), 0);
  } finally {
    cleanup();
    raf.restore();
  }
});

test('resets the retry budget after target -> null -> the same target', () => {
  const raf = installManualRaf();
  try {
    const calls = [];
    function Probe({ targetMessageId }) {
      useScrollTargetVirtualizer({
        targetMessageId,
        items,
        scrollToIndex: (index, options) => calls.push({ index, align: options.align }),
        isTargetSettled: () => false,
      });
      return null;
    }

    let view;
    act(() => {
      view = render(React.createElement(Probe, { targetMessageId: 'target' }));
    });
    while (raf.pendingCount() > 0) raf.flush();
    assert.equal(calls.length, 60, '首次定位耗尽预算');

    act(() => view.rerender(React.createElement(Probe, { targetMessageId: null })));
    act(() => view.rerender(React.createElement(Probe, { targetMessageId: 'target' })));

    assert.equal(calls.length, 61, '同一消息的新定位请求应获得全新的重试预算');
  } finally {
    cleanup();
    raf.restore();
  }
});

function renderScrollControllerProbe({ getActiveConvId, getMessages, renderTarget = true, scrollCalls }) {
  let current;
  const emptyMessages = [];
  function Probe() {
    const currentMessages = getMessages ? getMessages() : emptyMessages;
    current = useChatScrollController({
      visibleMessages: currentMessages,
      messages: currentMessages,
      activeConvId: getActiveConvId(),
      streamingText: '',
      streamingTargetId: null,
      streamingConvId: null,
      loadOlderMessages: () => {},
    });
    return React.createElement(
      'div',
      { ref: current.scrollContainerRef },
      renderTarget
        ? React.createElement('div', {
          id: 'msg-target',
          ref: node => {
            if (node) node.scrollIntoView = options => scrollCalls.push({ node: 'target', options });
          },
        })
        : null,
      React.createElement('div', {
        ref: node => {
          current.messagesEndRef.current = node;
          if (node) node.scrollIntoView = options => scrollCalls.push({ node: 'end', options });
        },
      }),
    );
  }

  let view;
  act(() => {
    view = render(React.createElement(Probe));
  });
  return {
    get current() {
      return current;
    },
    rerender() {
      act(() => view.rerender(React.createElement(Probe)));
    },
  };
}

test('keeps the new visual highlight when an older highlight timer fires', () => {
  const raf = installManualRaf();
  const timers = installManualTimers();
  const scrollCalls = [];
  try {
    const probe = renderScrollControllerProbe({
      getActiveConvId: () => 'conv-a',
      scrollCalls,
    });

    act(() => probe.current.markTargetForScroll('target'));
    act(() => raf.flush());
    const [firstTimer] = timers.entries().filter(([, entry]) => entry.delay === 2500);
    assert.ok(firstTimer, '首次定位完成后应创建光环定时器');

    act(() => probe.current.markTargetForScroll('new-target'));
    assert.equal(probe.current.highlightedId, 'new-target');
    act(() => timers.invoke(firstTimer[0]));

    assert.equal(probe.current.highlightedId, 'new-target', '旧目标的回调不得清除新目标光环');
    assert.equal(timers.isCleared(firstTimer[0]), true, '开始新定位时应主动取消旧定时器');
  } finally {
    cleanup();
    timers.restore();
    raf.restore();
  }
});

test('clears the visual highlight timer when the scroll controller unmounts', () => {
  const raf = installManualRaf();
  const timers = installManualTimers();
  const scrollCalls = [];
  try {
    const probe = renderScrollControllerProbe({
      getActiveConvId: () => 'conv-a',
      scrollCalls,
    });
    act(() => probe.current.markTargetForScroll('target'));
    act(() => raf.flush());
    const [highlightTimer] = timers.entries().filter(([, entry]) => entry.delay === 2500);
    assert.ok(highlightTimer);

    cleanup();

    assert.equal(timers.isCleared(highlightTimer[0]), true, '卸载必须取消仍在等待的光环定时器');
  } finally {
    cleanup();
    timers.restore();
    raf.restore();
  }
});

test('clears the active virtualizer target as soon as precise positioning completes', () => {
  const raf = installManualRaf();
  const timers = installManualTimers();
  const scrollCalls = [];
  try {
    const probe = renderScrollControllerProbe({
      getActiveConvId: () => 'conv-a',
      scrollCalls,
    });

    act(() => probe.current.markTargetForScroll('target'));
    assert.equal(probe.current.activeScrollTargetId, 'target');
    assert.equal(probe.current.highlightedId, 'target');

    act(() => raf.flush());

    assert.equal(probe.current.activeScrollTargetId, null, '完成定位后虚拟列表不应继续追踪光环');
    assert.equal(probe.current.highlightedId, 'target', '视觉光环仍保留到自己的计时结束');
    assert.equal(raf.pendingCount(), 0, '用户之后手动滚动时不再有定位帧把它拉回');
  } finally {
    cleanup();
    timers.restore();
    raf.restore();
  }
});

test('runs the deferred initial-bottom scroll after a pending target times out', () => {
  const raf = installManualRaf();
  const timers = installManualTimers();
  const scrollCalls = [];
  const previousResizeObserver = global.ResizeObserver;
  global.ResizeObserver = class FakeResizeObserver {
    observe() {}
    disconnect() {}
  };
  try {
    const probe = renderScrollControllerProbe({
      getActiveConvId: () => 'conv-a',
      renderTarget: false,
      scrollCalls,
    });

    act(() => {
      probe.current.markScrollToBottomOnLoad();
      probe.current.markTargetForScroll('missing');
    });
    for (let i = 0; i <= 180; i += 1) act(() => raf.flush());
    act(() => raf.flush());

    assert.equal(probe.current.activeScrollTargetId, null);
    assert.ok(
      scrollCalls.some(call => call.node === 'end' && call.options.behavior === 'instant'),
      'pending 超时后必须继续执行曾被阻塞的初始滚底',
    );
  } finally {
    cleanup();
    global.ResizeObserver = previousResizeObserver;
    timers.restore();
    raf.restore();
  }
});

test('cancels a pending target on conversation change and resumes initial-bottom scroll', () => {
  const raf = installManualRaf();
  const timers = installManualTimers();
  const scrollCalls = [];
  const previousResizeObserver = global.ResizeObserver;
  global.ResizeObserver = class FakeResizeObserver {
    observe() {}
    disconnect() {}
  };
  let activeConvId = 'conv-a';
  let messages = [];
  try {
    const probe = renderScrollControllerProbe({
      getActiveConvId: () => activeConvId,
      getMessages: () => messages,
      renderTarget: false,
      scrollCalls,
    });

    act(() => probe.current.markTargetForScroll('missing'));
    activeConvId = 'conv-b';
    probe.rerender();
    act(() => probe.current.markScrollToBottomOnLoad());
    messages = [{ id: 'new-message' }];
    probe.rerender();
    act(() => raf.flush());

    assert.equal(probe.current.activeScrollTargetId, null);
    assert.ok(
      scrollCalls.some(call => call.node === 'end' && call.options.behavior === 'instant'),
      '切换对话取消旧 pending 后应恢复新对话初始滚底',
    );
  } finally {
    cleanup();
    global.ResizeObserver = previousResizeObserver;
    timers.restore();
    raf.restore();
  }
});
