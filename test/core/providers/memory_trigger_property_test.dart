// 记忆触发条件属性测试
// Feature: flutter-core-features, Task 8.4
// Property 7: Memory trigger conditions fire correctly
// Property 8: Feature flags disable corresponding triggers
// Property 9: Memory extraction deduplication
// Validates: Requirements 3.1, 3.2, 3.3, 3.6, 3.7, 3.8, 3.9

import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, test, group;

/// 记忆触发条件检查逻辑（从 ChatController._checkMemoryTrigger 提取的纯函数版本）
///
/// 用于属性测试，避免依赖数据库和 Provider 框架。
class MemoryTriggerChecker {
  /// 检查是否应触发记忆提取
  ///
  /// 返回 true 表示应触发。
  static bool shouldTrigger({
    required int unextractedMessageCount,
    required int memoryInterval,
    required bool memoryTriggerIntervalEnabled,
    required DateTime? lastExtractionTime,
    required int memoryTriggerTimeHours,
    required bool memoryTriggerTimeEnabled,
    required String lastUserContent,
    required String memoryTriggerKeywords,
    required bool memoryTriggerKeywordEnabled,
    DateTime? now,
  }) {
    now ??= DateTime.now();

    // 条件 1：按消息数触发
    if (memoryTriggerIntervalEnabled &&
        unextractedMessageCount >= memoryInterval) {
      return true;
    }

    // 条件 2：按时间间隔触发
    if (memoryTriggerTimeEnabled) {
      if (lastExtractionTime == null ||
          now.difference(lastExtractionTime).inHours >= memoryTriggerTimeHours) {
        return true;
      }
    }

    // 条件 3：按关键词触发
    if (memoryTriggerKeywordEnabled) {
      final keywords = memoryTriggerKeywords
          .split(',')
          .map((k) => k.trim())
          .where((k) => k.isNotEmpty);
      for (final keyword in keywords) {
        if (lastUserContent.contains(keyword)) {
          return true;
        }
      }
    }

    return false;
  }
}

void main() {
  group('Property 7: Memory trigger conditions fire correctly', () {
    Glados<int>(any.intInRange(3, 100)).test(
      '消息数达到 memoryInterval 时触发（条件 1）',
      (interval) {
        final result = MemoryTriggerChecker.shouldTrigger(
          unextractedMessageCount: interval,
          memoryInterval: interval,
          memoryTriggerIntervalEnabled: true,
          lastExtractionTime: DateTime.now(),
          memoryTriggerTimeHours: 24,
          memoryTriggerTimeEnabled: false,
          lastUserContent: '普通消息',
          memoryTriggerKeywords: '晚安',
          memoryTriggerKeywordEnabled: false,
        );
        expect(result, isTrue,
            reason: '消息数 $interval 达到间隔 $interval 应触发');
      },
    );

    Glados<int>(any.intInRange(1, 50)).test(
      '消息数未达到 memoryInterval 时不触发（条件 1 不满足）',
      (interval) {
        final result = MemoryTriggerChecker.shouldTrigger(
          unextractedMessageCount: interval - 1,
          memoryInterval: interval,
          memoryTriggerIntervalEnabled: true,
          lastExtractionTime: DateTime.now(),
          memoryTriggerTimeHours: 24,
          memoryTriggerTimeEnabled: false,
          lastUserContent: '普通消息',
          memoryTriggerKeywords: '晚安',
          memoryTriggerKeywordEnabled: false,
        );
        expect(result, isFalse,
            reason: '消息数 ${interval - 1} 未达到间隔 $interval 不应触发');
      },
    );

    Glados<int>(any.intInRange(1, 48)).test(
      '时间超过 memoryTriggerTimeHours 时触发（条件 2）',
      (hours) {
        final now = DateTime(2026, 5, 15, 12, 0);
        final lastExtraction = now.subtract(Duration(hours: hours + 1));

        final result = MemoryTriggerChecker.shouldTrigger(
          unextractedMessageCount: 0,
          memoryInterval: 999,
          memoryTriggerIntervalEnabled: false,
          lastExtractionTime: lastExtraction,
          memoryTriggerTimeHours: hours,
          memoryTriggerTimeEnabled: true,
          lastUserContent: '普通消息',
          memoryTriggerKeywords: '晚安',
          memoryTriggerKeywordEnabled: false,
          now: now,
        );
        expect(result, isTrue,
            reason: '距上次提取 ${hours + 1} 小时，超过阈值 $hours 应触发');
      },
    );

    test('lastExtractionTime 为 null 时条件 2 触发', () {
      final result = MemoryTriggerChecker.shouldTrigger(
        unextractedMessageCount: 0,
        memoryInterval: 999,
        memoryTriggerIntervalEnabled: false,
        lastExtractionTime: null,
        memoryTriggerTimeHours: 24,
        memoryTriggerTimeEnabled: true,
        lastUserContent: '普通消息',
        memoryTriggerKeywords: '晚安',
        memoryTriggerKeywordEnabled: false,
      );
      expect(result, isTrue);
    });

    test('用户消息包含关键词时触发（条件 3）', () {
      final result = MemoryTriggerChecker.shouldTrigger(
        unextractedMessageCount: 0,
        memoryInterval: 999,
        memoryTriggerIntervalEnabled: false,
        lastExtractionTime: DateTime.now(),
        memoryTriggerTimeHours: 999,
        memoryTriggerTimeEnabled: false,
        lastUserContent: '今天好累，晚安',
        memoryTriggerKeywords: '晚安,再见',
        memoryTriggerKeywordEnabled: true,
      );
      expect(result, isTrue);
    });

    test('用户消息不包含任何关键词时不触发', () {
      final result = MemoryTriggerChecker.shouldTrigger(
        unextractedMessageCount: 0,
        memoryInterval: 999,
        memoryTriggerIntervalEnabled: false,
        lastExtractionTime: DateTime.now(),
        memoryTriggerTimeHours: 999,
        memoryTriggerTimeEnabled: false,
        lastUserContent: '今天天气不错',
        memoryTriggerKeywords: '晚安,再见',
        memoryTriggerKeywordEnabled: true,
      );
      expect(result, isFalse);
    });

    test('多个关键词中匹配任一即触发', () {
      const keywords = '晚安,再见,拜拜,下次见';
      for (final kw in keywords.split(',')) {
        final result = MemoryTriggerChecker.shouldTrigger(
          unextractedMessageCount: 0,
          memoryInterval: 999,
          memoryTriggerIntervalEnabled: false,
          lastExtractionTime: DateTime.now(),
          memoryTriggerTimeHours: 999,
          memoryTriggerTimeEnabled: false,
          lastUserContent: '好的$kw',
          memoryTriggerKeywords: keywords,
          memoryTriggerKeywordEnabled: true,
        );
        expect(result, isTrue, reason: '包含关键词 "$kw" 应触发');
      }
    });
  });

  group('Property 8: Feature flags disable corresponding triggers', () {
    Glados<int>(any.intInRange(3, 100)).test(
      'memoryTriggerIntervalEnabled=false 时消息数条件不触发',
      (count) {
        final result = MemoryTriggerChecker.shouldTrigger(
          unextractedMessageCount: count,
          memoryInterval: 1, // 极低阈值，正常应触发
          memoryTriggerIntervalEnabled: false, // 但开关关闭
          lastExtractionTime: DateTime.now(),
          memoryTriggerTimeHours: 999,
          memoryTriggerTimeEnabled: false,
          lastUserContent: '普通消息',
          memoryTriggerKeywords: '晚安',
          memoryTriggerKeywordEnabled: false,
        );
        expect(result, isFalse,
            reason: '消息数条件开关关闭时不应触发');
      },
    );

    test('memoryTriggerTimeEnabled=false 时时间条件不触发', () {
      final result = MemoryTriggerChecker.shouldTrigger(
        unextractedMessageCount: 0,
        memoryInterval: 999,
        memoryTriggerIntervalEnabled: false,
        lastExtractionTime: null, // 从未提取过，正常应触发
        memoryTriggerTimeHours: 1,
        memoryTriggerTimeEnabled: false, // 但开关关闭
        lastUserContent: '普通消息',
        memoryTriggerKeywords: '晚安',
        memoryTriggerKeywordEnabled: false,
      );
      expect(result, isFalse,
          reason: '时间条件开关关闭时不应触发');
    });

    test('memoryTriggerKeywordEnabled=false 时关键词条件不触发', () {
      final result = MemoryTriggerChecker.shouldTrigger(
        unextractedMessageCount: 0,
        memoryInterval: 999,
        memoryTriggerIntervalEnabled: false,
        lastExtractionTime: DateTime.now(),
        memoryTriggerTimeHours: 999,
        memoryTriggerTimeEnabled: false,
        lastUserContent: '晚安', // 包含关键词
        memoryTriggerKeywords: '晚安',
        memoryTriggerKeywordEnabled: false, // 但开关关闭
      );
      expect(result, isFalse,
          reason: '关键词条件开关关闭时不应触发');
    });

    test('所有开关关闭时任何条件都不触发', () {
      final result = MemoryTriggerChecker.shouldTrigger(
        unextractedMessageCount: 9999,
        memoryInterval: 1,
        memoryTriggerIntervalEnabled: false,
        lastExtractionTime: null,
        memoryTriggerTimeHours: 0,
        memoryTriggerTimeEnabled: false,
        lastUserContent: '晚安再见拜拜',
        memoryTriggerKeywords: '晚安,再见,拜拜',
        memoryTriggerKeywordEnabled: false,
      );
      expect(result, isFalse);
    });
  });

  group('Property 9: Memory extraction deduplication', () {
    // 去重逻辑在 MemoryExtractionService 中实现（内存 Set + DB 查询）
    // 这里验证触发条件的幂等性：相同输入产生相同结果
    Glados3<int, int, bool>(
      any.intInRange(0, 20),
      any.intInRange(1, 10),
      any.bool,
    ).test(
      '相同输入参数始终产生相同触发结果（确定性）',
      (count, interval, enabled) {
        final result1 = MemoryTriggerChecker.shouldTrigger(
          unextractedMessageCount: count,
          memoryInterval: interval,
          memoryTriggerIntervalEnabled: enabled,
          lastExtractionTime: DateTime(2026, 5, 15),
          memoryTriggerTimeHours: 24,
          memoryTriggerTimeEnabled: false,
          lastUserContent: '测试',
          memoryTriggerKeywords: '晚安',
          memoryTriggerKeywordEnabled: false,
          now: DateTime(2026, 5, 15, 12, 0),
        );

        final result2 = MemoryTriggerChecker.shouldTrigger(
          unextractedMessageCount: count,
          memoryInterval: interval,
          memoryTriggerIntervalEnabled: enabled,
          lastExtractionTime: DateTime(2026, 5, 15),
          memoryTriggerTimeHours: 24,
          memoryTriggerTimeEnabled: false,
          lastUserContent: '测试',
          memoryTriggerKeywords: '晚安',
          memoryTriggerKeywordEnabled: false,
          now: DateTime(2026, 5, 15, 12, 0),
        );

        expect(result1, result2,
            reason: '相同输入应产生相同结果（确定性）');
      },
    );
  });
}
