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

/// 判断是否为 CJK 字符
bool _isCjk(int rune) {
  return (rune >= 0x4E00 && rune <= 0x9FFF) || // CJK 统一汉字
      (rune >= 0x3400 && rune <= 0x4DBF) || // CJK 扩展 A
      (rune >= 0x3000 && rune <= 0x303F) || // CJK 标点
      (rune >= 0xFF00 && rune <= 0xFFEF) || // 全角字符
      (rune >= 0x3040 && rune <= 0x309F) || // 平假名
      (rune >= 0x30A0 && rune <= 0x30FF); // 片假名
}
