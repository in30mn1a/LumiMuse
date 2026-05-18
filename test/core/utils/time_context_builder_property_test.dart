// 时间上下文构建器属性测试
// Feature: flutter-core-features, Task 7.3
// Property 16: Time context formatting and injection
// Property 17: Regeneration uses message created_at for time context
// Property 18: Timestamp prefix stripping
// Validates: Requirements 6.1, 6.2, 6.3, 6.5

import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, test, group;
import 'package:lumimuse/core/utils/time_context_builder.dart';

void main() {
  group('Property 16: Time context formatting and injection', () {
    Glados3<int, int, int>(
      any.intInRange(2020, 2030), // year
      any.intInRange(1, 12), // month
      any.intInRange(1, 28), // day (安全范围，避免无效日期)
    ).test(
      '任意有效日期：输出始终包含 "## Current Time" 标题',
      (year, month, day) {
        final dt = DateTime(year, month, day, 12, 0);
        final result = TimeContextBuilder.buildTimeContext(dt);
        expect(result, contains('## Current Time'));
      },
    );

    Glados2<int, int>(
      any.intInRange(0, 23), // hour
      any.intInRange(0, 59), // minute
    ).test(
      '任意时分：输出包含正确格式的时间字符串',
      (hour, minute) {
        final dt = DateTime(2026, 5, 15, hour, minute);
        final result = TimeContextBuilder.buildTimeContext(dt);

        final hourStr = hour.toString().padLeft(2, '0');
        final minuteStr = minute.toString().padLeft(2, '0');
        expect(result, contains('$hourStr:$minuteStr'));
      },
    );

    Glados<int>(any.intInRange(1, 7)).test(
      '任意星期值：输出包含对应的中文星期名',
      (weekday) {
        // 构造一个已知星期的日期
        // 2026-05-11 是星期一，+weekday-1 得到对应星期
        final dt = DateTime(2026, 5, 11 + weekday - 1, 10, 30);
        final result = TimeContextBuilder.buildTimeContext(dt);
        final expectedName = TimeContextBuilder.weekdayName(weekday);
        expect(result, contains(expectedName));
      },
    );

    Glados3<int, int, int>(
      any.intInRange(2020, 2030),
      any.intInRange(1, 12),
      any.intInRange(1, 28),
    ).test(
      '任意日期：输出包含行为说明文本',
      (year, month, day) {
        final dt = DateTime(year, month, day);
        final result = TimeContextBuilder.buildTimeContext(dt);
        expect(result, contains('请根据这个时间来回答用户关于现实时间的问题'));
      },
    );

    Glados2<int, int>(
      any.intInRange(1, 12),
      any.intInRange(1, 9), // 单位数日期，验证补零
    ).test(
      '单位数月/日始终补零为两位',
      (month, day) {
        final dt = DateTime(2026, month, day, 8, 5);
        final result = TimeContextBuilder.buildTimeContext(dt);

        final monthStr = month.toString().padLeft(2, '0');
        final dayStr = day.toString().padLeft(2, '0');
        expect(result, contains('2026-$monthStr-$dayStr'));
      },
    );
  });

  group('Property 17: Regeneration time context', () {
    // 验证不同时间输入产生不同输出（确保时间参数被正确使用）
    test('不同 DateTime 输入产生不同时间字符串', () {
      final dt1 = DateTime(2026, 1, 1, 10, 0);
      final dt2 = DateTime(2026, 6, 15, 22, 30);

      final result1 = TimeContextBuilder.buildTimeContext(dt1);
      final result2 = TimeContextBuilder.buildTimeContext(dt2);

      expect(result1, isNot(equals(result2)));
      expect(result1, contains('2026-01-01 10:00'));
      expect(result2, contains('2026-06-15 22:30'));
    });

    test('重新生成使用消息 created_at 而非当前时间', () {
      // 模拟：消息创建于 2026-03-10 09:15
      final messageCreatedAt = DateTime(2026, 3, 10, 9, 15);
      final result = TimeContextBuilder.buildTimeContext(messageCreatedAt);

      expect(result, contains('2026-03-10 09:15'));
      expect(result, contains('星期二')); // 2026-03-10 是星期二
    });
  });

  group('Property 18: Timestamp prefix stripping', () {
    Glados<String>(any.choose(['alpha', 'beta', 'gamma', 'delta', 'hello', 'world', 'test', 'foo', 'bar', 'xyz123'])).test(
      '无前缀的文本始终原样返回',
      (text) {
        if (text.isEmpty) return;
        // 确保不以时间戳格式开头
        if (text.startsWith('[')) return;
        final result = TimeContextBuilder.stripTimestampPrefix(text);
        expect(result, text);
      },
    );

    Glados2<int, int>(
      any.intInRange(0, 23),
      any.intInRange(0, 59),
    ).test(
      '任意时分的 [YYYY-MM-DD HH:mm] 前缀都能被去除',
      (hour, minute) {
        final hourStr = hour.toString().padLeft(2, '0');
        final minuteStr = minute.toString().padLeft(2, '0');
        final input = '[2026-05-15 $hourStr:$minuteStr] 你好';
        final result = TimeContextBuilder.stripTimestampPrefix(input);
        expect(result, '你好');
      },
    );

    Glados2<int, int>(
      any.intInRange(0, 23),
      any.intInRange(0, 59),
    ).test(
      '任意时分的 [YYYY/MM/DD HH:mm] 前缀都能被去除',
      (hour, minute) {
        final hourStr = hour.toString().padLeft(2, '0');
        final minuteStr = minute.toString().padLeft(2, '0');
        final input = '[2026/05/15 $hourStr:$minuteStr] 你好';
        final result = TimeContextBuilder.stripTimestampPrefix(input);
        expect(result, '你好');
      },
    );

    test('stripTimestampPrefix 是幂等的（多次调用结果不变）', () {
      const input = '[2026-05-15 14:30] 你好呀';
      final once = TimeContextBuilder.stripTimestampPrefix(input);
      final twice = TimeContextBuilder.stripTimestampPrefix(once);
      expect(once, twice);
    });

    test('中间位置的时间戳不被去除', () {
      const input = '你好 [2026-05-15 14:30] 世界';
      final result = TimeContextBuilder.stripTimestampPrefix(input);
      expect(result, input);
    });
  });
}

