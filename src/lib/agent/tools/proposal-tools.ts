import {
  NO_EVIDENCE_NOTE,
  createMemoryProposal,
  createMemoryProposalSchema,
} from '@/lib/agent/proposals';
import { defineWriteTool } from './types';

/**
 * 唯一与记忆修改有关的工具：只生成待批准的提案，不修改 memories。
 * 含可执行项时结束本轮，避免模型在主人批准前声称已经完成。
 */
export const createMemoryProposalTool = defineWriteTool({
  name: 'create_memory_proposal',
  description: `生成待主人批准的记忆修改提案。提案本身不改记忆，主人在卡片上逐项批准后才生效。
每项的 op：
- create：新增记忆。fields 必填 content、category，可选 tags、memory_kind、importance、emotional_weight、pinned。
- update：修改 memory_id 指向的 active 记忆，fields 只写要改的字段。
- retire：让 memory_id 指向的过时记忆退场（变为 superseded，不再进入聊天）。处理前后矛盾时用它，不要合并矛盾的记忆。
- merge：把 memory_ids 中描述同一件事的重复记忆（至少 2 条）合并成一条。fields 必填 content，可选 category、tags、memory_kind、importance。
- archive：把 memory_ids 归档成一条摘要，fields 只填 content（摘要正文）。
- repair_candidate：把 candidate_id 指向的待修复提取记录补回成记忆。memories 列出要补回的每条记忆（各自必填 content、category），批准时整体生效。来源默认取原提取任务的消息，evidence.message_ids 只能在其中收窄。原任务已成功时补回可能重复，先用 list_repairable_candidates 看任务状态，再用 search_memories 查是否已有。
- discard_candidate：丢弃 candidate_id 指向的待修复提取记录。
- report_conflict：报告 memory_ids（至少 2 条）之间无法合并的矛盾。只记录发现，不会执行，也不结束本轮。
依据：新增、修改正文、退场、合并、归档和矛盾报告必须在 evidence.message_ids 给出角色对话中的真实消息 ID；补回只在原任务没有可用的来源消息时才需要自己给出。确实没有原文依据时 message_ids 留空，note 写「${NO_EVIDENCE_NOTE}」。
「修改前」由系统从数据库读取，无需提供。任何一项不合法时整份提案不会创建，按返回的原因修正后重试。
含可执行项时，提案生成后本轮立即结束，等主人决定；不要声称已经修改。`,
  schema: createMemoryProposalSchema,
  execute(args, ctx) {
    const outcome = createMemoryProposal(ctx.db, args, { sessionId: ctx.sessionId, now: new Date().toISOString() });
    if (!outcome.ok) {
      return { result: { ok: false, error: `提案未创建：\n${outcome.errors.join('\n')}` } };
    }
    const pending = outcome.items.filter(item => item.state === 'pending').length;
    const reported = outcome.items.length - pending;
    const warnings = outcome.items.filter(item => item.warning).map(item => `第 ${item.seq} 项：${item.warning}`);
    return {
      result: {
        ok: true,
        proposal_id: outcome.proposalId,
        pending_items: pending,
        reported_conflicts: reported,
        ...(warnings.length > 0 ? { warnings } : {}),
        note: pending > 0
          ? '提案已生成，等待主人批准。本轮到此结束，批准前不要声称已经修改。'
          : '矛盾发现已记录，可以继续工作。',
      },
      terminate: pending > 0,
    };
  },
});
