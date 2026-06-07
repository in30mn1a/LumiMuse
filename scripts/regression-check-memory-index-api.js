const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const routePath = path.join(root, 'src', 'app', 'api', 'memory-index', 'route.ts');

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  }
}

assert(fs.existsSync(routePath), 'src/app/api/memory-index/route.ts must exist');

if (fs.existsSync(routePath)) {
  const source = fs.readFileSync(routePath, 'utf8');

  assert(/export\s+async\s+function\s+GET\s*\(/.test(source), 'route must export GET');
  assert(/export\s+async\s+function\s+POST\s*\(/.test(source), 'route must export POST');
  assert(source.includes('getMemoryIndexStatus'), 'GET should call getMemoryIndexStatus or equivalent status logic');
  assert(
    source.includes('enqueueRebuildMemoryEmbeddings') || source.includes('enqueueMemoryEmbeddingTask'),
    'POST should enqueue rebuild tasks',
  );
  assert(/\bindexed\b/.test(source) && /\bready\b/.test(source), 'status response should expose indexed/ready');
  assert(/\bqueued\b/.test(source) && /\bpending\b/.test(source), 'status response should expose queued/pending');
  assert(/\bprocessing\b/.test(source) && /\bfailed\b/.test(source), 'status response should expose processing/failed');
  assert(!/\bembedText\b|\bprocessMemoryEmbeddingTasks\b/.test(source), 'API route must not call embedding processing directly');
}

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log('memory-index API regression checks passed');
