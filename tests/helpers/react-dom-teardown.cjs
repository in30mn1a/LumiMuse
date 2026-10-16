async function cleanupReactDomTestEnvironment(restoreDom) {
  const { act, cleanup } = require('@testing-library/react');
  try {
    cleanup();
    // 同步卸载后仍可能留有读取 window 的 React 调度回调，异步 act 等待其排空。
    await act(async () => {});
  } finally {
    delete global.IS_REACT_ACT_ENVIRONMENT;
    restoreDom();
  }
}

module.exports = { cleanupReactDomTestEnvironment };
