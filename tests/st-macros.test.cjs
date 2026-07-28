/**
 * st-macros 单元测试
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const fs = require('node:fs');
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
require.extensions['.ts'] = function (module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: filename });
  module._compile(output.outputText, filename);
};

const { collectSetAndAddVars, createStMacroState, expandGetVars, processStMacrosOnce } = require(path.join(root, 'src', 'lib', 'st-macros.ts'));

test('setvar 收集 + 从 content 中剥离', () => {
  const state = createStMacroState();
  const result = collectSetAndAddVars('{{setvar::x::hello}}', state);
  assert.equal(result, '');
  assert.equal(state.variables.get('x'), 'hello');
});

test('addvar 追加 + 多个 addvar 累积', () => {
  const state = createStMacroState();
  collectSetAndAddVars('{{addvar::x::A}}', state);
  collectSetAndAddVars('{{addvar::x::B}}', state);
  assert.equal(state.variables.get('x'), 'AB');
});

test('setvar → addvar 顺序生效', () => {
  const state = createStMacroState();
  collectSetAndAddVars('{{setvar::x::A}}{{addvar::x::B}}', state);
  assert.equal(state.variables.get('x'), 'AB');
});

test('getvar 替换', () => {
  const state = createStMacroState();
  state.variables.set('x', 'hello');
  assert.equal(expandGetVars('{{getvar::x}} world', state, ''), 'hello world');
});

test('getvar 未定义替换为空', () => {
  const state = createStMacroState();
  assert.equal(expandGetVars('{{getvar::missing}}end', state, ''), 'end');
});

test('lastUserMessage 替换', () => {
  const state = createStMacroState();
  const out = expandGetVars('用户输入是:{{lastUserMessage}}', state, 'hello world');
  assert.equal(out, '用户输入是:hello world');
});

test('getvar 与 lastUserMessage 中的 $ replacement token 按字面值保留', () => {
  const state = createStMacroState();
  state.variables.set('x', '$& $$ $` $\'');
  assert.equal(
    expandGetVars('A={{getvar::x}};B={{lastUserMessage}}', state, '$& $$ $` $\''),
    'A=$& $$ $` $\';B=$& $$ $` $\'',
  );
});

test('预设 consumer 能读取前置 collector 的聚合结果', () => {
  const state = createStMacroState();
  const collector = '{{setvar::wenfeng::叙事规范}}';
  const consumer = '<writing_setting>{{getvar::wenfeng}}</writing_setting>';
  // 模拟顺序
  const r1 = processStMacrosOnce(collector, state, '');
  assert.equal(r1, '');
  const r2 = processStMacrosOnce(consumer, state, '');
  assert.equal(r2, '<writing_setting>叙事规范</writing_setting>');
});

test('多段预设：setvar → addvar → getvar 聚合', () => {
  const state = createStMacroState();
  collectSetAndAddVars('{{setvar::wenfeng::A}}', state);
  collectSetAndAddVars('{{addvar::wenfeng::B}}', state);
  collectSetAndAddVars('{{addvar::wenfeng::C}}', state);
  const out = expandGetVars('{{getvar::wenfeng}}', state, '');
  assert.equal(out, 'ABC');
});

test('setvar 中的中文/多行内容保留', () => {
  const state = createStMacroState();
  const out = collectSetAndAddVars(`{{setvar::schema::
## 多行内容
含中文
}}`, state);
  assert.equal(out, '');
  assert.ok(state.variables.get('schema').includes('多行内容'));
});

test('宏外文本保留', () => {
  const state = createStMacroState();
  const out = collectSetAndAddVars('前置 {{setvar::x::y}} 后置', state);
  assert.equal(out, '前置  后置');
});

test('未识别宏保留（如 {{user}}/{{char}}）', () => {
  const state = createStMacroState();
  const out = collectSetAndAddVars('{{user}}和{{char}}', state);
  assert.equal(out, '{{user}}和{{char}}');
});

test('addvar value 内含 {{user}} 嵌套宏：brace 配对正确，不漏截', () => {
  const state = createStMacroState();
  const src = `{{addvar::ban::## 规则
<npcHs>
- 角色不会因{{user}}的要求自动顺从。
- 角色基于自身性格做出真实反应。
</npcHs>
}}
尾部`;
  const out = collectSetAndAddVars(src, state);
  assert.equal(out, '\n尾部');
  assert.ok(state.variables.get('ban').includes('{{user}}'), 'value 应保留嵌套宏 user');
  assert.ok(state.variables.get('ban').includes('</npcHs>'), 'value 应保留闭合 tag');
});

test('setvar value 多层嵌套（{{a{{b}}c}}）也能正确解析', () => {
  const state = createStMacroState();
  const src = '{{setvar::x::A {{user}} B {{char}} C}}';
  const out = collectSetAndAddVars(src, state);
  assert.equal(out, '');
  assert.equal(state.variables.get('x'), 'A {{user}} B {{char}} C');
});

test('未闭合 setvar 不抛出，原文保留', () => {
  const state = createStMacroState();
  const src = '{{setvar::x::unclosed';
  const out = collectSetAndAddVars(src, state);
  assert.equal(out, '{{setvar::x::unclosed');
  assert.equal(state.variables.get('x'), undefined);
});
