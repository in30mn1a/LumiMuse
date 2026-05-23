import 'dart:convert';
import 'dart:io';

import 'package:characters/characters.dart';
import 'package:lumimuse/core/models/attachment_item.dart';
import 'package:path/path.dart' as p;

/// 附件处理工具 — 负责文件验证、编码和多模态内容构建
///
/// 提供静态方法处理聊天附件的各种场景：
/// - 文件大小验证（≤10MB）
/// - 图片转 base64 编码（≤5MB 限制）
/// - 文本文件读取与截断（≤50000 字符）
/// - 构建 vision API 多模态内容格式
class AttachmentProcessor {
  /// 文件大小上限：10MB
  static const maxFileSize = 10 * 1024 * 1024;

  /// 图片 base64 编码大小上限：5MB
  static const maxBase64Size = 5 * 1024 * 1024;

  /// 文本文件内容截断阈值：50000 字符
  static const maxTextLength = 50000;

  /// 图片过大时的降级文字描述
  static const imageTooLargeDescription = '[用户发送了一张图片，但文件过大无法处理]';

  /// 文本截断时追加的提示
  static const truncationNotice = '\n...[内容已截断，原文超过 50000 字符]';

  // ─────────────────────────────────────────────
  // 验证方法
  // ─────────────────────────────────────────────

  /// 验证文件大小是否在允许范围内（≤10MB）
  ///
  /// [bytes] 文件大小（字节数）
  /// 返回 true 表示文件大小合规，false 表示超出限制。
  static bool validateFileSize(int bytes) => bytes <= maxFileSize;

  // ─────────────────────────────────────────────
  // 编码方法
  // ─────────────────────────────────────────────

  // ─────────────────────────────────────────────
  // 内部工具
  // ─────────────────────────────────────────────

  /// 校验文件路径基本合法性：非空、规范化后不含 `..` 路径遍历段
  ///
  /// 返回规范化后的绝对路径；不合法时返回 null。
  /// 注意：image_picker / file_picker 平台返回的都是绝对路径，
  /// 这里做最低限度的防御，避免恶意构造的 metadata 引用沙箱外文件。
  static String? _safeNormalizePath(String filePath) {
    if (filePath.isEmpty) return null;
    final normalized = p.normalize(p.absolute(filePath));
    final segments = p.split(normalized);
    if (segments.contains('..')) return null;
    return normalized;
  }

  // ─────────────────────────────────────────────
  // 编码方法
  // ─────────────────────────────────────────────

  /// 将图片文件编码为 base64 字符串
  ///
  /// 读取 [filePath] 指定的图片文件，编码为 base64。
  /// 如果编码后的 base64 字符串大小超过 5MB，返回 null 表示需要降级处理。
  /// 路径不合法（空、含 `..`）时同样返回 null。
  ///
  /// 返回 base64 编码字符串，或 null（超过 5MB 限制 / 路径非法时）。
  static Future<String?> imageToBase64(String filePath) async {
    final safePath = _safeNormalizePath(filePath);
    if (safePath == null) return null;

    final file = File(safePath);
    final bytes = await file.readAsBytes();
    final base64Str = base64Encode(bytes);

    // 检查 base64 字符串大小是否超过 5MB
    if (base64Str.length > maxBase64Size) {
      return null;
    }

    return base64Str;
  }

  /// 读取文本文件内容，超过 50000 字符时截断
  ///
  /// 输出格式为 "[附件: {fileName}]\n{content}"。
  /// 如果文件内容超过 50000 字符，仅保留前 50000 个字符并追加截断提示。
  /// 截断按 Unicode 字素簇（grapheme cluster）切分，避免在代理对中间断开。
  ///
  /// [filePath] 文本文件路径
  /// [fileName] 文件名（用于格式化输出标题）
  ///
  /// 路径非法或文件以非 UTF-8 编码存储时，会降级用 `latin1` 解码字节流，
  /// 保证调用方始终得到字符串而不是抛 `FormatException`。
  static Future<String> readTextFile(String filePath, {String? fileName}) async {
    final safePath = _safeNormalizePath(filePath);
    if (safePath == null) {
      final name = fileName ?? '<invalid path>';
      return '[附件: $name]\n[路径不合法，已拒绝读取]';
    }

    final file = File(safePath);
    final name = fileName ?? file.uri.pathSegments.last;

    String content;
    try {
      content = await file.readAsString();
    } on FormatException {
      // 非 UTF-8 编码：降级为字节读取后用 latin1 解码（lossless 字节透传）
      try {
        final bytes = await file.readAsBytes();
        content = latin1.decode(bytes, allowInvalid: true);
      } catch (e) {
        return '[附件: $name]\n[文件读取失败：$e]';
      }
    } catch (e) {
      return '[附件: $name]\n[文件读取失败：$e]';
    }

    // 超过阈值时按字素簇截断并追加提示，避免切断 surrogate pair 或组合字符
    if (content.length > maxTextLength) {
      final truncated = content.characters.take(maxTextLength).toString();
      content = truncated + truncationNotice;
    }

    return '[附件: $name]\n$content';
  }

  // ─────────────────────────────────────────────
  // 多模态内容构建
  // ─────────────────────────────────────────────

  /// 构建 vision API 多模态内容
  ///
  /// 将用户文本和附件列表组装为 LLM vision API 所需的多模态内容格式。
  /// - 文本部分作为 type: "text" 条目
  /// - 图片附件编码为 base64 后作为 type: "image_url" 条目
  /// - 超过 5MB 的图片降级为文字描述
  /// - 文本附件的内容已在调用前追加到 text 参数中
  ///
  /// [text] 用户消息文本（可能已包含文本附件内容）
  /// [attachments] 附件列表
  static Future<List<Map<String, dynamic>>> buildMultimodalContent(
    String text,
    List<AttachmentItem> attachments,
  ) async {
    final content = <Map<String, dynamic>>[];

    // 添加文本部分
    if (text.isNotEmpty) {
      content.add({
        'type': 'text',
        'text': text,
      });
    }

    // 处理图片附件
    for (final attachment in attachments) {
      if (attachment.type != AttachmentType.image) continue;

      final base64Str = await imageToBase64(attachment.filePath);

      if (base64Str != null) {
        // 图片大小合规，使用 base64 编码
        content.add({
          'type': 'image_url',
          'image_url': {
            'url': 'data:${attachment.mimeType};base64,$base64Str',
          },
        });
      } else {
        // 图片过大，降级为文字描述
        content.add({
          'type': 'text',
          'text': imageTooLargeDescription,
        });
      }
    }

    return content;
  }
}
