import { appendAgentMessage } from '@/lib/agent/store';
import { agentTaskPlanSchema } from '@/lib/agent/task-plan';
import { defineWriteTool } from './types';

/** 与 assistant 和全部工具结果同事务提交，只保存 Agent 的会话进度。 */
export const updateTaskPlanTool = defineWriteTool({
  name: 'update_task_plan',
  description: '保存当前会话的完整任务计划和进度快照。复杂任务开始前写总体目标、步骤和本轮目标；阶段结束时更新实际成果、未解决事项、下一轮行动与手动压缩建议。达到 round_goal 后设 round_complete 为 true，保存成功会立即结束本轮；必须在这次工具调用同一回复的正文里向主人说明阶段成果和下一轮，不得继续读取下一轮资料。步骤 ID 保持稳定，更新时提供完整快照，不能把已读取当作已审查完成。不会修改角色记忆、执行提案或自动压缩。生成会结束本轮的可执行提案前先保存进度。',
  schema: agentTaskPlanSchema,
  execute(args, ctx) {
    appendAgentMessage(ctx.db, ctx.sessionId, {
      role: 'event',
      content: JSON.stringify({ kind: 'task_plan', plan: args }),
    }, new Date().toISOString());
    return args.round_complete
      ? { result: { ok: true, saved: true, round_complete: true }, terminate: true }
      : { result: { ok: true, saved: true } };
  },
});
