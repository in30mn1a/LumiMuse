import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { Message } from '@/types';
import { buildBackgroundChatExtraBody, loadSettings, mergeSettingsForBackgroundLlm, resolveBackgroundConfig } from '@/lib/settings';
import { chatCompletion } from '@/lib/api-client';
import { formatZodFieldErrors, imagePromptBodySchema } from '@/lib/schemas';

/**
 * AI 生成图片 prompt — 根据对话上下文和角色信息生成适合文生图的英文标签
 * POST body: { conversation_id: string; message_id?: string; user_hint?: string }
 * - message_id: 触发生图的消息 ID，取该消息及之前共 10 条作为上下文
 * - user_hint: 额外补充说明（最高优先级）
 * 返回: { prompt: string; negative_prompt: string }
 */

const PROMPT_GENERATION_SYSTEM = `# 核心功能
将对话文本转译为 Danbooru 格式 Tag 串（英文单词/词语，逗号分隔），供 NovelAI / Stable Diffusion 生成插图。

# 导演思考（内部步骤，不输出）
在生成 Tag 前，先在脑中完成六要素分析：在哪、怎么拍、谁、穿什么、做什么、什么表情。

# Tag 构成规则

## Scene Composition（场景构图，约 15-25%）
### 通用
- 内容分级：sfw 或 nsfw
- 角色数量与性别：1girl / 1boy / 1girl 1boy 等
- 角色关系：solo / hetero / face to face 等

### 构图
- 画幅区域：full body / upper body / lower body / bust shot
- 视角：front view / from above / from below / from behind（禁止 POV，不要输出 pov / first-person view / viewer perspective 等 pov 相关 tag）
- 角度：cinematic angle / dutch angle / dynamic angle
- 焦点：face focus / ass focus / chest focus
- 其他：depth of field / bokeh / wide-angle

## Character Prompt（角色，主角 50-70%）
### 角色 DNA（身份）
- 性别：girl / boy
- 姓名：原创角色写"名字 (original)"；同人角色写"英文名 (作品名)"
- 年龄/职业标识（如适用）

### 角色 DNA（外貌，必须完整）
- 核心特征（必选）：发长、发色、瞳色、罩杯大小
- 非人特征（如有）：tail / horn / elf ears 等
- 修饰特征（如有）：彩妆 / 纹身 / 印记等

### 角色 DNA（服饰）
- 逐件列出所有可见服饰：头饰/上衣/裤裙/袜子/鞋/内衣/配饰
- 格式：品类 + 颜色 + 款式 + 材质/细节
- 裸露状态：按实际情况描述（open clothes / no bra / see-through 等）

### 当前动作（具体、可视化）
- 基础姿态：sitting / standing / lying / kneeling
- 肢体细节：像 3D 动画师一样定义接触点，说明"什么肢体+做什么+位置"
- 物理反馈（如适用）：sagging breasts / motion lines / speed lines

### 当前表情
- 视线：looking at viewer / looking away / looking up
- 情绪：happy / shy / aroused / surprised
- 感官细节：blush / tears / open mouth / tongue out / drooling

## Background Elements（背景，约 15-20%）
- 时代/风格：modern / fantasy / historical
- 环境：室内外 + 具体地点 + 周边事物
- 时间/天气：night / daytime / rain / snow
- 氛围：intimate atmosphere / tense atmosphere / ethereal atmosphere
- 光源与光效：sidelighting / backlighting / rim lighting / dramatic shadows

# Tag 质量规范
- 总 Tag 数：70 - 300 个
- 碎片化拆解：复合概念拆为多个细分 Tag（如"月下"→ moonlit, night, starry sky）
- 权重增强：低频/核心/易忽略元素用 1.2::tag:: 或 1.3::tag:: 强调
- 权重减弱：次要/背景元素用 0.6::tag:: 或 0.7::tag:: 降低占比
- 排序：按画面占比/重要性由高到低排列
- 仅描述视觉可见元素，不描述被遮挡/画面外的内容

# 视觉一致性
- 如果提供了角色固定外貌标签（image_tags），必须完整包含，不得省略或修改
- 如果提供了用户外貌标签（user_image_tags），在用户出场时必须完整包含，保持发色/瞳色等特征一致
- 每次生成同一角色时，发色/瞳色/核心特征保持一致

# 用户外貌标签（user_image_tags）
- 描述用户本人的外貌特征（发色、瞳色、性别、体型等），不是风格偏好
- **仅当用户出现在画面中时才包含这些标签**——根据对话内容判断用户是否在场
- 用户出场时：完整包含所有用户外貌标签
- 用户未出场（仅角色独白/旁白/单人场景）：不包含用户外貌标签

# 生成限制
- 默认第三人称视角，禁止 POV 视角，不要输出 pov 或任何第一人称视角相关 tag
- 禁止矛盾 tag（如 facing viewer + buttocks visible）
- 每张图为单一静态瞬间，不描述连续动作
- SFW场景不要出现男性角色 tag，除非用户外貌标签中明确标注了用户为男性（如 1boy），或男女之间的亲密互动如kiss,hugging；对话明确要求 NSFW 互动时允许男性角色 tag
- NSFW场景必须出现详细描写表情、性爱姿势等tag，禁止回避NSFW场景的tag生成

# 输出格式（严格遵守，不输出任何解释文字）
POSITIVE: <所有正面 Tag，逗号分隔，70 - 300个>`;

const GEMINI_IMAGE_PROMPT_SENSITIVE_TAG_PATTERN = /^(?:loli|shota|child|kindergarten|kindergarten uniform)$/i;

export async function POST(request: NextRequest) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = imagePromptBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', fieldErrors: formatZodFieldErrors(parsed.error) },
      { status: 400 }
    );
  }

  const { conversation_id, message_id, user_hint } = parsed.data;

  try {
    if (!conversation_id) {
      return NextResponse.json({ error: '缺少 conversation_id' }, { status: 400 });
    }

    const db = getDb();
    const loadedSettings = loadSettings();
    const backgroundConfig = resolveBackgroundConfig(loadedSettings);
    const settings = mergeSettingsForBackgroundLlm(loadedSettings, backgroundConfig, {
      json_mode: false,
      max_tokens: 16384,
    });
    const backgroundExtraBody = buildBackgroundChatExtraBody(loadedSettings, settings.model);

    if (!settings.api_base || !settings.model) {
      return NextResponse.json({ error: '请先配置 LLM API' }, { status: 400 });
    }

    // 获取对话信息
    const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversation_id) as { character_id: string } | undefined;
    if (!conversation) {
      return NextResponse.json({ error: '对话不存在' }, { status: 404 });
    }

    // 获取角色信息（含 image_tags）
    const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(conversation.character_id) as {
      name: string;
      personality: string;
      scenario: string;
      image_tags?: string;
      user_image_tags?: string;
    } | undefined;

    // 获取消息上下文：基于触发生图的消息，取该消息及之前共 10 条
    let messages: Pick<Message, 'role' | 'content'>[];
    if (message_id) {
      // 先找到目标消息的 seq
      const targetMsg = db.prepare(
        'SELECT seq FROM messages WHERE id = ? AND conversation_id = ?'
      ).get(message_id, conversation_id) as { seq: number } | undefined;
      if (targetMsg) {
        messages = db.prepare(
          'SELECT role, content FROM messages WHERE conversation_id = ? AND role IN (\'user\',\'assistant\') AND seq <= ? ORDER BY seq DESC LIMIT 10'
        ).all(conversation_id, targetMsg.seq) as Pick<Message, 'role' | 'content'>[];
      } else {
        messages = [];
      }
    } else {
      // 兜底：取最新 10 条
      messages = db.prepare(
        'SELECT role, content FROM messages WHERE conversation_id = ? AND role IN (\'user\',\'assistant\') ORDER BY seq DESC LIMIT 10'
      ).all(conversation_id) as Pick<Message, 'role' | 'content'>[];
    }
    messages.reverse();

    // 构建上下文
    let context = '';
    let strippedTags = '';
    if (character) {
      context += `【角色信息】\n`;
      context += `角色名：${character.name}\n`;
      if (character.personality) context += `性格/外貌描述：${character.personality}\n`;
      if (character.scenario) context += `世界观/场景设定：${character.scenario}\n`;
      if (character.image_tags) {
        const isGemini = /gemini/i.test(settings.model);
        if (isGemini) {
          // Gemini 安全过滤较严，先分离敏感标签，
          // 生图时再拼回 prompt，确保角色外貌完整
          const allTags = character.image_tags.split(',').map(t => t.trim()).filter(Boolean);
          const sensitive = allTags.filter(t => GEMINI_IMAGE_PROMPT_SENSITIVE_TAG_PATTERN.test(t));
          const safe = allTags.filter(t => !GEMINI_IMAGE_PROMPT_SENSITIVE_TAG_PATTERN.test(t));
          strippedTags = sensitive.join(', ');
          if (safe.length > 0) {
            context += `\n【角色固定外貌标签（必须完整包含在 POSITIVE 中，不得省略）】\n${safe.join(', ')}\n`;
          }
        } else {
          context += `\n【角色固定外貌标签（必须完整包含在 POSITIVE 中，不得省略）】\n${character.image_tags}\n`;
        }
      }
      if (character.user_image_tags) {
        context += `\n【用户外貌标签（描述用户本人的外貌。仅当用户出现在画面中时才包含在 POSITIVE 中；用户未出场则忽略这些标签）】\n${character.user_image_tags}\n`;
      }
    }

    context += '\n【最近对话（用于推断当前场景、动作、情绪）】\n';
    for (const msg of messages) {
      const role = msg.role === 'user' ? '用户' : character?.name || 'AI';
      context += `${role}：${msg.content}\n`;
    }

    if (user_hint) {
      context += `\n【用户额外指定（最高优先级）】\n${user_hint}\n`;
    }

    context += `\n请根据以上信息生成一张插图的 Tag。必须优先以最新一条消息为准来决定画面主体、动作、表情和场景；更早的对话只作为角色设定和上下文补充，不要让旧消息覆盖最新消息。`;

    const result = await chatCompletion(settings, [
      { role: 'system', content: PROMPT_GENERATION_SYSTEM },
      { role: 'user', content: context },
    ], undefined, backgroundExtraBody);

    // 解析输出
    let positive = '';
    let negative = '';
    const lines = result.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('POSITIVE:')) {
        positive = trimmed.slice(9).trim();
      } else if (trimmed.startsWith('NEGATIVE:')) {
        negative = trimmed.slice(9).trim();
      }
    }

    // 如果解析失败，整个结果作为正面 prompt
    if (!positive) {
      positive = result.replace(/POSITIVE:|NEGATIVE:.*$/gm, '').trim();
    }

    // 将被过滤的敏感标签拼回 prompt 开头，确保生图时角色外貌完整
    if (strippedTags) {
      positive = strippedTags + ', ' + positive;
    }

    return NextResponse.json({ prompt: positive, negative_prompt: negative });
  } catch (err) {
    console.error('[image-gen/prompt] 生成 prompt 失败:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '生成 prompt 失败' },
      { status: 500 }
    );
  }
}
