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
  static String buildTimeContext(DateTime dateTime) {
    final year = dateTime.year.toString().padLeft(4, '0');
    final month = dateTime.month.toString().padLeft(2, '0');
    final day = dateTime.day.toString().padLeft(2, '0');
    final hour = dateTime.hour.toString().padLeft(2, '0');
    final minute = dateTime.minute.toString().padLeft(2, '0');
    final weekday = weekdayName(dateTime.weekday);

    return '## Current Time\n'
        '当前用户本地时间是 $year-$month-$day $hour:$minute，$weekday。'
        '请根据这个时间来回答用户关于现实时间的问题，'
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
