const assert = require('node:assert/strict');
const { cleanupReactDomTestEnvironment } = require('./react-dom-teardown.cjs');
const { installDomTestEnvironment } = require('./dom-test-environment.cjs');

assert.equal(require.cache[require.resolve('@testing-library/react')], undefined);
const restoreDom = installDomTestEnvironment();
global.IS_REACT_ACT_ENVIRONMENT = true;

const React = require('react');
const originalSetImmediate = global.setImmediate;
let schedulerQueued = 0;
let schedulerRan = 0;
let afterScheduler;

// 在真实提交完成、下一次被动副作用调度尚未执行时收尾，不依赖定时等待。
global.setImmediate = function(callback, ...args) {
  if (callback?.name !== 'performWorkUntilDeadline') return originalSetImmediate(callback, ...args);
  schedulerQueued += 1;
  return originalSetImmediate(function(...values) {
    schedulerRan += 1;
    callback(...values);
    afterScheduler();
  }, ...args);
};

const { render } = require('@testing-library/react');
let update;
let effectCleaned = false;

function Example() {
  const [ready, setReady] = React.useState(false);
  update = setReady;
  React.useEffect(() => () => { effectCleaned = true; }, []);
  return React.createElement('h1', {}, ready ? 'Ready' : 'Loading');
}

async function main() {
  const view = render(React.createElement(Example));
  let teardownStarted = false;
  global.IS_REACT_ACT_ENVIRONMENT = false;
  await new Promise((resolve, reject) => {
    afterScheduler = () => {
      if (teardownStarted || view.getByRole('heading').textContent !== 'Ready') return;
      teardownStarted = true;
      const complete = async () => {
        assert.equal(view.getByRole('heading').textContent, 'Ready');
        assert.ok(schedulerQueued > schedulerRan, 'a passive scheduler callback must still be queued');
        await cleanupReactDomTestEnvironment(restoreDom);
        assert.equal(effectCleaned, true);
        assert.equal(schedulerRan, schedulerQueued, 'scheduled React work must finish before DOM restoration');
        assert.equal(Object.hasOwn(global, 'window'), false);
        assert.equal(Object.hasOwn(global, 'document'), false);
        assert.equal(Object.hasOwn(global, 'IS_REACT_ACT_ENVIRONMENT'), false);
        global.setImmediate = originalSetImmediate;
        console.log('REACT_DOM_TEARDOWN_OK');
        if (process.argv.includes('--throw-after-cleanup')) {
          setImmediate(() => { throw new Error('REACT_DOM_TEARDOWN_UNHANDLED'); });
        }
      };
      complete().then(resolve, reject);
    };
    update(true);
  });
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
