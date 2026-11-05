/**
 * 进程内的运行登记：同一会话同时只允许一轮，按项目「单写入实例」的部署假设，不跨进程协调。
 */
const activeRuns = new Map<string, AbortController>();

/** 登记一轮；该会话已有一轮在运行时返回 null。 */
export function startAgentRun(sessionId: string): AbortController | null {
  if (activeRuns.has(sessionId)) return null;
  const controller = new AbortController();
  activeRuns.set(sessionId, controller);
  return controller;
}

/** 只移除自己登记的那一轮，避免误删之后新开的一轮。 */
export function finishAgentRun(sessionId: string, controller: AbortController): void {
  if (activeRuns.get(sessionId) === controller) activeRuns.delete(sessionId);
}

export function isAgentRunActive(sessionId: string): boolean {
  return activeRuns.has(sessionId);
}

/**
 * 中止该会话正在运行的一轮，供「切走后回来」的页面停止它：那时页面已不持有原来的流。
 * 登记仍由那一轮收尾时自己移除，中断记录照常入库。没有在运行时返回 false。
 */
export function abortAgentRun(sessionId: string): boolean {
  const controller = activeRuns.get(sessionId);
  if (!controller) return false;
  controller.abort();
  return true;
}
