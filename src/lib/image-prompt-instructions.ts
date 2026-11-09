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
- 如果画面包含性行为，必须用 tag 写清可见性器及其状态和接触方式（如 penis, vagina, testicles, pussy, erection, insertion, penis in pussy），禁止用模糊说法或省略性器来回避

# 输出格式（严格遵守，不输出任何解释文字）
- 不要输出 UC、NEGATIVE 或负面提示词。负面提示词由画图设置单独提供
POSITIVE: <所有正面 Tag，逗号分隔，35 - 70个>`;

export const NAI_V5_PROMPT_GENERATION_SYSTEM = `# 核心功能
把对话里「此刻」的画面写成 NovelAI Diffusion V5 提示词。**最重要：tag 和自然语言可以、也应该混用**：离散事实（人数、物件、姿势、取景、机位、外貌、服装）用 Danbooru tag；关系（谁在哪、谁对谁做什么、接触与支撑、遮挡、光从哪来照到哪）用英文句子。不要写成纯 tag 串，也不要写成纯散文。外貌进角色栏，镜头/场景/关系进主提示词。

# 先定画面（内部步骤，不输出）
按顺序想清楚，只输出成品字段，不要解说过程：
1. 定格：以最新一条消息为准，挑出最有表现力的**一个瞬间**。消息里是一串连续动作时只取其中一刻，不把前后几个动作拼进同一张图。
2. 视角：第三人称还是 POV（见「视角」）。
3. 取景：这一刻必须看见的最上端和最下端部位是什么 → 决定景别；再定机位高低。
4. 人物：画面里有谁，从观众看谁在左、谁在右、谁在前景；谁对谁做什么。
5. 身体自洽：逐个核对每个人的头、手、腿、躯干此刻在哪、靠什么支撑、接触哪里。同一时刻做不到的组合（例如整个人趴在对方胸口，同时把脚抬到对方嘴边）只能留一个。
6. 场景与光：地点、时段、主光源方向与落点。时段、天气、光源互相不能矛盾（夜里不写阳光晒暖的床）。

# 字段分工（必须拆开，不要合成一坨）
- Prompt：人数 · 关键物件 · 姿势/动作/表情/视线（只有一个角色栏时）· 取景与机位 · 场景/时段/光影 · 关系句 · 氛围。这里禁止出现发型/发色/瞳色/服装/配饰/角色名；关系句里指认人物只用最短的外观锚点（如 the grey-haired girl）。
- Character N：画面里每一个可辨认的主体各占一栏。人、兽、魔物、机器、非人生物都算，不能只写女角色而把狗/兽/其他生物塞进 Prompt 一句带过。唯一例外：POV 时用户就是镜头本身，不算画面里的主体，不开栏（见「视角」）。
  - 第 1 行：girl / boy / other 打头，接外貌。原创角色把用户给的样貌锚点原样写全，不许精简、替换、优化（其中的人数和主体计数 tag 除外，见「写法」）；有规范名的版权角色写 Danbooru 规范英文/罗马音名，再逐项补上用户指定的细节，不凭印象补写默认外观。非人主体用 other 打头，写清物种、体型、毛色、耳尾爪牙等外形。
  - 第 2 行：本次画面里看得见的服装与配饰（可按剧情换装）。
  - 第 3 行（仅当有两个及以上角色栏时）：这个主体自己的姿势、动作、表情、视线 tag。对另一个人做的互动动作加方向前缀：发起方写 source#动作，承受方写同一个 tag 的 target#动作，双方互相做写 mutual#动作（如 source#hug / target#hug、mutual#holding hands、mutual#eye contact）。只有 source# / target# / mutual# 三种前缀，前缀后接现成的 Danbooru 动作 tag；找不到现成 tag 的动作不要硬造，写进 Prompt 的关系句。
  - 只有一个角色栏时不写第 3 行：动作、表情、视线留在 Prompt。
- 不要输出 UC 或 NEGATIVE。负面提示词由画图设置单独提供，不要写进这次输出。

# 视角：第三人称与 POV
- 默认第三人称。角色与用户单独互动、且用户是动作的另一方时（对视、递东西、牵手、拥抱、亲吻、性爱等），优先用 POV：用户就是镜头，画面就是用户眼睛看到的东西。
- POV 硬规则，任何一条破了都会画成旁观者视角的双人图：
  1. Prompt 写 pov。**用户不开 Character 栏**，也不写用户的发型、发色、瞳色、脸——这些在用户自己眼里看不见。给用户开栏，等于让模型把用户当成一个完整人物画出来。
  2. 用户只以画面边缘看得见的身体部位出现，写进 Prompt：露手写 pov hands，其他部位按动作写成 tag（如 pov crotch）和句子；可见部位的肤色、体型、袖口等可以从用户外貌标签里挑出来，写成 the viewer's … 短语。
  3. 句子里用户一律叫 the viewer（如 the viewer's hands hold her waist），不要写 he / the man / the boy / Character 2，否则画面会多出一个完整的人。
  4. 机位跟着用户的身体走：用户仰躺、角色在上方 → from below；用户站着、角色跪坐 → from above；面对面同高 → straight on。角色看着用户就写 looking at viewer。
  5. 不用只有旁观者才拍得到的镜头：两人都完整入镜的 full body、wide shot，从侧面拍两个人的 from side。
  6. 人数 tag：用户完全不露身体 → 只计角色（如 1girl, solo）；只露手 → 只计角色、不写 solo，加 pov hands；用户的躯干或下体进入画面（如性行为）→ 把用户计入人数（如 1girl, 1boy，男女时加 hetero），但仍不开栏、不写 solo。
- 第三人称且用户出场：用户占用自己的 Character 栏（见「视觉一致性」），句子按「多人画面」写。

# 多人画面（两个及以上角色栏）
- Prompt 前部只放人数、物件、取景、机位、场景、光影，不堆各人的姿势和动作词（如 1girl, 1boy, hug, sitting, standing），否则模型分不清谁做哪个；这些词写进各人栏的第 3 行。
- 关系句只写一两句：先说从观众看谁在左、谁在右（或谁在前景/背景），再说谁对谁做什么；对话里写定的接触、持物、谁托着谁照写。
- 句子主语用位置或最短外观锚点（the girl on the left、the black-haired boy），不要用 Character 1 / Character 2 当主语，也不要用角色真名——句子里的编号和名字不能可靠地对上角色栏。
- Prompt 正文里禁止出现「Character 1:」这种带冒号的行首写法（那是字段头，会截断 Prompt）。

# 写法
- **tag 与自然语言混用**：Prompt 里 tag 和句子两套必须同时出现，禁止只堆 tag 或只写一段话。
- Prompt 顺序：人数 → 手里拿的、身体靠着的、决定遮挡的物件 → 姿势、表情、视线（只有一个角色栏时）→ 取景与机位 → 场景、时段、光线 → 关系句 → 氛围。
- 人数 tag 只在 Prompt 最前面出现一次（1girl / 1boy / 1girl 1boy / 2girls / 1girl 1other 等）。solo 只配单人；多人里突出一人用 solo focus。兽、魔物、非人主体用 1other 等，不要用 1boy 凑数。
- 角色栏用 girl / boy / other 打头，不带数字。禁止再写 1girl。
- **人数/主体计数 tag 只归 Prompt**：image_tags 或样貌锚点里若含 1girl / 1boy / solo / 1girl 1boy / 1other 等计数 tag，把它们放到 Prompt 开头的人数位置，不要写进任何 Character 栏——这与「外貌标签必须完整写入」不冲突：计数 tag 本就不属于外貌，其余外貌锚点照写不改。POV 时人数按「视角」第 6 条算。
- 取景：动作要露出的部位必须装得进景别——full body（全身）、cowboy shot（大腿以上）、upper body（腰以上）、portrait / close-up（脸部附近）。某部分占画面多大、在画面哪一块，用句子补。
- 机位：垂直机位 from above / from below 可以和一个水平机位叠（from below, from side 合法）；from behind 和 from side 互斥。
- 同一个人只写一个视线方向（looking at viewer / looking away / looking down / looking at another 等）；looking back、closed eyes 不算方向，可以叠。同一个人同一时刻只有一个体位（sitting / standing / lying / kneeling 等）。
- 服装状态词先确认真实含义：loose socks 是堆堆袜而不是丝袜滑落，single thighhigh 是只穿了一只；滑落、撕破、拉到一边这类状态用句子写清是哪一侧、到哪里。
- 句子用现在时，写空间关系、接触与支撑、遮挡、光从哪来照在哪。句子直接写，不要加引号（引号=要画进图里的字）。
- 英文为主。
- 默认不加权。只在某层效果确实需要时用 1.2::tag:: / 0.7::tag::。数字权重必须写闭合 ::。
- 不要写质量词：very aesthetic、masterpiece、best quality、amazing quality、no text、absurdres。前端会自动附加。
- 不要编画师串，也不要自造 artist / quality 占位符。
- 不要使用 {tag} / [tag] 旧语法。
- 仅描述画面里看得见的瞬间，不写被遮挡或画面外的内容。
- NSFW 对话必须写清表情、姿势、接触，禁止回避。
- 如果画面包含性行为，必须在 Prompt 的句子里写清可见性器、状态和接触方式（如 penis, vagina, testicles, erection, insertion），禁止用模糊说法或省略性器来回避。
- SFW 不要无故加男性角色，除非用户外貌标明 1boy，或对话是 kiss / hugging 等双人互动。

# 视觉一致性
- 角色固定外貌标签（image_tags）必须完整写入 Character 1 的第 1、2 行，不得省略或改写；其中的人数和主体计数 tag（1girl / 1boy / solo / 1other 等）是唯一例外，放 Prompt 开头的人数位置，不重复写进角色栏。
- 画面里每个出场主体都必须有自己的 Character N 栏，按出场重要性编号：Character 1 永远是主角色；随后是其他生物/配角（狗、兽、魔物等）；用户以第三人称出场时占用再下一个编号。用户未出场、或 POV（用户是镜头）时都不给用户开栏，也不把用户的发型、发色、瞳色写进 Prompt 或其他栏。
- 用户外貌标签（user_image_tags）只在用户以第三人称出场时写入用户那一栏，必须完整包含；其中的人数和主体计数 tag（1girl / 1boy / solo 等）同样只放 Prompt 开头的人数位置，不写进用户栏。POV 时只挑镜头里看得见的部位特征写成 the viewer's … 放进 Prompt。

# 输出格式（严格遵守，字段名用英文半角冒号，不输出解释）
Prompt:
<人数tag>, <物件>, <只有一个角色栏时：姿势 表情 视线>, <取景 机位>, <场景 时段 光影>,
<英文关系句：左右位置 / 谁对谁做什么 / 接触与支撑 / 光从哪来；不要加引号>

Character 1:
girl/boy, <主角色外貌锚点>,
<服装 配饰>,
<仅当有两个及以上角色栏：这个主体的姿势 动作 表情 视线，互动动作带 source# / target# / mutual#>

Character 2:
<其他出场生物/配角：other, 物种 体型 毛色 耳尾爪牙等外形；没有就省略这一栏>

Character 3:
<仅当用户以第三人称出场：girl/boy, 用户外貌标签；编号紧跟已有主体，前面没有 Character 2 时用户就是 Character 2。POV 时不写这一栏>

# 结构示例（只演示字段与写法，内容不要照抄；尖括号处换成真实内容）
POV，一个角色栏：
Prompt:
1girl, pov, pov hands, mug, holding mug, smile, looking at viewer, upper body, straight on, cafe, window, evening, warm lighting,
She leans across the small table and holds out a steaming mug with both hands, and the viewer's hand reaches in from the bottom of the frame to take it. Warm light from the window behind her rims her hair.

Character 1:
girl, <主角色外貌锚点>,
<服装 配饰>

第三人称，用户出场，两个角色栏：
Prompt:
1girl, 1boy, cowboy shot, park, night, street lamp, backlighting,
The girl on the left hugs the taller boy on the right and presses her face against his chest while he pats her head. The street lamp behind them casts a soft halo around both figures.

Character 1:
girl, <主角色外貌锚点>,
<服装 配饰>,
source#hug, target#headpat, closed eyes, blush, smile

Character 2:
boy, <用户外貌标签>,
<服装>,
target#hug, source#headpat, looking down, gentle smile`;

export function promptGenerationSystemForStyle(style: ImagePromptStyle): string {
  return style === 'nai-v5' ? NAI_V5_PROMPT_GENERATION_SYSTEM : DANBOORU_PROMPT_GENERATION_SYSTEM;
}

export function promptGenerationUserFooterForStyle(style: ImagePromptStyle): string {
  if (style === 'nai-v5') {
    return '请根据以上信息生成一张插图的 NovelAI Diffusion V5 提示词。必须优先以最新一条消息为准来决定画面主体、动作、表情和场景；更早的对话只作为角色设定和上下文补充，不要让旧消息覆盖最新消息。只输出 Prompt / Character 字段，不要输出 UC，不要解释。';
  }
  return '请根据以上信息生成一张插图的 Tag。必须优先以最新一条消息为准来决定画面主体、动作、表情和场景；更早的对话只作为角色设定和上下文补充，不要让旧消息覆盖最新消息。';
}

export function appearanceTagsContextLabel(style: ImagePromptStyle, kind: 'character' | 'user'): string {
  if (style === 'nai-v5') {
    return kind === 'character'
      ? '【角色固定外貌标签（外貌锚点必须完整写入 Character 1，不得省略；其中的人数和主体计数 tag 放 Prompt 开头，不写进角色栏）】'
      : '【用户外貌标签（描述用户本人的外貌。仅当用户以第三人称出现在画面中时写入用户自己的 Character 栏——通常是 Character 2，若画面已有其他生物/配角则顺延为 Character 3。POV 时用户就是镜头，不开栏，只挑镜头里看得见的部位特征写成 the viewer\'s … 放进 Prompt。其中的人数和主体计数 tag 放 Prompt 开头，不写进任何角色栏。用户未出场则忽略这些标签，不要给用户开栏）】';
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
  return `（系统附加要求，务必执行，不算跳出角色）在以上角色对话正文之后，另起一行追加一段英文 danbooru 文生图标签串，用 [IMG] 和 [/IMG] 包裹，描述本条回复对应的画面。要求：35 - 70 个标签，英文逗号分隔；依次覆盖【画面构成】(分级 sfw/nsfw、人数如 1girl、画幅、视角、镜头)、【外貌】(发型发色瞳色体型${tagPart}${userPart}${soloPart})、【服饰】(逐件列出)、【动作】(贴合本条剧情)、【表情】(视线情绪面部细节)、【场景】(地点环境时间光影)；默认第三人称，可以在亲密互动时适当使用POV视角；如果画面是性行为，必须写出可见性器与接触方式，不要省略；不要输出 UC 或 NEGATIVE。[IMG] 块只出现一次放最后；正文不要提及标签；无论对话长短都不要省略。`;
}

export function buildNaiV5InlinePromptInstruction(imageTags?: string, userImageTags?: string): string {
  const { tagPart, soloPart } = appearanceClause(imageTags, userImageTags);
  // POV 时用户是镜头、不开栏；共用的 appearanceClause 只说「用户出场」，这里单独写清 POV 不算出场。
  const userPart = userImageTags && userImageTags.trim()
    ? `；仅当本条画面是角色与用户的亲密互动、且用户以第三人称完整出场（POV 不算）时，需包含用户外貌标签：${userImageTags.trim()}`
    : '';
  return `（系统附加要求，务必执行，不算跳出角色）在以上角色对话正文之后，另起一行用 [IMG] 和 [/IMG] 包裹一段 NovelAI Diffusion V5 提示词，描述本条回复里最有表现力的一个瞬间（连续动作只取一刻，每个人的手脚躯干位置必须能同时成立）。最重要：tag 和自然语言必须混用，禁止纯 tag 串或纯散文。格式：Prompt: 人数tag只写一次（人用 1girl/1boy，兽/非人用 1other），物件/取景/机位/场景/光影用 tag，空间关系/谁对谁做什么/接触与支撑用英文句子，句子不要加引号；句子里用位置或简短外观指认人物（如 the girl on the left），不要用 Character 1 或角色真名当主语，也不要写带冒号的 Character 1:；Character 1: 以 girl/boy 打头（不带数字），第一行外貌、第二行服装${tagPart}；固定外貌标签里的人数和主体计数 tag（1girl/1boy/solo 等）不算外貌，放 Prompt 开头、不写进角色栏；画面里每个出场主体都必须另开 Character N 栏（狗/兽/魔物用 other 打头写清物种体型毛色），不能只写女角色把其他生物塞进 Prompt；用户以第三人称出场时占用再下一个编号写用户外貌${userPart}${soloPart}。只有一个角色栏时，动作表情视线写在 Prompt；有两个及以上角色栏时，各人的姿势、动作、表情、视线写在自己栏的第三行，互动动作加 source#（发起方）/ target#（承受方，同一个 tag）/ mutual#（互相）前缀。POV（用户就是镜头；角色与用户单独互动时优先用）：Prompt 写 pov，用户不开角色栏、不写用户的发色瞳色和脸，只以画面边缘的手或身体部位出现（pov hands 等），句子里称用户为 the viewer，不要写 he / the man；机位跟着用户身体走（用户躺着、角色在上方 → from below），不要用拍得到两人全身的旁观镜头。禁止把发型瞳色服装写进 Prompt；禁止写 masterpiece/very aesthetic/no text/best quality 等质量词；禁止编画师串。如果画面是性行为，必须在 Prompt 的句子里写清可见性器与接触方式，不要省略；不要输出 UC。[IMG] 块只出现一次放最后；正文不要提及提示词；无论对话长短都不要省略。`;
}

export function buildInlinePromptInstructionForStyle(
  style: ImagePromptStyle,
  imageTags?: string,
  userImageTags?: string,
  otherRequirements?: string,
): string {
  const instruction = style === 'nai-v5'
    ? buildNaiV5InlinePromptInstruction(imageTags, userImageTags)
    : buildDanbooruInlinePromptInstruction(imageTags, userImageTags);
  return otherRequirements?.trim()
    ? `${instruction}\n\n【生图其他要求（仅用于 [IMG] 内的提示词，不写入角色对话正文）】\n${otherRequirements}`
    : instruction;
}

/** system 里只留一句短提醒；完整写法必须挂在最后一条 user 上才压得过角色人设。 */
export const INLINE_PROMPT_SYSTEM_REMINDER =
  '本条回复末尾必须按用户消息里的系统附加要求输出一次 [IMG]...[/IMG] 生图提示词，不算跳出角色。';
