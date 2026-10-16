const fs = require('node:fs/promises');
const path = require('node:path');

// 运行时写入的用户媒体：由部署环境挂载或现场生成，不随 standalone 包分发；
// 只在包里留空目录，否则直接运行 standalone 时就绪检查（要求这些目录可写）会失败
const USER_MEDIA_DIRS = ['generated', 'avatars', 'attachments'];

// standalone 包应有的全部顶层条目；.env / .env.production 是 Next 按约定自行复制的运行时环境文件。
// 服务端用 path.join(process.cwd(), …) 读写 data/ 与 public/，Next 的文件追踪因此把整个工作区都算成
// 依赖并复制进来（数据库、个人备份、.env.local、.git、docs……）。outputFileTracingExcludes 管不到
// proxy 的追踪清单，所以在这里按白名单收口，不依赖追踪器的行为。
const STANDALONE_ENTRIES = new Set([
  '.next', 'node_modules', 'package.json', 'server.js', 'public', '.env', '.env.production',
]);

async function copyDirectory(source, target, filter) {
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(source, target, { recursive: true, filter });
}

async function assertDirectory(dir, label) {
  const stat = await fs.stat(dir).catch((err) => {
    if (err && err.code === 'ENOENT') {
      throw new Error(`${label} not found. Run next build before preparing standalone assets.`);
    }
    throw err;
  });
  if (!stat.isDirectory()) {
    throw new Error(`${label} is not a directory.`);
  }
}

async function prepareStandaloneAssets(root = process.cwd(), logger = console) {
  const nextDir = path.join(root, '.next');
  const standaloneDir = path.join(nextDir, 'standalone');
  const staticDir = path.join(nextDir, 'static');
  const publicDir = path.join(root, 'public');
  // Windows Node 20 的 fs.cp 会向 filter 传入 namespaced 路径，比较前统一路径形式。
  const normalizedPublicDir = path.toNamespacedPath(publicDir);

  await assertDirectory(standaloneDir, '.next/standalone');
  await assertDirectory(staticDir, '.next/static');
  await assertDirectory(publicDir, 'public');

  await copyDirectory(staticDir, path.join(standaloneDir, '.next', 'static'));
  await copyDirectory(
    publicDir,
    path.join(standaloneDir, 'public'),
    (source) => !USER_MEDIA_DIRS.includes(path.relative(normalizedPublicDir, path.toNamespacedPath(source))),
  );
  await Promise.all(USER_MEDIA_DIRS.map((dir) => (
    fs.mkdir(path.join(standaloneDir, 'public', dir), { recursive: true })
  )));

  const traced = (await fs.readdir(standaloneDir)).filter((name) => !STANDALONE_ENTRIES.has(name));
  await Promise.all(traced.map((name) => fs.rm(path.join(standaloneDir, name), { recursive: true, force: true })));

  logger.log('[postbuild] Copied .next/static and public into .next/standalone');
  if (traced.length > 0) {
    logger.log(`[postbuild] Removed traced workspace files from .next/standalone: ${traced.join(', ')}`);
  }
}

if (require.main === module) {
  prepareStandaloneAssets().catch((err) => {
    console.error(`[postbuild] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}

module.exports = { prepareStandaloneAssets };
