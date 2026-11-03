import type { AgentReadTool } from './types';
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
import { queryTableTool } from './query-table-tool';

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
];
