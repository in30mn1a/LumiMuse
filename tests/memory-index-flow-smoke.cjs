#!/usr/bin/env node

/**
 * Settings + memory-index smoke test.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const tmpRoot = path.join(repoRoot, '.tmp-tests', 'memory-index-flow-smoke');
const nextCli = path.join(repoRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
const API_KEY_MASK = '********';
const SERVER_TIMEOUT_MS = Number(process.env.SMOKE_SERVER_TIMEOUT_MS || 120_000);
const KEEP_TMP = process.env.SMOKE_KEEP_TMP === '1';

function assertInsideWorkspace(targetPath) {
  const resolved = path.resolve(targetPath);
  const allowedRoot = path.join(repoRoot, '.tmp-tests');
  const relative = path.relative(allowedRoot, resolved);
  assert.ok(
    relative && !relative.startsWith('..') && !path.isAbsolute(relative),
    `Refusing to operate outside .tmp-tests: ${resolved}`,
  );
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function removeDirIfExists(targetPath) {
  assertInsideWorkspace(targetPath);
  // Windows: better-sqlite3 / Next 进程退出后，.db-shm/.db-wal 可能仍短暂占锁。
  // 清理失败不应把已成功的 smoke 断言变成整文件失败；重试后再尽力删除。
  const maxAttempts = process.platform === 'win32' ? 8 : 1;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      fs.rmSync(targetPath, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      const code = error && error.code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'ENOTEMPTY') {
        throw error;
      }
      if (attempt < maxAttempts) {
        sleepSync(150 * attempt);
      }
    }
  }
  if (process.platform === 'win32' && lastError) {
    console.warn(`[memory-index-flow-smoke] cleanup skipped after lock: ${lastError.message}`);
    return;
  }
  throw lastError;
}

function copyFile(name) {
  fs.copyFileSync(path.join(repoRoot, name), path.join(tmpRoot, name));
}

function writeNextEnvFile() {
  fs.writeFileSync(
    path.join(tmpRoot, 'next-env.d.ts'),
    [
      '/// <reference types="next" />',
      '/// <reference types="next/image-types/global" />',
      '',
    ].join('\n'),
  );
}

function copyDir(name) {
  fs.cpSync(path.join(repoRoot, name), path.join(tmpRoot, name), {
    recursive: true,
    filter(source) {
      const normalized = source.replace(/\\/g, '/');
      return !normalized.includes('/public/generated/')
        && !normalized.includes('/public/avatars/')
        && !normalized.includes('/public/attachments/');
    },
  });
}

function linkNodeModules() {
  fs.symlinkSync(
    path.join(repoRoot, 'node_modules'),
    path.join(tmpRoot, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
}

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function requestJson(baseUrl, route, options = {}) {
  const url = new URL(route, baseUrl);
  const body = options.body === undefined ? null : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: options.method || 'GET',
        headers: {
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
          ...(options.headers || {}),
        },
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => {
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch (error) {
            reject(new Error(`Invalid JSON from ${route}: ${error.message}\n${raw.slice(0, 500)}`));
            return;
          }
          resolve({ status: res.statusCode, json, raw });
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitForServer(baseUrl, child) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < SERVER_TIMEOUT_MS) {
    if (child.exitCode !== null) {
      throw new Error(`Next dev server exited early with code ${child.exitCode}`);
    }

    try {
      const response = await requestJson(baseUrl, '/api/settings');
      if (response.status === 200 && response.json && typeof response.json === 'object') return;
      lastError = new Error(`Unexpected /api/settings status ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await new Promise(resolve => setTimeout(resolve, 1_000));
  }

  throw new Error(`Timed out waiting for Next dev server: ${lastError?.message || 'no response'}`);
}

function spawnCommand(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd || repoRoot,
    env: options.env || process.env,
    shell: options.shell || false,
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  if (child.stdout) child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  if (child.stderr) child.stderr.on('data', chunk => { stderr += chunk.toString(); });

  const done = new Promise((resolve) => {
    child.on('error', error => resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` }));
    child.on('close', code => resolve({ code, stdout, stderr }));
  });

  return { child, done, getOutput: () => ({ stdout, stderr }) };
}

function terminateProcessTree(child) {
  if (!child || !child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  child.kill('SIGTERM');
}

async function waitForDoneWithTimeout(done, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      done,
      new Promise(resolve => {
        timeout = setTimeout(() => resolve({ code: -1, stdout: '', stderr: `Timed out after ${timeoutMs}ms` }), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function runApiSmoke(baseUrl) {
  const initialSettings = await requestJson(baseUrl, '/api/settings');
  assert.equal(initialSettings.status, 200);
  assert.ok(initialSettings.json.memory_engine, 'settings response should include memory_engine');

  const settingsPayload = {
    memory_engine: {
      ...initialSettings.json.memory_engine,
      enabled: true,
      retrieval_mode: 'local',
      embedding_enabled: false,
      embedding_api_base: 'https://embedding.invalid/v1',
      embedding_api_key: 'embedding-secret-for-smoke',
      embedding_model: 'smoke-embedding-model',
      reranker_enabled: false,
      reranker_api_base: 'https://reranker.invalid/v1',
      reranker_api_key: 'reranker-secret-for-smoke',
      reranker_model: 'smoke-reranker-model',
    },
  };
  const putSettings = await requestJson(baseUrl, '/api/settings', {
    method: 'PUT',
    body: settingsPayload,
  });
  assert.equal(putSettings.status, 200);
  assert.equal(putSettings.json.memory_engine.embedding_api_key, API_KEY_MASK);
  assert.equal(putSettings.json.memory_engine.reranker_api_key, API_KEY_MASK);

  const preservedSettings = await requestJson(baseUrl, '/api/settings', {
    method: 'PUT',
    body: {
      memory_engine: {
        ...putSettings.json.memory_engine,
        embedding_api_key: API_KEY_MASK,
        reranker_api_key: API_KEY_MASK,
        embedding_model: 'smoke-embedding-model-v2',
      },
    },
  });
  assert.equal(preservedSettings.status, 200);
  assert.equal(preservedSettings.json.memory_engine.embedding_api_key, API_KEY_MASK);
  assert.equal(preservedSettings.json.memory_engine.embedding_model, 'smoke-embedding-model-v2');

  const emptyIndex = await requestJson(baseUrl, '/api/memory-index');
  assert.equal(emptyIndex.status, 200);
  assert.equal(emptyIndex.json.ok, true);
  assert.equal(emptyIndex.json.total, 0);

  const character = await requestJson(baseUrl, '/api/characters', {
    method: 'POST',
    body: {
      name: 'Smoke Test Character',
      greeting: 'Hello from smoke test',
    },
  });
  assert.equal(character.status, 201);
  assert.ok(character.json.id);

  const memory = await requestJson(baseUrl, '/api/memories', {
    method: 'POST',
    body: {
      character_id: character.json.id,
      category: '偏好习惯',
      content: '主人喜欢把 memory index smoke test 保持得又轻又准。',
      tags: ['smoke'],
    },
  });
  assert.equal(memory.status, 201);
  assert.ok(memory.json.id);

  const indexAfterMemory = await requestJson(baseUrl, '/api/memory-index');
  assert.equal(indexAfterMemory.status, 200);
  assert.equal(indexAfterMemory.json.ok, true);
  assert.equal(indexAfterMemory.json.total, 1);
  assert.equal(indexAfterMemory.json.queued, 1);

  const rebuildAll = await requestJson(baseUrl, '/api/memory-index', {
    method: 'POST',
    body: { action: 'rebuild' },
  });
  assert.equal(rebuildAll.status, 200);
  assert.equal(rebuildAll.json.ok, true);
  assert.equal(rebuildAll.json.character_id, null);
  assert.equal(rebuildAll.json.processing_started, false);

  const invalidCharacterId = await requestJson(baseUrl, '/api/memory-index', {
    method: 'POST',
    body: { action: 'rebuild', character_id: 42 },
  });
  assert.equal(invalidCharacterId.status, 400);

  return {
    characterId: character.json.id,
    memoryId: memory.json.id,
  };
}

async function prepareIsolatedProject() {
  removeDirIfExists(tmpRoot);
  fs.mkdirSync(tmpRoot, { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, 'data'), { recursive: true });

  for (const file of [
    'package.json',
    'tsconfig.json',
    'next.config.ts',
    'postcss.config.js',
    'tailwind.config.ts',
  ]) {
    copyFile(file);
  }

  writeNextEnvFile();
  for (const dir of ['src', 'public']) copyDir(dir);
  linkNodeModules();
}

async function main() {
  await prepareIsolatedProject();

  const port = Number(process.env.SMOKE_PORT || await findFreePort());
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawnCommand(
    process.execPath,
    [nextCli, 'dev', tmpRoot, '--webpack', '-p', String(port), '-H', '127.0.0.1'],
    {
      cwd: tmpRoot,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        ACCESS_PASSWORD: '',
      },
    },
  );

  try {
    await waitForServer(baseUrl, server.child);
    const apiResult = await runApiSmoke(baseUrl);

    console.log(JSON.stringify({
      ok: true,
      baseUrl,
      isolatedDataDir: path.join(tmpRoot, 'data'),
      api: apiResult,
    }, null, 2));
  } catch (error) {
    const output = server.getOutput();
    console.error(output.stdout.slice(-4000));
    console.error(output.stderr.slice(-4000));
    throw error;
  } finally {
    terminateProcessTree(server.child);
    // 给 Windows 一点时间释放 SQLite WAL/SHM 句柄，再删临时目录。
    await waitForDoneWithTimeout(server.done, process.platform === 'win32' ? 15_000 : 5_000).catch(() => {});
    if (process.platform === 'win32') {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!KEEP_TMP) {
      removeDirIfExists(tmpRoot);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
