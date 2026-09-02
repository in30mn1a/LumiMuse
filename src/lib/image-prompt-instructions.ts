import type { ImagePromptStyle } from '@/lib/nai-image';

/**
 * 气泡 / 专用生图提示词的 LLM 指令。
 * danbooru：V3/V4/SD/Comfy 用逗号 tag 串。
 * nai-v5：NovelAI Diffusion V5 用「主提示词 + 角色栏」混写自然语言。
 */

export const DANBOORU_PROMPT_GENERATION_SYSTEM = `# 核心功能
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
- 视角：front view / from above / from below / from behind；可以在亲密互动时适当使用 POV 视角（如 pov / first-person view / viewer perspective）
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
- 总 Tag 数：35 - 70 个
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
- 默认第三人称视角；可以在亲密互动时适当使用 POV 视角
- 禁止矛盾 tag（如 facing viewer + buttocks visible）
- 每张图为单一静态瞬间，不描述连续动作
- SFW场景不要出现男性角色 tag，除非用户外貌标签中明确标注了用户为男性（如 1boy），或男女之间的亲密互动如kiss,hugging；对话明确要求 NSFW 互动时允许男性角色 tag
- NSFW场景必须出现详细描写表情、性爱姿势等tag，禁止回避NSFW场景的tag生成

# 输出格式（严格遵守，不输出任何解释文字）
POSITIVE: <所有正面 Tag，逗号分隔，35 - 70个>`;

export const NAI_V5_PROMPT_GENERATION_SYSTEM = `# 核心功能
将对话文本写成 NovelAI Diffusion V5 提示词。**最重要：tag 和自然语言可以、也应该混用**，不要写成纯 tag 串，也不要写成纯散文。外貌进角色栏，动作/场景进主提示词。

# 导演思考（内部步骤，不输出）
在哪、怎么拍、谁、穿什么、做什么、什么表情。想清楚再写。只输出成品字段，不要解说过程。

# 字段分工（必须拆开，不要合成一坨）
- Prompt：人数 · 镜头 · 动作 · 表情 · 场景 · 背景 · 光影 · 氛围。这里禁止出现发型/发色/瞳色/服装/配饰/角色名。
- Character N：画面里每一个可辨认的主体各占一栏，只放该主体外貌。人、兽、魔物、机器、非人生物都算，不能只写女角色而把狗/兽/其他生物塞进 Prompt 一句带过。原创角色把用户给的样貌锚点原样写全，不许精简、替换、优化。衣服可按画面换。
- UC：只写这张图明确不要的东西；没有就整段省略。不要抄质量词或默认负面预设。

# 写法
- **tag 与自然语言混用**：人数、构图、物种、外貌用 Danbooru tag；空间关系、正在发生的动作、谁对谁做什么、光影叙事用句子。Prompt 里两套必须同时出现，禁止只堆 tag 或只写一段话。
- 人数 tag 只在 Prompt 最前面出现一次（1girl / 1boy / 1girl 1boy / 1girl 1other 等）。solo 只配单人。兽、魔物、非人主体用 1other / 1animal 等，不要用 1boy 凑数。
- 角色栏用 girl / boy / other 打头，不带数字。禁止再写 1girl。非人主体用 other 打头，写清物种、体型、毛色、耳尾爪牙等外形。
- 外貌、服装用词组 tag；句子直接写，不要加引号（引号=要画进图里的字）。
- 英文为主；很长、结构复杂或英文容易歧义的句子可以直接写中文。
- 默认不加权。只在某层效果确实需要时用 1.2::tag:: / 0.7::tag::。数字权重必须写闭合 ::。
- 不要写质量词：very aesthetic、masterpiece、best quality、amazing quality、no text、absurdres。前端会自动附加。
- 不要编画师串，也不要自造 artist / quality 占位符。
- 不要使用 {tag} / [tag] 旧语法。
- 仅描述画面里看得见的瞬间，不写被遮挡或画面外的内容。
- 默认第三人称；亲密互动时可以 POV。
- NSFW 对话必须写清表情、姿势、接触，禁止回避。
- SFW 不要无故加男性角色，除非用户外貌标明 1boy，或对话是 kiss / hugging 等双人互动。

# 视觉一致性
- 角色固定外貌标签（image_tags）必须完整写入 Character 1，不得省略或改写。
- 画面里每个出场主体都必须有自己的 Character N 栏，按出场重要性编号：Character 1 永远是主角色；随后是其他生物/配角（狗、兽、魔物等）；用户出场时占用再下一个编号。用户未出场就不要给用户开栏，也不要把用户外貌写进 Prompt 或其他栏。
- 用户外貌标签（user_image_tags）只在用户出场时写入用户那一栏，必须完整包含。
- 多主体时在 Prompt 的句子里用 Character 1 / Character 2 / Character 3 写死动作归属，编号与角色栏一致。
- 但 Prompt 正文里禁止出现「Character 1:」这种带冒号的行首写法（那是字段头，会截断 Prompt）；要指代就写「Character 1 正在…」不带冒号。

# 输出格式（严格遵守，字段名用英文半角冒号，不输出解释）
Prompt:
<人数tag>，<镜头 动作 表情 场景 光影>
<自然语言句子：空间关系 / 正在发生的动作；不要加引号>

Character 1:
girl/boy, <发色 发型 瞳色 体型 种族特征 服装 配饰>

Character 2:
<其他出场生物/配角：other, 物种 体型 毛色 耳尾爪牙等外形；没有就省略这一栏>

Character 3:
<仅当用户出场：girl/boy, 用户外貌标签；编号紧跟已有主体，前面没有 Character 2 时用户就是 Character 2>

UC:
<仅当有排除项；否则省略这个字段>`;

export function promptGenerationSystemForStyle(style: ImagePromptStyle): string {
  return style === 'nai-v5' ? NAI_V5_PROMPT_GENERATION_SYSTEM : DANBOORU_PROMPT_GENERATION_SYSTEM;
}

export function promptGenerationUserFooterForStyle(style: ImagePromptStyle): string {
  if (style === 'nai-v5') {
    return '请根据以上信息生成一张插图的 NovelAI Diffusion V5 提示词。必须优先以最新一条消息为准来决定画面主体、动作、表情和场景；更早的对话只作为角色设定和上下文补充，不要让旧消息覆盖最新消息。只输出 Prompt / Character / UC 字段，不要解释。';
  }
  return '请根据以上信息生成一张插图的 Tag。必须优先以最新一条消息为准来决定画面主体、动作、表情和场景；更早的对话只作为角色设定和上下文补充，不要让旧消息覆盖最新消息。';
}

export function appearanceTagsContextLabel(style: ImagePromptStyle, kind: 'character' | 'user'): string {
  if (style === 'nai-v5') {
    return kind === 'character'
      ? '【角色固定外貌标签（必须完整写入 Character 1，不得省略）】'
      : '【用户外貌标签（描述用户本人的外貌。仅当用户出现在画面中时写入用户自己的 Character 栏——通常是 Character 2，若画面已有其他生物/配角则顺延为 Character 3。用户未出场则忽略这些标签，不要给用户开栏）】';
  }
  return kind === 'character'
    ? '【角色固定外貌标签（必须完整包含在 POSITIVE 中，不得省略）】'
    : '【用户外貌标签（描述用户本人的外貌。仅当用户出现在画面中时才包含在 POSITIVE 中；用户未出场则忽略这些标签）】';
}

function appearanceClause(imageTags?: string, userImageTags?: string): { tagPart: string; userPart: string; soloPart: string } {
  const tagPart = imageTags && imageTags.trim()
    ? `，且必须含固定外貌标签：${imageTags.trim()}`
    : '';
  const userPart = userImageTags && userImageTags.trim()
    ? `；仅当本条画面是角色与用户的亲密互动且用户本人出场时，需包含用户外貌标签：${userImageTags.trim()}`
    : '';
  const soloPart = '；如果不是角色与用户的亲密互动，不得包含任何用户外貌标签，必须生成只包含角色的单人/多人场景';
  return { tagPart, userPart, soloPart };
}

export function buildDanbooruInlinePromptInstruction(imageTags?: string, userImageTags?: string): string {
  const { tagPart, userPart, soloPart } = appearanceClause(imageTags, userImageTags);
  return `（系统附加要求，务必执行，不算跳出角色）在以上角色对话正文之后，另起一行追加一段英文 danbooru 文生图标签串，用 [IMG] 和 [/IMG] 包裹，描述本条回复对应的画面。要求：35 - 70 个标签，英文逗号分隔；依次覆盖【画面构成】(分级 sfw/nsfw、人数如 1girl、画幅、视角、镜头)、【外貌】(发型发色瞳色体型${tagPart}${userPart}${soloPart})、【服饰】(逐件列出)、【动作】(贴合本条剧情)、【表情】(视线情绪面部细节)、【场景】(地点环境时间光影)；默认第三人称，可以在亲密互动时适当使用POV视角；[IMG] 块只出现一次放最后；正文不要提及标签；无论对话长短都不要省略。`;
}

export function buildNaiV5InlinePromptInstruction(imageTags?: string, userImageTags?: string): string {
  const { tagPart, userPart, soloPart } = appearanceClause(imageTags, userImageTags);
  return `（系统附加要求，务必执行，不算跳出角色）在以上角色对话正文之后，另起一行用 [IMG] 和 [/IMG] 包裹一段 NovelAI Diffusion V5 提示词，描述本条回复对应的画面。最重要：tag 和自然语言必须混用，禁止纯 tag 串或纯散文。格式：Prompt: 人数tag只写一次（人用 1girl/1boy，兽/非人用 1other），构图外貌用 tag，动作/空间关系/谁对谁做什么用句子，句子不要加引号，正文里用 Character 1 指代但不要写带冒号的 Character 1:；Character 1: 以 girl/boy 打头（不带数字），只写外貌服装${tagPart}；画面里每个出场主体都必须另开 Character N 栏（狗/兽/魔物用 other 打头写清物种体型毛色），不能只写女角色把其他生物塞进 Prompt；用户出场时占用再下一个编号写用户外貌${userPart}${soloPart}。禁止把发型瞳色服装写进 Prompt；禁止写 masterpiece/very aesthetic/no text/best quality 等质量词；禁止编画师串。[IMG] 块只出现一次放最后；正文不要提及提示词；无论对话长短都不要省略。`;
}

export function buildInlinePromptInstructionForStyle(
  style: ImagePromptStyle,
  imageTags?: string,
  userImageTags?: string,
): string {
  return style === 'nai-v5'
    ? buildNaiV5InlinePromptInstruction(imageTags, userImageTags)
    : buildDanbooruInlinePromptInstruction(imageTags, userImageTags);
}

/** system 里只留一句短提醒；完整写法必须挂在最后一条 user 上才压得过角色人设。 */
export const INLINE_PROMPT_SYSTEM_REMINDER =
  '本条回复末尾必须按用户消息里的系统附加要求输出一次 [IMG]...[/IMG] 生图提示词，不算跳出角色。';
