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
