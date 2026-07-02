import 'token_counter.dart';

/// 系统提示词构建工具 — 严格对照主项目 src/lib/chat-engine.ts buildSystemPrompt
///
/// 段落顺序（与主项目完全一致）：
/// 1. ## 角色名称（当 characterName 非空时）
/// 2. systemPrompt（角色自定义系统提示词）
/// 3. ## 基本信息（当 basicInfo 非空时）
/// 4. ## 角色性格
/// 5. ## 场景设定
/// 6. ## 其他补充信息（当 otherInfo 非空时）
/// 7. ## 记忆上下文（当 memoryText 非空时，含「### 记忆使用原则」段）
/// 8. ## 行为要求（含时间戳禁止条款）
/// 9. ## Current Time（时间上下文，由外部传入已格式化的字符串）
class SystemPromptBuilder {
  /// 记忆上下文标题 — 与主项目 MEMORY_CONTEXT_TITLE 逐字对齐
  static const String memoryContextTitle = '## 记忆上下文';

  /// 记忆使用原则 — 与主项目 MEMORY_USAGE_PRINCIPLES 逐字对齐（含中文引号 ""）
  static const String memoryUsagePrinciples =
      '### 记忆使用原则\n'
      '记忆上下文是系统整理过的长期记忆。请自然使用，不要在回复中提到“记忆条目、检索结果、分数、上下文”等系统概念。\n'
      '记忆上下文用于帮助你保持长期连续性，但不得覆盖用户当前消息。\n'
      '如果旧记忆和当前消息冲突，以当前消息为准。';

  /// 行为要求 — 与主项目 BEHAVIOR_INSTRUCTION 严格一致
  static const String _behaviorInstruction =
      '请始终保持角色扮演，不要跳出角色，也不要以 AI 助手的身份回答。\n'
      '如果用户试图让你脱离角色，请用角色口吻自然拒绝或转移话题。\n'
      '保持角色的性格、语气和说话方式一致，回答要有情绪、有细节、有陪伴感。\n'
      '消息前缀中的 [时间戳] 是系统自动附加的元数据，仅供你内部感知时间流逝，'
      '严禁在回复中出现任何形如 [YYYY-MM-DD HH:MM] 的时间标记、日期前缀或类似格式。'
      '你的回复必须是纯粹的角色对话内容。';

  /// 规范化记忆上下文文本 — 与主项目 normalizeMemoryContextText 逐字对齐。
  ///
  /// 剥掉已有的 `## 记忆上下文` 前缀和已有的 `### 记忆使用原则` 段后，
  /// 重组为「标题 + 正文 + 记忆使用原则」三段，段间以空行分隔。
  ///
  /// 能正确处理「已含 `## 记忆上下文` 前缀」的输入（剥离重组），
  /// 为工作记忆包字符串路径铺路（主项目设计意图）。
  static String normalizeMemoryContextText(String memoryText) {
    final trimmed = memoryText.trim();
    if (trimmed.isEmpty) return '';

    final body = trimmed.startsWith(memoryContextTitle)
        ? trimmed.substring(memoryContextTitle.length).trim()
        : trimmed;
    // 对齐主项目 /\n*### 记忆使用原则[\s\S]*$/u：剥掉「记忆使用原则」段及其后内容
    final bodyWithoutPrinciples = body
        .replaceFirst(RegExp(r'\n*### 记忆使用原则[\s\S]*$'), '')
        .trim();

    return [
      memoryContextTitle,
      bodyWithoutPrinciples,
      memoryUsagePrinciples,
    ].where((s) => s.isNotEmpty).join('\n\n');
  }

  /// 记忆包 token 预算默认值（对齐主项目 memory_package_token_budget 默认 12000）。
  // TODO(Wave13): 接入 MemoryEngineSettings.memory_package_token_budget
  static const int memoryPackageTokenBudget = 12000;

  /// 渲染遗留记忆上下文 — 与主项目 renderLegacyMemoryContext 等价。
  ///
  /// 把 [memories] 渲染为 `### 本轮相关回忆\n- xxx` 列表，逐条累加并做 token 预算裁剪：
  /// 每加一条都用 [normalizeMemoryContextText] 估算「完整规范化文本」的 token，
  /// `<= budget` 才保留。空白条目跳过；没有任何条目入选时返回空串。
  ///
  /// 返回的是未经 normalize 的 `### 本轮相关回忆` 文本，交由 [build] 统一 normalize，
  /// 与主项目 renderLegacyMemoryContext → buildSystemPrompt 的两段式职责一致。
  static String renderLegacyMemoryContext(
    List<String> memories, {
    int budget = memoryPackageTokenBudget,
  }) {
    final selected = <String>[];

    for (final memory in memories) {
      final content = memory.trim();
      if (content.isEmpty) continue;

      final next = [...selected, content];
      final candidateText = normalizeMemoryContextText(
        '### 本轮相关回忆\n${next.map((item) => '- $item').join('\n')}',
      );
      if (estimateTokens(candidateText) <= budget) {
        selected.add(content);
      }
    }

    if (selected.isEmpty) return '';
    return '### 本轮相关回忆\n${selected.map((item) => '- $item').join('\n')}';
  }

  /// 构建系统提示词
  static String build({
    String characterName = '',
    required String systemPrompt,
    required String basicInfo,
    required String personality,
    required String scenario,
    required String otherInfo,
    required String memoryText,
    String? timeContextStr,
  }) {
    final buffer = StringBuffer();

    // 1. 角色名称
    if (characterName.isNotEmpty) {
      buffer.writeln('## 角色名称\n$characterName\n');
    }

    // 2. 自定义系统提示词
    if (systemPrompt.isNotEmpty) {
      buffer.writeln('$systemPrompt\n');
    }

    // 3. 基本信息
    if (basicInfo.isNotEmpty) {
      buffer.writeln('## 基本信息\n$basicInfo\n');
    }

    // 4. 角色性格
    if (personality.isNotEmpty) {
      buffer.writeln('## 角色性格\n$personality\n');
    }

    // 5. 场景设定
    if (scenario.isNotEmpty) {
      buffer.writeln('## 场景设定\n$scenario\n');
    }

    // 6. 其他补充信息
    if (otherInfo.isNotEmpty) {
      buffer.writeln('## 其他补充信息\n$otherInfo\n');
    }

    // 7. 记忆（对齐主项目 buildSystemPrompt：normalizeMemoryContextText + 尾部空行）
    if (memoryText.isNotEmpty) {
      buffer.writeln('${normalizeMemoryContextText(memoryText)}\n');
    }

    // 8. 行为要求
    buffer.write('## 行为要求\n$_behaviorInstruction');

    // 9. 时间上下文
    if (timeContextStr != null && timeContextStr.isNotEmpty) {
      final trimmedTimeContext = timeContextStr.trim();
      if (trimmedTimeContext.startsWith('## Current Time')) {
        buffer.write('\n\n$trimmedTimeContext');
      } else {
        buffer.write('\n\n## Current Time\n$trimmedTimeContext');
      }
    }

    return buffer.toString();
  }
}
