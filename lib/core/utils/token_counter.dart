/// 简易 token 估算 — 与 Next.js 版保持一致的估算逻辑
/// 中文约 1 字 ≈ 1.5 token，英文约 4 字符 ≈ 1 token
int estimateTokens(String text) {
  if (text.isEmpty) return 0;

  int cjkCount = 0;
  int otherCount = 0;

  for (final rune in text.runes) {
    if (_isCjk(rune)) {
      cjkCount++;
    } else {
      otherCount++;
    }
  }

  // CJK 字符按 1.5 token/字估算，其他按 0.25 token/字符估算
  return (cjkCount * 1.5 + otherCount * 0.25).ceil();
}

/// 判断是否为「广义 CJK」字符
///
/// FIX: 名称沿用 `_isCjk`，但实际语义已扩展为「中日韩 + 兼容平面 + 扩展平面」。
/// 估算策略：所有这些字符都按 1.5 token/字算，与 Next.js 主项目保持一致。
///
/// 覆盖范围：
/// - 0x3000 - 0x303F  CJK 标点符号
/// - 0x3040 - 0x309F  日文平假名
/// - 0x30A0 - 0x30FF  日文片假名
/// - 0x3130 - 0x318F  韩文兼容字母（Hangul Compatibility Jamo）
/// - 0x3400 - 0x4DBF  CJK 扩展 A
/// - 0x4E00 - 0x9FFF  CJK 统一汉字（基本区）
/// - 0xAC00 - 0xD7AF  韩文音节（Hangul Syllables）
/// - 0xF900 - 0xFAFF  CJK 兼容汉字（Compatibility Ideographs）
/// - 0xFE30 - 0xFE4F  CJK 兼容标点（Compatibility Forms）
/// - 0xFF00 - 0xFFEF  全角/半角字符（含全角 ASCII、半角片假名）
/// - 0x1100 - 0x11FF  韩文字母（Hangul Jamo）
/// - 0x20000 - 0x2A6DF CJK 扩展 B（rune 是 codepoint，可直接判断）
/// - 0x2A700 - 0x2B73F CJK 扩展 C
/// - 0x2B740 - 0x2B81F CJK 扩展 D
/// - 0x2B820 - 0x2CEAF CJK 扩展 E
bool _isCjk(int rune) {
  return (rune >= 0x4E00 && rune <= 0x9FFF) || // CJK 统一汉字
      (rune >= 0x3400 && rune <= 0x4DBF) || // CJK 扩展 A
      (rune >= 0x3000 && rune <= 0x303F) || // CJK 标点
      (rune >= 0xFF00 && rune <= 0xFFEF) || // 全角字符
      (rune >= 0x3040 && rune <= 0x309F) || // 平假名
      (rune >= 0x30A0 && rune <= 0x30FF) || // 片假名
      // FIX: 以下范围为补充覆盖，修复 Hangul / 兼容 / 扩展 B+ 漏判
      (rune >= 0xAC00 && rune <= 0xD7AF) || // 韩文音节
      (rune >= 0x1100 && rune <= 0x11FF) || // 韩文字母（Hangul Jamo）
      (rune >= 0x3130 && rune <= 0x318F) || // 韩文兼容字母
      (rune >= 0xF900 && rune <= 0xFAFF) || // CJK 兼容汉字
      (rune >= 0xFE30 && rune <= 0xFE4F) || // CJK 兼容标点
      (rune >= 0x20000 && rune <= 0x2A6DF) || // CJK 扩展 B
      (rune >= 0x2A700 && rune <= 0x2B73F) || // CJK 扩展 C
      (rune >= 0x2B740 && rune <= 0x2B81F) || // CJK 扩展 D
      (rune >= 0x2B820 && rune <= 0x2CEAF); // CJK 扩展 E
}
