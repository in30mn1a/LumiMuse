const fs = require('node:fs/promises');
const path = require('node:path');

async function copyDirectory(source, target) {
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(source, target, { recursive: true });
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

  await assertDirectory(standaloneDir, '.next/standalone');
  await assertDirectory(staticDir, '.next/static');
  await assertDirectory(publicDir, 'public');

  await copyDirectory(staticDir, path.join(standaloneDir, '.next', 'static'));
  await copyDirectory(publicDir, path.join(standaloneDir, 'public'));

  logger.log('[postbuild] Copied .next/static and public into .next/standalone');
}

if (require.main === module) {
  prepareStandaloneAssets().catch((err) => {
    console.error(`[postbuild] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}

module.exports = { prepareStandaloneAssets };
