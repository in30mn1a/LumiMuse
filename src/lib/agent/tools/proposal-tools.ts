import {
  NO_EVIDENCE_NOTE,
  createCharacter,
  createCharacterSchema,
  createCharacterProposal,
  createCharacterProposalSchema,
  createMemoryProposal,
  createMemoryProposalSchema,
  createMessageProposal,
  createMessageProposalSchema,
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
- update：修改 memory_id 指向的 active 记忆，fields 只写要改的字段。修正来源时显式写 source_msg_ids，表示完整替换列表（只保留真正支撑正文的消息），[] 清空；未写则不修改来源。非空列表批准后标为逐条选定，清空后为未标注。
- retire：让 memory_id 指向的过时记忆退场（变为 superseded，不再进入聊天）。处理前后矛盾时用它，不要合并矛盾的记忆。
- merge：把 memory_ids 中描述同一件事的重复记忆（至少 2 条）合并成一条。fields 必填 content，可选 category、tags、memory_kind、importance。
- archive：把 memory_ids 归档成一条摘要，fields 只填 content（摘要正文）。
- repair_candidate：把 candidate_id 指向的待修复提取记录补回成记忆。memories 列出要补回的每条记忆（各自必填 content、category），批准时整体生效。来源默认取原提取任务的消息，evidence.message_ids 只能在其中收窄。原任务已成功时补回可能重复，先用 list_repairable_candidates 看任务状态，再用 search_memories 查是否已有。
- discard_candidate：丢弃 candidate_id 指向的待修复提取记录。
- report_conflict：报告 memory_ids（至少 2 条）之间无法合并的矛盾。只记录发现，不会执行，也不结束本轮。时间先后清楚时，可以在同一份提案里附上对旧记忆的 retire，卡片会标成「矛盾建议退场」并默认不勾选，由主人确认。
依据：新增、修改正文或来源、退场、合并、归档和矛盾报告必须有依据；来源新列表非空且没有另给消息依据时，系统会复用新列表作为 evidence.message_ids。evidence 只记录修改依据，不会隐式替换已有来源，来源修改必须显式写 fields.source_msg_ids。依据是主人在本会话里的指示（例如确认了日期、要求删掉某句话）时，把主人的原话逐字写进 evidence.owner_quote；补回只在原任务没有可用的来源消息时才需要自己给出。确实没有原文依据时 message_ids 留空，note 以「${NO_EVIDENCE_NOTE}」开头，后面可以写原因。
记忆 ID 和消息 ID 可以写至少 8 位的唯一前缀，系统会补全；对应多条时会列出候选，按完整 ID 重试。
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

export const createCharacterProposalTool = defineWriteTool({
  name: 'create_character_proposal',
  description: `生成待主人批准的角色卡修改提案。先用 get_character 读取当前设定，再在 fields 里只写要修改的文本字段。
支持 name（名称）、basic_info（基础信息）、personality（性格）、scenario（场景）、greeting（开场白）、example_dialogue（示例对话）、system_prompt（角色系统提示）、other_info（其他信息）、image_tags（角色生图标签）、user_image_tags（用户生图标签）、image_prompt_other_requirements（生图其他要求）。空字符串清空文本，未写的字段保持原值。头像、模型、供应商和预设绑定使用角色设置入口。
reason 说明修改理由，evidence 提供角色对话消息 ID 或逐字摘录本会话里主人的指示到 owner_quote；确实没有原文依据的创作建议，note 以「${NO_EVIDENCE_NOTE}」开头并解释。不要把依据说明写进角色设定。
系统读取完整修改前快照，一项包含这次列出的全部字段，主人在卡片上批准后才一起生效，支持撤销。期间角色卡已被编辑时旧提案会过期。
生成成功后本轮立即结束，等待主人批准；不要声称已经修改。`,
  schema: createCharacterProposalSchema,
  execute(args, ctx) {
    const outcome = createCharacterProposal(ctx.db, args, { sessionId: ctx.sessionId, now: new Date().toISOString() });
    if (!outcome.ok) return { result: { ok: false, error: `提案未创建：\n${outcome.errors.join('\n')}` } };
    return {
      result: {
        ok: true, proposal_id: outcome.proposalId, pending_items: outcome.items.length,
        note: '角色卡提案已生成，等待主人批准。本轮到此结束，批准前不要声称已经修改。',
      },
      terminate: true,
    };
  },
});

export const createMessageProposalTool = defineWriteTool({
  name: 'create_message_proposal',
  description: `生成待主人批准的聊天消息修改提案，用于修改角色对话里已有消息的正文（用户或角色的发言）。提案本身不改消息，主人在卡片上逐项批准后才生效，支持撤销。
先用 read_messages 或 search_messages 读到消息的完整原文。items 每项修改一条消息：message_id 是目标消息，content 是修改后的完整正文（不是片段或差异），没有改动的部分逐字保留，包括换行、标点和 [IMG] 等标记。一份提案里的消息须属于同一个角色。
只能改正文，不能新增、删除消息，也不能改附件或切换版本，这些由主人在聊天界面操作。修改消息不会自动更新由它提取出的记忆，需要时另用 create_memory_proposal。
每项都要有 reason 和依据：主人在本会话里的指示逐字写进 evidence.owner_quote，或在 evidence.message_ids 给出支撑修改的角色对话消息 ID；确实没有原文依据时，note 以「${NO_EVIDENCE_NOTE}」开头并解释。
消息 ID 可以写至少 8 位的唯一前缀。「修改前」由系统从数据库读取；期间消息已被编辑时该项会过期。任何一项不合法时整份提案不会创建，按返回的原因修正后重试。
生成成功后本轮立即结束，等待主人批准；不要声称已经修改。`,
  schema: createMessageProposalSchema,
  execute(args, ctx) {
    const outcome = createMessageProposal(ctx.db, args, { sessionId: ctx.sessionId, now: new Date().toISOString() });
    if (!outcome.ok) return { result: { ok: false, error: `提案未创建：\n${outcome.errors.join('\n')}` } };
    const warnings = outcome.items.filter(item => item.warning).map(item => `第 ${item.seq} 项：${item.warning}`);
    return {
      result: {
        ok: true, proposal_id: outcome.proposalId, pending_items: outcome.items.length,
        ...(warnings.length > 0 ? { warnings } : {}),
        note: '消息修改提案已生成，等待主人批准。本轮到此结束，批准前不要声称已经修改。',
      },
      terminate: true,
    };
  },
});

export const createCharacterTool = defineWriteTool({
  name: 'create_character',
  description: `从零生成待主人批准的新角色卡提案，无需已有角色 ID。这里只创建提案，批准后才创建角色。
fields.name 必填且不能为空，其余可选角色卡文本字段与 create_character_proposal 相同；未写的文本为空，完整保留设定。不要传头像、模型、供应商或预设绑定，新角色使用正常新建默认配置。
reason 说明创作理由，evidence.owner_quote 逐字摘录本会话里主人的要求；确实没有原文依据时，note 以「${NO_EVIDENCE_NOTE}」开头并解释。新角色尚无对话，不接受 evidence.message_ids。
生成成功后本轮立即结束，等待主人批准；批准前不要声称角色已经创建，也不要先创建空白角色。未修改、未产生关联数据的新角色可以撤销创建。`,
  schema: createCharacterSchema,
  execute(args, ctx) {
    const outcome = createCharacter(ctx.db, args, { sessionId: ctx.sessionId, now: new Date().toISOString() });
    if (!outcome.ok) return { result: { ok: false, error: `提案未创建：\n${outcome.errors.join('\n')}` } };
    return {
      result: {
        ok: true, proposal_id: outcome.proposalId, pending_items: outcome.items.length,
        note: '新角色卡提案已生成，等待主人批准。本轮到此结束，批准前不要声称角色已经创建。',
      },
      terminate: true,
    };
  },
});
