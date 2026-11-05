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
import { createMemoryProposalTool } from './proposal-tools';
import { queryTableTool } from './query-table-tool';
import { rememberTool } from './document-tools';
import { loadSkillTool, prepareMemoryReviewTool, readReviewBatchTool } from './review-tools';
import { updateTaskPlanTool } from './task-plan-tool';

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
];

/** 写入工具。没有直接修改记忆的工具：记忆只能经提案、由主人批准后修改。 */
export const AGENT_WRITE_TOOLS: AgentWriteTool[] = [createMemoryProposalTool, rememberTool, updateTaskPlanTool];

/** 交给 Agent 循环的完整工具表。 */
export const AGENT_TOOLS: AgentTool[] = [...AGENT_READ_TOOLS, ...AGENT_WRITE_TOOLS];
