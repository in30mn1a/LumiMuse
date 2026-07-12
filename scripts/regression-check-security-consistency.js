const fs = require('fs');
const path = require('path');

const root = process.cwd();
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const assert = (condition, message) => {
  if (!condition) {
    console.error('FAIL ' + message);
    process.exitCode = 1;
  } else {
    console.log('PASS ' + message);
  }
};

const providersRoute = read('src/app/api/providers/route.ts');
assert((providersRoute.match(/const unauthorized = await requireAuth/g) || []).length >= 3, 'providers write routes require auth first');
assert(providersRoute.includes('isUuid'), 'providers route validates caller supplied provider id');

const activateProviderRoute = read('src/app/api/providers/activate/route.ts');
assert(activateProviderRoute.includes('const unauthorized = await requireAuth(request);'), 'provider activation route requires auth before writing settings');

const importRoute = read('src/app/api/import/route.ts');
assert(importRoute.includes('const importAll = db.transaction'), 'import route wraps all imports in one transaction');
assert(importRoute.indexOf('const importAll = db.transaction') < importRoute.indexOf('for (const char of charactersToImport)'), 'import transaction begins before characters import');
assert(importRoute.indexOf('importAll(') > importRoute.indexOf('for (const conv of convs)'), 'import route executes one full import transaction');
assert(!importRoute.includes('const importConversations = db.transaction'), 'import route no longer transactions conversations only');

const messageRoute = read('src/app/api/messages/[id]/route.ts');
assert(messageRoute.includes('function mergeMessageMetadata'), 'messages PUT uses metadata merge helper');
assert(/(?:const|let)\s+mergedMeta\s*=\s*mergeMessageMetadata/.test(messageRoute), 'messages PUT merges metadata instead of replacing it');
assert(!messageRoute.includes('run(JSON.stringify(body.metadata), id)'), 'messages PUT does not overwrite metadata with raw request body');

if (process.exitCode) process.exit(process.exitCode);
console.log('security consistency regression checks passed');
