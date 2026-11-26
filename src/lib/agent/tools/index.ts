import type { AgentReadTool, AgentTool, AgentWriteTool } from './types';
import { getCharacterTool, listCharactersTool } from './character-tools';
import { listConversationsTool, readMessagesTool, searchMessagesTool } from './conversation-tools';
import {
  getSystemStatusTool,
  listAppEventsTool,
  listFailedTasksTool,
  listRepairableCandidatesTool,
} from './diagnostic-tools';
import {
  getMemoriesTool,
  getMemoryProfileTool,
  getMemorySourcesTool,
  searchMemoriesTool,
} from './memory-tools';
import {
  createCharacterProposalTool, createCharacterTool, createMemoryProposalTool, createMessageProposalTool,
  createWorksProposalTool,
} from './proposal-tools';
import { queryTableTool } from './query-table-tool';
import { rememberTool } from './document-tools';
import { loadSkillTool, prepareMemoryReviewTool, readReviewBatchTool } from './review-tools';
import { updateTaskPlanTool } from './task-plan-tool';
import { WEB_TOOLS, webToolsAvailable } from './web-tools';
import { getWorksCatalogTool } from './works-tools';
import type { Settings } from '@/types';

export { createSearchMemoriesTool, type SearchMemoriesDeps } from './memory-tools';

/** 全部只读工具。均不写库、不抛出，返回前统一做凭据脱敏。 */
export const AGENT_READ_TOOLS: AgentReadTool[] = [
  listCharactersTool,
  getCharacterTool,
  searchMemoriesTool,
  getMemoriesTool,
  getMemorySourcesTool,
  getMemoryProfileTool,
  listConversationsTool,
  readMessagesTool,
  searchMessagesTool,
  getSystemStatusTool,
  listAppEventsTool,
  listFailedTasksTool,
  listRepairableCandidatesTool,
  queryTableTool,
  loadSkillTool,
  prepareMemoryReviewTool,
  readReviewBatchTool,
  getWorksCatalogTool,
];

/** 角色卡、记忆、聊天消息与作品片单经提案、由主人批准后修改；其余工具只写 Agent 笔记与计划。 */
export const AGENT_WRITE_TOOLS: AgentWriteTool[] = [
  createMemoryProposalTool, createCharacterProposalTool, createCharacterTool, createMessageProposalTool,
  createWorksProposalTool, rememberTool, updateTaskPlanTool,
];

/** 交给 Agent 循环的完整工具表（不含按设置启用的联网工具，见 agentToolsFor）。 */
export const AGENT_TOOLS: AgentTool[] = [...AGENT_READ_TOOLS, ...AGENT_WRITE_TOOLS];

const AGENT_TOOLS_WITH_WEB: AgentTool[] = [...AGENT_READ_TOOLS, ...WEB_TOOLS, ...AGENT_WRITE_TOOLS];

/** 按当前设置决定工具表：联网搜索启用且有密钥时多出 search_web / fetch_url，否则与 AGENT_TOOLS 相同。 */
export function agentToolsFor(settings: Settings): AgentTool[] {
  return webToolsAvailable(settings) ? AGENT_TOOLS_WITH_WEB : AGENT_TOOLS;
}
