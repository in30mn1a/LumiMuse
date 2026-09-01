const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const root = path.resolve(__dirname, '..', '..');
const originalResolveFilename = Module._resolveFilename;

if (!Module._resolveFilename.__lumimuseAlias) {
  Module._resolveFilename = function resolveFilename(request, parent, isMain, options) {
    if (request.startsWith('@/')) {
      const mapped = path.join(root, 'src', request.slice(2));
      for (const candidate of [mapped, `${mapped}.ts`, `${mapped}.tsx`, path.join(mapped, 'index.ts')]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      }
    }
    return originalResolveFilename.call(this, request, parent, isMain, options);
  };
  Module._resolveFilename.__lumimuseAlias = true;
}

function registerTsLoader(options = {}) {
  require.extensions['.ts'] = function loadTs(module, filename) {
    const source = fs.readFileSync(filename, 'utf8');
    const output = ts.transpileModule(source, {
      compilerOptions: {
        esModuleInterop: true,
        jsx: options.jsx ? ts.JsxEmit.ReactJSX : undefined,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
      fileName: filename,
    });
    module._compile(output.outputText, filename);
  };
}

module.exports = { registerTsLoader };
