const assert = require('node:assert/strict');

/** 保护整个测试进程，包括用例结束后仍在运行的异步回调。 */
function installMemoryOnlyTestGuard(test) {
  const blocked = [];
  const reject = operation => {
    blocked.push(operation);
    // 业务代码可能捕获异常；即使如此，本次测试进程也必须失败。
    process.exitCode = 1;
    throw new Error(`Isolated test blocked ${operation}`);
  };

  const databasePath = require.resolve('better-sqlite3');
  const Database = require(databasePath);
  const checkDatabase = args => {
    if (args[0] !== ':memory:') reject(`database: ${String(args[0])}`);
  };
  require.cache[databasePath].exports = new Proxy(Database, {
    construct(target, args, newTarget) {
      checkDatabase(args);
      return Reflect.construct(target, args, newTarget);
    },
    apply(target, thisArg, args) {
      checkDatabase(args);
      return Reflect.apply(target, thisArg, args);
    },
  });

  // getDb 在构造文件数据库之前可能先创建 data 目录，也必须阻止。
  require('node:fs').mkdirSync = () => reject('directory creation');
  global.fetch = () => reject('global fetch');
  require('undici').fetch = () => reject('undici fetch');
  require('node:dns/promises').lookup = () => reject('DNS lookup');
  require('node:net').Socket.prototype.connect = () => reject('network connection');

  test.after(() => {
    assert.deepEqual(blocked, [], '数据库或联网隔离被突破，即使调用方捕获了异常也不能通过');
  });
}

module.exports = { installMemoryOnlyTestGuard };
