import 'dart:async';

import 'package:flutter/material.dart';

import 'app_theme.dart';

/// 自定义紫色细滚动条 — 支持滚动与 hover 透明度状态
class LumiScrollbar extends StatefulWidget {
  final Widget child;
  final ScrollController? controller;

  const LumiScrollbar({
    super.key,
    required this.child,
    this.controller,
  });

  @override
  State<LumiScrollbar> createState() => _LumiScrollbarState();
}

class _LumiScrollbarState extends State<LumiScrollbar> {
  static const _idleAlpha = 0.3;
  static const _scrollingAlpha = 0.7;
  static const _hoverAlpha = 0.9;

  Timer? _idleTimer;
  bool _hovering = false;
  bool _scrolling = false;

  @override
  void dispose() {
    _idleTimer?.cancel();
    super.dispose();
  }

  bool _handleScrollNotification(ScrollNotification notification) {
    if (notification is ScrollStartNotification ||
        notification is ScrollUpdateNotification ||
        notification is OverscrollNotification) {
      _markScrolling();
    }
    if (notification is ScrollEndNotification) {
      _scheduleIdle();
    }
    return false;
  }

  void _markScrolling() {
    _idleTimer?.cancel();
    if (!_scrolling && mounted) {
      setState(() => _scrolling = true);
    }
    _scheduleIdle();
  }

  void _scheduleIdle() {
    _idleTimer?.cancel();
    _idleTimer = Timer(const Duration(milliseconds: 800), () {
      if (!mounted) return;
      setState(() => _scrolling = false);
    });
  }

  double get _alpha {
    if (_hovering) return _hoverAlpha;
    if (_scrolling) return _scrollingAlpha;
    return _idleAlpha;
  }

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final thumbColor = isDark ? AppTheme.darkAccent : AppTheme.accent;

    return MouseRegion(
      onEnter: (_) => setState(() => _hovering = true),
      onExit: (_) => setState(() => _hovering = false),
      child: NotificationListener<ScrollNotification>(
        onNotification: _handleScrollNotification,
        child: RawScrollbar(
          controller: widget.controller,
          thumbColor: thumbColor.withValues(alpha: _alpha),
          trackColor: Colors.transparent,
          trackBorderColor: Colors.transparent,
          thickness: 6,
          radius: const Radius.circular(3),
          thumbVisibility: true,
          child: widget.child,
        ),
      ),
    );
  }
}
