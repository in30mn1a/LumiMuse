/// 时间上下文构建器 — 为系统提示词生成时间段落，并处理 AI 回复中的时间戳前缀
///
/// 用于让 AI 感知当前时间，以便在对话中自然地回应与时间相关的话题。
/// 同时提供去除 AI 回复开头时间戳前缀的功能。
class TimeContextBuilder {
  /// 中文星期名映射（1=星期一 ... 7=星期日）
  static const _weekdayNames = <int, String>{
    1: '星期一',
    2: '星期二',
    3: '星期三',
    4: '星期四',
    5: '星期五',
    6: '星期六',
    7: '星期日',
  };

  /// 匹配 AI 回复开头的时间戳前缀
  ///
  /// 与 Node.js 主项目 `src/lib/strip-timestamp-prefix.ts` 的 `stripTimestampPrefix`
  /// 行为等价，支持秒级时间戳，并允许月份/日期为 1 或 2 位数字。
  ///
  /// 支持格式：
  /// - `[YYYY-M-D HH:mm]` / `[YYYY-MM-DD HH:mm]`
  /// - `[YYYY-MM-DD HH:mm:ss]`（秒级时间戳）
  /// - `[YYYY/M/D HH:mm]` / `[YYYY/MM/DD HH:mm]`
  /// - `[YYYY/MM/DD HH:mm:ss]`
  ///
  /// 前导空白：使用 `\s*` 仅匹配 ASCII 空白（与 Node.js 端 `\s` 行为一致），
  /// 全角空格不会被剥离，保留正文首尾的非 ASCII 字符。
  static final _timestampPrefixPattern = RegExp(
    r'^\s*\[\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?\]\s*',
  );

  // ─────────────────────────────────────────────
  // 公开方法
  // ─────────────────────────────────────────────

  /// 构建时间上下文段落文本。
  ///
  /// 与主项目 src/lib/chat-time.ts buildCurrentTimeInstruction 严格对齐。
  ///
  /// [dateTime] 通常为 `DateTime.now()`，重新生成时使用消息的 `created_at`。
  ///
  /// [timeZone]（IANA 时区名）/[utcOffsetMinutes]（UTC 偏移分钟数）用于对齐主项目
  /// getTimeParts：
  /// - 传入 [utcOffsetMinutes] 时，按「UTC 时刻 - 偏移」取 UTC 字段换算（对齐
  ///   formatPartsWithOffset）。
  /// - 传入 [timeZone] 时，Flutter 本地无 IANA 时区转换且无上报源，timeZone 暂回退本地，
  ///   保留参数以对齐主项目 API。
  /// - 两者都不传时使用本地时间字段。
  ///
  /// sourceLabel 逻辑对齐主项目 buildCurrentTimeInstruction：timeZone 优先，其次
  /// utcOffsetMinutes；当前 Flutter 本地无上报源，两者通常为 null、sourceLabel 为空。
  static String buildTimeContext(
    DateTime dateTime, {
    String? timeZone,
    int? utcOffsetMinutes,
  }) {
    final String year;
    final String month;
    final String day;
    final String hour;
    final String minute;
    final String weekday;

    if (timeZone != null) {
      // Flutter 本地无 IANA 时区转换且无上报源，timeZone 暂回退本地，保留参数以对齐主项目 API
      year = dateTime.year.toString().padLeft(4, '0');
      month = dateTime.month.toString().padLeft(2, '0');
      day = dateTime.day.toString().padLeft(2, '0');
      hour = dateTime.hour.toString().padLeft(2, '0');
      minute = dateTime.minute.toString().padLeft(2, '0');
      weekday = weekdayName(dateTime.weekday);
    } else if (utcOffsetMinutes != null) {
      // 时区偏移换算。注意符号约定的坑：
      // 主项目 chat-time.ts formatPartsWithOffset 用「getTime() - offset*60000」(减法)，
      // 但其 offset 来自 JS `getTimezoneOffset()`，语义是「UTC - 本地」(UTC+8 → -480)，
      // 减去负数等于加，最终得到正确的本地时间。
      // Flutter 端目前无上报源、本参数恒为 null（见 _buildSystemPrompt 调用处），
      // 此分支仅供未来接入时使用；为避免符号约定与主项目不一致导致结果反向，
      // 这里沿用「偏移量」语义(offset 为 UTC+8 → +480)并用加法，与下方现有测试
      // (test/core/utils/time_context_builder_test.dart) 约定一致。真正接入上报源时
      // 须连符号约定一起对齐主项目（ getTimezoneOffset 语义 + 减法）。
      final shifted = dateTime.toUtc().add(
        Duration(minutes: utcOffsetMinutes),
      );
      year = shifted.year.toString().padLeft(4, '0');
      month = shifted.month.toString().padLeft(2, '0');
      day = shifted.day.toString().padLeft(2, '0');
      hour = shifted.hour.toString().padLeft(2, '0');
      minute = shifted.minute.toString().padLeft(2, '0');
      weekday = weekdayName(shifted.weekday);
    } else {
      year = dateTime.year.toString().padLeft(4, '0');
      month = dateTime.month.toString().padLeft(2, '0');
      day = dateTime.day.toString().padLeft(2, '0');
      hour = dateTime.hour.toString().padLeft(2, '0');
      minute = dateTime.minute.toString().padLeft(2, '0');
      weekday = weekdayName(dateTime.weekday);
    }

    final sourceLabel = timeZone != null
        ? '（用户时区：$timeZone）'
        : utcOffsetMinutes != null
        ? '（用户 UTC 偏移：$utcOffsetMinutes 分钟）'
        : '';

    return '## Current Time\n'
        '当前用户本地时间是 $year-$month-$day $hour:$minute，$weekday$sourceLabel。'
        '如果用户询问现在几点、今天几号、星期几等现实时间问题，'
        '必须严格依据这个时间回答，不要猜测，也不要引用其他日期。';
  }

  /// 获取中文星期名
  ///
  /// [weekday] 取值 1–7，对应 Dart 的 `DateTime.weekday`（1=星期一，7=星期日）。
  /// 传入无效值时返回空字符串。
  static String weekdayName(int weekday) {
    return _weekdayNames[weekday] ?? '';
  }

  /// 去除 AI 回复开头的时间戳前缀
  ///
  /// 匹配并移除形如 `[YYYY-MM-DD HH:mm]` 或 `[YYYY/MM/DD HH:mm]`（含可选秒数 `:ss`）的前缀。
  /// 若无匹配前缀则原样返回。
  static String stripTimestampPrefix(String text) {
    return text.replaceFirst(_timestampPrefixPattern, '');
  }
}
