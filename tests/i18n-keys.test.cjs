const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('./helpers/register-ts-loader.cjs').registerTsLoader();

const translations = require('../src/lib/i18n.ts').default;

const root = path.resolve(__dirname, '..');

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(fullPath);
    return /\.(ts|tsx)$/.test(entry.name) ? [fullPath] : [];
  });
}

// t() 找不到 key 时原样返回 key，界面会直接显示 'settings.xxx' 这类字符串，编译期也查不出来。
test('every literal translation key used in src is defined in both languages', () => {
  const missing = [];
  for (const file of sourceFiles(path.join(root, 'src'))) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\bt\(\s*['"]([a-zA-Z0-9_.-]+)['"]/g)) {
      const key = match[1];
      for (const lang of ['zh', 'en']) {
        if (!Object.hasOwn(translations[lang], key)) {
          missing.push(`${lang}: ${key} (${path.relative(root, file)})`);
        }
      }
    }
  }
  assert.deepEqual(missing, []);
});

test('zh and en define the same translation keys', () => {
  const zhKeys = Object.keys(translations.zh).sort();
  const enKeys = Object.keys(translations.en).sort();
  assert.deepEqual(zhKeys.filter(key => !Object.hasOwn(translations.en, key)), [], 'keys missing in en');
  assert.deepEqual(enKeys.filter(key => !Object.hasOwn(translations.zh, key)), [], 'keys missing in zh');
});
