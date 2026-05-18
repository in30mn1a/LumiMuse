import 'package:flutter/material.dart';
import 'package:flutter_animate/flutter_animate.dart';

/// 消息出现动画包装器
///
/// 为新消息提供平滑的入场动画效果：
/// - translateY(8px → 0) + opacity(0 → 1) 并行播放
/// - 时长 300ms，缓动 Curves.easeOut
/// - 支持 stagger 错开动画（连续消息依次入场）
/// - 支持跳过动画（初始加载/分页加载/辅助功能设置）
/// - 流式消息通过 key 确保只在首次插入时触发一次动画
class MessageAnimationWrapper extends StatelessWidget {
  /// 子组件（消息气泡）
  final Widget child;

  /// 是否执行动画（false = 跳过动画，用于初始加载/分页加载）
  final bool shouldAnimate;

  /// 用于计算 stagger 延迟的索引
  final int staggerIndex;

  /// 相邻消息动画起始时间间隔（默认 50ms）
  final Duration staggerDelay;

  const MessageAnimationWrapper({
    super.key,
    required this.child,
    this.shouldAnimate = true,
    this.staggerIndex = 0,
    this.staggerDelay = const Duration(milliseconds: 50),
  });

  @override
  Widget build(BuildContext context) {
    // 不需要动画时直接返回子组件
    if (!shouldAnimate) {
      return child;
    }

    // 检测辅助功能"减少动态效果"设置
    final mediaQuery = MediaQuery.of(context);
    if (mediaQuery.disableAnimations) {
      return child;
    }

    // 计算 stagger 延迟：索引 × 每条间隔
    final delay = staggerDelay * staggerIndex;

    // 使用 flutter_animate 实现 translateY + opacity 并行动画
    return child
        .animate()
        .fadeIn(
          duration: const Duration(milliseconds: 300),
          curve: Curves.easeOut,
          delay: delay,
        )
        .moveY(
          begin: 8,
          end: 0,
          duration: const Duration(milliseconds: 300),
          curve: Curves.easeOut,
          delay: delay,
        );
  }
}
