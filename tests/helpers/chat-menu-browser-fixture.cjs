// 实际组件的 SSR + 构建 CSS，用于浏览器层叠/指针命中检查；不连接业务 API。
// 键盘和弹窗逻辑由 chat-header-menu.test.cjs 的真实 React 挂载测试覆盖。
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const root = path.resolve(__dirname, '../..');
const originalResolve = Module._resolveFilename;
const originalLoad = Module._load;
Module._resolveFilename = function(request, parent, ...args) {
  if (request.startsWith('@/')) {
    const base = path.join(root, 'src', request.slice(2));
    for (const file of [base, `${base}.ts`, `${base}.tsx`]) {
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
    }
  }
  return originalResolve.call(this, request, parent, ...args);
};
Module._load = function(request, parent, ...args) {
  if (request === '@/lib/i18n-context') return { useTranslation: () => ({ t: key => key }) };
  // SSR fixture 直接从菜单展开状态开始，不改源码或冒充客户端 hydration。
  if (request === 'react' && parent.filename.endsWith('ChatHeader.tsx')) {
    return { ...React, useState: () => React.useState(true) };
  }
  return originalLoad.call(this, request, parent, ...args);
};
function loadTs(module, filename) {
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText, filename);
}
require.extensions['.ts'] = loadTs;
require.extensions['.tsx'] = loadTs;
const ChatHeader = require('../../src/components/chat/ChatHeader.tsx').default;
const ChatToolbar = require('../../src/components/chat/ChatToolbar.tsx').default;
const noop = () => {};
const conversation = { id: 'fixture-conversation', title: 'Conversation' };
const markup = renderToStaticMarkup(React.createElement('div', {
  className: 'flex h-full min-h-0 flex-1 flex-col gap-2 px-2 py-2 md:gap-4 md:px-4 md:py-4',
},
React.createElement(ChatHeader, {
  character: { id: 'fixture-character', name: 'Alice', avatar_url: null },
  activeConversation: conversation, conversationsCount: 1, memoryCount: 0,
  isStreamingHere: false, creating: false, summarizing: false, duplicating: false,
  toolbarExpanded: false, onToggleToolbar: noop, onOpenConvDrawer: noop,
  onNewChat: noop, onRename: noop, onSummarize: noop, onDuplicate: noop,
  onOpenImageManager: noop, onRequestDelete: noop,
}),
React.createElement('div', { className: 'flex min-h-0 flex-1 gap-2 md:gap-4' },
  React.createElement('section', { className: 'surface-panel flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden' },
    React.createElement(ChatToolbar, {
      activeConversation: conversation, unextractedCount: 0, memoryExtractStatus: 'idle', tokenCount: 12,
      onOpenResetExtraction: noop, onOpenTokenBreakdown: noop,
    }),
  ),
)));
const chunks = path.join(root, '.next/static/chunks');
const css = fs.readdirSync(chunks).filter(file => file.endsWith('.css'))
  .map(file => fs.readFileSync(path.join(chunks, file), 'utf8')).join('\n');
if (!css) throw new Error('Run npm run build before starting the browser fixture');
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body style="height:100dvh;margin:0">${markup}<script>
window.pointerActions = [];
document.addEventListener('click', event => {
  const item = event.target.closest('[role="menuitem"]');
  if (item) window.pointerActions.push(item.textContent);
});
</script></body></html>`;
http.createServer((request, response) => {
  response.setHeader('Content-Type', request.url === '/fixture.css' ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8');
  response.end(request.url === '/fixture.css' ? css : html);
}).listen(0, '127.0.0.1', function() {
  console.log(`Browser fixture: http://127.0.0.1:${this.address().port}`);
});
