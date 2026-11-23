const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
require('./helpers/register-ts-loader.cjs').registerTsLoader();

const { buildHistoryMessages } = require('../src/lib/chat-engine.ts');
const { DEFAULT_SETTINGS } = require('../src/types/index.ts');

const settings = { ...DEFAULT_SETTINGS, show_timestamps: false };

function userMessageWithImage(url) {
  return {
    id: 'msg-image',
    conversation_id: 'conv',
    role: 'user',
    content: '看看这张图',
    token_count: 0,
    created_at: '2026-11-23T01:00:00.000Z',
    metadata: { attachments: [{ type: 'image', name: 'photo.png', url, mimeType: 'image/png' }] },
  };
}

// 附件按 process.cwd()/public/attachments 解析；切到临时目录，避免读写真实上传目录。
function withAttachmentsDir(t, files, outsideFiles = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lumimuse-attachments-'));
  const attachmentsDir = path.join(tempRoot, 'public', 'attachments');
  fs.mkdirSync(attachmentsDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(attachmentsDir, name), content);
  }
  for (const [name, content] of Object.entries(outsideFiles)) {
    fs.writeFileSync(path.join(tempRoot, name), content);
  }
  const previousCwd = process.cwd();
  process.chdir(tempRoot);
  t.after(() => {
    process.chdir(previousCwd);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
}

test('a local image attachment is read on the server and sent to the model as a data URL', async t => {
  const bytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  withAttachmentsDir(t, { 'photo.png': bytes });

  for (const url of ['/api/files/attachments/photo.png', '/attachments/photo.png']) {
    const { history } = await buildHistoryMessages([userMessageWithImage(url)], settings, undefined, 0);
    const parts = history[0].content;
    assert.ok(Array.isArray(parts), `${url} should produce multimodal content`);
    const image = parts.find(part => part.type === 'image_url');
    assert.equal(image.image_url.url, `data:image/png;base64,${bytes.toString('base64')}`);
  }
});

test('a local image attachment over 5MB falls back to a text note instead of being inlined', async t => {
  withAttachmentsDir(t, { 'huge.png': Buffer.alloc(5 * 1024 * 1024 + 1) });

  const { history } = await buildHistoryMessages(
    [userMessageWithImage('/api/files/attachments/huge.png')],
    settings,
    undefined,
    0,
  );

  const content = history[0].content;
  assert.equal(typeof content, 'string', 'with no usable image the message falls back to plain text');
  assert.match(content, /\[图片附件: photo\.png\] 图片超过 5MB/);
  assert.doesNotMatch(content, /data:image/);
});

test('a local attachment path that tries to leave the attachments directory is not read', async t => {
  // 目录外真的放一张可读的 png：若穿越防护失效，它会被读成 data URL
  withAttachmentsDir(t, {}, { 'secret.png': Buffer.from('secret-bytes') });
  const { history } = await buildHistoryMessages(
    [userMessageWithImage('/api/files/attachments/..%2F..%2Fsecret.png')],
    settings,
    undefined,
    0,
  );
  const content = history[0].content;
  assert.equal(typeof content, 'string');
  assert.doesNotMatch(content, /data:/);
});
