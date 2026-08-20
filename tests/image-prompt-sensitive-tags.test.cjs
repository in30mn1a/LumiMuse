const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

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

const {
  partitionSensitiveImageTags,
  rejoinSensitiveTagsFromOriginalOrder,
  rejoinSensitiveTagsAfterSubject,
  isSensitiveImageTag,
  imageTagCoreForSensitivity,
  prepareImageTagsForLlm,
  restoreSensitiveImageTagsToPrompt,
  splitTags,
} = require('../src/lib/image-prompt-sensitive-tags.ts');

test('imageTagCoreForSensitivity unwraps weighted tags, brackets and special syntax', () => {
  assert.equal(imageTagCoreForSensitivity('1.3::loli::'), 'loli');
  assert.equal(imageTagCoreForSensitivity('1.3::loli'), 'loli');
  assert.equal(imageTagCoreForSensitivity('1.3 :: loli ::'), 'loli');
  assert.equal(imageTagCoreForSensitivity('::loli::'), 'loli');
  assert.equal(imageTagCoreForSensitivity('{1.3::loli::}'), 'loli');
  assert.equal(imageTagCoreForSensitivity('{{{loli}}}'), 'loli');
  assert.equal(imageTagCoreForSensitivity('(loli:1.3)'), 'loli');
  assert.equal(imageTagCoreForSensitivity('(loli: 1.3)'), 'loli');
  assert.equal(imageTagCoreForSensitivity('((loli))'), 'loli');
  assert.equal(imageTagCoreForSensitivity('[loli]'), 'loli');
  assert.equal(imageTagCoreForSensitivity('[loli:0.8]'), 'loli');
  assert.equal(imageTagCoreForSensitivity('<lora:loli_model:0.8>'), 'loli_model');
  assert.equal(imageTagCoreForSensitivity('1.2::kindergarten uniform::'), 'kindergarten uniform');
  assert.equal(imageTagCoreForSensitivity('blue eyes'), 'blue eyes');
});

test('splitTags handles commas, Chinese commas, semicolons, and newlines', () => {
  assert.deepEqual(
    splitTags('1girl, 1.3::loli::，blonde hair; blue eyes；smile\nred ribbon'),
    ['1girl', '1.3::loli::', 'blonde hair', 'blue eyes', 'smile', 'red ribbon'],
  );
});

test('isSensitiveImageTag matches weighted sensitive cores and variations', () => {
  assert.equal(isSensitiveImageTag('1.3::loli::'), true);
  assert.equal(isSensitiveImageTag('{1.3::loli::}'), true);
  assert.equal(isSensitiveImageTag('(loli:1.3)'), true);
  assert.equal(isSensitiveImageTag('((loli))'), true);
  assert.equal(isSensitiveImageTag('0.8::shota::'), true);
  assert.equal(isSensitiveImageTag('1.1::child'), true);
  assert.equal(isSensitiveImageTag('kindergartener'), true);
  assert.equal(isSensitiveImageTag('elementary school student'), true);
  assert.equal(isSensitiveImageTag('little girl'), true);
  assert.equal(isSensitiveImageTag('萝莉'), true);
  assert.equal(isSensitiveImageTag('best quality'), false);
  assert.equal(isSensitiveImageTag('high school student'), false);
});

test('partitionSensitiveImageTags preserves original weighted spelling for rejoin', () => {
  const { safeForLlm, strippedForRejoin } = partitionSensitiveImageTags(
    'blue eyes, 1.3::loli::, 1.2::kindergarten uniform::, red hair',
  );
  assert.equal(safeForLlm, 'blue eyes, red hair');
  assert.equal(strippedForRejoin, '1.3::loli::, 1.2::kindergarten uniform::');

  const braced = partitionSensitiveImageTags('blue eyes, {1.3::loli::}，(loli:1.3), red hair');
  assert.equal(braced.safeForLlm, 'blue eyes, red hair');
  assert.equal(braced.strippedForRejoin, '{1.3::loli::}, (loli:1.3)');
});

test('rejoinSensitiveTagsFromOriginalOrder inserts after left neighbor from image_tags', () => {
  const joined = rejoinSensitiveTagsFromOriginalOrder(
    'masterpiece, 1girl, blue eyes, long hair, red hair',
    'blue eyes, 1.3::loli::, red hair',
  );
  assert.equal(
    joined,
    'masterpiece, 1girl, blue eyes, 1.3::loli::, long hair, red hair',
  );
});

test('rejoinSensitiveTagsFromOriginalOrder inserts before right neighbor when left is missing', () => {
  const joined = rejoinSensitiveTagsFromOriginalOrder(
    '1girl, blue eyes, red hair',
    '1.3::loli::, blue eyes, red hair',
  );
  assert.equal(joined, '1girl, 1.3::loli::, blue eyes, red hair');
});

test('rejoinSensitiveTagsFromOriginalOrder keeps consecutive sensitive tags in original order', () => {
  const joined = rejoinSensitiveTagsFromOriginalOrder(
    'best quality, 1girl, blue eyes, red hair',
    'blue eyes, 1.3::loli::, kindergarten uniform, red hair',
  );
  assert.equal(
    joined,
    'best quality, 1girl, blue eyes, 1.3::loli::, kindergarten uniform, red hair',
  );
});

test('rejoinSensitiveTagsFromOriginalOrder falls back after 1girl when no neighbors present', () => {
  const joined = rejoinSensitiveTagsFromOriginalOrder(
    'masterpiece, 1girl, long hair',
    '1.3::loli::, kindergarten uniform',
  );
  assert.equal(
    joined,
    'masterpiece, 1girl, 1.3::loli::, kindergarten uniform, long hair',
  );
});

test('rejoinSensitiveTagsFromOriginalOrder skips tags already present by core', () => {
  const joined = rejoinSensitiveTagsFromOriginalOrder(
    '1girl, loli, blue eyes',
    '1.3::loli::, blue eyes',
  );
  assert.equal(joined, '1girl, loli, blue eyes');
});

test('legacy rejoinSensitiveTagsAfterSubject still inserts after 1girl', () => {
  const joined = rejoinSensitiveTagsAfterSubject(
    'masterpiece, 1girl, long hair, smile',
    '1.3::loli::, kindergarten uniform',
  );
  assert.equal(
    joined,
    'masterpiece, 1girl, 1.3::loli::, kindergarten uniform, long hair, smile',
  );
});

test('prepareImageTagsForLlm strips sensitive tags for every model', () => {
  const stripped = prepareImageTagsForLlm('blue eyes, 1.3::loli::, red hair');
  assert.equal(stripped.tagsForLlm, 'blue eyes, red hair');
  assert.equal(stripped.strippedForRejoin, '1.3::loli::');

  const clean = prepareImageTagsForLlm('blue eyes, red hair');
  assert.equal(clean.tagsForLlm, 'blue eyes, red hair');
  assert.equal(clean.strippedForRejoin, '');

  const empty = prepareImageTagsForLlm('   ');
  assert.equal(empty.tagsForLlm, undefined);
  assert.equal(empty.strippedForRejoin, '');
});

test('restoreSensitiveImageTagsToPrompt uses original order for every model', () => {
  const restored = restoreSensitiveImageTagsToPrompt(
    'masterpiece, 1girl, blue eyes, long hair',
    'blue eyes, 1.3::loli::, red hair',
  );
  assert.equal(restored, 'masterpiece, 1girl, blue eyes, 1.3::loli::, long hair');

  const bracedRestored = restoreSensitiveImageTagsToPrompt(
    'masterpiece, 1girl, blue eyes, long hair',
    'blue eyes, {1.3::loli::}, red hair',
  );
  assert.equal(bracedRestored, 'masterpiece, 1girl, blue eyes, {1.3::loli::}, long hair');

  const sdRestored = restoreSensitiveImageTagsToPrompt(
    'masterpiece, 1girl, blue eyes, long hair',
    'blue eyes, (loli:1.3), red hair',
  );
  assert.equal(sdRestored, 'masterpiece, 1girl, blue eyes, (loli:1.3), long hair');

  const noTags = restoreSensitiveImageTagsToPrompt('masterpiece, 1girl, long hair', '');
  assert.equal(noTags, 'masterpiece, 1girl, long hair');
});