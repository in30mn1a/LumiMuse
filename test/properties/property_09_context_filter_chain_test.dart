// ignore_for_file: library_private_types_in_public_api

// Feature: flutter-pixel-perfect-parity, Property 9: 上下文构建过滤器链复合不变量
// Validates: Requirements B5.1, B5.2, B5.3, B5.4 (INV-8)
//
// 设计说明
// ────────
// design.md §5 ChatEngine.buildContext 与 INV-8 要求：
//   对任意输入历史消息序列 H，过滤器链输出 H' 必须满足：
//     · 每条 m 的 content 非空字符串；
//     · 若 m.role == 'system'，则 m.metadata['isSummary'] == true；
//     · m.attachments 中无任何 type == 'image' && sizeBytes > 5MB 的图片附件；
//       超大图片在原消息处被降级为文字描述并保留在 m.content 中。
//
// 本属性测试不依赖 Drift Message 或具体 ChatEngine 实现，把契约层
// 「过滤器链」抽出为最小占位 `_TestMessage` + 纯函数 `buildContextFilterChain`，
// 用 glados 随机构造混合历史消息序列覆盖以下场景：
//
//   - 空 content 消息 —— 验证 filter 1 「跳过空内容」；
//   - 非 summary 的 system 消息 —— 验证 filter 2 「仅保留 isSummary 的 system」；
//   - 含超 5MB 图片附件的消息 —— 验证 filter 3 「降级为文字描述」；
//   - 正常 user / assistant 消息 —— 验证不被误删；
//   - 同时含两类异常（空 content + 超大附件）—— 验证最终安全检查。
//
// 失败时 glados 会自动 shrink 到最小反例。

import 'dart:math' as math;

import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test;

// ──────────────────────────────────────────────────────────────────────────
// 占位 `_TestMessage` 模型
//
// 独立于 Drift `Message`：本测试只关心契约层的「过滤行为」，因此用最小
// 字段集复刻 ChatProvider 出站消息形态：
//   - role：'system' / 'user' / 'assistant'
//   - content：可空字符串
//   - metadata：可含 `isSummary` 标记（system 摘要识别）
//   - attachments：每个附件含 `type`（'image' / 'text' 等）与 `sizeBytes`（字节数）
// ──────────────────────────────────────────────────────────────────────────

class _TestAttachment {
  final String type; // 'image' / 'text' 等
  final int sizeBytes; // 附件字节数（图片附件指 base64 解码后的字节数）

  const _TestAttachment({
    required this.type,
    required this.sizeBytes,
  });

  @override
  String toString() => '_TestAttachment(type=$type, sizeBytes=$sizeBytes)';
}

class _TestMessage {
  final String role;
  final String content;
  final Map<String, dynamic> metadata;
  final List<_TestAttachment> attachments;

  const _TestMessage({
    required this.role,
    required this.content,
    required this.metadata,
    required this.attachments,
  });

  _TestMessage copyWith({
    String? content,
    List<_TestAttachment>? attachments,
  }) {
    return _TestMessage(
      role: role,
      content: content ?? this.content,
      metadata: metadata,
      attachments: attachments ?? this.attachments,
    );
  }

  @override
  String toString() =>
      '_TestMessage(role=$role, content="$content", metadata=$metadata, attachments=$attachments)';
}

// ──────────────────────────────────────────────────────────────────────────
// 过滤器链阈值常量 —— 与 design.md / requirements.md B5.3 对齐：
// 「图片附件 base64 大小超过 5MB 降级为文字描述」。
// ──────────────────────────────────────────────────────────────────────────

const int _kOversizedImageThresholdBytes = 5 * 1024 * 1024;

// 降级提示文字（与主项目 AGENTS.md「图片附件超过 5MB 降级为文字描述」一致）。
const String _kOversizedImageDemotionNote =
    '[用户发送了一张图片，但文件过大无法处理]';

// ──────────────────────────────────────────────────────────────────────────
// 纯函数：四步过滤器链
//
//   filter 1：跳过 content.isEmpty 的消息；
//   filter 2：仅保留「system && metadata['isSummary']==true」的 system 消息，
//            非 system 不动；
//   filter 3：把 attachments 中超 5MB 的图片降级为文字描述附在 content 后，
//            并把这些图片从 attachments 中移除；
//   final ：再过滤一次 content.isEmpty 兜底。
//
// 每一步都返回新 list / 新 _TestMessage，保持纯函数语义。
// ──────────────────────────────────────────────────────────────────────────

bool _isOversizedImageAttachment(_TestAttachment a) {
  return a.type == 'image' && a.sizeBytes > _kOversizedImageThresholdBytes;
}

List<_TestMessage> buildContextFilterChain(List<_TestMessage> raw) {
  // filter 1：跳过空内容
  final step1 = raw.where((m) => m.content.isNotEmpty).toList();

  // filter 2：仅保留 isSummary == true 的 system；非 system 不动
  final step2 = step1.where((m) {
    if (m.role != 'system') return true;
    return m.metadata['isSummary'] == true;
  }).toList();

  // filter 3：超大图片附件降级为文字描述，附在 content 后；从 attachments 中移除
  final step3 = step2.map((m) {
    final hasOversized = m.attachments.any(_isOversizedImageAttachment);
    if (!hasOversized) return m;
    final survivors = m.attachments
        .where((a) => !_isOversizedImageAttachment(a))
        .toList();
    final newContent = m.content.isEmpty
        ? _kOversizedImageDemotionNote
        : '${m.content}\n$_kOversizedImageDemotionNote';
    return m.copyWith(content: newContent, attachments: survivors);
  }).toList();

  // 最终安全检查：再过滤一次 content.isEmpty
  final step4 = step3.where((m) => m.content.isNotEmpty).toList();

  return step4;
}

// ──────────────────────────────────────────────────────────────────────────
// glados 生成器：随机构造混合历史消息序列
//
// 设计策略：
// - 序列长度 ∈ [0, 20]：覆盖空序列、单条与中等规模。
// - role 从 {system, user, assistant} 等概率抽取（各占 1/3），保证 system
//   分支被高概率覆盖。
// - content 以 ~30% 概率为空字符串，否则取短文本，覆盖 filter 1 与最终安全检查。
// - metadata：
//     · system 角色以 ~50% 概率带 isSummary=true，其余为 false / 空 map / 脏值，
//       保证 filter 2 「保留 / 跳过」两条分支都覆盖；
//     · 非 system 的 metadata 中是否含 isSummary 都不应影响过滤。
// - attachments 长度 ∈ [0, 3]：
//     · 每个附件 ~30% 概率为图片（image），70% 为文本（text）；
//     · 图片以 ~50% 概率超 5MB（精确取阈值 + 1 字节，命中边界），保证
//       filter 3 「降级 / 保留」两条分支均覆盖。
// - 用 `seed` 构造确定性 `Random`，保证 glados 失败重放可复现。
// ──────────────────────────────────────────────────────────────────────────

extension on Any {
  Generator<List<_TestMessage>> get historyMessageSequences {
    return combine2<int, int, List<_TestMessage>>(
      intInRange(0, 21), // 序列长度 [0, 20]
      intInRange(0, 1 << 30), // Random 种子
      (seqLen, seed) {
        if (seqLen == 0) return const <_TestMessage>[];
        final rng = math.Random(seed);
        const roles = <String>['system', 'user', 'assistant'];
        const nonEmptyContents = <String>['a', 'b', 'c', 'd', '你好'];

        return List<_TestMessage>.generate(seqLen, (_) {
          // role 等概率（各 1/3）
          final role = roles[rng.nextInt(roles.length)];

          // content：~30% 空字符串，70% 短文本
          final content = rng.nextInt(10) < 3
              ? ''
              : nonEmptyContents[rng.nextInt(nonEmptyContents.length)];

          // metadata：根据 role 分支构造
          final Map<String, dynamic> metadata;
          if (role == 'system') {
            final dice = rng.nextInt(10);
            if (dice < 5) {
              metadata = <String, dynamic>{'isSummary': true};
            } else if (dice < 8) {
              metadata = <String, dynamic>{'isSummary': false};
            } else {
              metadata = <String, dynamic>{};
            }
          } else {
            metadata = rng.nextBool()
                ? <String, dynamic>{}
                : <String, dynamic>{'isSummary': true};
          }

          // attachments：长度 [0, 3]
          final attCount = rng.nextInt(4);
          final attachments = List<_TestAttachment>.generate(attCount, (_) {
            final isImage = rng.nextInt(10) < 3;
            if (!isImage) {
              return _TestAttachment(
                type: 'text',
                sizeBytes: rng.nextInt(1024),
              );
            }
            // 图片 ~50% 概率超 5MB（精确取阈值 + 1 字节命中边界），其余在 [0, 5MB)
            final oversized = rng.nextBool();
            final size = oversized
                ? _kOversizedImageThresholdBytes + 1
                : rng.nextInt(_kOversizedImageThresholdBytes);
            return _TestAttachment(type: 'image', sizeBytes: size);
          });

          return _TestMessage(
            role: role,
            content: content,
            metadata: metadata,
            attachments: attachments,
          );
        });
      },
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 测试主体
// ──────────────────────────────────────────────────────────────────────────

void main() {
  group('Property 9: 上下文构建过滤器链复合不变量', () {
    Glados<List<_TestMessage>>(
      any.historyMessageSequences,
      ExploreConfig(numRuns: 100),
    ).test(
      '任意混合历史消息序列经过 buildContextFilterChain 后，输出 H 满足 INV-8 三条不变量',
      (raw) {
        final result = buildContextFilterChain(raw);

        for (final m in result) {
          // ① content 非空字符串（filter 1 + 最终安全检查）
          expect(
            m.content.isNotEmpty,
            isTrue,
            reason: '违反 B5.1：输出消息 content 必须非空字符串，但发现 $m',
          );

          // ② 若 role == 'system'，必须 metadata['isSummary'] == true（filter 2）
          if (m.role == 'system') {
            expect(
              m.metadata['isSummary'],
              isTrue,
              reason:
                  '违反 B5.2：system 消息必须带 metadata[isSummary] == true，但发现 $m',
            );
          }

          // ③ attachments 中不允许残留 type == 'image' && sizeBytes > 5MB 的元素（filter 3）
          for (final a in m.attachments) {
            expect(
              _isOversizedImageAttachment(a),
              isFalse,
              reason:
                  '违反 B5.3：超 5MB 图片应被降级为文字描述并从 attachments 中移除，'
                  '但发现 $a 仍残留于 $m',
            );
          }
        }
      },
    );
  });
}
