import 'package:drift/drift.dart';
import 'package:flutter/foundation.dart';
import '../database/database.dart';
import '../models/app_settings.dart';
import 'llm_service.dart';

/// AI 生图 prompt 系统提示词常量
///
/// 与 Node.js 主项目 `src/app/api/image-gen/prompt/route.ts` 的
/// `PROMPT_GENERATION_SYSTEM` 严格等价，原样保留 10 块结构：
/// 1. 核心功能
/// 2. 导演思考（内部步骤，不输出）
/// 3. Tag 构成规则下的 Scene Composition / Character Prompt / Background Elements 三大子块
///    （Character Prompt 内部再细分角色 DNA、当前动作、当前表情等）
/// 4. Tag 质量规范
/// 5. 视觉一致性（含 user_image_tags 出场约束）
/// 6. 用户外貌标签（user_image_tags 使用规范，区别于风格偏好）
/// 7. 生成限制
/// 8. 输出格式
///
/// 该常量为 R12 的「正确性基线」：调用方（generateImagePrompt 等，由后续子任务 13.2 接入）
/// 必须把它作为 system 消息发给 LLM，以保证 Flutter 端生图 prompt 质量与主项目持平。
const String _kPromptGenerationSystem = '''# 核心功能
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
POSITIVE: <所有正面 Tag，逗号分隔，70 - 300个>''';

/// 图片提示词生成服务 — 根据对话上下文生成 Danbooru 风格标签
class ImagePromptService {
  final LlmService _llm = LlmService();

  /// 根据对话上下文生成图片提示词
  /// [settings] 应用设置（含 API 配置）
  /// [conversationId] 当前对话 ID
  /// [db] 数据库实例
  /// [userHint] 用户额外提示（可选）
  /// [messageId] 触发生图的目标消息 ID（可选，R12 上下文窗口锚点）
  ///   - 命中：取该消息及之前共 10 条（`seq <= target.seq` 取最近 10，按 `seq` 升序）
  ///   - 为空或未命中：取该对话最近 10 条消息（按 `seq` 升序）
  ///
  /// 返回值为命名记录 `({String positive, String negative})`，与 Node.js 主项目
  /// `src/app/api/image-gen/prompt/route.ts` 的 POSITIVE/NEGATIVE 双段输出对齐：
  /// - 同时存在 `POSITIVE:` 与 `NEGATIVE:` 标记 → 分别提取并 `trim`
  /// - 不含标记 → 整段作为 `positive`，`negative` 置为空字符串
  /// 调用方需相应取值（由任务 13.4 在 chat_view 等处更新）。
  Future<({String positive, String negative})> generateImagePrompt(
    AppSettings settings,
    String conversationId,
    AppDatabase db, {
    String userHint = '',
    String? messageId,
  }) async {
    // 1. 加载对话所属角色信息
    final conversation = await (db.select(db.conversations)
          ..where((t) => t.id.equals(conversationId)))
        .getSingle();

    final character = await (db.select(db.characters)
          ..where((t) => t.id.equals(conversation.characterId)))
        .getSingle();

    // 2. 按 messageId 锚点加载上下文窗口（共 4 条，按 seq 升序）
    final sortedMessages = await _loadContextWindow(
      db: db,
      conversationId: conversationId,
      messageId: messageId,
    );

    // 3. 构建上下文 — 严格对照主项目 src/app/api/image-gen/prompt/route.ts
    final contextBuffer = StringBuffer();
    contextBuffer.writeln('【角色信息】');
    contextBuffer.writeln('角色名：${character.name}');
    if (character.personality.isNotEmpty) {
      final personality = character.personality.length > 400
          ? character.personality.substring(0, 400)
          : character.personality;
      contextBuffer.writeln('性格/外貌描述：$personality');
    }
    if (character.scenario.isNotEmpty) {
      final scenario = character.scenario.length > 300
          ? character.scenario.substring(0, 300)
          : character.scenario;
      contextBuffer.writeln('世界观/场景设定：$scenario');
    }
    String strippedTags = '';
    if (character.imageTags.isNotEmpty) {
      final isGemini = RegExp(r'gemini', caseSensitive: false).hasMatch(settings.model);
      if (isGemini) {
        // Gemini 安全过滤较严，分离敏感标签（loli/shota/child），
        // 生图时再拼回 prompt，确保角色外貌完整
        final allTags = character.imageTags
            .split(',')
            .map((t) => t.trim())
            .where((t) => t.isNotEmpty)
            .toList();
        final sensitivePattern = RegExp(r'^loli$|^shota$|^child$', caseSensitive: false);
        final sensitive = allTags.where((t) => sensitivePattern.hasMatch(t)).toList();
        final safe = allTags.where((t) => !sensitivePattern.hasMatch(t)).toList();
        strippedTags = sensitive.join(', ');
        if (safe.isNotEmpty) {
          contextBuffer.writeln();
          contextBuffer.writeln('【角色固定外貌标签（必须完整包含在 POSITIVE 中，不得省略）】');
          contextBuffer.writeln(safe.join(', '));
        }
      } else {
        contextBuffer.writeln();
        contextBuffer.writeln('【角色固定外貌标签（必须完整包含在 POSITIVE 中，不得省略）】');
        contextBuffer.writeln(character.imageTags);
      }
    }

    // 注入用户外貌标签（user_image_tags），对照主项目 route.ts 195-197 行
    // 与 image_tags 不同：这里不做 Gemini 敏感标签分离（主项目也未对 user_image_tags 做）
    if (character.userImageTags.isNotEmpty) {
      contextBuffer.writeln();
      contextBuffer.writeln('【用户外貌标签（描述用户本人的外貌。仅当用户出现在画面中时才包含在 POSITIVE 中；用户未出场则忽略这些标签）】');
      contextBuffer.writeln(character.userImageTags);
    }

    contextBuffer.writeln();
    contextBuffer.writeln('【最近对话（用于推断当前场景、动作、情绪）】');
    for (final msg in sortedMessages) {
      final role = msg.role == 'user' ? '用户' : (character.name);
      final content = msg.content.length > 300
          ? msg.content.substring(0, 300)
          : msg.content;
      contextBuffer.writeln('$role：$content');
    }

    if (userHint.isNotEmpty) {
      contextBuffer.writeln();
      contextBuffer.writeln('【用户额外指定（最高优先级）】');
      contextBuffer.writeln(userHint);
    }

    contextBuffer.writeln();
    contextBuffer.writeln('请根据以上信息，生成一张插图的 Tag。重点捕捉最近对话中最具画面感的瞬间。');

    // 4. 调用 LLM 生成 Danbooru 标签
    //
    // 系统提示词使用任务 13.1 已落地的 `_kPromptGenerationSystem`（导演式 9 块结构），
    // 与 Node.js 主项目 `src/app/api/image-gen/prompt/route.ts` 对齐。
    // 任务 13.3：返回 POSITIVE/NEGATIVE 双段命名记录；解析逻辑抽到 `_parsePromptResponse`。
    final messages = [
      const ChatMessage(role: 'system', content: _kPromptGenerationSystem),
      ChatMessage(role: 'user', content: contextBuffer.toString()),
    ];

    final result = await _llm.chatCompletion(
      settings: AppSettings(
        apiBase: settings.apiBase,
        apiKey: settings.apiKey,
        model: settings.model,
        temperature: 0.7,
        maxTokens: 16384,
        contextWindow: settings.contextWindow,
        streaming: false,
        jsonMode: false,
      ),
      messages: messages,
    );

    final parsed = _parsePromptResponse(result);
    if (strippedTags.isNotEmpty) {
      final positive = '$strippedTags, ${parsed.positive}';
      return (positive: positive, negative: parsed.negative);
    }
    return parsed;
  }

  /// 解析 LLM 返回的 POSITIVE/NEGATIVE 双段输出
  /// 对照主项目 src/app/api/image-gen/prompt/route.ts 的解析逻辑
  static ({String positive, String negative}) _parsePromptResponse(String text) {
    final positiveIndex = text.indexOf('POSITIVE:');
    final negativeIndex = text.indexOf('NEGATIVE:');

    if (positiveIndex >= 0 && negativeIndex >= 0) {
      if (positiveIndex < negativeIndex) {
        final positive =
            text.substring(positiveIndex + 'POSITIVE:'.length, negativeIndex).trim();
        final negative = text.substring(negativeIndex + 'NEGATIVE:'.length).trim();
        return (positive: positive, negative: negative);
      } else {
        final negative =
            text.substring(negativeIndex + 'NEGATIVE:'.length, positiveIndex).trim();
        final positive = text.substring(positiveIndex + 'POSITIVE:'.length).trim();
        return (positive: positive, negative: negative);
      }
    }

    if (positiveIndex >= 0) {
      final positive = text.substring(positiveIndex + 'POSITIVE:'.length).trim();
      return (positive: positive, negative: '');
    }

    if (negativeIndex >= 0) {
      final negative = text.substring(negativeIndex + 'NEGATIVE:'.length).trim();
      return (positive: '', negative: negative);
    }

    return (positive: text.trim(), negative: '');
  }

  /// 按 messageId 锚点加载上下文窗口（共 10 条，按 `seq` 升序）
  ///
  /// 与主项目 `src/app/api/image-gen/prompt/route.ts:158,166` 的 `LIMIT 10` 对齐：
  /// - `messageId` 命中：取 `seq <= target.seq` 的最近 10 条，再按 `seq` 升序返回
  /// - `messageId == null` 或未命中：取该对话最近 10 条（按 `seq DESC LIMIT 10` 后反转升序）
  Future<List<Message>> _loadContextWindow({
    required AppDatabase db,
    required String conversationId,
    required String? messageId,
  }) async {
    if (messageId != null) {
      final target = await (db.select(db.messages)
            ..where((t) =>
                t.id.equals(messageId) &
                t.conversationId.equals(conversationId)))
          .getSingleOrNull();
      if (target != null) {
        // 命中：取 seq <= target.seq 的最近 10 条，再升序返回
        final recent = await (db.select(db.messages)
              ..where((t) =>
                  t.conversationId.equals(conversationId) &
                  t.seq.isSmallerOrEqualValue(target.seq))
              ..orderBy([(t) => OrderingTerm.desc(t.seq)])
              ..limit(10))
            .get();
        return recent.reversed.toList();
      }
    }
    // 未命中或未传：取该对话最近 10 条，按 seq 升序
    final recent = await (db.select(db.messages)
          ..where((t) => t.conversationId.equals(conversationId))
          ..orderBy([(t) => OrderingTerm.desc(t.seq)])
          ..limit(10))
        .get();
    return recent.reversed.toList();
  }

  void dispose() {
    _llm.dispose();
  }

  // ───────── @visibleForTesting 别名 ─────────
  //
  // 任务 13.5 / 13.6 的属性测试需要在不发起真实 HTTP 请求的前提下覆盖
  // 「上下文窗口选择」和「POSITIVE/NEGATIVE 解析」两条核心逻辑。
  // 这里仅暴露薄包装方法 / 静态别名，内部仍调用现有的私有实现，
  // 不放宽线上代码的访问权限。

  /// 对 [_loadContextWindow] 的 `@visibleForTesting` 公开别名。
  ///
  /// 仅在 `test/` 中使用；线上代码必须经由 [generateImagePrompt] 间接调用。
  /// 命名沿用 task 13.5 描述里的 `loadContextWindowForTesting`。
  @visibleForTesting
  Future<List<Message>> loadContextWindowForTesting({
    required AppDatabase db,
    required String conversationId,
    required String? messageId,
  }) {
    return _loadContextWindow(
      db: db,
      conversationId: conversationId,
      messageId: messageId,
    );
  }

  /// 对静态私有解析方法 [_parsePromptResponse] 的 `@visibleForTesting` 公开别名。
  ///
  /// 仅在 `test/` 中使用，便于 task 13.6 在不构造 `AppDatabase` /
  /// `AppSettings` 的前提下断言解析结果。
  @visibleForTesting
  static ({String positive, String negative}) parsePromptResponseForTesting(
    String text,
  ) {
    return _parsePromptResponse(text);
  }
}
