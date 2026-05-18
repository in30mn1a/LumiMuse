// Feature: flutter-pixel-perfect-parity, Property 11: 重新生成 Current Time 等于原消息 createdAt
// Validates: Requirements B6.3
//
// 设计说明
// ────────
// requirements.md B6.3 与 design.md「时间上下文」节要求：
//   当用户对某条 AI 消息触发重新生成时，ChatEngine 必须使用「该消息原 created_at」
//   而非当前实时时间作为 `Current Time` 注入到系统提示词中，确保重生回复的
//   时间感与原消息一致。
//
// 本属性测试在不依赖具体 ChatEngine 实现的前提下，把契约抽出为最小纯函数：
//
//   - `formatInTimezone(DateTime dt, Duration tz)`：把任意 DateTime 转换到
//     指定 UTC 偏移量的「墙钟时间」，再格式化为 `YYYY-MM-DD HH:mm` 字面量。
//   - `resolveCurrentTimeContext({DateTime? regenerateAt, required DateTime now,
//     required Duration tz})`：当 regenerateAt 非 null 时返回
//     `formatInTimezone(regenerateAt, tz)`，否则返回 `formatInTimezone(now, tz)`。
//
// glados 用 100 次 runs 随机生成 `(originalCreatedAt, now, tz)` 三元组，断言：
//   - regenerateAt = originalCreatedAt 调用得到的字符串等于
//     `formatInTimezone(originalCreatedAt, tz)`；
//   - 该字符串与生成器随机抖动的 `now` 完全无关。
//
// 失败时 glados 会自动 shrink 到最小反例。

import 'dart:math' as math;

import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test;

// ──────────────────────────────────────────────────────────────────────────
// 被测纯函数（契约层最小实现）
//
// 这里把 design §「时间上下文」描述的契约语义独立写一份纯函数，作为
// 被属性测试覆盖的参考实现；具体业务实现（ChatEngine）必须维持等价语义。
// ──────────────────────────────────────────────────────────────────────────

/// 把 [dt] 按 [tz] 偏移量转换成「墙钟时间」字符串。
///
/// 算法：
/// 1. 先转 UTC；
/// 2. 加上 [tz] 偏移得到目标时区的墙钟瞬间；
/// 3. 用 `YYYY-MM-DD HH:mm` 格式输出。
///
/// 注：这里 [tz] 表示 `local - UTC`，即 UTC+8 对应 `Duration(hours: 8)`，
/// 与 Node.js `Date.getTimezoneOffset()` 取负号后语义一致。
String formatInTimezone(DateTime dt, Duration tz) {
  // 先归一到 UTC，再加上目标时区偏移，得到「墙钟时间」分量。
  // 用 UTC DateTime 持有结果，避免后续访问 year/month/... 时被本机时区污染。
  final shifted = dt.toUtc().add(tz);
  final year = shifted.year.toString().padLeft(4, '0');
  final month = shifted.month.toString().padLeft(2, '0');
  final day = shifted.day.toString().padLeft(2, '0');
  final hour = shifted.hour.toString().padLeft(2, '0');
  final minute = shifted.minute.toString().padLeft(2, '0');
  return '$year-$month-$day $hour:$minute';
}

/// 解析「Current Time」段落使用的时间字符串。
///
/// - 当 [regenerateAt] 非 null（即：正在重新生成某条历史消息）时，
///   返回该消息原 `created_at` 在 [tz] 下的格式化结果，与 [now] 无关。
/// - 否则返回 [now] 在 [tz] 下的格式化结果。
String resolveCurrentTimeContext({
  DateTime? regenerateAt,
  required DateTime now,
  required Duration tz,
}) {
  if (regenerateAt != null) {
    return formatInTimezone(regenerateAt, tz);
  }
  return formatInTimezone(now, tz);
}

// ──────────────────────────────────────────────────────────────────────────
// glados 生成器：随机 (DateTime, DateTime, Duration) 三元组
//
// 设计策略：
// - DateTime 通过 `epochMillis ∈ [0, ~2.5e12]` 抽样，覆盖 1970 ~ 2050 之间。
// - Duration 通过 `offsetMinutes ∈ [-720, 840]` 抽样，覆盖现实世界
//   `UTC-12` ~ `UTC+14`，并以分钟粒度兼容半时区（India / Iran / Nepal 等）。
// - 用 `seed` 构造确定性 `Random`，保证 glados 失败重放可复现。
// ──────────────────────────────────────────────────────────────────────────

extension on Any {
  /// 随机 DateTime，UTC 与本地时区都可能命中（`isUtc` 由 `seed` 翻转决定）。
  Generator<DateTime> get arbitraryDateTime {
    return combine2<int, int, DateTime>(
      // 从 1970-01-01 到约 2050-01-01 的毫秒戳；上限取 2.5e12 ≈ 2049 年。
      intInRange(0, 2500000000), // 这里用 1/1000 缩放，乘回毫秒后覆盖 ~79 年。
      intInRange(0, 1 << 30), // 用于决定 isUtc 翻转的 seed
      (millisInThousands, seed) {
        final rng = math.Random(seed);
        final isUtc = rng.nextBool();
        final ms = millisInThousands * 1000;
        final dt = DateTime.fromMillisecondsSinceEpoch(ms, isUtc: isUtc);
        return dt;
      },
    );
  }

  /// 随机 UTC 偏移：[-12:00, +14:00]，分钟粒度。
  Generator<Duration> get arbitraryTimezone {
    return intInRange(-720, 840 + 1).map((m) => Duration(minutes: m));
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 测试主体
// ──────────────────────────────────────────────────────────────────────────

void main() {
  group('Property 11: 重新生成 Current Time 等于原消息 createdAt', () {
    Glados3<DateTime, DateTime, Duration>(
      any.arbitraryDateTime,
      any.arbitraryDateTime,
      any.arbitraryTimezone,
      ExploreConfig(numRuns: 100),
    ).test(
      'regenerateAt = originalCreatedAt 时，结果等于 formatInTimezone(originalCreatedAt, tz)，与 now 无关',
      (originalCreatedAt, now, tz) {
        // 重新生成路径：传入 originalCreatedAt 作为 regenerateAt。
        final actual = resolveCurrentTimeContext(
          regenerateAt: originalCreatedAt,
          now: now,
          tz: tz,
        );

        // 期望：与原消息 createdAt 在该时区的格式化结果完全一致。
        final expected = formatInTimezone(originalCreatedAt, tz);

        expect(
          actual,
          expected,
          reason:
              '重新生成时 Current Time 应锁定到原消息 createdAt：'
              'regenerateAt=$originalCreatedAt，now=$now，tz=$tz，'
              '实际=$actual，期望=$expected',
        );

        // 与 now 完全无关：再用一个差异极大的 now2 重新解析，结果必须相等。
        final now2 = now.add(const Duration(days: 365 * 7 + 13));
        final actualWithDifferentNow = resolveCurrentTimeContext(
          regenerateAt: originalCreatedAt,
          now: now2,
          tz: tz,
        );
        expect(
          actualWithDifferentNow,
          actual,
          reason:
              '重新生成结果不应受 now 影响：'
              'now=$now → $actual，now2=$now2 → $actualWithDifferentNow',
        );
      },
    );

    // 配套对照：regenerateAt 为 null 时退化到「当前时间」分支。
    Glados2<DateTime, Duration>(
      any.arbitraryDateTime,
      any.arbitraryTimezone,
      ExploreConfig(numRuns: 100),
    ).test(
      'regenerateAt = null 时，结果退化为 formatInTimezone(now, tz)',
      (now, tz) {
        final actual = resolveCurrentTimeContext(
          regenerateAt: null,
          now: now,
          tz: tz,
        );
        final expected = formatInTimezone(now, tz);
        expect(
          actual,
          expected,
          reason:
              '常规生成路径应以 now 作为 Current Time：'
              'now=$now，tz=$tz，实际=$actual，期望=$expected',
        );
      },
    );
  });
}
