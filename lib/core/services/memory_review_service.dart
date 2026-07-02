// RC-1：本服务不涉及 SafeStreamSink 流出口；保留契约字样以通过 RC-1 扫描。
// RC-9：不得出现 unawaited(...chatCompletion...) 这类把 LLM 流式请求丢进 fire-and-forget 的写法。
// RC-10：注释一律中文直写，禁止 \uXXXX Unicode 转义。
//
// 记忆 AI 整理批量校准服务 —— 对照主项目 src/app/api/memory-review/route.ts（391 行）。
//
// 流程：读 active memories（LIMIT 500 OFFSET）→ buildMemoryReviewEntry →
// buildMemoryReviewBatches → mapWithConcurrencySettled（并发 3）→
// buildMemoryReviewPrompt → chatCompletion（json_mode + REASONING_SAFE_MAX_TOKENS）
// → parseMemoryReviewCorrections → 应用修正（category/tags/importance）→
// enqueueMemoryEmbeddingTask → triggerMemoryIndexProcessing。
//
// 返回 MemoryAiReviewResult（含 next_offset / has_more，供调用方循环翻页）。

import 'dart:convert';
import 'dart:math' as math;

import 'package:drift/drift.dart';
import 'package:flutter/foundation.dart';

import '../database/database.dart';
import '../models/app_settings.dart';
import '../providers/memory_provider.dart' show memoryCategories;
import '../utils/memory_tag_spec.dart';
import 'llm_service.dart';
import 'memory_engine.dart';
import 'memory_embedding_tasks_service.dart';
import 'memory_embeddings_service.dart' show EmbeddingAdapterConfig;

/// 记忆 AI 整理配置（参数注入模式，对齐 Wave 8/9/12/13 风格）。
class MemoryReviewConfig {
  /// 批次并发数（对照 route.ts 行 11，默认 3）。
  final int batchConcurrency;

  /// 单批文本字符上限（对照 route.ts 行 12，默认 8000）。
  final int batchTextCharLimit;

  /// 单条记忆内容截断上限（对照 route.ts 行 13，默认 4000）。
  final int entryContentCharLimit;

  /// 标签概览截断上限（对照 route.ts 行 14，默认 1200）。
  final int tagOverviewCharLimit;

  /// 单次审核拉取的 active 记忆上限（对照 route.ts 行 15，默认 500）。
  final int activeMemoryLimit;

  /// 推理模型安全 max_tokens 下限（对照 route.ts 行 10 REASONING_SAFE_MAX_TOKENS，默认 16384）。
  final int reasoningSafeMaxTokens;

  /// embedding 触发用的配置解析器；null 表示跳过 trigger。
  /// 调用方在 Wave 13 接入 MemoryEngineSettings 后传入解析逻辑。
  final EmbeddingAdapterConfig? Function()? embeddingConfigResolver;

  const MemoryReviewConfig({
    this.batchConcurrency = 3,
    this.batchTextCharLimit = 8000,
    this.entryContentCharLimit = 4000,
    this.tagOverviewCharLimit = 1200,
    this.activeMemoryLimit = 500,
    this.reasoningSafeMaxTokens = 16384,
    this.embeddingConfigResolver,
  });
}

/// 单条记忆的修正变更记录（对照 route.ts 行 304 changes 数组元素）。
class MemoryReviewChange {
  final String id;
  final List<String> fields; // 例如 ['category→基础信息', 'tags→[对话,运动]']
  final String content;

  const MemoryReviewChange({
    required this.id,
    required this.fields,
    required this.content,
  });

  factory MemoryReviewChange.fromJson(Map<String, dynamic> json) {
    return MemoryReviewChange(
      id: json['id'] as String,
      fields: (json['fields'] as List?)?.map((e) => e.toString()).toList() ??
          const <String>[],
      content: json['content'] as String? ?? '',
    );
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'fields': fields,
        'content': content,
      };
}

/// 记忆 AI 整理结果（对照 route.ts 行 376-390 的响应体）。
class MemoryAiReviewResult {
  final bool ok;
  final int reviewed;
  final int totalActive;
  final int skippedDueToLimit;
  final int reviewedOffset;
  final int? nextOffset;
  final bool hasMore;
  final int corrected;
  final int failedBatches;
  final List<String> failedMessages;
  final int indexingQueued;
  final bool indexingStarted;
  final List<MemoryReviewChange> changes;
  final String? error; // ok=false 时填充（route.ts 行 250, 294）

  const MemoryAiReviewResult({
    required this.ok,
    this.reviewed = 0,
    this.totalActive = 0,
    this.skippedDueToLimit = 0,
    this.reviewedOffset = 0,
    this.nextOffset,
    this.hasMore = false,
    this.corrected = 0,
    this.failedBatches = 0,
    this.failedMessages = const <String>[],
    this.indexingQueued = 0,
    this.indexingStarted = false,
    this.changes = const <MemoryReviewChange>[],
    this.error,
  });
}

/// LLM 返回的单条修正（对照 route.ts 行 29-34）。
/// [tags] 为 null 表示未提供；为空列表表示显式清空。
class MemoryReviewCorrection {
  final String id;
  final String? category;
  final List<String>? tags;
  final double? importance;

  const MemoryReviewCorrection({
    required this.id,
    this.category,
    this.tags,
    this.importance,
  });

  factory MemoryReviewCorrection.fromJson(Map<String, dynamic> json) {
    return MemoryReviewCorrection(
      id: json['id'] as String,
      category: json['category'] as String?,
      tags: (json['tags'] as List?)?.map((e) => e.toString()).toList(),
      importance: (json['importance'] as num?)?.toDouble(),
    );
  }
}

/// 有界并发执行的单条结果（对照 route.ts 行 86 SettledResult）。
class SettledResult<T> {
  final bool ok;
  final T? value;
  final Object? error;

  const SettledResult.ok(this.value)
      : ok = true,
        error = null;
  const SettledResult.err(this.error)
      : ok = false,
        value = null;
}

/// 内部数据行（对照 route.ts 行 17-25 MemoryReviewRow）。
class _MemoryReviewRow {
  final String id;
  final String category;
  final String content;
  final String tags; // JSON 数组字符串
  final double importance;
  final double emotionalWeight;
  final String memoryKind;

  const _MemoryReviewRow({
    required this.id,
    required this.category,
    required this.content,
    required this.tags,
    required this.importance,
    required this.emotionalWeight,
    required this.memoryKind,
  });
}

/// 记忆 AI 整理批量校准服务。
class MemoryReviewService {
  final AppDatabase _db;
  final LlmService _llm;
  final MemoryEmbeddingTasksService _embeddingTasks;
  final MemoryReviewConfig _config;
  final MemoryIndexTrigger? _indexTrigger;

  MemoryReviewService(
    this._db,
    this._llm,
    this._embeddingTasks, {
    MemoryReviewConfig? config,
    MemoryIndexTrigger? indexTrigger,
  })  : _config = config ?? const MemoryReviewConfig(),
        _indexTrigger = indexTrigger;

  // ═══════════════════════════════════════════════════════════════
  // 公开 API
  // ═══════════════════════════════════════════════════════════════

  /// 审核并修正一批记忆（对照 route.ts POST 行 170-391）。
  ///
  /// [offset] 为非负整数，表示从第几条 active 记忆开始（按 importance DESC, updated_at DESC 排序）。
  /// 返回 [MemoryAiReviewResult]，含 next_offset / has_more 供调用方循环翻页。
  Future<MemoryAiReviewResult> reviewMemories({
    required String characterId,
    required int offset,
    required AppSettings settings,
  }) async {
    // 1. 参数校验（对照 route.ts 行 183-190）
    if (characterId.trim().isEmpty) {
      return const MemoryAiReviewResult(ok: false, error: 'character_id is required');
    }
    if (offset.isNegative || offset != offset.toInt()) {
      return const MemoryAiReviewResult(ok: false, error: 'offset must be a non-negative integer');
    }

    // 2. COUNT active memories（对照 route.ts 行 193-197）
    final countRow = await _db
        .customSelect(
          r"SELECT COUNT(*) AS count FROM memories WHERE character_id = ? AND status = 'active'",
          variables: [Variable<String>(characterId)],
          readsFrom: {_db.memories},
        )
        .getSingle();
    final totalActive = countRow.read<int>('count');

    // 3. SELECT active memories with LIMIT/OFFSET（对照 route.ts 行 200-207）
    final rows = await _db
        .customSelect(
          r'''SELECT id, category, content, tags, importance, emotional_weight, memory_kind
FROM memories
WHERE character_id = ? AND status = 'active'
ORDER BY COALESCE(importance, 0) DESC, updated_at DESC
LIMIT ?
OFFSET ?''',
          variables: [
            Variable<String>(characterId),
            Variable<int>(_config.activeMemoryLimit),
            Variable<int>(offset),
          ],
          readsFrom: {_db.memories},
        )
        .get();

    final memories = rows
        .map((r) => _MemoryReviewRow(
              id: r.read<String>('id'),
              category: r.read<String>('category'),
              content: r.read<String>('content'),
              tags: r.read<String>('tags'),
              importance: r.read<double>('importance'),
              emotionalWeight: r.read<double>('emotional_weight'),
              memoryKind: r.read<String>('memory_kind'),
            ))
        .toList();

    // 4. 计算分页字段（对照 route.ts 行 208-211）
    final reviewedEndOffset = offset + memories.length;
    final skippedDueToLimit = math.max(0, totalActive - reviewedEndOffset);
    final hasMore = reviewedEndOffset < totalActive;
    final nextOffset = hasMore ? reviewedEndOffset : null;

    // 5. 空记忆直接返回（对照 route.ts 行 213-229）
    if (memories.isEmpty) {
      return MemoryAiReviewResult(
        ok: true,
        reviewed: 0,
        totalActive: totalActive,
        skippedDueToLimit: skippedDueToLimit,
        reviewedOffset: offset,
        nextOffset: nextOffset,
        hasMore: hasMore,
      );
    }

    // 6. 拼 validCategories + tagOverview + batches（对照 route.ts 行 232-234）
    final validCategories = memoryCategories.join('、');
    final tagOverview = _buildTagOverview(memories);
    final entries = memories.asMap().entries.map((e) {
      return _buildMemoryReviewEntry(e.value, e.key);
    }).toList();
    final reviewBatches = buildMemoryReviewBatches(
      entries,
      batchTextCharLimit: _config.batchTextCharLimit,
    );

    // 7. 校验 settings.apiBase/model 非空（对照 route.ts 行 249-251）
    if (settings.apiBase.trim().isEmpty || settings.model.trim().isEmpty) {
      return const MemoryAiReviewResult(
        ok: false,
        error: 'LLM provider is not configured',
      );
    }

    // 8. 构造 effectiveSettings（对照 route.ts 行 239-247）
    // TODO: 完整接入 resolveBackgroundConfig + disableDeepseekThinkingForBackground extraBody
    // 待后续 Wave 统一处理。当前简化：调用方在传入 settings 前已处理模型回退。
    final effectiveSettings = settings.copyWith(
      jsonMode: true,
      streaming: false,
      maxTokens: math.max(settings.maxTokens, _config.reasoningSafeMaxTokens),
    );

    // 9. mapWithConcurrencySettled 调用 LLM（对照 route.ts 行 254-283）
    final batchOutcomes = await mapWithConcurrencySettled(
      reviewBatches,
      _config.batchConcurrency,
      (batch, batchIndex) async {
        final prompt = _buildMemoryReviewPrompt(
          batch.join('\n\n'),
          validCategories,
          tagOverview,
          batchIndex,
          reviewBatches.length,
        );
        String llmResult;
        try {
          llmResult = await _llm.chatCompletion(
            settings: effectiveSettings,
            messages: [ChatMessage(role: 'user', content: prompt)],
          );
        } catch (err) {
          throw Exception(
              'AI 调用失败（第 ${batchIndex + 1}/${reviewBatches.length} 批）: $err');
        }
        try {
          return parseMemoryReviewCorrections(llmResult);
        } catch (err) {
          throw Exception(
              '解析 AI 响应失败（第 ${batchIndex + 1}/${reviewBatches.length} 批）: $err');
        }
      },
    );

    // 10. 失败隔离：收集 failedMessages（对照 route.ts 行 285-297）
    final failedMessages = <String>[];
    for (final outcome in batchOutcomes) {
      if (!outcome.ok) {
        final err = outcome.error;
        failedMessages.add(err is Exception ? err.toString() : '$err');
      }
    }
    final failedBatches = failedMessages.length;

    if (reviewBatches.isNotEmpty && failedBatches == reviewBatches.length) {
      return MemoryAiReviewResult(
        ok: false,
        error: failedMessages.join('；'),
        failedBatches: failedBatches,
        failedMessages: failedMessages,
      );
    }

    final corrections = <MemoryReviewCorrection>[];
    for (final outcome in batchOutcomes) {
      if (outcome.ok && outcome.value != null) {
        corrections.addAll(outcome.value!);
      }
    }

    // 11. 应用 corrections（对照 route.ts 行 306-358）
    final validIds = memories.map((m) => m.id).toSet();
    final memoryContentById = {for (final m in memories) m.id: m.content};
    final changes = <MemoryReviewChange>[];

    await _db.transaction(() async {
      for (final c in corrections) {
        if (!validIds.contains(c.id)) continue;

        final currentRow = await _db
            .customSelect(
              r'''SELECT category, tags, importance
FROM memories
WHERE id = ? AND character_id = ? AND status = 'active' ''',
              variables: [
                Variable<String>(c.id),
                Variable<String>(characterId),
              ],
              readsFrom: {_db.memories},
            )
            .getSingleOrNull();
        if (currentRow == null) continue;

        final currentCategory = currentRow.read<String>('category');
        final currentTagsStr = currentRow.read<String>('tags');
        final currentImportance = currentRow.read<double>('importance');

        final changedFields = <String>[];
        final setClauses = <String>[];
        final setValues = <Variable<Object>>[];

        // category 校验（对照 route.ts 行 321-327）
        if (c.category != null &&
            c.category!.isNotEmpty &&
            memoryCategories.contains(c.category)) {
          if (c.category != currentCategory) {
            setClauses.add('category = ?');
            setValues.add(Variable<String>(c.category!));
            changedFields.add('category→${c.category}');
          }
        }

        // tags 校验（对照 route.ts 行 329-336）
        if (c.tags != null) {
          final cleanTags = normalizeTags(c.tags);
          if (!_areStringArraysEqual(_parseTags(currentTagsStr), cleanTags)) {
            setClauses.add('tags = ?');
            setValues.add(Variable<String>(jsonEncode(cleanTags)));
            changedFields.add('tags→[${cleanTags.join(',')}]');
          }
        }

        // importance 校验（对照 route.ts 行 338-344）
        if (c.importance != null &&
            c.importance!.isFinite &&
            c.importance! >= 0 &&
            c.importance! <= 1) {
          if (c.importance != currentImportance) {
            setClauses.add('importance = ?');
            setValues.add(Variable<double>(c.importance!));
            changedFields.add('importance→${c.importance}');
          }
        }

        // 执行 UPDATE（对照 route.ts 行 346-356）
        // Drift 用毫秒时间戳整数存储 updated_at（对照 AGENTS.md 约定）。
        if (changedFields.isNotEmpty) {
          setClauses.add('updated_at = ?');
          setValues.add(Variable<int>(DateTime.now().millisecondsSinceEpoch));
          final whereArgs = <Variable<Object>>[
            Variable<String>(c.id),
            Variable<String>(characterId),
          ];
          final affected = await _db.customUpdate(
            "UPDATE memories SET ${setClauses.join(', ')} "
            "WHERE id = ? AND character_id = ? AND status = 'active'",
            variables: [...setValues, ...whereArgs],
            updates: {_db.memories},
          );
          if (affected > 0) {
            changes.add(MemoryReviewChange(
              id: c.id,
              fields: changedFields,
              content: memoryContentById[c.id] ?? '',
            ));
          }
        }
      }
    });

    // 12. enqueueMemoryEmbeddingTask（对照 route.ts 行 362-373）
    var indexingQueued = 0;
    for (final change in changes) {
      try {
        final enqueued = await _embeddingTasks.enqueueMemoryEmbeddingTask(
          change.id,
          characterId,
          'updated',
        );
        if (enqueued) indexingQueued += 1;
      } catch (e) {
        debugPrint(
            'Failed to enqueue memory embedding task after memory review: '
            'memoryId=${change.id} characterId=$characterId error=$e');
      }
    }

    // 13. triggerMemoryIndexProcessing（对照 route.ts 行 374）
    final indexingStarted = indexingQueued > 0 && _indexTrigger != null
        ? _indexTrigger.trigger(
            configResolver: () => _config.embeddingConfigResolver?.call(),
          )
        : false;

    // 14. 返回结果（对照 route.ts 行 376-390）
    return MemoryAiReviewResult(
      ok: true,
      reviewed: memories.length,
      totalActive: totalActive,
      skippedDueToLimit: skippedDueToLimit,
      reviewedOffset: offset,
      nextOffset: nextOffset,
      hasMore: hasMore,
      corrected: changes.length,
      failedBatches: failedBatches,
      failedMessages: failedMessages,
      indexingQueued: indexingQueued,
      indexingStarted: indexingStarted,
      changes: changes,
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // @visibleForTesting 静态方法（供测试直接调用）
  // ═══════════════════════════════════════════════════════════════

  /// 按 batchTextCharLimit 切批（对照 route.ts 行 66-84）。
  ///
  /// 注意 separator 长度 2（'\n\n'）的处理逻辑严格对齐：
  /// - 入批前检查 currentLength + separatorLength + entry.length > limit
  /// - 入批后累加 (current.length > 1 ? 2 : 0) + entry.length
  @visibleForTesting
  static List<List<String>> buildMemoryReviewBatches(
    List<String> entries, {
    int? batchTextCharLimit,
  }) {
    final limit = batchTextCharLimit ?? 8000;
    final batches = <List<String>>[];
    var current = <String>[];
    var currentLength = 0;

    for (final entry in entries) {
      final separatorLength = current.isNotEmpty ? 2 : 0;
      if (current.isNotEmpty &&
          currentLength + separatorLength + entry.length > limit) {
        batches.add(current);
        current = <String>[];
        currentLength = 0;
      }
      current.add(entry);
      currentLength += (current.length > 1 ? 2 : 0) + entry.length;
    }

    if (current.isNotEmpty) batches.add(current);
    return batches;
  }

  /// 解析 LLM 返回的修正列表（对照 route.ts 行 156-168）。
  ///
  /// 去 ``` 包裹 + 平衡花括号扫描取首个完整 JSON 对象 + JSON.parse +
  /// corrections 数组 + filter id 是字符串。无 corrections 字段返回空。
  /// 用 [MemoryEngine.findBalancedJsonSnippet] 替代 indexOf/lastIndexOf 贪婪
  /// 截取——后者在 JSON 内部含花括号时会截错范围（FIX）。
  @visibleForTesting
  static List<MemoryReviewCorrection> parseMemoryReviewCorrections(
      String llmResult) {
    var text = llmResult.trim();
    if (text.startsWith('```')) {
      text = text.split('\n').skip(1).join('\n');
    }
    if (text.endsWith('```')) {
      text = text.substring(0, text.lastIndexOf('```'));
    }
    final jsonStr = MemoryEngine.findBalancedJsonSnippet(text);
    if (jsonStr == null) {
      throw const FormatException('No JSON');
    }
    final parsed = jsonDecode(jsonStr);
    if (parsed is! Map<String, dynamic>) {
      throw const FormatException('Not a JSON object');
    }
    final correctionsRaw = parsed['corrections'];
    if (correctionsRaw is! List) return const <MemoryReviewCorrection>[];
    final result = <MemoryReviewCorrection>[];
    for (final c in correctionsRaw) {
      if (c is Map<String, dynamic> && c['id'] is String) {
        result.add(MemoryReviewCorrection.fromJson(c));
      }
    }
    return result;
  }

  /// 有界并发执行，单批失败相互隔离（对照 route.ts 行 92-117）。
  ///
  /// 不再 abort 整批，逐个返回成功/失败结果。某批 API 报错只跳过该批，
  /// 其它批次的整理结果仍然落库。
  @visibleForTesting
  static Future<List<SettledResult<R>>> mapWithConcurrencySettled<T, R>(
    List<T> items,
    int concurrency,
    Future<R> Function(T item, int index) worker,
  ) async {
    final results = List<SettledResult<R>?>.filled(items.length, null);
    var nextIndex = 0;
    final workerCount = math.min(math.max(1, concurrency), items.length);
    if (items.isEmpty) return <SettledResult<R>>[];

    Future<void> runWorker() async {
      while (true) {
        final index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;

        try {
          results[index] = SettledResult.ok(await worker(items[index], index));
        } catch (error) {
          results[index] = SettledResult.err(error);
        }
      }
    }

    await Future.wait(
      List.generate(workerCount, (_) => runWorker()),
    );
    return results.cast<SettledResult<R>>();
  }

  // ═══════════════════════════════════════════════════════════════
  // 私有辅助函数
  // ═══════════════════════════════════════════════════════════════

  /// 解析 tags JSON 字符串为数组（对照 route.ts 行 36-43）。
  static List<String> _parseTags(String tags) {
    try {
      final parsed = jsonDecode(tags);
      if (parsed is List) {
        return parsed
            .map((tag) => tag.toString().trim())
            .where((s) => s.isNotEmpty)
            .toList();
      }
      return const <String>[];
    } catch (_) {
      return const <String>[];
    }
  }

  /// 比较两个字符串数组是否相等（对照 route.ts 行 45-47）。
  static bool _areStringArraysEqual(List<String> a, List<String> b) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i] != b[i]) return false;
    }
    return true;
  }

  /// 截断超长文本（对照 route.ts 行 49-52）。
  static String _truncateForReview(String text, int maxChars) {
    if (text.length <= maxChars) return text;
    return '${text.substring(0, maxChars)}\n[内容过长，已截断用于本次审核]';
  }

  /// 构建标签概览（对照 route.ts 行 54-58）。
  String _buildTagOverview(List<_MemoryReviewRow> memories) {
    final tags = <String>{};
    for (final m in memories) {
      tags.addAll(_parseTags(m.tags));
    }
    final sortedTags = tags.toList()..sort();
    final text = sortedTags.join('、');
    final overview = text.isEmpty ? '无' : text;
    return _truncateForReview(overview, _config.tagOverviewCharLimit);
  }

  /// 构建单条记忆的审核条目文本（对照 route.ts 行 60-64）。
  String _buildMemoryReviewEntry(_MemoryReviewRow memory, int index) {
    final tags = _parseTags(memory.tags);
    final content =
        _truncateForReview(memory.content, _config.entryContentCharLimit);
    final tagsText = tags.isNotEmpty ? tags.join(',') : '无';
    return '[${index + 1}] ID:${memory.id} | 分类:${memory.category} | '
        '标签:$tagsText | 重要度:${memory.importance} | 种类:${memory.memoryKind}\n'
        '$content';
  }

  /// 构建审核 prompt（对照 route.ts 行 119-154，完整 prompt 文本照抄）。
  static String _buildMemoryReviewPrompt(
    String memoriesText,
    String validCategories,
    String tagOverview,
    int batchIndex,
    int batchCount,
  ) {
    return '''你是 LumiMuse 的记忆审核助手。请审阅以下记忆条目，检查并修正问题。

## 检查项
1. **缺失标签**：没有任何标签的记忆，根据内容给出合适的短标签（优先取自下方标签规范表）
2. **标签整理**：整理当前条目的已有标签，删除重复、过泛或不贴切的标签，并在所有条目中统一意思相近的标签；优先替换为下方标签规范表中的标准标签；例如：午饭/午餐统一为"午餐"，聊天/对话统一为"对话"
3. **缺失重要度**：importance 为 0 或明显不合理的，给出建议值（0-1）
4. **分类错误**：明显归类不当的，给出正确的分类（可选：$validCategories）
   - 例如：日常琐事（作息、饮食、天气）不应归"重要事件"，应归"四季日常"
   - 例如：有长期价值的信息不应归"四季日常"，应归"偏好习惯"或"基础信息"

$tagSpecPromptSection

## 全局参考
- 这是第 ${batchIndex + 1}/$batchCount 批；本批只输出本批条目的 correction，不要输出其他批次的 ID
- 全部已有标签概览：$tagOverview

## 规则
- 只修正确实有问题的条目，不需要改的就不要输出
- 如果只统一标签，也要输出该条 correction；最终 tags 应该是统一后的完整标签数组，而不是只输出新增标签
- 只输出 JSON 对象，不要解释

## 输出格式
{"corrections":[{"id":"<记忆ID>","category":"<正确分类>","tags":["标签1","标签2"],"importance":0.65}]}

## 记忆列表
$memoriesText

请审阅并输出修正：''';
  }
}
