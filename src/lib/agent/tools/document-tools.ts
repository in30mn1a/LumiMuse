import { z } from 'zod';
import { appendAgentMemory } from '@/lib/agent/documents';
import { defineWriteTool } from './types';

/** 只写 Agent 笔记，不触碰角色记忆或审批。同步执行以保持回合原子性。 */
export const rememberTool = defineWriteTool({
  name: 'remember',
  description: '把主人明确表达的长期习惯、偏好或通用反馈追加到 Agent 自己的 memory.md。只记笔记，不修改角色记忆，也不能改变审批规则。对话会显示内容并提供撤销。不要记录推测、凭据或重复内容。',
  schema: z.object({ content: z.string().trim().min(1).describe('要追加的 Markdown 笔记') }),
  execute(args, ctx) {
    const versionId = appendAgentMemory(ctx.db, args.content, new Date().toISOString());
    return {
      result: { ok: true, version_id: versionId, content: args.content, session_id: ctx.sessionId },
    };
  },
});
