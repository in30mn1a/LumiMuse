const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const srcDir = path.join(root, 'src');

function listSourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return full.startsWith(path.join(srcDir, 'app', 'api')) ? [] : listSourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

// 设了 ACCESS_PASSWORD 时，proxy 的 CSRF 校验对 /api/* 写请求只放行 application/json
// （/api/upload 另放行 multipart）。本地默认不设密码，漏带 Content-Type 只会在线上 415，
// 2026-11 Agent 删除会话和停止运行就是这样坏掉的。
test('client write requests to /api send a JSON content type', () => {
  const offenders = [];
  for (const file of listSourceFiles(srcDir)) {
    const source = fs.readFileSync(file, 'utf8');
    const methodPattern = /method:\s*'(POST|PUT|PATCH|DELETE)'/g;
    let match;
    while ((match = methodPattern.exec(source))) {
      const fetchStart = source.lastIndexOf('fetch(', match.index);
      if (fetchStart < 0 || match.index - fetchStart > 400) continue;
      const call = source.slice(fetchStart, match.index + 300);
      if (/\/api\/upload/.test(call)) continue;
      if (/'Content-Type':\s*'application\/json'/.test(call)) continue;
      const line = source.slice(0, match.index).split('\n').length;
      offenders.push(`${path.relative(root, file)}:${line}`);
    }
  }
  assert.deepEqual(offenders, []);
});
