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

const {
  formatChatTimestamp,
  buildCurrentTimeInstruction,
  formatExtractionTimestamp,
  zonedDayRangeToUtc,
  currentYearInZone,
} = require('../src/lib/chat-time.ts');

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

// ── 提取/画像时间戳 ────────────────────────────────────────────
// 提取 prompt 要求把日期前置写进记忆 content，所以这里算错日期会被持久化。
// 容器默认 UTC，用户在 UTC+9 时凌晨的对话会被记成前一天。
test('extraction timestamp renders in the reported client time zone', () => {
  // UTC 时间 17:00 → Asia/Tokyo 次日 02:00，跨天
  assert.equal(formatExtractionTimestamp('2026-08-02T17:00:00Z', 'Asia/Tokyo'), '2026/8/3 02:00');
  assert.equal(formatExtractionTimestamp('2026-08-02T17:00:00Z', 'UTC'), '2026/8/2 17:00');
  // 上海比东京晚一小时，仍在同一天
  assert.equal(formatExtractionTimestamp('2026-08-02T17:00:00Z', 'Asia/Shanghai'), '2026/8/3 01:00');
});

test('extraction timestamp keeps the legacy unpadded month/day format', () => {
  // EXTRACTION_PROMPT 告诉模型对话文本里的时间戳长这样，改格式等于改 prompt 契约
  assert.match(formatExtractionTimestamp('2026-03-05T01:02:00Z', 'UTC'), /^2026\/3\/5 01:02$/);
});

test('invalid client time zone degrades instead of throwing', () => {
  // 后台任务里抛错会让提取任务重试并丢记忆
  assert.doesNotThrow(() => formatExtractionTimestamp('2026-08-02T17:00:00Z', 'Not/AZone'));
  const fallback = formatExtractionTimestamp('2026-08-02T17:00:00Z', 'Not/AZone');
  assert.match(fallback, /^\d{4}\/\d{1,2}\/\d{1,2} \d{2}:\d{2}$/);
});

test('empty time zone falls back to server local rendering', () => {
  const withEmpty = formatExtractionTimestamp('2026-08-02T17:00:00Z', '');
  const withNothing = formatExtractionTimestamp('2026-08-02T17:00:00Z');
  assert.equal(withEmpty, withNothing);
});

test('invalid extraction timestamp falls through unchanged', () => {
  assert.equal(formatExtractionTimestamp('not-a-date', 'Asia/Tokyo'), 'not-a-date');
});

// ── 按日期搜索的时区边界 ──────────────────────────────────────
// 消息 created_at 存 UTC，用户说的「3月30日」指他本地那一天。
// 服务器时区（容器默认 UTC）与用户不同时，日边界整体偏移，搜出来的头尾都不对。
function zoneParts(iso, timeZone) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

test('day range starts exactly at local midnight of the target zone', () => {
  const [start] = zonedDayRangeToUtc(2026, 8, 2, 'Asia/Tokyo');
  assert.match(zoneParts(start, 'Asia/Tokyo'), /^2026\/08\/02 00:00:00$/);
  // Tokyo 是 UTC+9，所以当天起点在 UTC 是前一天 15:00
  assert.equal(start, '2026-08-01T15:00:00.000Z');
});

test('day range end is contiguous with the next day start', () => {
  // 最严密的判据：end+1ms 必须正好是次日起点，既不留缝也不重叠。
  // 不能靠格式化验证——Intl 会把 23:59:59.999 向上舍入成次日 00:00。
  for (const timeZone of ['Asia/Tokyo', 'UTC', 'America/New_York', 'Asia/Kathmandu']) {
    const [, end] = zonedDayRangeToUtc(2026, 8, 2, timeZone);
    const [nextStart] = zonedDayRangeToUtc(2026, 8, 3, timeZone);
    assert.equal(
      new Date(end).getTime() + 1,
      new Date(nextStart).getTime(),
      `${timeZone} day boundary must be contiguous`,
    );
  }
});

test('day range spans 23h and 25h across DST transitions', () => {
  const span = (y, m, d, tz) => {
    const [start, end] = zonedDayRangeToUtc(y, m, d, tz);
    return (new Date(end).getTime() + 1 - new Date(start).getTime()) / 3600000;
  };
  // 回归防护：偏移若用带毫秒的时刻计算，会整体偏移 999ms，此处断言即挂
  assert.equal(span(2026, 7, 1, 'America/New_York'), 24);
  assert.equal(span(2026, 3, 8, 'America/New_York'), 23, 'DST 开始日只有 23 小时');
  assert.equal(span(2026, 11, 1, 'America/New_York'), 25, 'DST 结束日有 25 小时');
  assert.equal(span(2026, 4, 5, 'Australia/Lord_Howe'), 24.5, '半小时 DST 偏移');
});

test('day range rejects dates that do not exist', () => {
  assert.equal(zonedDayRangeToUtc(2026, 2, 30, 'Asia/Tokyo'), null);
  assert.equal(zonedDayRangeToUtc(2026, 2, 29, 'Asia/Tokyo'), null, '2026 不是闰年');
  assert.ok(zonedDayRangeToUtc(2028, 2, 29, 'Asia/Tokyo'), '2028 是闰年');
});

test('day range falls back to server local time for a bad zone', () => {
  const viaBadZone = zonedDayRangeToUtc(2026, 8, 2, 'Not/AZone');
  const viaNoZone = zonedDayRangeToUtc(2026, 8, 2);
  assert.deepEqual(viaBadZone, viaNoZone);
});

test('currentYearInZone respects the target zone and degrades safely', () => {
  const year = currentYearInZone('Asia/Tokyo');
  assert.ok(Number.isInteger(year) && year > 2000);
  assert.equal(currentYearInZone('Not/AZone'), new Date().getFullYear());
  assert.equal(currentYearInZone(), new Date().getFullYear());
});
