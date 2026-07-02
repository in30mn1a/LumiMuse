import 'dart:async';
import 'dart:convert';
import 'package:drift/drift.dart';
import 'package:flutter/foundation.dart';
import 'package:uuid/uuid.dart';
import '../database/database.dart';
import '../models/app_settings.dart';
import '../models/message_metadata.dart';
import '../services/llm_service.dart';
import '../services/memory_candidates_service.dart';
import '../services/memory_engine.dart';
import '../services/secret_storage_service.dart';

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

/// 提取响应解析结果 — [_parseExtractionResponse] 的返回结构。
/// - [items]：解析成功并经 [MemoryEngine.calibrateRawMemoryItem] 校准后的记忆列表
///   （空数组表示解析成功但无有效记忆）。
/// - [parseFailed]：true=完全解析失败（找不到 JSON 块 / JSON 解析异常 / 顶层
///   非 memories 对象或数组）；false=解析成功（含空数组）。
/// - [errorReason]：parseFailed=true 时的失败原因，用于写候选表的 error_reason。
class _ExtractionParseResult {
  final List<Map<String, dynamic>> items;
  final bool parseFailed;
  final String? errorReason;

  const _ExtractionParseResult({
    this.items = const [],
    this.parseFailed = false,
    this.errorReason,
  });
}

/// 记忆提取服务 — 对应 Next.js 版的 memory-queue.ts + memory-engine.ts 的提取部分
class MemoryExtractionService {
  final AppDatabase _db;
  final LlmService _llm;
  final MemoryEngine _memoryEngine;
  /// 候选修复服务 — 解析失败/无有效记忆时把原始响应写入候选表，供 UI 修复。
  /// 默认内部 new 一个，保持 chat_provider.dart 行 1574 调用兼容；
  /// 测试可注入 null 跳过候选写入，或注入 mock 验证调用。
  final MemoryCandidatesService? _candidatesService;
  /// 安全存储适配，用于解析 DB 里 `secret://api-key/...` 引用为真实 key。
  /// 默认内部 new 一个；测试可注入 mock 验证解析路径。
  final SecretStorageService _secretStorage;
  bool _processing = false;
  final Set<String> _inFlightConversations = {};
  static const _uuid = Uuid();

  MemoryExtractionService(
    this._db,
    this._llm,
    this._memoryEngine, {
    MemoryCandidatesService? candidatesService,
    SecretStorageService? secretStorage,
  })  : _candidatesService = candidatesService ??
            MemoryCandidatesService(_db, _memoryEngine),
        _secretStorage = secretStorage ?? SecretStorageService();

  /// 启动时清理上一次运行残留的 memory_tasks。
  ///
  /// 修复用户反馈："记忆提取卡住了…重开软件也不行"。
  ///
  /// 触发场景：用户手动选了几十条消息触发提取，单次 LLM 请求耗时极长，
  /// 期间 App 被切到后台被系统杀掉 / 用户手动结束进程 / 网络层异常未冒泡到
  /// `_processTask` 的 try 内。结果 `memory_tasks` 行卡在 `processing`，重启
  /// 后内存队列状态全丢，[enqueueExtraction] 的 DB 去重 guard 会因为存在
  /// `pending`/`processing` 行而把后续的所有手动触发静默吞掉，UI 上的
  /// 「提取中」按钮永久无法解除。
  ///
  /// 修复策略：App 启动时（`databaseProvider` 一次性调用）把所有未完成的
  /// `memory_tasks` 行强制翻成 `failed`。这些行此时一定是孤儿——内存里的
  /// `_inFlightConversations` / `_processing` 还是初始空状态，没有任何
  /// service 实例真在驱动它们。翻成 `failed` 后：
  /// - UI 状态指示器自然回到 idle / failed 短暂提示；
  /// - 下次手动触发能正常入队、正常推进。
  ///
  /// 静态方法，只读 DB，不需要 LlmService / MemoryEngine 即可调用。
  static Future<int> recoverStaleTasksOnStartup(AppDatabase db) async {
    final now = DateTime.now();
    return (db.update(db.memoryTasks)
          ..where((t) =>
              t.status.equals('pending') | t.status.equals('processing')))
        .write(MemoryTasksCompanion(
      status: const Value('failed'),
      updatedAt: Value(now),
    ));
  }

  /// 自上次状态推进以来超过该阈值的 `pending`/`processing` 行视为孤儿。
  ///
  /// `LlmService` 的 dio receiveTimeout 是 5 分钟，给 1 倍冗余取 10 分钟，
  /// 既保证正常长请求不会被误杀，也避免真有卡死的行永远占着去重 guard。
  static const Duration _stalenessThreshold = Duration(minutes: 10);


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

  /// 提取提示词模板 — 对齐主项目 src/lib/prompt-templates.ts 七类提取提示词
  /// （七大分类含「四季日常」+ memory_kind/importance/emotional_weight/lifecycle_action
  ///   完整字段 + 防污染规则）
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

## 七大分类

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

### 7. 四季日常
- 用户日常生活的琐碎记录：天气、饮食、睡眠、散步、家务、通勤等
- **必须有时间戳，日期前置**，格式："2026年X月X日，用户+日常描述"
- 合并同类日常：如"2026年5月30日，用户一觉睡到下午一点半才自然醒"
- 低信息密度的日常生活片段归入此类，不要和重要事件混淆
- 注意：有长期价值的习惯/偏好仍归"偏好习惯"，不归四季日常

## 不要提取的内容
- 闲聊寒暄（"早上好""晚安""嗯嗯"等无信息量的话）
- 客观知识问答（用户问知识点、AI回答知识点，不提取）
- 纯情绪宣泄无实质信息（"好烦啊""唉"等单独出现时不提取）

## 防污染规则
- 角色说"我会记得"、"我不会忘"、"以后我会"本身不是记忆内容，只能保存它承诺记住或承诺执行的具体对象
- 角色承诺、边界、以后会怎么陪伴用户，memory_kind 必须写 character_promise，不要写成 user_fact
- 如果角色凭空承诺了用户没有表达过的事实，不能把这个虚构事实写成用户记忆；只能在确有承诺价值时写成 character_promise
- 用户事实、用户偏好和角色承诺必须分开写，不要混在同一条 content 里

## 内容要求
- content 必须写成适合长期记忆的完整句子，包含对象、事件、观点、原因、结果
- content 优先写1-2句信息密度高的中文，不要只写"用户喜欢某电影"这种空句
- 如果有具体作品名、人名、称呼、时间点、评价理由，优先保留在 content 中
- content 要写成自然的记忆陈述，不要写成"这是一条...""体现出...""说明用户..."这类分析腔
- 优先描述用户做了什么、说了什么、喜欢什么、怎么看
- tags 填0-3个短标签，便于后续检索

## memory_kind 规则
- general：普通话题历史或无法归入其他类型的记忆
- user_fact：用户基础信息、人格特质、长期背景
- user_preference：用户偏好、习惯、边界、喜欢/不喜欢的陪伴方式
- relationship_event：关系变化、共同经历、重要互动、重要事件
- character_promise：角色自己的承诺、约定、以后要兑现的陪伴方式
- open_thread：未完成事项、后续需要继续跟进的话题
- world_state：角色世界观或长期状态变化

## 重要性与情绪权重
- importance 和 emotional_weight 都是 0 到 1 的数字
- 承诺、禁忌、关系变化、冲突和解：importance 至少 0.8
- 普通话题历史：importance 不超过 0.6
- 情绪强、关系强、需要长期兑现的内容 emotional_weight 较高
- 一次性闲聊、低信息密度内容不要入库

## 输出格式
{"memories": [{"category": "话题历史", "memory_kind": "general", "content": "2026年3月30日，用户和我一起看了《海上钢琴师》，觉得不太戳自己的喜好，尤其不喜欢1900过于固执。", "tags": ["电影", "观后感"], "importance": 0.55, "emotional_weight": 0.2, "lifecycle_action": "upsert"}, {"category": "关系动态", "memory_kind": "relationship_event", "content": "用户会叫我'宝宝'和'広ちゃん'。", "tags": ["称呼"], "importance": 0.75, "emotional_weight": 0.6, "lifecycle_action": "upsert"}, {"category": "关系动态", "memory_kind": "character_promise", "content": "我承诺以后用户难过时，会先安抚和陪伴，再讨论问题。", "tags": ["承诺", "陪伴方式"], "importance": 0.9, "emotional_weight": 0.85, "lifecycle_action": "upsert"}]}

直接输出 JSON 对象，不要代码块标记。顶层只有 memories 字段。每个条目必须包含: category、memory_kind、content、tags、importance、emotional_weight、lifecycle_action。category 必须是以下之一：关系动态、话题历史、基础信息、偏好习惯、人格特质、重要事件、四季日常。memory_kind 必须是以下之一：general、user_fact、user_preference、relationship_event、character_promise、open_thread、world_state。lifecycle_action 第一版只用 insert、upsert、supersede、ignore；不确定时用 upsert。

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

    // 防御性恢复：把同一对话上 updated_at 已经过期的 pending/processing 行
    // 翻成 failed，避免上次运行卡住的孤儿行永远霸占下面的去重 guard。
    // 与 [recoverStaleTasksOnStartup] 是两层互补：那一处覆盖"App 重启"，
    // 这里覆盖"运行中崩溃但 App 没重启"或"启动恢复来得太晚"的场景。
    final staleCutoff = DateTime.now().subtract(_stalenessThreshold);
    await (_db.update(_db.memoryTasks)
          ..where((t) =>
              t.conversationId.equals(conversationId) &
              (t.status.equals('pending') | t.status.equals('processing')) &
              t.updatedAt.isSmallerThanValue(staleCutoff)))
        .write(MemoryTasksCompanion(
      status: const Value('failed'),
      updatedAt: Value(DateTime.now()),
    ));

    // 数据库层去重 — SELECT + INSERT 必须在同一事务内原子执行，
    // 对齐主项目 memory-queue.ts:103-114 的 TOCTOU 保护：避免两个并发
    // enqueueExtraction 同时观测到「无 pending/processing 行」后各自 INSERT，
    // 产生两条 pending 任务行（队列虽能串行消费，但去重 guard 失效会污染
    // 状态指示器与计数）。
    final now = DateTime.now();
    await _db.transaction(() async {
      final existing = await (_db.select(_db.memoryTasks)
            ..where((t) =>
                t.conversationId.equals(conversationId) &
                (t.status.equals('pending') | t.status.equals('processing')))
            ..limit(1))
          .get();
      if (existing.isNotEmpty) return;

      await _db.into(_db.memoryTasks).insert(MemoryTasksCompanion.insert(
        characterId: characterId,
        conversationId: conversationId,
        messageIds: Value(jsonEncode(messageIds)),
        status: const Value('pending'),
        createdAt: Value(now),
        updatedAt: Value(now),
      ));
    });

    if (!_processing) unawaited(_processQueue());
  }

  /// 处理队列
  ///
  /// FIX(C5): 修复 enqueueExtraction 与 _processQueue 之间的竞态：
  /// - A 调用 `enqueueExtraction` 写入新任务后，检查 `_processing == true` 而跳过启动；
  /// - B 此时正处于 `_processQueue` 末尾，刚好走完最后一次 select 拿到空列表 break
  ///   出 while，但还未把 `_processing` 置回 false（或刚置回但 A 已观测过 true）。
  /// - 结果：A 的新任务卡在 pending，永远没人触发下一轮处理。
  ///
  /// 修复思路：finally 把 `_processing` 置回 false 后，再做一次 pending 探测；
  /// 若仍有 pending 任务，则 `unawaited(_processQueue())` 启动新一轮。
  /// 新一轮内部仍然会用 `if (_processing) return` 守门，配合事件循环让出，
  /// 不会形成同步无限递归。
  Future<void> _processQueue() async {
    if (_processing) return;
    _processing = true;

    try {
      while (true) {
        // SQL 层直接排除 inFlight 对话（对齐主项目 memory-queue.ts:154-160）：
        // 取下一条 pending 任务时附带 `conversation_id NOT IN (_inFlightConversations)`，
        // 这样 inFlight 中的对话自然不会被选出来，避免「命中 inFlight 后 break
        // 退出整个 while」导致其他对话的 pending 任务被一同阻塞。
        // _inFlightConversations 为空时 isNotIn([]) 等价于无条件，不影响首轮。
        final tasks = await (_db.select(_db.memoryTasks)
              ..where((t) =>
                  t.status.equals('pending') &
                  t.conversationId.isNotIn(_inFlightConversations.toList()))
              ..orderBy([(t) => OrderingTerm.asc(t.id)])
              ..limit(1))
            .get();

        if (tasks.isEmpty) break;
        final task = tasks.first;

        // SQL 已过滤 inFlight 对话，理论上这里不会命中；保留 continue 作兜底，
        // 万一 SQL 与内存集合在边界时机不一致也不至于退出整个 while。
        if (_inFlightConversations.contains(task.conversationId)) continue;
        _inFlightConversations.add(task.conversationId);

        // 标记为 processing —— 同步写 started_at（毫秒级时间戳，记录进入 processing 的时间）
        // 对齐主项目 memory-queue.ts 的任务追踪字段，便于后续「卡死自愈」按时间阈值判定孤儿。
        final processingAt = DateTime.now();
        await (_db.update(_db.memoryTasks)..where((t) => t.id.equals(task.id)))
            .write(MemoryTasksCompanion(
          status: const Value('processing'),
          startedAt: Value(processingAt.millisecondsSinceEpoch),
          updatedAt: Value(processingAt),
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
          // 失败时写 error_message，截断到 1000 字符避免 DB 体积膨胀
          // （LLM 异常堆栈或超长响应可能上千行）。
          final errorStr = e.toString();
          final truncatedError = errorStr.length > 1000
              ? errorStr.substring(0, 1000)
              : errorStr;
          await (_db.update(_db.memoryTasks)
                ..where((t) => t.id.equals(task.id)))
              .write(MemoryTasksCompanion(
            status: const Value('failed'),
            errorMessage: Value(truncatedError),
            updatedAt: Value(DateTime.now()),
          ));
        } finally {
          _inFlightConversations.remove(task.conversationId);
        }
      }
    } finally {
      _processing = false;

      // FIX(C5): 关闭 enqueue/_processQueue 之间的窗口期。
      // 走到这里说明当前轮次已退出 while；如果在 break 与本行之间
      // 有新任务被 enqueue（其当时观测到 _processing == true 直接返回，
      // 不会触发新一轮），需要由我们自己再检查并重新启动一轮处理。
      try {
        final pending = await (_db.select(_db.memoryTasks)
              ..where((t) => t.status.equals('pending'))
              ..limit(1))
            .get();
        if (pending.isNotEmpty) {
          // 用 unawaited 避免阻塞 finally 链；新一轮内部以
          // `if (_processing) return` 守门，不会形成同步递归。
          unawaited(_processQueue());
        }
      } catch (_) {
        // 探测失败不影响主流程；下一次 enqueueExtraction 仍会再次驱动队列。
      }
    }
  }

  /// 处理单个提取任务
  Future<void> _processTask(MemoryTask task) async {
    final settings = await _loadSettings();
    final messageIds =
        (jsonDecode(task.messageIds) as List).map((e) => e.toString()).toList();

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

    // FIX(Major-6): 强制 jsonMode 提取记忆。
    // 提示词要求模型直接输出形如 `{"memories":[...]}` 的 JSON 对象，
    // 但默认 settings.jsonMode 跟随用户聊天配置（多数情况下为 false），
    // 模型可能返回带 ``` 代码块标记或附加解释的文本，导致下游
    // _parseExtractionResponse 兜底解析失败、记忆提取静默丢失。
    // 这里在 settings 上 clone 一份只对本次调用生效的 jsonMode=true，
    // 既保证 OpenAI 兼容 API 在支持 response_format 时返回严格 JSON，
    // 也不污染用户的全局设置。
    final extractionSettings = settings.copyWith(jsonMode: true);

    final response = await _llm.chatCompletion(
      settings: extractionSettings,
      messages: [ChatMessage(role: 'user', content: prompt)],
    );

    // 解析结果
    final parseResult = _parseExtractionResponse(response);
    final newMemories = parseResult.items;
    if (newMemories.isEmpty) {
      // 解析失败/无有效记忆 → 写候选。对照主项目 memory-engine.ts
      // extractMemoriesFromConversation 内 insertCandidate 调用点：
      // parseFailed=true → status='repairable'（UI 可修复）；
      // parseFailed=false 但 items 空 → status='ignored'（空 memories 数组，无需修复）。
      await _candidatesService?.insertCandidate(
        characterId: task.characterId,
        options: ExtractMemoryOptions(
          taskId: task.id,
          conversationId: task.conversationId,
        ),
        rawResponse: response,
        status: parseResult.parseFailed ? 'repairable' : 'ignored',
        errorReason: parseResult.errorReason ?? '无有效记忆可提取',
      );
      return;
    }

    // 合并并存入数据库 — 对照主项目 src/lib/memory-engine.ts mergeMemories
    //
    // 事务包裹整个写入循环（含所有 supersede / upsert / insert 分支）以及紧随其后的
    // mergeCount 写入（spec Task 15）：保证「一批提取结果要么全部落库要么全部回滚」，
    // 避免 supersede 命中后 INSERT 新记忆成功、UPDATE 旧记忆 status='superseded'
    // 失败时出现「新旧记忆并存」的污染态。循环内只有 DB 操作（含
    // findSimilarExistingMemories 的查询），无 LLM 调用等外部资源，可安全放进事务。
    int changedCount = 0;
    await _db.transaction(() async {
      for (final entry in newMemories) {
      // supersede 分支：LLM 在 entry 上带 lifecycle_action='supersede' 时，
      // 先查找相似旧记忆；命中则把旧记忆翻 status='superseded' 并在 metadata
      // 上写 supersededBy=<新记忆 id>，再 INSERT 新记忆（spec Task 9）。
      // 未命中或 lifecycle_action 缺失 / = 'insert' 时走下方原有合并 / 插入流程。
      final lifecycleAction =
          (entry['lifecycle_action'] as String?) ?? 'insert';
      if (lifecycleAction == 'supersede') {
        final candidateContent = entry['content'] as String? ?? '';
        final target = await _memoryEngine.findSimilarExistingMemories(
          task.characterId,
          candidateContent,
        );
        if (target != null) {
          // 命中：先 INSERT 新记忆拿到 id，再 UPDATE 旧记忆写 metadata.supersededBy。
          // 新记忆显式 status='active'，不依赖列默认值（spec SubTask 9.3）
          final newId = _uuid.v4();
          await _db.into(_db.memories).insert(MemoriesCompanion.insert(
            id: newId,
            characterId: task.characterId,
            category: entry['category'] as String,
            content: candidateContent,
            confidence:
                Value((entry['confidence'] as num?)?.toDouble() ?? 0.8),
            tags: Value(jsonEncode(entry['tags'] ?? [])),
            // 落库 calibrateRawMemoryItem 校准出的字段（FIX：supersede 分支
            // 此前丢弃这些字段，导致承诺记忆 importance 退化为列默认 0.5）
            memoryKind:
                Value(entry['memory_kind'] as String? ?? 'general'),
            importance: Value(
                (entry['importance'] as num?)?.toDouble() ?? 0.5),
            emotionalWeight: Value(
                (entry['emotional_weight'] as num?)?.toDouble() ?? 0),
            sourceMsgIds: Value(jsonEncode(messageIds)),
            status: const Value('active'),
            createdAt: Value(DateTime.now()),
            updatedAt: Value(DateTime.now()),
          ));
          changedCount++;

          // UPDATE 旧记忆：status='superseded' + metadata.supersededBy=<newId>
          // （metadata 是 JSON 字符串，需要读出 → 修改 → 写回，spec SubTask 9.2）
          final oldMetadata = _readMetadata(target.metadata);
          oldMetadata['supersededBy'] = newId;
          await (_db.update(_db.memories)
                ..where((t) => t.id.equals(target.id)))
              .write(MemoriesCompanion(
            status: const Value('superseded'),
            metadata: Value(_writeMetadata(oldMetadata)),
            updatedAt: Value(DateTime.now()),
          ));
          continue;
        }
        // 未命中目标：退化为普通 insert（落到下方"新增记忆"分支，spec SubTask 9.4）
      }

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

      // 动态阈值：以两条记忆中较短的一方判定，避免长记忆带短记忆"蹭过"阈值
      // （对照主项目 src/lib/memory-engine.ts:274-277）
      if (bestMatch != null &&
          bestSimilarity >=
              _mergeThreshold(newContent.length < bestMatch.content.length
                  ? newContent.length
                  : bestMatch.content.length)) {
        // 合并：更新已有记忆（取更长的 content，合并 tags）
        final mergedContent = newContent.length > bestMatch.content.length
            ? newContent
            : bestMatch.content;
        final existingTags = _parseTags(bestMatch.tags);
        final mergedTags = {...existingTags, ...newTags}.toList();
        if (mergedTags.length > 5) mergedTags.removeRange(5, mergedTags.length);

        final newConfidence = ((entry['confidence'] as num?)?.toDouble() ?? 0.8)
            .clamp(0.0, 1.0)
            .toDouble();

        // 检查是否真的发生了修改以避免多余的更新和错误的计数（与主项目 bdc8c01ead5a1ee8bb640a45eacb01d9e6d77d5f 严格一致）
        final isChanged = mergedContent != bestMatch.content ||
            newConfidence != bestMatch.confidence ||
            jsonEncode(mergedTags) != bestMatch.tags;

        if (isChanged) {
          changedCount++;
          await (_db.update(_db.memories)
                ..where((t) => t.id.equals(bestMatch!.id)))
              .write(MemoriesCompanion(
            content: Value(mergedContent),
            confidence: Value(newConfidence),
            tags: Value(jsonEncode(mergedTags)),
            updatedAt: Value(DateTime.now()),
          ));
        }
      } else {
        // 新增记忆
        changedCount++;
        // 使用完整 UUID v4，避免同毫秒内 ID 碰撞
        final id = _uuid.v4();
        await _db.into(_db.memories).insert(MemoriesCompanion.insert(
          id: id,
          characterId: task.characterId,
          category: entry['category'] as String,
          content: entry['content'] as String,
          confidence: Value((entry['confidence'] as num?)?.toDouble() ?? 0.8),
          tags: Value(jsonEncode(entry['tags'] ?? [])),
          // 落库 calibrateRawMemoryItem 校准出的字段（与 supersede 分支一致）
          memoryKind: Value(entry['memory_kind'] as String? ?? 'general'),
          importance:
              Value((entry['importance'] as num?)?.toDouble() ?? 0.5),
          emotionalWeight:
              Value((entry['emotional_weight'] as num?)?.toDouble() ?? 0),
          sourceMsgIds: Value(jsonEncode(messageIds)),
          createdAt: Value(DateTime.now()),
          updatedAt: Value(DateTime.now()),
        ));
      }
      }

      // 更新本次实际新增/合并的记忆数量，供 UI 判断是否真的提取到内容。
      // 与写入循环同事务：循环回滚时 mergeCount 也不应被写入，避免「0 条结果
      // 却显示 N 条」的不一致。
      if (changedCount > 0) {
        await (_db.update(_db.memoryTasks)..where((t) => t.id.equals(task.id)))
            .write(MemoryTasksCompanion(mergeCount: Value(changedCount)));
      }
    });

    // 不论是否提取到记忆，本批消息扫描完成后均标记为已提取，
    // 避免无营养闲聊（changedCount == 0）被反复送给 LLM 造成 Token 浪费。
    for (final msg in messages) {
      if (msg.role != 'user') continue;
      final meta = MessageMetadata.fromJsonString(msg.metadata);
      final newMeta = meta.copyWith(memoryExtracted: true);
      await (_db.update(_db.messages)..where((t) => t.id.equals(msg.id)))
          .write(MessagesCompanion(metadata: Value(newMeta.toJsonString())));
    }
  }

  /// 解析 LLM 返回的提取结果
  ///
  /// 改写为基于 [MemoryEngine.findBalancedJsonSnippet] 的平衡花括号扫描，
  /// 替代旧的「先直接 parse 失败再走贪婪正则」逻辑：
  /// - 贪婪正则 `\{[\s\S]*"memories"[\s\S]*\}` 会越过第一个 `}` 后续出现的
  ///   内容，遇到带 markdown 代码块或前后解释文本时会误把多段 JSON 拼成一个
  ///   无法解析的字符串；findBalancedJsonSnippet 考虑字符串字面量与转义，
  ///   在多个完整候选块中优先返回含 `"memories"` 字段的块，更稳健。
  /// - 解析出的每条记忆在返回前调用 [MemoryEngine.calibrateRawMemoryItem]
  ///   做承诺信号词校准（memory_kind/importance/emotional_weight/category）。
  ///
  /// 返回 [_ExtractionParseResult]：
  /// - findBalancedJsonSnippet 返回 null → parseFailed=true
  /// - jsonDecode 抛异常 → parseFailed=true
  /// - 顶层非 Map/List 或 Map 无 memories 字段 → parseFailed=true
  /// - 解析成功（含空数组）→ parseFailed=false，items 可能为空
  _ExtractionParseResult _parseExtractionResponse(String response) {
    final snippet = MemoryEngine.findBalancedJsonSnippet(response);
    if (snippet == null) {
      return const _ExtractionParseResult(
        parseFailed: true,
        errorReason: '无法找到 JSON 代码块',
      );
    }
    try {
      final decoded = jsonDecode(snippet);
      List<Map<String, dynamic>> items;
      if (decoded is Map && decoded['memories'] is List) {
        items = (decoded['memories'] as List).cast<Map<String, dynamic>>();
      } else if (decoded is List) {
        // 兼容直接返回数组的情况
        items = decoded.cast<Map<String, dynamic>>();
      } else {
        return const _ExtractionParseResult(
          parseFailed: true,
          errorReason: 'JSON 顶层非 memories 对象或数组',
        );
      }
      final normalized = _normalizeCategories(items);
      final calibrated = normalized
          .map((item) => _memoryEngine.calibrateRawMemoryItem(item))
          .toList();
      return _ExtractionParseResult(items: calibrated);
    } catch (e) {
      return _ExtractionParseResult(
        parseFailed: true,
        errorReason: 'JSON 解析失败: $e',
      );
    }
  }

  /// 对照主项目 src/lib/memory-category.ts normalizeMemoryCategory
  /// 模糊匹配 category 字符串，确保存入数据库的值是标准七大分类之一
  static String _normalizeCategory(String value) {
    if (value.contains('关系')) return '关系动态';
    if (value.contains('话题')) return '话题历史';
    if (value.contains('基础')) return '基础信息';
    if (value.contains('偏好')) return '偏好习惯';
    if (value.contains('人格')) return '人格特质';
    if (value.contains('重要')) return '重要事件';
    if (value.contains('四季') || value.contains('日常')) return '四季日常';
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
  ///
  /// 从 settings 表读取并以 [SecretStorageService.resolveApiKey] 解析
  /// `secret://api-key/...` 引用为真实 key——否则会把引用串当 Bearer token
  /// 发给上游导致 401（FIX：记忆提取全 401 失效）。
  /// 同时补齐后台模型相关字段（memoryBackgroundModel 等），供后续后台模型
  /// 解析复用，避免本服务静默用主对话模型。
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
    final rawApiKey = map['api_key'] as String? ?? '';
    final apiKey = await _secretStorage.resolveApiKey(rawApiKey);
    return AppSettings(
      apiBase: map['api_base'] as String? ?? '',
      apiKey: apiKey,
      model: map['model'] as String? ?? '',
      temperature: (map['temperature'] as num?)?.toDouble() ?? 1.0,
      maxTokens: map['max_tokens'] as int? ?? 4096,
      memoryBackgroundModel: map['memory_background_model'] as String? ?? '',
      memoryBackgroundProviderId:
          map['memory_background_provider_id'] as String? ?? '',
      disableDeepseekThinkingForBackground:
          map['disable_deepseek_thinking_for_background'] as bool? ?? false,
    );
  }

  /// 提取文本中的 anchor（书名号/引号内的专有名词）— 对照主项目 extractAnchors
  ///
  /// FIX(Major-8): 扩展引号字符类，增加对以下两类引号的匹配：
  /// - `『』`：日语 / 中文文本中常用的内层书名号或强调引号
  /// - `“”`（U+201C / U+201D）：中文弯引号（智能引号），多见于复制粘贴或富文本
  /// 引号语义/来源汇总：
  ///   - `《》`(U+300A/B)        ：中文书名号，作品名常用
  ///   - `「」`(U+300C/D)        ：日文 / 港台中文常用直角引号
  ///   - `『』`(U+300E/F)        ：日文 / 港台中文常用直角双引号（内层）
  ///   - `""`(U+0022)            ：ASCII 直引号
  ///   - `“”`(U+201C/D)          ：中文弯引号 / Smart quotes
  static Set<String> _extractAnchors(String text) {
    final anchors = <String>{};
    if (text.isEmpty) return anchors;

    // 各类成对引号 — 每对单独正则，确保左右匹配严格成对
    for (final pattern in [
      RegExp(r'《([^》]{1,30})》'),
      RegExp(r'「([^」]{1,30})」'),
      RegExp(r'『([^』]{1,30})』'),
      RegExp(r'"([^"]{1,30})"'),
      // 中文弯引号：用 unicode 转义避免源码中混入 BOM / 全角差异
      RegExp('\u201C([^\u201D]{1,30})\u201D'),
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

  /// 读取记忆的 metadata（JSON 字符串 → Map），null / 异常时返回空 Map
  /// 用于 supersede 分支在旧记忆上追加 supersededBy 等字段（spec SubTask 9.2）
  static Map<String, dynamic> _readMetadata(String? metadataJson) {
    if (metadataJson == null || metadataJson.isEmpty) return {};
    try {
      return jsonDecode(metadataJson) as Map<String, dynamic>;
    } catch (_) {
      return {};
    }
  }

  /// 把 metadata Map 写回 JSON 字符串
  static String _writeMetadata(Map<String, dynamic> map) => jsonEncode(map);

  /// 合并动态阈值 — 对照主项目 src/lib/memory-engine.ts:274-277
  ///
  /// 短文本（如"喜欢猫" vs "喜欢狗"）bigram 重叠率天然偏高但语义可能
  /// 完全不同，因此对较短记忆采用更严格的阈值；以两条中较短的一方判定，
  /// 避免长记忆带短记忆"蹭过"阈值。调用方传入
  /// `min(existing.content.length, newContent.length)`。
  static double _mergeThreshold(int shorterLen) =>
      shorterLen < 20 ? 0.85 : 0.72;

  /// 对 [_mergeThreshold] 的 `@visibleForTesting` 公开别名，
  /// 便于单元测试在不构造完整提取流程的前提下断言阈值边界。
  @visibleForTesting
  static double mergeThresholdForTesting(int shorterLen) =>
      _mergeThreshold(shorterLen);

  /// 对 [_processQueue] 的 `@visibleForTesting` 公开入口，
  /// 便于单元测试在手动构造 inFlight 集合后直接驱动一次队列处理，
  /// 验证「inFlight 中的对话被 SQL 排除，其他对话的 pending 任务被处理」。
  /// 不改业务逻辑，仅暴露私有方法。
  @visibleForTesting
  Future<void> processQueueForTesting() => _processQueue();

  /// 对 [_inFlightConversations] 集合的 `@visibleForTesting` 手动注入入口。
  /// 用于 SubTask 21.3：在不实际启动 _processTask 的前提下，把指定对话标记为
  /// 「正在处理中」，验证 _processQueue 的 SQL 排除逻辑。
  /// 测试结束前必须调用 [unmarkConversationInFlightForTesting] 清理，避免
  /// finally 中 pending 探测触发的 unawaited(_processQueue) 因永远排除该对话
  /// 而形成空转循环。
  @visibleForTesting
  void markConversationInFlightForTesting(String conversationId) =>
      _inFlightConversations.add(conversationId);

  /// 对 [_inFlightConversations] 集合的 `@visibleForTesting` 清理入口，
  /// 与 [markConversationInFlightForTesting] 配对使用。
  @visibleForTesting
  void unmarkConversationInFlightForTesting(String conversationId) =>
      _inFlightConversations.remove(conversationId);

  /// 对 [_inFlightConversations] 集合的 `@visibleForTesting` 只读视图，
  /// 便于单元测试断言「_processTask 执行期间 inFlight 集合包含当前对话」、
  /// 「_processTask 结束后 inFlight 集合移除当前对话」。
  @visibleForTesting
  Set<String> get inFlightConversationsForTesting =>
      Set<String>.unmodifiable(_inFlightConversations);
}
