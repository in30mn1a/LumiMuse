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
  LEGACY_STORY_PLOT_TAGS,
  PROTOCOL_TAG_PREFIXES,
  stripByPresetRules,
  stripByPresetRulesForStreamingChunk,
  stripContainerTags,
  stripStoryPlotForStreamingChunk,
  stripStoryPlotXml,
  usesLegacyStoryPlotRules,
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
  assert.equal(stripStoryPlotXml('<sto'), '');
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

// ============================================================
// stripContainerTags / stripByPresetRules / stripByPresetRulesForStreamingChunk（参数化 tags）
// ============================================================

test('stripContainerTags 空 tags 原样返回', () => {
  assert.equal(stripContainerTags('<content>正文</content>', []), '<content>正文</content>');
});

test('stripContainerTags 剥 content 容器保内部', () => {
  assert.equal(
    stripContainerTags('<content>夜空下，她走进书房。</content>', ['content']),
    '夜空下，她走进书房。',
  );
});

test('stripContainerTags 剥 content + drop 思考草稿', () => {
  assert.equal(
    stripContainerTags(
      '<thinking>草稿</thinking><content>夜空下，她走进书房。</content>',
      ['content', '#thinking'],
    ),
    '夜空下，她走进书房。',
  );
});

test('stripContainerTags 参数化标签匹配大小写不敏感', () => {
  assert.equal(
    stripContainerTags(
      '<ThInK>草稿</tHiNk><CONTENT>正文</content>',
      ['content', '#think'],
    ),
    '正文',
  );
});

test('stripContainerTags 剥 content + drop 未使用 output-template', () => {
  assert.equal(
    stripContainerTags(
      '<output-template>TODO</output-template><content>正文</content>',
      ['content', '#output-template'],
    ),
    '正文',
  );
});

test('stripContainerTags 头部未闭合 block tag 剥开', () => {
  assert.equal(stripContainerTags('<content>正文未闭合', ['content']), '正文未闭合');
});

test('stripContainerTags 尾部未闭合 block tag 剥掉', () => {
  assert.equal(stripContainerTags('正文</content>', ['content']), '正文');
});

test('stripContainerTags 不成对 block tag 保留原文（不误伤正文中字面量）', () => {
  assert.equal(
    stripContainerTags('她说 <content> 是标签符号', ['content']),
    '她说 <content> 是标签符号',
  );
});

test('stripByPresetRules 含 story_plot 走 RONG 旧逻辑', () => {
  assert.equal(
    stripByPresetRules('<story_plot><story_body>正文</story_body></story_plot>', ['story_plot']),
    '正文',
  );
});

test('stripByPresetRules 不含 story_plot 走参数化', () => {
  assert.equal(
    stripByPresetRules('<content>正文</content>', ['content']),
    '正文',
  );
});

test('stripByPresetRulesForStreamingChunk 含 story_plot 走 RONG 流式', () => {
  assert.equal(
    stripByPresetRulesForStreamingChunk('<story_plot><story_body>正文', ['story_plot']),
    '正文',
  );
});

test('stripByPresetRulesForStreamingChunk 不含 story_plot 走参数化', () => {
  assert.equal(
    stripByPresetRulesForStreamingChunk('<thinking>草稿</thinking><content>正文', ['content', '#thinking']),
    '正文',
  );
});

test('stripContainerTags 可待真实输出：scene 保内部 + content 剥 + thinking/output-template 整段丢', () => {
  const text =
    '<thinking>思考草稿</thinking>\n\n'
    + '<scene>2026-07-28 05:17 客厅</scene>\n\n'
    + '<content>"乖……宝宝？\n正文</content>\n\n'
    + '<output-template>模板</output-template>';
  const stripped = stripContainerTags(text, ['content', 'scene', '#thinking', '#output-template']);
  // 剥开 block 时紧邻容器内部的换行被吸收（容器是排版占位），不残留空行
  assert.equal(stripped, '2026-07-28 05:17 客厅\n\n"乖……宝宝？\n正文');
});

test('stripContainerTags 段落间空行保留（不被剥走）', () => {
  // 主人报告的回归：正文段落间 \n\n 不能被吃掉
  const text = '<content>\n第一段。\n\n第二段对话。\n同段继续。\n\n第三段。\n</content>';
  assert.equal(
    stripContainerTags(text, ['content']),
    '第一段。\n\n第二段对话。\n同段继续。\n\n第三段。',
  );
});

test('stripContainerTags scene 未闭合尾部能剥掉', () => {
  assert.equal(
    stripContainerTags('正文</scene>', ['scene']),
    '正文',
  );
});

test('stripByPresetRules 可待完整列表：block 保内部 + drop 整段丢', () => {
  const text = '<output-template>TODO</output-template><scene>客厅</scene><content>正文</content><thinking>草稿</thinking>';
  assert.equal(
    stripByPresetRules(text, ['content', 'scene', '#thinking', '#output-template']),
    '客厅正文',
  );
});

test('stripByPresetRules 可待完整列表：块与块之间带换行的自然情况（块间单换行）', () => {
  const text = '<output-template>TODO</output-template>\n\n<scene>客厅</scene>\n\n<content>正文</content>\n\n<thinking>草稿</thinking>';
  // block 剥开后紧邻容器内部的换行被吸收（`<scene>X</scene>\n\n<content>Y</content>` → `X\n\nY`）
  // 不会出现莫名两行空行，也不会被压成零换行
  assert.equal(
    stripByPresetRules(text, ['content', 'scene', '#thinking', '#output-template']),
    '客厅\n\n正文',
  );
});

test('stripByPresetRules drop 位于两个可见块之间时合并两侧布局空白', () => {
  assert.equal(
    stripByPresetRules(
      '<scene>客厅</scene>\n<think>草稿</think>\n<content>正文</content>',
      ['scene', 'content', '#think'],
    ),
    '客厅\n正文',
  );
  assert.equal(
    stripByPresetRules(
      '<scene>客厅</scene>\n\n<think>草稿</think>\n\n<content>正文</content>',
      ['scene', 'content', '#think'],
    ),
    '客厅\n\n正文',
  );
});

// ============================================================
// stripByPresetRulesForStreamingChunk 参数化路径 drop tag 未闭合遮挡
// ============================================================

test('流式参数化：drop tag 未闭合期间整块不输出（思考草稿先被遮挡）', () => {
  // 阶段 1：思考草稿还在流式（<think> 未闭合）—— 应该立刻空，不向用户透传
  assert.equal(
    stripByPresetRulesForStreamingChunk('<think>正在思考剧情……', ['content', 'scene', '#think', '#thinking']),
    '',
    '<think> 未闭合时输出应为空',
  );
  // 阶段 2：思考草稿闭合但正文还没出现 —— 输出应为空
  assert.equal(
    stripByPresetRulesForStreamingChunk('<think>剧情草稿</think>', ['content', 'scene', '#think', '#thinking']),
    '',
    '<think> 闭合但正文未到时输出应为空',
  );
  // 阶段 3：scene 出现但未闭合 —— 应该逐步透传 scene 内文本；<scene> 开 tag 本身不输出
  assert.equal(
    stripByPresetRulesForStreamingChunk('<think>剧情草稿</think><scene>2026-07-28', ['content', 'scene', '#think', '#thinking']),
    '2026-07-28',
    'scene 开 tag 到达后应立即透传内部',
  );
  // 阶段 4：content 开 tag 到达、内部正文正在流式 —— 应透传正文、开 tag 不输出
  assert.equal(
    stripByPresetRulesForStreamingChunk(
      '<think>剧情草稿</think><scene>客厅</scene><content>"乖……宝宝？"',
      ['content', 'scene', '#think', '#thinking'],
    ),
    '客厅"乖……宝宝？"',
    'content 内部正文应立即透传',
  );
});

test('流式参数化：正文先行、think 在尾部时不影响正文', () => {
  assert.equal(
    stripByPresetRulesForStreamingChunk(
      '<scene>客厅</scene><content>正文内容',
      ['content', 'scene', '#think'],
    ),
    '客厅正文内容',
    'block tag 正文流式不受影响',
  );
});

test('流式参数化：<think> 起头但 close tag 已在文本里 → 不遮挡后续内容', () => {
  // 思考草稿已闭合，正文在写 —— 输出应只含场景+正文
  const text = '<think>剧情草稿</think><scene>客厅</scene><content>正文';
  const streamed = stripByPresetRulesForStreamingChunk(text, ['content', 'scene', '#think', '#thinking']);
  assert.equal(streamed, '客厅正文');
});

test('流式参数化：半截 tag 字面量应被遮挡（不产生倒退）', () => {
  // 模拟 chunk 末尾恰好切在 tag 中间：'<co' / '</sce' 都不应作为可见内容流出
  assert.equal(
    stripByPresetRulesForStreamingChunk('<scene>客厅</sce', ['content', 'scene', '#think']),
    '客厅',
  );
  assert.equal(
    stripByPresetRulesForStreamingChunk('<scene>客厅</scene><co', ['content', 'scene', '#think']),
    '客厅',
  );
  // 下一个 chunk 补全 '<content>' 后应正常透传
  assert.equal(
    stripByPresetRulesForStreamingChunk('<scene>客厅</scene><content>正文', ['content', 'scene', '#think']),
    '客厅正文',
  );
});

function collectLengthDeltas(full, rules, chunkSizes) {
  let raw = '';
  let emitted = '';
  let previousLength = 0;
  let offset = 0;
  let chunkIndex = 0;

  while (offset < full.length) {
    const size = chunkSizes[chunkIndex % chunkSizes.length];
    raw += full.slice(offset, offset + size);
    offset += size;
    chunkIndex += 1;
    const current = stripByPresetRulesForStreamingChunk(raw, rules);
    assert.ok(
      current.startsWith(emitted),
      `流式安全前缀倒退: emitted=${JSON.stringify(emitted)} current=${JSON.stringify(current)}`,
    );
    emitted += current.slice(previousLength);
    previousLength = current.length;
  }

  return emitted;
}

test('流式参数化：逐字符和任意 chunk 的 length-delta 严格单调且等于最终剥离', () => {
  const rules = ['content', 'scene', '#think'];
  const cases = [
    '<think>思考</think>\n\n<scene>客厅</scene>\n\n<content>正文ABC</content>',
    '<scene>客厅</scene>\n\n<think>思考</think>\n\n<content>正文ABC</content>',
  ];
  for (const full of cases) {
    const final = stripByPresetRules(full, rules);
    assert.equal(collectLengthDeltas(full, rules, [1]), final);
    assert.equal(collectLengthDeltas(full, rules, [2, 7, 1, 9, 3]), final);
  }
});

test('最终参数化：EOF 未闭合 drop 整块丢弃，不能落库思考草稿', () => {
  assert.equal(
    stripByPresetRules('<think>未完成草稿', ['content', '#think']),
    '',
  );
  assert.equal(
    stripByPresetRules('<scene>客厅</scene><think>未完成草稿', ['scene', '#think']),
    '客厅',
  );
});

test('最终参数化：协议已建立后剥非头部未闭合 block 和半截协议 tag', () => {
  const rules = ['scene', 'content', '#think'];
  assert.equal(
    stripByPresetRules('<scene>客厅</scene><content>正文', rules),
    '客厅正文',
  );
  assert.equal(
    stripByPresetRules('<scene>客厅</scene><content>正文</con', rules),
    '客厅正文',
  );
});

test('最终参数化：首个未完成协议前缀在 EOF 不落库', () => {
  assert.equal(stripByPresetRules('<con', ['content', '#think']), '');
  assert.equal(stripByPresetRules('<think', ['content', '#think']), '');
});

test('最终参数化：#story_plot 保持 drop 整块语义，不进入 RONG 保正文路径', () => {
  assert.equal(
    stripByPresetRules(
      '<story_plot><story_body>不应保留</story_body></story_plot>',
      ['#story_plot'],
    ),
    '',
  );
});

test('最终参数化：没有匹配协议 tag 时原样保留首尾空白', () => {
  const plain = '  \n  缩进 Markdown\n    ';
  assert.equal(stripByPresetRules(plain, ['content', '#think']), plain);
});

test('usesLegacyStoryPlotRules：block story_plot 触发旧协议，drop 形式不触发', () => {
  assert.equal(usesLegacyStoryPlotRules(['story_plot', '#thinking']), true);
  assert.equal(usesLegacyStoryPlotRules(['STORY_PLOT']), true, 'tag 名大小写不敏感');
  assert.equal(usesLegacyStoryPlotRules(['#story_plot']), false, 'drop 规则走通用参数化路径');
  assert.equal(usesLegacyStoryPlotRules(['content', '#think']), false);
  assert.equal(usesLegacyStoryPlotRules([]), false);
});

test('旧协议模式下 strip_tags 其余规则确实不参与剥离（UI 据此标灰）', () => {
  // #thinking 在参数化路径会整块丢弃；混入 story_plot 后走 RONG 硬编码逻辑，它不再生效
  const raw = '<story_plot><story_body>正文<thinking>草稿</thinking></story_body></story_plot>';
  assert.equal(
    stripByPresetRules(raw, ['content', '#thinking']),
    '<story_plot><story_body>正文</story_body></story_plot>',
    '参数化路径：#thinking 丢整块，非规则 tag 原样留着',
  );
  assert.equal(
    stripByPresetRules(raw, ['story_plot', '#thinking']),
    '正文<thinking>草稿</thinking>',
    'RONG 路径：容器被剥，但 #thinking 未生效，草稿仍留在正文里',
  );
});

test('LEGACY_STORY_PLOT_TAGS 与旧协议扫描前缀表保持同步', () => {
  // 对照实现（PROTOCOL_TAG_PREFIXES）而不是测试里手写的字面量：
  // 任一侧增删容器都会让本用例变红，避免 UI 把生效规则误标为失效（或反之）
  const namesFromPrefixes = [...new Set(
    PROTOCOL_TAG_PREFIXES.map(prefix => prefix.replace(/^<\/?/, '').replace(/>$/, '')),
  )].sort();
  assert.deepEqual(namesFromPrefixes, [...LEGACY_STORY_PLOT_TAGS].sort());
});

test('最终参数化：未闭合 block 的长空白输入保持线性级响应', () => {
  const input = `<content>${' '.repeat(1000)}`;
  const startedAt = performance.now();
  stripByPresetRules(input, ['content']);
  const elapsedMs = performance.now() - startedAt;
  assert.ok(elapsedMs < 100, `1000 字符耗时 ${elapsedMs.toFixed(1)}ms，疑似超线性回溯`);
});
