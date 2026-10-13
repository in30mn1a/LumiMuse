const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const Database = require('better-sqlite3');
const { registerTsLoader } = require('./helpers/register-ts-loader.cjs');

// 审计 2026-10-13 F02：孤儿文件清理的引用集合必须按「URL 解析出的目录」归类，
// 而不是按「被扫描的表」归类——角色头像可以指向 generated/attachments，
// 消息正文 / metadata 也可以引用 avatars。漏判会 unlink 仍在使用的文件（不可恢复）。

registerTsLoader();
const originalLoad = Module._load;

function requireFreshWithMocks(modulePath, mocks) {
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) {
      return mocks[request];
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const resolved = require.resolve(modulePath);
    delete require.cache[resolved];
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

function jsonResponseMock() {
  return {
    NextResponse: {
      json(body, init = {}) {
        return {
          status: init.status ?? 200,
          async json() {
            return body;
          },
        };
      },
    },
  };
}

function createDb({ characters = [], messages = [] }) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE characters (
      id TEXT PRIMARY KEY,
      avatar_url TEXT
    );
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      content TEXT,
      metadata TEXT
    );
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL
    );
    CREATE TABLE memory_tasks (
      id INTEGER PRIMARY KEY,
      conversation_id TEXT NOT NULL
    );
  `);

  // 所有消息都挂在一个「活」对话上，避免被 DB 孤儿清理先删掉而干扰文件引用判定。
  db.prepare('INSERT INTO characters (id, avatar_url) VALUES (?, ?)').run('character-host', null);
  db.prepare('INSERT INTO conversations (id, character_id) VALUES (?, ?)').run('conversation-host', 'character-host');

  const insertCharacter = db.prepare('INSERT INTO characters (id, avatar_url) VALUES (?, ?)');
  characters.forEach((avatarUrl, index) => insertCharacter.run(`character-${index}`, avatarUrl));

  const insertMessage = db.prepare(
    'INSERT INTO messages (id, conversation_id, content, metadata) VALUES (?, ?, ?, ?)',
  );
  const insertMessages = db.transaction(() => {
    messages.forEach((message, index) => {
      insertMessage.run(
        `message-${index}`,
        'conversation-host',
        message.content ?? '',
        JSON.stringify(message.metadata ?? {}),
      );
    });
  });
  insertMessages();

  return db;
}

/**
 * 在 os.tmpdir() 下建一个隔离的工作目录并 chdir 进去：路由用 process.cwd()/public 定位文件，
 * 因此绝不会碰到仓库里真实的 public/ 用户文件。
 * 所有夹具文件的 mtime 都回拨到 24h 宽限期之外——否则「漏判引用」会被宽限期掩盖，测试恒真。
 */
async function withMaintenanceWorkspace({ characters, messages, files }, run) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'lumimuse-audit-maintenance-'));
  const previousCwd = process.cwd();
  const db = createDb({ characters, messages });
  const filePathOf = (dirName, filename) => path.join(workspace, 'public', dirName, ...filename.split('/'));

  try {
    const oldMtime = new Date(Date.now() - 25 * 60 * 60 * 1000);
    for (const [dirName, filename] of files) {
      const filePath = filePathOf(dirName, filename);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, filename, 'utf8');
      fs.utimesSync(filePath, oldMtime, oldMtime);
    }

    process.chdir(workspace);
    const route = requireFreshWithMocks('../src/app/api/maintenance/route.ts', {
      '@/lib/db': { getDb: () => db },
      '@/lib/route-auth': { requireAuth: async () => null },
      'next/server': jsonResponseMock(),
    });

    await run({
      route,
      exists: (dirName, filename) => fs.existsSync(filePathOf(dirName, filename)),
    });
  } finally {
    process.chdir(previousCwd);
    db.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

test('F02: character avatar pointing into generated/ is not treated as an orphan', async () => {
  await withMaintenanceWorkspace({
    characters: [
      // 「把生成图设为头像」：avatar_url 指向 generated 目录（含角色子目录）
      '/api/files/generated/character-0/avatar-pick.png',
      // legacy 前缀（不带 /api/files）同样必须识别
      '/generated/legacy-avatar-pick.png',
    ],
    messages: [],
    files: [
      ['generated', 'character-0/avatar-pick.png'],
      ['generated', 'legacy-avatar-pick.png'],
      ['generated', 'character-0/true-orphan.png'],
    ],
  }, async ({ route, exists }) => {
    const preview = await (await route.GET({})).json();
    assert.deepEqual(preview.orphanFiles.generated, { total: 3, orphanCount: 1 });

    const cleanup = await (await route.POST({})).json();
    assert.deepEqual(cleanup.fileResults.generated, { deleted: 1, errors: 0 });
    assert.deepEqual(cleanup.deletedUrls.sort(), [
      '/api/files/generated/character-0/true-orphan.png',
      '/generated/character-0/true-orphan.png',
    ].sort());

    assert.equal(exists('generated', 'character-0/avatar-pick.png'), true);
    assert.equal(exists('generated', 'legacy-avatar-pick.png'), true);
    // 对照样本：真正无引用的文件仍被删除，证明不是「什么都不删」
    assert.equal(exists('generated', 'character-0/true-orphan.png'), false);
  });
});

test('F02: character avatar pointing into attachments/ is not treated as an orphan', async () => {
  await withMaintenanceWorkspace({
    characters: [
      '/api/files/attachments/avatar-upload.png',
      '/attachments/legacy-avatar-upload.png',
    ],
    messages: [],
    files: [
      ['attachments', 'avatar-upload.png'],
      ['attachments', 'legacy-avatar-upload.png'],
      ['attachments', 'true-orphan.png'],
    ],
  }, async ({ route, exists }) => {
    const preview = await (await route.GET({})).json();
    assert.deepEqual(preview.orphanFiles.attachments, { total: 3, orphanCount: 1 });

    const cleanup = await (await route.POST({})).json();
    assert.deepEqual(cleanup.fileResults.attachments, { deleted: 1, errors: 0 });
    assert.deepEqual(cleanup.deletedUrls.sort(), [
      '/api/files/attachments/true-orphan.png',
      '/attachments/true-orphan.png',
    ].sort());

    assert.equal(exists('attachments', 'avatar-upload.png'), true);
    assert.equal(exists('attachments', 'legacy-avatar-upload.png'), true);
    assert.equal(exists('attachments', 'true-orphan.png'), false);
  });
});

test('F02: avatars/ files referenced by message content, metadata or history versions are not orphans', async () => {
  await withMaintenanceWorkspace({
    // 回归对照：角色头像自身的引用仍然有效
    characters: ['/api/files/avatars/character-avatar.png'],
    messages: [
      { content: '![saved](/api/files/avatars/in-content.png)' },
      { metadata: { attachments: [{ url: '/api/files/avatars/in-metadata-attachment.png' }] } },
      { metadata: { generatedImages: [{ data: '/avatars/in-metadata-generated.png' }] } },
      {
        content: 'active version has no local asset url',
        metadata: {
          versions: [{ content: 'old version shows /avatars/in-version.png inline' }],
          activeVersion: 1,
        },
      },
    ],
    files: [
      ['avatars', 'character-avatar.png'],
      ['avatars', 'in-content.png'],
      ['avatars', 'in-metadata-attachment.png'],
      ['avatars', 'in-metadata-generated.png'],
      ['avatars', 'in-version.png'],
      ['avatars', 'true-orphan.png'],
    ],
  }, async ({ route, exists }) => {
    const preview = await (await route.GET({})).json();
    assert.deepEqual(preview.orphanFiles.avatars, { total: 6, orphanCount: 1 });

    const cleanup = await (await route.POST({})).json();
    assert.deepEqual(cleanup.fileResults.avatars, { deleted: 1, errors: 0 });
    assert.deepEqual(cleanup.deletedUrls.sort(), [
      '/api/files/avatars/true-orphan.png',
      '/avatars/true-orphan.png',
    ].sort());

    for (const filename of [
      'character-avatar.png',
      'in-content.png',
      'in-metadata-attachment.png',
      'in-metadata-generated.png',
      'in-version.png',
    ]) {
      assert.equal(exists('avatars', filename), true, `avatars/${filename} is still referenced`);
    }
    assert.equal(exists('avatars', 'true-orphan.png'), false);
  });
});

test('F02: cross-directory references found beyond the first messages page still protect files', async () => {
  // 路由按 1000 行一页分页扫描 messages；把唯一的引用放在第三页，守住分页游标。
  const messages = Array.from({ length: 2004 }, () => ({ content: 'filler without local asset urls' }));
  messages.push({
    content: 'late /api/files/avatars/late-avatar.png and /api/files/generated/late-generated.png',
    metadata: { attachments: [{ url: '/api/files/attachments/late-attachment.png' }] },
  });

  await withMaintenanceWorkspace({
    characters: [],
    messages,
    files: [
      ['avatars', 'late-avatar.png'],
      ['generated', 'late-generated.png'],
      ['attachments', 'late-attachment.png'],
    ],
  }, async ({ route, exists }) => {
    const preview = await (await route.GET({})).json();
    assert.deepEqual(preview.orphanFiles, {
      avatars: { total: 1, orphanCount: 0 },
      attachments: { total: 1, orphanCount: 0 },
      generated: { total: 1, orphanCount: 0 },
    });

    const cleanup = await (await route.POST({})).json();
    assert.deepEqual(cleanup.fileResults, {
      avatars: { deleted: 0, errors: 0 },
      attachments: { deleted: 0, errors: 0 },
      generated: { deleted: 0, errors: 0 },
    });
    assert.deepEqual(cleanup.deletedUrls, []);

    assert.equal(exists('avatars', 'late-avatar.png'), true);
    assert.equal(exists('generated', 'late-generated.png'), true);
    assert.equal(exists('attachments', 'late-attachment.png'), true);
  });
});

test('F02: stale files nobody references are still deleted, and a reference only protects its own directory', async () => {
  await withMaintenanceWorkspace({
    // 引用按「目录 + 文件名」归类：generated/shared-name.png 被引用，
    // 不能顺带保护 avatars/ 与 attachments/ 下的同名文件。
    characters: ['/api/files/generated/shared-name.png'],
    messages: [{ content: 'see /api/files/generated/shared-name.png' }],
    files: [
      ['avatars', 'shared-name.png'],
      ['avatars', 'true-orphan.png'],
      ['attachments', 'shared-name.png'],
      ['attachments', 'true-orphan.png'],
      ['generated', 'true-orphan.png'],
      ['generated', 'character-0/true-orphan.png'],
    ],
  }, async ({ route, exists }) => {
    const preview = await (await route.GET({})).json();
    assert.deepEqual(preview.orphanFiles, {
      avatars: { total: 2, orphanCount: 2 },
      attachments: { total: 2, orphanCount: 2 },
      generated: { total: 2, orphanCount: 2 },
    });

    const cleanup = await (await route.POST({})).json();
    assert.deepEqual(cleanup.fileResults, {
      avatars: { deleted: 2, errors: 0 },
      attachments: { deleted: 2, errors: 0 },
      generated: { deleted: 2, errors: 0 },
    });

    for (const [dirName, filename] of [
      ['avatars', 'shared-name.png'],
      ['avatars', 'true-orphan.png'],
      ['attachments', 'shared-name.png'],
      ['attachments', 'true-orphan.png'],
      ['generated', 'true-orphan.png'],
      ['generated', 'character-0/true-orphan.png'],
    ]) {
      assert.equal(exists(dirName, filename), false, `${dirName}/${filename} should be deleted`);
    }
  });
});
