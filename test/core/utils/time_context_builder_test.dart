// 时间上下文构建器单元测试
// Feature: flutter-core-features, Task 7.1: 创建 TimeContextBuilder 工具类
// Validates: Requirements 6.1, 6.2, 6.4, 6.5

import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/utils/time_context_builder.dart';

void main() {
  group('TimeContextBuilder', () {
    // ─────────────────────────────────────────────
    // buildTimeContext 测试
    // ─────────────────────────────────────────────

    group('buildTimeContext', () {
      test('输出包含 "## Current Time" 标题', () {
        final dt = DateTime(2026, 5, 15, 14, 30);
        final result = TimeContextBuilder.buildTimeContext(dt);
        expect(result, contains('## Current Time'));
      });

      test('输出格式正确：YYYY-MM-DD HH:mm，星期X', () {
        // 2026-05-15 在公历上是星期五（Friday），与 DateTime.weekday 返回的 5 一致；
        // 历史上这条用例曾误写为「星期四」，导致 weekday 标识对不上日期，这里修正。
        final dt = DateTime(2026, 5, 15, 14, 30);
        final result = TimeContextBuilder.buildTimeContext(dt);
        expect(
          result,
          contains('当前用户本地时间是 2026-05-15 14:30，星期五。'),
        );
      });

      test('输出包含行为说明', () {
        final dt = DateTime(2026, 5, 15, 14, 30);
        final result = TimeContextBuilder.buildTimeContext(dt);
        expect(
          result,
          contains('请根据这个时间来回答用户关于现实时间的问题'),
        );
      });

      test('月份和日期补零', () {
        final dt = DateTime(2026, 1, 5, 8, 3);
        final result = TimeContextBuilder.buildTimeContext(dt);
        expect(result, contains('2026-01-05 08:03'));
      });

      test('午夜时间格式正确', () {
        final dt = DateTime(2026, 12, 31, 0, 0);
        final result = TimeContextBuilder.buildTimeContext(dt);
        expect(result, contains('2026-12-31 00:00'));
      });

      test('跨年日期格式正确', () {
        final dt = DateTime(2027, 1, 1, 23, 59);
        final result = TimeContextBuilder.buildTimeContext(dt);
        expect(result, contains('2027-01-01 23:59'));
      });
    });

    // ─────────────────────────────────────────────
    // weekdayName 测试
    // ─────────────────────────────────────────────

    group('weekdayName', () {
      test('1 → 星期一', () {
        expect(TimeContextBuilder.weekdayName(1), '星期一');
      });

      test('2 → 星期二', () {
        expect(TimeContextBuilder.weekdayName(2), '星期二');
      });

      test('3 → 星期三', () {
        expect(TimeContextBuilder.weekdayName(3), '星期三');
      });

      test('4 → 星期四', () {
        expect(TimeContextBuilder.weekdayName(4), '星期四');
      });

      test('5 → 星期五', () {
        expect(TimeContextBuilder.weekdayName(5), '星期五');
      });

      test('6 → 星期六', () {
        expect(TimeContextBuilder.weekdayName(6), '星期六');
      });

      test('7 → 星期日', () {
        expect(TimeContextBuilder.weekdayName(7), '星期日');
      });

      test('无效值 0 返回空字符串', () {
        expect(TimeContextBuilder.weekdayName(0), '');
      });

      test('无效值 8 返回空字符串', () {
        expect(TimeContextBuilder.weekdayName(8), '');
      });

      test('负数返回空字符串', () {
        expect(TimeContextBuilder.weekdayName(-1), '');
      });
    });

    // ─────────────────────────────────────────────
    // stripTimestampPrefix 测试
    // ─────────────────────────────────────────────

    group('stripTimestampPrefix', () {
      test('去除 [YYYY-MM-DD HH:mm] 前缀', () {
        const input = '[2026-05-15 14:30] 你好呀';
        expect(TimeContextBuilder.stripTimestampPrefix(input), '你好呀');
      });

      test('去除 [YYYY/MM/DD HH:mm] 前缀', () {
        const input = '[2026/05/15 14:30] 你好呀';
        expect(TimeContextBuilder.stripTimestampPrefix(input), '你好呀');
      });

      test('去除带秒数的 [YYYY-MM-DD HH:mm:ss] 前缀', () {
        const input = '[2026-05-15 14:30:45] 你好呀';
        expect(TimeContextBuilder.stripTimestampPrefix(input), '你好呀');
      });

      test('去除带秒数的 [YYYY/MM/DD HH:mm:ss] 前缀', () {
        const input = '[2026/05/15 14:30:45] 你好呀';
        expect(TimeContextBuilder.stripTimestampPrefix(input), '你好呀');
      });

      test('前缀后无空格也能去除', () {
        const input = '[2026-05-15 14:30]你好呀';
        expect(TimeContextBuilder.stripTimestampPrefix(input), '你好呀');
      });

      test('前缀后多个空格也能去除', () {
        const input = '[2026-05-15 14:30]   你好呀';
        expect(TimeContextBuilder.stripTimestampPrefix(input), '你好呀');
      });

      test('无前缀的文本原样返回', () {
        const input = '你好呀，今天天气不错';
        expect(TimeContextBuilder.stripTimestampPrefix(input), input);
      });

      test('空字符串原样返回', () {
        expect(TimeContextBuilder.stripTimestampPrefix(''), '');
      });

      test('中间位置的时间戳不被去除', () {
        const input = '你好 [2026-05-15 14:30] 世界';
        expect(TimeContextBuilder.stripTimestampPrefix(input), input);
      });

      test('不完整的时间戳格式不被去除', () {
        const input = '[2026-05-15] 你好呀';
        expect(TimeContextBuilder.stripTimestampPrefix(input), input);
      });

      test('仅有前缀无正文时返回空字符串', () {
        const input = '[2026-05-15 14:30]';
        expect(TimeContextBuilder.stripTimestampPrefix(input), '');
      });

      test('仅有前缀加空格时返回空字符串', () {
        const input = '[2026-05-15 14:30] ';
        expect(TimeContextBuilder.stripTimestampPrefix(input), '');
      });
    });

    // ─────────────────────────────────────────────
    // buildTimeContext 与 weekdayName 一致性验证
    // ─────────────────────────────────────────────

    group('一致性验证', () {
      test('buildTimeContext 中的星期名与 weekdayName 一致', () {
        // 2026-05-11 是星期一
        for (int i = 0; i < 7; i++) {
          final dt = DateTime(2026, 5, 11 + i);
          final result = TimeContextBuilder.buildTimeContext(dt);
          final expectedWeekday = TimeContextBuilder.weekdayName(dt.weekday);
          expect(result, contains(expectedWeekday));
        }
      });
    });
  });
}
