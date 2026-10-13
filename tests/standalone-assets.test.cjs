const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { prepareStandaloneAssets } = require('../scripts/prepare-standalone-assets.js');

test('prepareStandaloneAssets copies Next static and public files into standalone output', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumimuse-standalone-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const staticFile = path.join(root, '.next', 'static', 'chunks', 'app.js');
  const publicFile = path.join(root, 'public', 'fonts', 'lxgw.css');
  fs.mkdirSync(path.dirname(staticFile), { recursive: true });
  fs.mkdirSync(path.dirname(publicFile), { recursive: true });
  fs.mkdirSync(path.join(root, '.next', 'standalone'), { recursive: true });
  fs.writeFileSync(staticFile, 'console.log("asset");');
  fs.writeFileSync(publicFile, '@font-face {}');

  await prepareStandaloneAssets(root, { log: () => {} });

  assert.equal(
    fs.readFileSync(path.join(root, '.next', 'standalone', '.next', 'static', 'chunks', 'app.js'), 'utf8'),
    'console.log("asset");',
  );
  assert.equal(
    fs.readFileSync(path.join(root, '.next', 'standalone', 'public', 'fonts', 'lxgw.css'), 'utf8'),
    '@font-face {}',
  );
});

function makeBuildOutput(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumimuse-standalone-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relativePath, content = 'x') => {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  };
  write('.next/static/chunks/app.js');
  write('.next/standalone/server.js');
  write('public/favicon.ico');
  return { root, write, standalone: (...parts) => path.join(root, '.next', 'standalone', ...parts) };
}

test('prepareStandaloneAssets leaves runtime user media out of the standalone output', async (t) => {
  const { root, write, standalone } = makeBuildOutput(t);
  write('public/generated/char-1/private.png');
  write('public/avatars/me.png');
  write('public/attachments/upload.png');
  // 只有 public 顶层的三个用户媒体目录不随包分发，静态资源里的同名子目录不受影响
  write('public/icons/generated/logo.png');

  await prepareStandaloneAssets(root, { log: () => {} });

  assert.ok(fs.existsSync(standalone('public', 'favicon.ico')));
  assert.ok(fs.existsSync(standalone('public', 'icons', 'generated', 'logo.png')));
  // 目录本身要在（就绪检查要求可写），里面的用户文件一个都不能带
  for (const dir of ['generated', 'avatars', 'attachments']) {
    assert.deepEqual(fs.readdirSync(standalone('public', dir)), [], `public/${dir} must ship empty`);
  }
});

test('prepareStandaloneAssets strips workspace files that file tracing copied into the standalone output', async (t) => {
  const { root, write, standalone } = makeBuildOutput(t);
  // 真实数据不能留在包里：工作区里的原件必须原封不动，只清掉包内的副本
  write('data/lumimuse.db', 'real database');
  write('.next/standalone/data/lumimuse.db', 'traced copy');
  write('.next/standalone/backup_20260101_0000.tar.gz');
  write('.next/standalone/.env.local', 'ACCESS_PASSWORD=placeholder');
  write('.next/standalone/.git/config');
  write('.next/standalone/docs/audit.md');
  write('.next/standalone/src/lib/db.ts');
  // standalone 运行所需的条目，以及 Next 自己复制的运行时环境文件
  write('.next/standalone/package.json', '{}');
  write('.next/standalone/node_modules/next/package.json', '{}');
  write('.next/standalone/.next/server/app.js');
  write('.next/standalone/.env.production', 'PLACEHOLDER=1');
  const logs = [];

  await prepareStandaloneAssets(root, { log: (line) => logs.push(line) });

  assert.deepEqual(
    fs.readdirSync(standalone()).sort(),
    ['.env.production', '.next', 'node_modules', 'package.json', 'public', 'server.js'],
  );
  assert.ok(fs.existsSync(standalone('.next', 'server', 'app.js')));
  assert.ok(fs.existsSync(standalone('node_modules', 'next', 'package.json')));
  assert.equal(fs.readFileSync(path.join(root, 'data', 'lumimuse.db'), 'utf8'), 'real database');
  assert.ok(logs.some((line) => /Removed traced workspace files.*data/.test(line)));
});
