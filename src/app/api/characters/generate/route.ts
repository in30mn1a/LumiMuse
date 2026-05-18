import { NextRequest, NextResponse } from 'next/server';
import { chatCompletion } from '@/lib/api-client';
import { getDb } from '@/lib/db';
import { Character } from '@/types';
import { loadSettings } from '@/lib/settings';

const CHARACTER_GENERATION_SYSTEM = `你是 LumiMuse 的角色卡创作助手。
请根据用户要求生成一个适合聊天陪伴工具使用的原创角色。

输出要求：
- 只输出 JSON，不要 Markdown，不要解释。
- 所有界面可见文本使用中文。
- basic_info 用于填写身份、年龄、外貌、职业、关系等基础资料。
- personality 只写性格、说话方式、习惯和情绪节奏，不要重复 basic_info。
- image_tags 必须使用英文 Danbooru 风格标签，逗号分隔，用于图片生成。
- other_info 用于补充不适合放入性格、场景或开场白的其他角色信息。
- system_prompt 要简洁，强调角色扮演边界、语气和互动方式。
- example_dialogue 使用 {{user}} 和 {{char}} 标记。

JSON 字段必须完整包含：
{
  "name": "角色名称",
  "basic_info": "身份、年龄、外貌、职业、关系等基础资料",
  "personality": "性格、说话方式、习惯与情绪节奏",
  "scenario": "关系设定、世界观或相处背景",
  "greeting": "新对话开场白",
  "example_dialogue": "示例对话",
  "system_prompt": "系统提示词",
  "other_info": "其他补充信息",
  "image_tags": "english tags, comma separated"
}`;


function parseGeneratedCharacter(text: string): Partial<Character> {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/i, '')
    .trim();
  const parsed = JSON.parse(cleaned) as Record<string, unknown>;
  const result: Partial<Character> = {};

  for (const field of ['name', 'basic_info', 'personality', 'scenario', 'greeting', 'example_dialogue', 'system_prompt', 'other_info', 'image_tags'] as const) {
    if (typeof parsed[field] === 'string') {
      result[field] = parsed[field].trim();
    }
  }

  return result;
}

export async function POST(request: NextRequest) {
  try {
    const { requirement, current_character } = await request.json() as {
      requirement?: string;
      current_character?: Partial<Character>;
    };

    if (!requirement?.trim()) {
      return NextResponse.json({ error: '请输入角色要求' }, { status: 400 });
    }

    const settings = loadSettings();
    if (!settings.api_base || !settings.api_key || !settings.model) {
      return NextResponse.json({ error: '请先在设置中配置 API 地址、密钥和模型' }, { status: 400 });
    }

    const currentContext = current_character
      ? `\n\n当前表单内容（可参考，也可以按用户要求重写）：\n${JSON.stringify(current_character, null, 2)}`
      : '';

    const result = await chatCompletion({ ...settings, json_mode: false }, [
      { role: 'system', content: CHARACTER_GENERATION_SYSTEM },
      { role: 'user', content: `用户要求：${requirement.trim()}${currentContext}` },
    ]);

    return NextResponse.json(parseGeneratedCharacter(result));
  } catch (err) {
    console.error('[characters/generate] 生成角色失败:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '生成角色失败' },
      { status: 500 },
    );
  }
}
