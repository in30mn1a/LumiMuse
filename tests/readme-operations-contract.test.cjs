const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

for (const filename of ['README.md', 'README.en.md']) {
  test(`${filename} documents the complete operational contract`, () => {
    const readme = fs.readFileSync(path.join(root, filename), 'utf8');

    assert.match(readme, /\/api\/health\?ready=1/);
    assert.match(readme, /build.*(?:SHA|构建)/i);
    assert.match(readme, /public\/attachments/);
    assert.match(readme, /1001/);
    assert.match(readme, /docker compose logs lumimuse/);
    assert.match(readme, /user_version/);
    assert.match(readme, /(?:降级|downgrad)/i);
    // WAL 模式下运行中只拷主 .db 会丢最近写入：两种语言都必须给出在线备份命令
    assert.match(readme, /VACUUM INTO/);
    assert.match(readme, /Start\.bat/);
    assert.match(readme, /npm explain postcss/);
    assert.match(readme, /npm prune --dry-run/);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(manifest.overrides, undefined, '当前文档的无 override 说明需与清单一致');
    assert.match(readme, /(?:未配置 PostCSS override|no PostCSS override)/);
    assert.match(readme, /npm run lint[\s\S]*npm test[\s\S]*npm run regression[\s\S]*npm run build/);
  });
}
