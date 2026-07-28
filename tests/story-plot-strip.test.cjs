/**
 * story-plot-strip 单元测试：剥 SillyTavern 剧本协议 XML
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const originalResolveFilename = Module._resolveFilename;

Module._resolveFilename = function resolveFilename(request, parent, isMain, options) {
  if (request.startsWith('@/')) {
    const mapped = path.join(root, 'src', request.slice(2));
    for (const candidate of [mapped, `${mapped}.ts`, `${mapped}.tsx`, path.join(mapped, 'index.ts')]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

require.extensions['.ts'] = function loadTs(module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const {
  stripStoryPlotForStreamingChunk,
  stripStoryPlotXml,
} = require(path.join(root, 'src', 'lib', 'story-plot-strip.ts'));

test('非 story_plot 文本原样返回', () => {
  assert.equal(stripStoryPlotXml('普通中文叙述'), '普通中文叙述');
  assert.equal(stripStoryPlotXml('hello world'), 'hello world');
  assert.equal(stripStoryPlotXml(''), '');
});

test('story_plot + story_done：剥容器，只留正文', () => {
  const input = `<story_plot>
<story_body>
<story_scene>
<date>2026 年 7 月 28 日 周二</date>
<time>凌晨 5:17</time>
<location>基沃托斯 - 客厅</location>
</story_scene>
我贴着你小腿的脸颊顿了顿，蓝色的眼睛慢慢睁圆。

"状况确认……普拉娜可以一直和牧牧连在一起。"
</story_body>
<story_after_format><story_done/></story_after_format>
</story_plot>`;
  const out = stripStoryPlotXml(input);
  assert.match(out, /^我贴着你小腿的脸颊顿了顿/);
  assert.match(out, /"状况确认……普拉娜可以一直和牧牧连在一起。"$/);
  assert.ok(!out.includes('<story_plot'));
  assert.ok(!out.includes('<story_scene>'));
  assert.ok(!out.includes('<story_body>'));
  assert.ok(!out.includes('<story_after_format>'));
  assert.ok(!out.includes('2026 年 7 月 28 日'), 'date 整体丢弃');
  assert.ok(!out.includes('基沃托斯'), 'location 整体丢弃');
});

test('story_plot + w2g 行动选项：保留 w2g 原文', () => {
  const input = `<story_plot>
<story_scene><date>D</date></story_scene>
<story_body>
正文。
</story_body>
<story_after_format>
<w2g>
A：选项A
B：选项B
</w2g>
</story_after_format>
</story_plot>`;
  const out = stripStoryPlotXml(input);
  assert.match(out, /^正文。/);
  assert.match(out, /<w2g>/);
  assert.match(out, /选项A/);
  assert.match(out, /<\/w2g>$/);
});

test('story_after_format 只含 story_done：完全不带末尾', () => {
  const input = `<story_plot><story_body>x</story_body><story_after_format>  <story_done/>  </story_after_format></story_plot>`;
  const out = stripStoryPlotXml(input);
  assert.equal(out, 'x');
});

test('自闭合 <story_plot/> 不带内容', () => {
  const input = `<story_plot/>`;
  // 这种情况其实是空 story_plot，剥光；以 <story_plot 开头但仍应当 strip
  const out = stripStoryPlotXml(input);
  assert.equal(out, '');
});

test('前导空白也触发', () => {
  const input = `  \n<story_plot><story_body>trim</story_body></story_plot>`;
  assert.equal(stripStoryPlotXml(input), 'trim');
});

test('写坏缺 story_body：兜底剥容器', () => {
  const input = `<story_plot><story_scene><date>x</date></story_scene>残余正文</story_plot>`;
  const out = stripStoryPlotXml(input);
  assert.equal(out, '残余正文');
});

test('流式跨任意字符边界保持单调，且完整发送 body 与可见 after_format', () => {
  const input = [
    '<story_plot>',
    '<story_scene><date>D</date><location>L</location></story_scene>',
    '<story_body>正文第一句。\\n正文第二句。</story_body>',
    '<story_after_format><w2g>A：继续</w2g></story_after_format>',
    '</story_plot>',
  ].join('');
  let previous = '';
  for (let index = 1; index <= input.length; index += 1) {
    const current = stripStoryPlotForStreamingChunk(input.slice(0, index));
    assert.ok(
      current.startsWith(previous),
      `第 ${index} 个字符处输出发生回退：${JSON.stringify(previous)} -> ${JSON.stringify(current)}`,
    );
    previous = current;
  }
  assert.equal(previous, '正文第一句。\\n正文第二句。\n\n<w2g>A：继续</w2g>');
  assert.equal(previous, stripStoryPlotXml(input));
});

test('流式 story_done 在跨 chunk 期间不泄漏协议碎片', () => {
  const chunks = [
    '<sto',
    'ry_plot><story_sc',
    'ene><date>D</date></story_scene><story_bo',
    'dy>干净正文</story_body><story_after_format><story_do',
    'ne/></story_after_format></story_plot>',
  ];
  let raw = '';
  let previous = '';
  let emitted = '';
  for (const chunk of chunks) {
    raw += chunk;
    const current = stripStoryPlotForStreamingChunk(raw);
    assert.ok(current.startsWith(previous));
    emitted += current.slice(previous.length);
    previous = current;
  }
  assert.equal(emitted, '干净正文');
  assert.doesNotMatch(emitted, /story_/);
});

test('abort 停在协议 tag 或 scene 中间时不把碎片写入正文', () => {
  assert.equal(
    stripStoryPlotXml('<story_plot><story_body>正文</sto'),
    '正文',
  );
  assert.equal(
    stripStoryPlotXml('<story_plot><story_body>正文<story_sce'),
    '正文',
  );
  assert.equal(
    stripStoryPlotXml('<story_plot><story_body>正文<story_scene><date>未完成'),
    '正文',
  );
});
