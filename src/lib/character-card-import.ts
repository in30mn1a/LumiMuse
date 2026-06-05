import type { Character } from '@/types';

export type CharacterDraft = Pick<Character,
  'name' |
  'avatar_url' |
  'basic_info' |
  'personality' |
  'scenario' |
  'greeting' |
  'example_dialogue' |
  'system_prompt' |
  'other_info' |
  'image_tags' |
  'user_image_tags'
>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function firstText(...values: unknown[]): string {
  return values.map(text).find(value => value.trim()) ?? '';
}

function tagsToText(value: unknown): string {
  return Array.isArray(value)
    ? value.filter(item => typeof item === 'string' && item.trim()).join(', ')
    : text(value);
}

function joinSections(sections: Array<[string, string]>): string {
  return sections
    .filter(([, content]) => content.trim())
    .map(([title, content]) => `【${title}】\n${content.trim()}`)
    .join('\n\n');
}

export function normalizeCharacterCard(payload: unknown): CharacterDraft | null {
  const root = asRecord(payload);
  if (!root) return null;

  const lumimuseCharacter = asRecord(root.character) ?? root;
  if (text(lumimuseCharacter.name)) {
    return {
      name: text(lumimuseCharacter.name),
      avatar_url: firstText(lumimuseCharacter.avatar_url, lumimuseCharacter.avatar),
      basic_info: text(lumimuseCharacter.basic_info),
      personality: text(lumimuseCharacter.personality),
      scenario: text(lumimuseCharacter.scenario),
      greeting: text(lumimuseCharacter.greeting),
      example_dialogue: text(lumimuseCharacter.example_dialogue),
      system_prompt: text(lumimuseCharacter.system_prompt),
      other_info: text(lumimuseCharacter.other_info),
      image_tags: text(lumimuseCharacter.image_tags),
      user_image_tags: text(lumimuseCharacter.user_image_tags),
    };
  }

  const data = asRecord(root.data);
  if (!data || !text(data.name)) return null;

  return {
    name: text(data.name),
    avatar_url: firstText(data.avatar, data.avatar_url),
    basic_info: joinSections([
      ['角色描述', text(data.description)],
      ['创作者', text(data.creator)],
      ['版本', text(data.character_version)],
    ]),
    personality: text(data.personality),
    scenario: text(data.scenario),
    greeting: firstText(data.first_mes, data.greeting),
    example_dialogue: firstText(data.mes_example, data.example_dialogue),
    system_prompt: text(data.system_prompt),
    other_info: joinSections([
      ['历史后置指令', text(data.post_history_instructions)],
      ['作者备注', text(data.creator_notes)],
    ]),
    image_tags: tagsToText(data.tags),
    user_image_tags: '',
  };
}
