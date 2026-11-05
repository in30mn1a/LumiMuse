import { z } from 'zod';
import type { AgentMessageRow } from './store';

/** Agent 工作进度的完整快照，不是角色记忆或审批结果。 */
export const agentTaskPlanSchema = z.object({
  goal: z.string().trim().min(1).max(4000).describe('整个任务的目标'),
  steps: z.array(z.object({
    id: z.string().trim().min(1).max(100).describe('稳定的步骤 ID，更新时保留'),
    title: z.string().trim().min(1).max(1000),
    status: z.enum(['pending', 'in_progress', 'completed']),
    result: z.string().trim().max(8000).optional().describe('该步骤实际得到的结果，不把读取算作审查完成'),
  })).min(1).max(40).superRefine((steps, ctx) => {
    const ids = new Set<string>();
    for (let index = 0; index < steps.length; index += 1) {
      if (ids.has(steps[index].id)) {
        ctx.addIssue({ code: 'custom', path: [index, 'id'], message: '步骤 ID 不能重复' });
      }
      ids.add(steps[index].id);
    }
    if (steps.filter(step => step.status === 'in_progress').length > 1) {
      ctx.addIssue({ code: 'custom', message: '一次只聚焦一个进行中的步骤' });
    }
  }),
  round_goal: z.string().trim().min(1).max(4000).describe('本轮要完成什么，以及完成的标准'),
  progress: z.string().trim().max(16000).describe('实际成果和覆盖范围，明确区分已读取、已审查和已取证'),
  unresolved: z.array(z.string().trim().min(1).max(4000)).max(50).describe('尚未解决的疑点，保留真实 ID 和需要的依据'),
  next_round: z.string().trim().max(8000).describe('下一轮具体行动；整个任务已完成时可留空'),
  recommend_compaction: z.boolean().describe('阶段结束后是否建议主人手动压缩；只是建议，不执行压缩'),
  round_complete: z.boolean().default(false).describe('本轮目标已达成时设为 true，保存成果和下一轮后立即结束本轮，不继续读取下一轮资料'),
});

export type AgentTaskPlan = z.infer<typeof agentTaskPlanSchema>;

/** 从原始会话记录恢复最新有效快照，压缩与工具折叠不改变这些记录。 */
export function readLatestAgentTaskPlan(
  rows: readonly Pick<AgentMessageRow, 'id' | 'role' | 'content'>[],
): { rowId: number; plan: AgentTaskPlan } | null {
  let latest: { rowId: number; plan: AgentTaskPlan } | null = null;
  for (const row of rows) {
    if (row.role !== 'event' || (latest && row.id <= latest.rowId)) continue;
    try {
      const event: unknown = JSON.parse(row.content);
      if (!event || typeof event !== 'object' || !('kind' in event) || event.kind !== 'task_plan' || !('plan' in event)) continue;
      const parsed = agentTaskPlanSchema.safeParse(event.plan);
      if (parsed.success) latest = { rowId: row.id, plan: parsed.data };
    } catch {
      // 损坏或旧版本的不完整快照不覆盖最近一次有效进度。
    }
  }
  return latest;
}
