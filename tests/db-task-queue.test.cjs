const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const Database = require('better-sqlite3');

const root = path.resolve(__dirname, '..');
const originalResolveFilename = Module._resolveFilename;

Module._resolveFilename = function resolveFilename(request, parent, isMain, options) {
  if (request.startsWith('@/')) {
    const mapped = path.join(root, 'src', request.slice(2));
    for (const candidate of [mapped, `${mapped}.ts`, `${mapped}.tsx`, path.join(mapped, 'index.ts')]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

require.extensions['.ts'] = function loadTs(module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

function loadQueueModule() {
  const modPath = path.join(root, 'src/lib/db-task-queue.ts');
  delete require.cache[require.resolve(modPath)];
  return require(modPath);
}

function createTasksDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sample_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      claim_token TEXT,
      lease_expires_at TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

test('enqueue without dedupe inserts every time', () => {
  const { createDbTaskQueue } = loadQueueModule();
  const queue = createDbTaskQueue({ table: 'sample_tasks' });
  const db = createTasksDb();

  const a = queue.enqueue(db, { columns: { entity_id: 'e1', payload: 'a' } });
  const b = queue.enqueue(db, { columns: { entity_id: 'e1', payload: 'b' } });
  assert.equal(a.inserted, true);
  assert.equal(b.inserted, true);
  assert.notEqual(a.id, b.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sample_tasks').get().c, 2);
});

test('enqueue with dedupe skips pending/processing and can revive failed', () => {
  const { createDbTaskQueue } = loadQueueModule();
  const queue = createDbTaskQueue({ table: 'sample_tasks' });
  const db = createTasksDb();

  const first = queue.enqueue(db, {
    columns: { entity_id: 'mem-1', payload: 'v1' },
    dedupeKey: { column: 'entity_id', value: 'mem-1' },
  });
  const skipped = queue.enqueue(db, {
    columns: { entity_id: 'mem-1', payload: 'v2' },
    dedupeKey: { column: 'entity_id', value: 'mem-1' },
  });
  assert.equal(first.inserted, true);
  assert.equal(skipped.inserted, false);
  assert.equal(skipped.id, first.id);

  db.prepare(`UPDATE sample_tasks SET status = 'failed', error_message = 'boom' WHERE id = ?`).run(first.id);
  const revived = queue.enqueue(db, {
    columns: { entity_id: 'mem-1', payload: 'v3' },
    dedupeKey: { column: 'entity_id', value: 'mem-1' },
    reviveFailed: true,
    reviveColumns: { payload: 'revived', retry_count: 0 },
  });
  assert.equal(revived.revived, true);
  assert.equal(revived.id, first.id);
  const row = db.prepare('SELECT status, payload, error_message, retry_count FROM sample_tasks WHERE id = ?').get(first.id);
  assert.equal(row.status, 'pending');
  assert.equal(row.payload, 'revived');
  assert.equal(row.error_message, null);
  assert.equal(row.retry_count, 0);
});

test('claim sets token and lease; recoverStale only resets expired leases', () => {
  const { createDbTaskQueue } = loadQueueModule();
  const queue = createDbTaskQueue({ table: 'sample_tasks', defaultLeaseSeconds: 300 });
  const db = createTasksDb();

  queue.enqueue(db, { columns: { entity_id: 'fresh', payload: '1' } });
  queue.enqueue(db, { columns: { entity_id: 'stale', payload: '2' } });

  const claimed = queue.claim(db, { limit: 2, leaseSeconds: 300 });
  assert.equal(claimed.length, 2);
  assert.ok(claimed.every(t => t.status === 'processing' && t.claim_token && t.lease_expires_at));

  // 把第一条租约改成已过期，第二条保持未来租约
  db.prepare(`
    UPDATE sample_tasks
    SET lease_expires_at = datetime('now', '-1 minute')
    WHERE id = ?
  `).run(claimed[0].id);

  const recovered = queue.recoverStale(db);
  assert.equal(recovered, 1);
  const fresh = db.prepare('SELECT status, claim_token FROM sample_tasks WHERE id = ?').get(claimed[1].id);
  const stale = db.prepare('SELECT status, claim_token, lease_expires_at FROM sample_tasks WHERE id = ?').get(claimed[0].id);
  assert.equal(fresh.status, 'processing');
  assert.ok(fresh.claim_token);
  assert.equal(stale.status, 'pending');
  assert.equal(stale.claim_token, null);
  assert.equal(stale.lease_expires_at, null);
});

test('confirmClaim / complete / fail honor claim_token', () => {
  const { createDbTaskQueue } = loadQueueModule();
  const queue = createDbTaskQueue({ table: 'sample_tasks' });
  const db = createTasksDb();
  queue.enqueue(db, { columns: { entity_id: 'x', payload: 'p' } });
  const [task] = queue.claim(db, { limit: 1 });
  assert.ok(task);

  assert.equal(queue.confirmClaim(db, task), true);
  assert.equal(queue.confirmClaim(db, { id: task.id, claim_token: 'wrong' }), false);

  assert.equal(queue.complete(db, task), true);
  const done = db.prepare('SELECT status, claim_token, lease_expires_at FROM sample_tasks WHERE id = ?').get(task.id);
  assert.equal(done.status, 'done');
  assert.equal(done.claim_token, null);
  assert.equal(done.lease_expires_at, null);

  queue.enqueue(db, { columns: { entity_id: 'y', payload: 'p2' } });
  const [task2] = queue.claim(db, { limit: 1 });
  assert.equal(queue.fail(db, task2, 'nope'), true);
  const failed = db.prepare('SELECT status, retry_count, error_message, claim_token FROM sample_tasks WHERE id = ?').get(task2.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.retry_count, 1);
  assert.equal(failed.error_message, 'nope');
  assert.equal(failed.claim_token, null);
});

test('requeue returns processing task to pending with optional retry increment', () => {
  const { createDbTaskQueue } = loadQueueModule();
  const queue = createDbTaskQueue({ table: 'sample_tasks' });
  const db = createTasksDb();
  queue.enqueue(db, { columns: { entity_id: 'retry-me', payload: 'p' } });
  const [task] = queue.claim(db, { limit: 1 });
  assert.equal(queue.requeue(db, task, {
    errorMessage: 'timeout',
    incrementRetry: true,
  }), true);
  const row = db.prepare('SELECT status, retry_count, error_message, claim_token, lease_expires_at FROM sample_tasks WHERE id = ?').get(task.id);
  assert.equal(row.status, 'pending');
  assert.equal(row.retry_count, 1);
  assert.equal(row.error_message, 'timeout');
  assert.equal(row.claim_token, null);
  assert.equal(row.lease_expires_at, null);
});

test('createDrainGate is mutually exclusive and stops when claimed is 0', async () => {
  const { createDbTaskQueue } = loadQueueModule();
  const queue = createDbTaskQueue({ table: 'sample_tasks' });
  let rounds = 0;
  const gate = queue.createDrainGate(async () => {
    rounds += 1;
    return { claimed: rounds < 3 ? 1 : 0 };
  }, { maxRounds: 10 });

  gate.trigger();
  gate.trigger(); // 第二次应被互斥掉
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(rounds, 3);
  assert.equal(gate.isActive(), false);
});

test.after(() => {
  Module._resolveFilename = originalResolveFilename;
});
