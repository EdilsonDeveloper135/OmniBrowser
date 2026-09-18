const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

/**
 * Loads application TypeScript modules (and their relative imports) in memory, so a POC exercises the shipped source
 * instead of a copy. Packages resolve from the repository's node_modules. Type-only imports are erased.
 */
function createTypeScriptLoader(root) {
  const cache = new Map();

  function load(relativePath) {
    const filename = path.resolve(root, relativePath);
    const cached = cache.get(filename);
    if (cached) return cached.exports;
    const source = fs.readFileSync(filename, 'utf8');
    const { outputText } = ts.transpileModule(source, {
      fileName: filename,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
    });
    const module = new Module(filename, null);
    module.filename = filename;
    module.paths = Module._nodeModulePaths(path.dirname(filename));
    cache.set(filename, module);
    const localRequire = (request) => {
      if (!request.startsWith('.')) return module.require(request);
      const resolved = path.resolve(path.dirname(filename), request);
      return load(fs.existsSync(`${resolved}.ts`) ? `${resolved}.ts` : path.join(resolved, 'index.ts'));
    };
    const compiled = vm.runInThisContext(Module.wrap(outputText), { filename });
    compiled.call(module.exports, module.exports, localRequire, module, filename, path.dirname(filename));
    module.loaded = true;
    return module.exports;
  }

  return { load };
}

module.exports = { createTypeScriptLoader };
