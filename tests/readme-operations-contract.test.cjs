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
    assert.match(readme, /Start\.bat/);
    assert.match(readme, /npm explain postcss/);
    assert.match(readme, /npm prune --dry-run/);
    assert.match(readme, /npm run lint[\s\S]*npm test[\s\S]*npm run regression[\s\S]*npm run build/);
  });
}
