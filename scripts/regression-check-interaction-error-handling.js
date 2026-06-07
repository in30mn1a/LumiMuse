const fs = require('fs');
const path = require('path');

const root = process.cwd();
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const assert = (condition, message) => {
  if (!condition) {
    console.error('❌ ' + message);
    process.exitCode = 1;
  } else {
    console.log('✅ ' + message);
  }
};

const http = read('src/lib/http.ts');
assert(http.includes('export async function parseJsonResponse'), '统一 HTTP 工具会把非 2xx 响应转为错误');
assert(http.includes('export function getErrorMessage'), '统一 HTTP 工具会规范化错误消息');

const settingsPage = read('src/app/settings/page.tsx');
assert(settingsPage.includes('parseJsonResponse'), '设置页使用统一 HTTP 错误处理工具');
assert(settingsPage.includes('const loadProviders = useCallback(async () => {'), '供应商加载使用 async/try 模式');
assert(settingsPage.includes("showToast(`${tRef.current('common.loadFailed')}:"), '设置页加载失败会提示用户');
assert(settingsPage.includes("showToast(`${t('common.operationFailed')}:"), '供应商切换/删除失败会提示用户');
assert(settingsPage.includes("showToast(`${t('settings.saveFailed')}:"), '供应商保存失败会提示用户');
assert(settingsPage.includes("showToast(`${t('auth.logoutFailed')}:"), '登出失败会提示用户且不继续跳转');

const chatView = read('src/components/chat/ChatView.tsx');
assert(chatView.includes('parseJsonResponse'), '聊天页使用统一 HTTP 错误处理工具');
assert(chatView.includes('const previousActiveConvId = activeConvIdRef.current;'), '删除对话失败时能恢复当前对话');
assert(chatView.includes('setDeleteOpen(true);'), '删除对话失败时重新打开确认弹窗/保留上下文');
assert(chatView.includes('await expectOkResponse(await fetch(`/api/conversations/${targetConvId}`'), '删除对话会检查服务端失败');
assert(chatView.includes('t(\'chat.deleteError\')'), '删除对话失败会提示用户');
assert(chatView.includes('await expectOkResponse(await fetch(`/api/conversations/${activeConvId}`'), '忽略记忆切换会检查服务端失败');
assert(chatView.includes('t(\'chat.ignoreToggleFail\')'), '忽略记忆切换失败会提示用户');
assert(chatView.includes('if (!data.ok) throw new Error'), '消息删除会校验返回 ok 字段');
assert(chatView.includes('await parseJsonResponse<void>'), '模型切换设置保存会检查失败');

const memoryList = read('src/components/memories/MemoryList.tsx');
assert(memoryList.includes('parseJsonResponse'), '记忆列表使用统一 HTTP 错误处理工具');
assert(memoryList.includes("setListError(t('common.loadFailed'))"), '记忆加载失败会展示错误');
assert(memoryList.includes("setBatchDeleteError(t('memory.batchDeleteFailed'))"), '记忆批量删除失败保留错误提示');
assert(memoryList.includes("setMutationError(t('common.operationFailed'))"), '记忆单条新增/更新/删除失败会展示错误');

const characterList = read('src/components/sidebar/CharacterList.tsx');
assert(characterList.includes('parseJsonResponse'), '角色列表使用统一 HTTP 错误处理工具');
assert(characterList.includes("setListError(t('common.loadFailed'))"), '角色加载失败会展示错误');
assert(characterList.includes("setListError(t('common.operationFailed'))"), '角色新建失败会展示错误');

const chatInput = read('src/components/chat/ChatInput.tsx');
assert(chatInput.includes('setModelError'), '模型选择器保留模型加载错误状态');
assert(chatInput.includes("setModelError(t('input.modelLoadFail'))"), '模型选择器加载失败会提示用户');

if (process.exitCode) process.exit(process.exitCode);
console.log('前端交互错误处理回归检查通过');
