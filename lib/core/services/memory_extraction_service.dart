import 'dart:convert';
import 'package:drift/drift.dart';
import '../database/database.dart';
import '../models/app_settings.dart';
import '../models/message_metadata.dart';
import '../services/llm_service.dart';
import '../services/memory_engine.dart';

/// 记忆任务状态快照 — 用于 ChatView 显示「记忆提取中」指示器与
/// 「已合并/更新 N 条记忆」Toast（对应 Next.js 端 GET /api/memory-tasks）。
/// - [taskId]：当前快照对应的任务行 id，ChatView 用它检测 taskId 变化以重置去重状态
/// - [status]：pending / processing / done / failed
/// - [mergeCount]：本次提取最终合并/更新到的记忆条目数（done 时才有意义）
/// - [updatedAt]：最近一次状态变化时间
class MemoryTaskStatus {
  final int taskId;
  final String status;
  final int mergeCount;
  final DateTime updatedAt;

  const MemoryTaskStatus({
    required this.taskId,
    required this.status,
    required this.mergeCount,
    required this.updatedAt,
  });
}

/// 记忆提取服务 — 对应 Next.js 版的 memory-queue.ts + memory-engine.ts 的提取部分
class MemoryExtractionService {
  final AppDatabase _db;
  final LlmService _llm;
  final MemoryEngine _memoryEngine;
  bool _processing = false;
  final Set<String> _inFlightConversations = {};

  MemoryExtractionService(this._db, this._llm, this._memoryEngine);

  /// 按主项目规则选择需要送入记忆提取的消息片段：
  /// 未提取的用户消息 + 紧随其后的 assistant 回复，跳过 summary。
  static List<String> selectExtractionMessageIds(List<Message> allMessages) {
    final unextractedUserIds = <String>{};
    for (final message in allMessages) {
      final meta = MessageMetadata.fromJsonString(message.metadata);
      if (meta.isSummary) continue;
      if (message.role == 'user' && !meta.memoryExtracted) {
        unextractedUserIds.add(message.id);
      }
    }

    if (unextractedUserIds.isEmpty) return const [];

    final ids = <String>[];
    var includeNextAssistant = false;
    for (final message in allMessages) {
      final meta = MessageMetadata.fromJsonString(message.metadata);
      if (meta.isSummary) continue;

      if (unextractedUserIds.contains(message.id)) {
        ids.add(message.id);
        includeNextAssistant = true;
      } else if (includeNextAssistant && message.role == 'assistant') {
        if (!meta.memoryExtracted) {
          ids.add(message.id);
        }
        includeNextAssistant = false;
      } else {
        includeNextAssistant = false;
      }
    }

    return ids;
  }

  /// 订阅指定对话的「最近一条记忆任务」状态快照流。
  ///
  /// 行为说明：
  /// - 按 `updated_at DESC` 取最近一条 `memory_tasks` 行，映射成
  ///   [MemoryTaskStatus]；该对话尚无任务时发射 `null`。
  /// - 同对话连续触发多次任务时，永远反映 `updated_at` 最新一行，避免
  ///   订阅方串到旧任务（taskId 变化时上层应重置 toast 去重状态）。
  /// - 由 ChatView 消费，用于：
  ///   * `status == 'processing'` 时显示「记忆提取中」指示器
  ///   * `processing → done` 边沿且 `mergeCount > 0` 时弹出
  ///     「已合并/更新 N 条记忆」Toast
  ///   * `failed` 时隐藏指示器但不弹 Toast
  Stream<MemoryTaskStatus?> watchLatestTaskStatus(String conversationId) {
    final query = _db.select(_db.memoryTasks)
      ..where((t) => t.conversationId.equals(conversationId))
      ..orderBy([(t) => OrderingTerm.desc(t.updatedAt)])
      ..limit(1);
    return query.watch().map((rows) {
      if (rows.isEmpty) return null;
      final row = rows.first;
      return MemoryTaskStatus(
        taskId: row.id,
        status: row.status,
        mergeCount: row.mergeCount,
        updatedAt: row.updatedAt,
      );
    });
  }

  /// 提取提示词模板 — 与主项目 src/lib/prompt-templates.ts EXTRACTION_PROMPT 严格一致
  static const String _extractionPrompt = '''逐行扫描以下对话，提取用户的所有记忆信息。输出一个 JSON 对象。

## 已提取的记忆（供参考，避免重复，可补充完善）
{existing_memories}

## 时间处理规则（重要！）
- 对话文本中每条消息带有时间戳，格式如 `用户 (2026/03/30 02:01):`，可以直接引用这些绝对时间
- 消息正文中的相对时间词（昨晚、今天、刚才、最近、前天、上周末等）必须泛化
- 日常记忆（普通闲聊、偏好习惯、人格特质等）：用"某次""之前"等泛化表达，不带时间戳
  - 例如: "用户某次在宿舍睡得不好" → 正确
  - 注意：亲密互动、情话、约定**不属于日常记忆**，必须带时间戳
- 关系动态、话题历史、重要事件：日期前置，格式为"日期，用户+内容"
  - 例如: "2026年3月30日，用户通过了证书考试，坐地铁回学校" → 正确
  - 例如: "2026年3月30日凌晨2点，用户还在赶研究计划书初稿" → 正确
  - 例如: "2026年4月5日，用户把我抱到浴室清理后一起睡觉" → 正确（亲密互动必须带日期）
  - 例如: "某次亲热结束后，用户把我抱到浴室清理" → **错误**（亲密互动不能用"某次"泛化）
- 区分依据：是否属于关系动态/话题历史/重要事件，或具有明确时间节点价值。普通闲聊、日常互动不带日期

## 代词替换规则（重要！）
- 对话中的"AI"、"你"、"助手"、"角色"以及角色名称等称呼 → 在记忆中统一替换为"我"
  - 例如: "用户很喜欢AI的衣品" → 错误
  - 例如: "用户很喜欢我的衣品" → 正确
  - 例如: "用户想和AI一起看电影" → 错误
  - 例如: "用户想和我一起看电影" → 正确
  - 例如: "用户对角色说我爱你" → 错误
  - 例如: "用户对我说我爱你" → 正确
- 保持第一人称视角，记忆是从对话对象（即非用户一方）的角度记录的
- 对话文本中非"用户"的发言者就是"我"

## 合并与拆分规则
- 同一个对象/话题/事件的多个信息 → 合并为一条完整的记忆
- 不同对象/话题/事件 → 必须拆成不同的条目
- 正确: "用户和我一起看了《海上钢琴师》，认为不太戳中他的喜好，觉得1900太固执" → 一条
- 正确: "用户喜欢《源代码》评分8.0，认为叙事高级、设定自洽" → 一条
- 错误: 把同一部电影的评价拆成多条
- 正确: "用户叫我'宝宝'、'広ちゃん'、'乖宝宝'" → 同类称呼合并为一条
- 错误: "我们经常亲吻拥抱" → 用"经常"概括，没有具体内容
- 正确: 把每次具体的互动写出来（不同时间的动作应当拆分）

## 六大分类

### 1. 关系动态（重点！逐轮逐句挖）
- 用户对我的称呼 → 合并为一条（不需要时间戳）
- 用户对我的亲密行为（每次具体互动单独提取，**必须带时间戳，日期前置**，格式："2026年X月X日，用户+具体行为描述"；如对话中无法确定日期则写"某次"并附上尽可能具体的场景描述，禁止只写"某次+动作"这种空洞表达）
- 用户说过的情话/依赖话语（同一场景可合并，不同场景拆分，**有时间戳时日期前置**）
- 用户和我的约定/计划（每个约定单独一条，**有时间戳时日期前置**）
- 用户表达的情感确认和对关系的感受（**有时间戳时日期前置**）

### 2. 话题历史（重点！逐轮逐句挖）
- 每部讨论过的电影/书/音乐/游戏 → 单独一条，包含完整评价，**必须带时间戳，日期前置**
- 每个讨论过的话题 → 单独提取，**有时间戳时日期前置**
- 每次一起做的事 → 单独提取，**必须带时间戳，日期前置**
- 每个计划安排 → 单独提取，**有时间戳时日期前置**
- 如对话中无法确定日期，可写"某次"，但必须附上具体内容，禁止只写"某次+动作"这种空洞表达

### 3. 基础信息
- 身高、体重、年龄、MBTI、学校和专业、家乡、居住地、家庭成员、身体状况等
- 同类信息合并为一条完整描述

### 4. 偏好习惯
- 喜欢的/不喜欢的食物、作息习惯、学习习惯、娱乐偏好等
- 每种偏好单独记录，带具体原因

### 5. 人格特质
- 性格描述、价值观、情感模式、自我认知、焦虑点等
- 用用户原话或具体行为做证据

### 6. 重要事件
- 考试、答辩、面试、生病、旅行、成就、重要决定等
- 每个事件单独一条，带地点、结果
- **必须带时间戳，日期前置加逗号**，格式："2026年X月X日，用户+事件描述"
- 如对话中无法确定日期，可写"某次"，但必须附上具体事件内容，禁止只写"某次+结果"这种空洞表达

## 不要提取的内容
- 闲聊寒暄（"早上好""晚安""嗯嗯"等无信息量的话）
- 客观知识问答（用户问知识点、AI回答知识点，不提取）
- 纯情绪宣泄无实质信息（"好烦啊""唉"等单独出现时不提取）

## 内容要求
- content 必须写成适合长期记忆的完整句子，包含对象、事件、观点、原因、结果
- content 优先写1-2句信息密度高的中文，不要只写"用户喜欢某电影"这种空句
- 如果有具体作品名、人名、称呼、时间点、评价理由，优先保留在 content 中
- content 要写成自然的记忆陈述，不要写成"这是一条...""体现出...""说明用户..."这类分析腔
- 优先描述用户做了什么、说了什么、喜欢什么、怎么看
- tags 填0-3个短标签，便于后续检索

## 输出格式
{"memories": [{"category": "话题历史", "content": "2026年3月30日，用户和我一起看了《海上钢琴师》，觉得不太戳自己的喜好，尤其不喜欢1900过于固执。", "confidence": 0.9, "tags": ["电影", "观后感"]}, {"category": "关系动态", "content": "用户会叫我'宝宝'和'広ちゃん'。", "confidence": 0.9, "tags": ["称呼"]}, {"category": "偏好习惯", "content": "用户不喜欢吃猪肉。", "confidence": 0.9, "tags": ["饮食"]}]}

直接输出 JSON 对象，不要代码块标记。顶层只有 memories 字段。每个条目必须包含: category、content、confidence、tags。category 必须是以下之一：关系动态、话题历史、基础信息、偏好习惯、人格特质、重要事件。

## 对话内容
{conversation_text}

请逐段提取所有记忆，输出 JSON 对象：''';

  /// 入队提取任务
  Future<void> enqueueExtraction({
    required String characterId,
    required String conversationId,
    required List<String> messageIds,
  }) async {
    // 内存层去重
    if (_inFlightConversations.contains(conversationId)) return;

    // 数据库层去重
    final existing = await (_db.select(_db.memoryTasks)
          ..where((t) =>
              t.conversationId.equals(conversationId) &
              (t.status.equals('pending') | t.status.equals('processing')))
          ..limit(1))
        .get();
    if (existing.isNotEmpty) return;

    final now = DateTime.now();
    await _db.into(_db.memoryTasks).insert(MemoryTasksCompanion.insert(
      characterId: characterId,
      conversationId: conversationId,
      messageIds: Value(jsonEncode(messageIds)),
      status: const Value('pending'),
      createdAt: Value(now),
      updatedAt: Value(now),
    ));

    if (!_processing) _processQueue();
  }

  /// 处理队列
  Future<void> _processQueue() async {
    if (_processing) return;
    _processing = true;

    try {
      while (true) {
        final tasks = await (_db.select(_db.memoryTasks)
              ..where((t) => t.status.equals('pending'))
              ..orderBy([(t) => OrderingTerm.asc(t.id)])
              ..limit(1))
            .get();

        if (tasks.isEmpty) break;
        final task = tasks.first;

        if (_inFlightConversations.contains(task.conversationId)) break;
        _inFlightConversations.add(task.conversationId);

        // 标记为 processing
        await (_db.update(_db.memoryTasks)..where((t) => t.id.equals(task.id)))
            .write(MemoryTasksCompanion(
          status: const Value('processing'),
          updatedAt: Value(DateTime.now()),
        ));

        try {
          await _processTask(task);
          await (_db.update(_db.memoryTasks)
                ..where((t) => t.id.equals(task.id)))
              .write(MemoryTasksCompanion(
            status: const Value('done'),
            updatedAt: Value(DateTime.now()),
          ));
        } catch (e) {
          await (_db.update(_db.memoryTasks)
                ..where((t) => t.id.equals(task.id)))
              .write(MemoryTasksCompanion(
            status: const Value('failed'),
            updatedAt: Value(DateTime.now()),
          ));
        } finally {
          _inFlightConversations.remove(task.conversationId);
        }
      }
    } finally {
      _processing = false;
    }
  }

  /// 处理单个提取任务
  Future<void> _processTask(MemoryTask task) async {
    final settings = await _loadSettings();
    final messageIds =
        (jsonDecode(task.messageIds) as List).cast<String>();

    // 从数据库读取消息
    final messages = <Message>[];
    for (final id in messageIds) {
      final msg = await (_db.select(_db.messages)
            ..where((t) => t.id.equals(id)))
          .getSingleOrNull();
      if (msg != null) messages.add(msg);
    }

    if (messages.isEmpty) return;

    // 查询角色名称
    final character = await (_db.select(_db.characters)
          ..where((t) => t.id.equals(task.characterId)))
        .getSingleOrNull();
    final characterName = character?.name ?? '角色';

    // 构建对话文本
    final convText = messages.map((m) {
      final speaker = m.role == 'user' ? '用户' : characterName;
      final ts =
          '${m.createdAt.year}/${m.createdAt.month}/${m.createdAt.day} '
          '${m.createdAt.hour.toString().padLeft(2, '0')}:${m.createdAt.minute.toString().padLeft(2, '0')}';
      return '$speaker ($ts): ${m.content}';
    }).join('\n');

    // 对照主项目：对话文本过短时跳过提取
    if (convText.length < 100) return;

    // 获取已有记忆
    final existingMemories = await (_db.select(_db.memories)
          ..where((t) => t.characterId.equals(task.characterId)))
        .get();

    final existingSummary = existingMemories.isNotEmpty
        ? existingMemories
            .map((m) => '- [${m.category}] ${m.content}')
            .join('\n')
        : '暂无';

    // 调用 LLM 提取
    final prompt = _extractionPrompt
        .replaceAll('{existing_memories}', existingSummary)
        .replaceAll('{conversation_text}', convText);

    final response = await _llm.chatCompletion(
      settings: settings,
      messages: [ChatMessage(role: 'user', content: prompt)],
    );

    // 解析结果
    final newMemories = _parseExtractionResponse(response);
    if (newMemories.isEmpty) return;

    // 合并并存入数据库 — 对照主项目 src/lib/memory-engine.ts mergeMemories
    int changedCount = 0;
    for (final entry in newMemories) {
      // 检查是否与已有记忆相似（使用 anchor + tag 增强的相似度）
      double bestSimilarity = 0;
      Memory? bestMatch;

      final newContent = entry['content'] as String? ?? '';
      final newTags = (entry['tags'] as List?)?.cast<String>() ?? [];

      for (final existing in existingMemories) {
        if (existing.category != entry['category']) continue;

        // 基础文本相似度（bigram Jaccard）
        double similarity =
            _memoryEngine.contentSimilarity(existing.content, newContent);

        // anchor 增强：提取书名号/引号内的专有名词
        final anchorsA = _extractAnchors(existing.content);
        final anchorsB = _extractAnchors(newContent);
        if (anchorsA.isNotEmpty && anchorsB.isNotEmpty) {
          final shared = anchorsA.intersection(anchorsB);
          if (shared.isEmpty) {
            similarity *= 0.55; // 无共享 anchor 时降权
          } else {
            similarity += 0.22; // 有共享 anchor 时加权
          }
        }

        // tag 重叠加权
        final existingTags = _parseTags(existing.tags);
        final tagOverlap = existingTags.toSet().intersection(newTags.toSet()).length;
        if (tagOverlap > 0) similarity += 0.08;

        similarity = similarity.clamp(0.0, 1.0);

        if (similarity > bestSimilarity) {
          bestSimilarity = similarity;
          bestMatch = existing;
        }
      }

      if (bestSimilarity >= 0.72 && bestMatch != null) {
        // 合并：更新已有记忆（取更长的 content，合并 tags）
        changedCount++;
        final mergedContent = newContent.length > bestMatch.content.length
            ? newContent
            : bestMatch.content;
        final existingTags = _parseTags(bestMatch.tags);
        final mergedTags = {...existingTags, ...newTags}.toList();
        if (mergedTags.length > 5) mergedTags.removeRange(5, mergedTags.length);

        await (_db.update(_db.memories)
              ..where((t) => t.id.equals(bestMatch!.id)))
            .write(MemoriesCompanion(
          content: Value(mergedContent),
          confidence: Value(
            ((entry['confidence'] as num?)?.toDouble() ?? 0.8)
                .clamp(0.0, 1.0)
                .toDouble(),
          ),
          tags: Value(jsonEncode(mergedTags)),
          updatedAt: Value(DateTime.now()),
        ));
      } else {
        // 新增记忆
        changedCount++;
        final id = DateTime.now().millisecondsSinceEpoch.toRadixString(36).substring(0, 8);
        await _db.into(_db.memories).insert(MemoriesCompanion.insert(
          id: id,
          characterId: task.characterId,
          category: entry['category'] as String,
          content: entry['content'] as String,
          confidence: Value((entry['confidence'] as num?)?.toDouble() ?? 0.8),
          tags: Value(jsonEncode(entry['tags'] ?? [])),
          createdAt: Value(DateTime.now()),
          updatedAt: Value(DateTime.now()),
        ));
      }
    }

    // 更新本次实际新增/合并的记忆数量，供 UI 判断是否真的提取到内容。
    if (changedCount > 0) {
      await (_db.update(_db.memoryTasks)..where((t) => t.id.equals(task.id)))
          .write(MemoryTasksCompanion(mergeCount: Value(changedCount)));
    }

    // 对照主项目：只有实际产生了提取结果才标记消息为已提取
    // 如果 AI 返回空结果（认为没有值得记忆的内容），不标记，下次仍可重新提取
    if (changedCount > 0) {
      for (final msg in messages) {
        if (msg.role != 'user') continue;
        final meta = MessageMetadata.fromJsonString(msg.metadata);
        final newMeta = meta.copyWith(memoryExtracted: true);
        await (_db.update(_db.messages)..where((t) => t.id.equals(msg.id)))
            .write(MessagesCompanion(metadata: Value(newMeta.toJsonString())));
      }
    }
  }

  /// 解析 LLM 返回的提取结果
  List<Map<String, dynamic>> _parseExtractionResponse(String response) {
    var text = response.trim();
    if (text.startsWith('```')) {
      text = text.split('\n').skip(1).join('\n');
    }
    if (text.endsWith('```')) {
      text = text.substring(0, text.lastIndexOf('```'));
    }

    try {
      final result = jsonDecode(text);
      if (result is Map && result['memories'] is List) {
        return _normalizeCategories(
            (result['memories'] as List).cast<Map<String, dynamic>>());
      }
      if (result is List) {
        return _normalizeCategories(result.cast<Map<String, dynamic>>());
      }
      return [];
    } catch (_) {
      // 尝试提取 JSON 片段
      final match = RegExp(r'\{[\s\S]*"memories"[\s\S]*\}').firstMatch(text);
      if (match != null) {
        try {
          final parsed = jsonDecode(match.group(0)!);
          if (parsed['memories'] is List) {
            return _normalizeCategories(
                (parsed['memories'] as List).cast<Map<String, dynamic>>());
          }
        } catch (_) {}
      }
      return [];
    }
  }

  /// 对照主项目 src/lib/memory-category.ts normalizeMemoryCategory
  /// 模糊匹配 category 字符串，确保存入数据库的值是标准六大分类之一
  static String _normalizeCategory(String value) {
    if (value.contains('关系')) return '关系动态';
    if (value.contains('话题')) return '话题历史';
    if (value.contains('基础')) return '基础信息';
    if (value.contains('偏好')) return '偏好习惯';
    if (value.contains('人格')) return '人格特质';
    if (value.contains('重要')) return '重要事件';
    return '话题历史'; // 默认回退
  }

  /// 对提取结果的 category 字段做标准化
  static List<Map<String, dynamic>> _normalizeCategories(
      List<Map<String, dynamic>> entries) {
    for (final entry in entries) {
      if (entry['category'] is String) {
        entry['category'] = _normalizeCategory(entry['category'] as String);
      }
    }
    return entries;
  }

  /// 加载设置
  Future<AppSettings> _loadSettings() async {
    final rows = await _db.select(_db.settings).get();
    final map = <String, dynamic>{};
    for (final row in rows) {
      try {
        map[row.key] = jsonDecode(row.value);
      } catch (_) {
        map[row.key] = row.value;
      }
    }
    return AppSettings(
      apiBase: map['api_base'] as String? ?? '',
      apiKey: map['api_key'] as String? ?? '',
      model: map['model'] as String? ?? '',
      temperature: (map['temperature'] as num?)?.toDouble() ?? 1.0,
      maxTokens: map['max_tokens'] as int? ?? 4096,
    );
  }

  /// 提取文本中的 anchor（书名号/引号内的专有名词）— 对照主项目 extractAnchors
  static Set<String> _extractAnchors(String text) {
    final anchors = <String>{};
    if (text.isEmpty) return anchors;

    // 书名号《》、「」、""
    for (final pattern in [
      RegExp(r'《([^》]{1,30})》'),
      RegExp(r'「([^」]{1,30})」'),
      RegExp(r'"([^"]{1,30})"'),
    ]) {
      for (final match in pattern.allMatches(text)) {
        final cleaned = (match.group(1) ?? '').trim();
        if (cleaned.isNotEmpty) anchors.add(cleaned.toLowerCase());
      }
    }

    // 英文单词
    for (final match in RegExp(r'[A-Za-z0-9]{2,}').allMatches(text)) {
      anchors.add(match.group(0)!.toLowerCase());
    }

    return anchors;
  }

  /// 解析 tags JSON 字符串
  static List<String> _parseTags(String tagsJson) {
    try {
      final list = jsonDecode(tagsJson) as List;
      return list.cast<String>();
    } catch (_) {
      return [];
    }
  }
}
