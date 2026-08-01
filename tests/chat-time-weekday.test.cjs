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
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const { formatChatTimestamp, buildCurrentTimeInstruction } = require('../src/lib/chat-time.ts');

const SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

test('timestamp carries the abbreviated English weekday', () => {
  const stamp = formatChatTimestamp('2026-08-02T14:30:00Z', { timeZone: 'UTC' });
  assert.equal(stamp, '2026-08-02 Sun 14:30');
});

test('weekday matches the target time zone, not the server locale', () => {
  // 同一瞬间在日界线两侧属于不同的星期
  const iso = '2026-08-02T14:30:00Z';
  assert.equal(formatChatTimestamp(iso, { timeZone: 'Pacific/Kiritimati' }), '2026-08-03 Mon 04:30');
  assert.equal(formatChatTimestamp(iso, { timeZone: 'Pacific/Niue' }), '2026-08-02 Sun 03:30');
});

test('midnight stays 00:00 and keeps the correct weekday', () => {
  // 回归防护：en-US + hour12:false 会把午夜渲染成 "24:00"，本实现必须保持 "00:00"
  assert.equal(formatChatTimestamp('2026-01-01T00:00:00Z', { timeZone: 'UTC' }), '2026-01-01 Thu 00:00');
});

test('offset path and time-zone path agree on the weekday', () => {
  const iso = '2026-12-31T23:59:00Z';
  // Asia/Shanghai 是 UTC+8；getTimezoneOffset 的符号约定是 -480
  const viaZone = formatChatTimestamp(iso, { timeZone: 'Asia/Shanghai' });
  const viaOffset = formatChatTimestamp(iso, { utcOffsetMinutes: -480 });
  assert.equal(viaZone, viaOffset);
  assert.equal(viaZone, '2027-01-01 Fri 07:59');
});

test('derived weekday matches Intl across time zones and boundary dates', () => {
  const zones = ['Asia/Shanghai', 'America/New_York', 'UTC', 'Pacific/Kiritimati', 'Pacific/Niue', 'Asia/Kathmandu'];
  const dates = [
    '2026-08-02T14:30:00Z',
    '2026-01-01T00:00:00Z',
    '2026-12-31T23:59:00Z',
    '2026-02-28T18:00:00Z',
    '2028-02-29T12:00:00Z',
  ];

  for (const timeZone of zones) {
    for (const iso of dates) {
      const truth = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(new Date(iso));
      const actual = formatChatTimestamp(iso, { timeZone }).split(' ')[1];
      assert.equal(actual, truth, `${timeZone} ${iso}`);
      assert.ok(SHORT.includes(actual));
    }
  }
});

test('current time instruction uses the full English weekday', () => {
  const text = buildCurrentTimeInstruction({ clientNowIso: '2026-08-02T14:30:00Z', timeZone: 'UTC' });
  assert.match(text, /2026-08-02 14:30，Sunday/);
  assert.ok(!/星期[日一二三四五六]/.test(text.replace('星期几', '')), 'weekday must not be rendered in Chinese');
});

test('current time instruction weekday is one of the seven full names', () => {
  const text = buildCurrentTimeInstruction({ clientNowIso: '2026-11-25T09:05:00Z', timeZone: 'Asia/Shanghai' });
  const matched = LONG.filter((name) => text.includes(name));
  assert.equal(matched.length, 1);
  assert.equal(matched[0], 'Wednesday');
});

test('invalid timestamp falls through unchanged', () => {
  assert.equal(formatChatTimestamp('not-a-date'), 'not-a-date');
});
