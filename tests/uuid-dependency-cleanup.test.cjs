const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const originalResolveFilename = Module._resolveFilename;
const originalLoad = Module._load;
const legacyIdPackage = ['u', 'uid'].join('');
const legacyTypePackage = ['@types', 'uuid'].join('/');

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

function requireFreshWithMocks(modulePath, mocks) {
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) {
      return mocks[request];
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    for (const resetPath of [
      modulePath,
      '../src/lib/schemas.ts',
      '../src/types/index.ts',
    ]) {
      const resolved = require.resolve(resetPath);
      delete require.cache[resolved];
    }
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
          body,
          async json() {
            return body;
          },
        };
      },
    },
  };
}

function jsonRequest(body) {
  return {
    async json() {
      return body;
    },
  };
}

function createCharacterDb() {
  let inserted = null;
  return {
    prepare(sql) {
      if (sql.includes('SELECT MIN(sort_order) AS min_sort FROM characters')) {
        return {
          get() {
            return { min_sort: null };
          },
        };
      }
      if (sql.includes('INSERT INTO characters')) {
        return {
          run(id, name, avatarUrl, basicInfo, personality, scenario, greeting, exampleDialogue, systemPrompt, otherInfo, imageTags, userImageTags, sortOrder, createdAt, updatedAt) {
            inserted = {
              id,
              name,
              avatar_url: avatarUrl,
              basic_info: basicInfo,
              personality,
              scenario,
              greeting,
              example_dialogue: exampleDialogue,
              system_prompt: systemPrompt,
              other_info: otherInfo,
              image_tags: imageTags,
              user_image_tags: userImageTags,
              sort_order: sortOrder,
              created_at: createdAt,
              updated_at: updatedAt,
            };
          },
        };
      }
      if (sql.includes('SELECT * FROM characters WHERE id = ?')) {
        return {
          get(id) {
            return inserted?.id === id ? inserted : undefined;
          },
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function assertManifestSectionDoesNotReferenceLegacyUuid(section, manifestPath, sectionName) {
  if (!section || typeof section !== 'object') return;
  for (const packageName of [legacyIdPackage, legacyTypePackage]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(section, packageName),
      false,
      `${manifestPath} ${sectionName} should not depend on ${packageName}`,
    );
  }
}

function listCodeFiles(startDir) {
  const files = [];
  for (const entry of fs.readdirSync(startDir, { withFileTypes: true })) {
    const entryPath = path.join(startDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listCodeFiles(entryPath));
      continue;
    }
    if (/\.(?:cjs|js|jsx|ts|tsx)$/.test(entry.name)) files.push(entryPath);
  }
  return files;
}

function relativePath(filePath) {
  return path.relative(root, filePath).replaceAll(path.sep, '/');
}

test('/api/characters POST creates 12-character IDs from crypto.randomUUID', async () => {
  const route = requireFreshWithMocks('../src/app/api/characters/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: createCharacterDb },
    crypto: { randomUUID: () => '12345678-abcd-4abc-8abc-123456789abc' },
    [legacyIdPackage]: {
      v4() {
        throw new Error('external ID package should not be used for generated IDs');
      },
    },
  });

  const response = await route.POST(jsonRequest({ name: '艾莉丝' }));
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.id, '12345678-abc');
  assert.equal(body.id.length, 12);
});

test('package manifests do not keep legacy uuid dependencies', () => {
  const packageJson = readJson('package.json');
  for (const sectionName of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    assertManifestSectionDoesNotReferenceLegacyUuid(packageJson[sectionName], 'package.json', sectionName);
  }

  const packageLock = readJson('package-lock.json');
  for (const [packagePath, metadata] of Object.entries(packageLock.packages || {})) {
    for (const packageName of [legacyIdPackage, legacyTypePackage]) {
      assert.equal(
        packagePath.includes(`node_modules/${packageName}`),
        false,
        `package-lock.json should not contain ${packageName} package entries`,
      );
    }
    for (const sectionName of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      assertManifestSectionDoesNotReferenceLegacyUuid(metadata?.[sectionName], `package-lock.json ${packagePath || '<root>'}`, sectionName);
    }
  }
});

test('source and tests do not import or call legacy uuid helpers', () => {
  const importNeedles = [
    ['from ', "'", legacyIdPackage, "'"].join(''),
    ['from ', '"', legacyIdPackage, '"'].join(''),
    ['require(', "'", legacyIdPackage, "'", ')'].join(''),
    ['require(', '"', legacyIdPackage, '"', ')'].join(''),
    ['uuid', 'v4'].join(''),
  ];
  const currentTestPath = path.join(root, 'tests', 'uuid-dependency-cleanup.test.cjs');
  const files = [
    ...listCodeFiles(path.join(root, 'src')),
    ...listCodeFiles(path.join(root, 'tests')).filter(filePath => filePath !== currentTestPath),
  ];

  const matches = [];
  for (const filePath of files) {
    const source = fs.readFileSync(filePath, 'utf8');
    for (const needle of importNeedles) {
      if (source.includes(needle)) matches.push(`${relativePath(filePath)} contains ${needle}`);
    }
  }

  assert.deepEqual(matches, []);
});
