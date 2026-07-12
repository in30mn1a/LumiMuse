const fs = require('node:fs');
const ts = require('typescript');

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
