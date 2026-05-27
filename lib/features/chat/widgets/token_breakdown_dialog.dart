import 'package:flutter/material.dart';
import '../../../core/utils/i18n.dart';
import '../../../theme/app_theme.dart';
import '../../../theme/surfaces.dart';

/// Token 拆分弹窗 — 严格 1:1 对照
/// src/components/chat/TokenBreakdownModal.tsx。
///
/// 展示当前会话发给 LLM 的上下文中各组成部分的 token 估算与占比。
///
/// 视觉契约（每处都对应 TSX 中的 className）：
/// - Modal max-w-md ≈ 448 宽度；surface-panel p-5
/// - 标题 `t('token.breakdownTitle')`；副标题 `text-xs text-text-muted`
/// - 每项：`flex items-baseline justify-between gap-2 text-sm`
///   - 左：label + 可选 detail（`text-[11px] text-text-muted (xxx)`）
///   - 右：`≈{tokens} t('status.tokens') {percent}%`
///   - 下方进度条：`h-1.5 rounded-full bg-gradient-to-r from-accent to-accent-dark`
/// - 底部分割线 + 合计：`border-t border-border-light pt-3`
///
/// 入参：[TokenBreakdownItem] 列表，按主项目"出现在 system prompt 中的顺序"排列；
/// 零 token 项也应保留，避免缺失误以为统计有 bug。

/// 单项 token 拆分数据（对照 TSX 中的 TokenBreakdownItem 接口）
class TokenBreakdownItem {
  /// 翻译键，例如 'token.systemPrompt'
  final String labelKey;

  /// 该项 token 数（estimateTokens 估算值）
  final int tokens;

  /// 可选副标题，例如记忆条目数 "12 条"
  final String? detail;

  const TokenBreakdownItem({
    required this.labelKey,
    required this.tokens,
    this.detail,
  });
}

/// 弹出 token 占比拆分弹窗。
///
/// 视觉/交互与 [showDeleteConversationDialog] 保持一致：
/// barrierColor 0x59000000，淡入 + ScaleTransition 0.96→1.0，180ms。
Future<void> showTokenBreakdownDialog(
  BuildContext context, {
  required List<TokenBreakdownItem> items,
  required String lang,
}) {
  return showGeneralDialog<void>(
    context: context,
    barrierDismissible: true,
    barrierLabel: I18n.t('chat.dialog.close', lang: lang),
    barrierColor: const Color(0x59000000), // bg-black/35
    transitionDuration: const Duration(milliseconds: 180),
    pageBuilder: (ctx, animation, secondary) {
      return _TokenBreakdownDialog(items: items, lang: lang);
    },
    transitionBuilder: (ctx, animation, secondary, child) {
      return FadeTransition(
        opacity: animation,
        child: ScaleTransition(
          scale: Tween<double>(begin: 0.96, end: 1.0).animate(
            CurvedAnimation(parent: animation, curve: Curves.easeOutCubic),
          ),
          child: child,
        ),
      );
    },
  );
}

class _TokenBreakdownDialog extends StatelessWidget {
  final List<TokenBreakdownItem> items;
  final String lang;

  const _TokenBreakdownDialog({required this.items, required this.lang});

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;

    // 占比基于 total = 各项之和（与 TSX 第 37 行 reduce 一致）
    int total = 0;
    for (final item in items) {
      total += item.tokens;
    }

    final borderLight =
        isDark ? AppTheme.darkBorderLight : AppTheme.borderLight;
    final textPrimary =
        isDark ? AppTheme.darkTextPrimary : AppTheme.textPrimary;
    final textSecondary =
        isDark ? AppTheme.darkTextSecondary : AppTheme.textSecondary;
    final textMuted = isDark ? AppTheme.darkTextMuted : AppTheme.textMuted;
    final tokensLabel = I18n.t('status.tokens', lang: lang);

    return SafeArea(
      child: Center(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 448), // max-w-md
            child: Material(
              color: Colors.transparent,
              child: Container(
                decoration: AppSurfaces.panel(isDark: isDark),
                padding: const EdgeInsets.all(20), // p-5
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    // ── 标题 section-title text-xl ──
                    Text(
                      I18n.t('token.breakdownTitle', lang: lang),
                      style: TextStyle(
                        fontSize: 20, // text-xl
                        height: 1.18,
                        fontWeight: FontWeight.w600,
                        color: textPrimary,
                      ),
                    ),
                    const SizedBox(height: 12), // space-y-3 ≈ 12

                    // ── 顶部说明 text-xs text-text-muted ──
                    Text(
                      I18n.t('token.breakdownHint', lang: lang),
                      style: TextStyle(
                        fontSize: 12, // text-xs
                        height: 1.5,
                        color: textMuted,
                      ),
                    ),
                    const SizedBox(height: 12),

                    // ── 列表 space-y-2 ──
                    Flexible(
                      child: SingleChildScrollView(
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            for (int i = 0; i < items.length; i++) ...[
                              if (i > 0) const SizedBox(height: 8), // space-y-2
                              _BreakdownRow(
                                item: items[i],
                                total: total,
                                isDark: isDark,
                                lang: lang,
                                textPrimary: textPrimary,
                                textSecondary: textSecondary,
                                textMuted: textMuted,
                                tokensLabel: tokensLabel,
                              ),
                            ],
                          ],
                        ),
                      ),
                    ),
                    const SizedBox(height: 12),

                    // ── 分割线 + 合计 ──
                    Container(
                      decoration: BoxDecoration(
                        border: Border(
                          top: BorderSide(color: borderLight),
                        ),
                      ),
                      padding: const EdgeInsets.only(top: 12), // pt-3
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.baseline,
                        textBaseline: TextBaseline.alphabetic,
                        children: [
                          Expanded(
                            child: Text(
                              I18n.t('token.total', lang: lang),
                              style: TextStyle(
                                fontSize: 14, // text-sm
                                fontWeight: FontWeight.w500, // font-medium
                                color: textPrimary,
                              ),
                            ),
                          ),
                          RichText(
                            text: TextSpan(
                              style: TextStyle(
                                fontSize: 14,
                                color: textPrimary,
                                fontFeatures: const [
                                  FontFeature.tabularFigures(),
                                ],
                              ),
                              children: [
                                TextSpan(text: '≈$total '),
                                TextSpan(
                                  text: tokensLabel,
                                  style: TextStyle(
                                    fontSize: 11,
                                    color: textMuted,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// 单行进度条 + 标签 — 对照 TSX 第 45~67 行
class _BreakdownRow extends StatelessWidget {
  final TokenBreakdownItem item;
  final int total;
  final bool isDark;
  final String lang;
  final Color textPrimary;
  final Color textSecondary;
  final Color textMuted;
  final String tokensLabel;

  const _BreakdownRow({
    required this.item,
    required this.total,
    required this.isDark,
    required this.lang,
    required this.textPrimary,
    required this.textSecondary,
    required this.textMuted,
    required this.tokensLabel,
  });

  @override
  Widget build(BuildContext context) {
    final percent = total > 0 ? (item.tokens / total) * 100 : 0.0;
    final detail = item.detail;

    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // ── 第一行：label + tokens/percent ──
        Row(
          crossAxisAlignment: CrossAxisAlignment.baseline,
          textBaseline: TextBaseline.alphabetic,
          children: [
            Expanded(
              child: RichText(
                text: TextSpan(
                  style: TextStyle(
                    fontSize: 14, // text-sm
                    color: textPrimary,
                  ),
                  children: [
                    TextSpan(text: I18n.t(item.labelKey, lang: lang)),
                    if (detail != null && detail.isNotEmpty)
                      TextSpan(
                        text: ' ($detail)',
                        style: TextStyle(
                          fontSize: 11, // text-[11px]
                          color: textMuted,
                        ),
                      ),
                  ],
                ),
              ),
            ),
            const SizedBox(width: 8),
            RichText(
              text: TextSpan(
                style: TextStyle(
                  fontSize: 14,
                  color: textSecondary,
                  fontFeatures: const [FontFeature.tabularFigures()],
                ),
                children: [
                  TextSpan(text: '≈${item.tokens} '),
                  TextSpan(
                    text: tokensLabel,
                    style: TextStyle(fontSize: 11, color: textMuted),
                  ),
                  const TextSpan(text: '  '),
                  TextSpan(
                    text: '${percent.toStringAsFixed(1)}%',
                    style: TextStyle(fontSize: 11, color: textMuted),
                  ),
                ],
              ),
            ),
          ],
        ),
        const SizedBox(height: 4), // gap-1
        // ── 第二行：进度条 h-1.5 rounded-full ──
        ClipRRect(
          borderRadius: BorderRadius.circular(999),
          child: Container(
            height: 6, // h-1.5 ≈ 6px
            color: isDark
                ? Colors.white.withValues(alpha: 0.10) // dark:bg-white/10
                : Colors.black.withValues(alpha: 0.05), // bg-black/5
            child: Align(
              alignment: Alignment.centerLeft,
              child: FractionallySizedBox(
                widthFactor: (percent / 100).clamp(0.0, 1.0),
                child: Container(
                  decoration: BoxDecoration(
                    gradient: LinearGradient(
                      begin: Alignment.centerLeft,
                      end: Alignment.centerRight,
                      colors: isDark
                          ? const [AppTheme.darkAccent, AppTheme.darkAccentDark]
                          : const [AppTheme.accent, AppTheme.accentDark],
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }
}
