import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/painting.dart';
import 'package:path/path.dart' as p;

/// 图片工具模块 — 提供文件格式验证、大小验证和缩放功能
///
/// 用于角色头像上传等场景，确保图片符合要求后再进行裁剪和保存。
class ImageUtils {
  /// 支持的图片格式扩展名（小写）
  static const supportedExtensions = {'.jpg', '.jpeg', '.png', '.webp'};

  /// 支持的 MIME 类型
  static const supportedMimeTypes = {
    'image/jpeg',
    'image/png',
    'image/webp',
  };

  /// 最大文件大小：10MB
  static const maxFileSizeBytes = 10 * 1024 * 1024;

  /// 头像输出尺寸
  static const avatarSize = 512;

  // ─────────────────────────────────────────────
  // 验证方法（纯函数，方便测试）
  // ─────────────────────────────────────────────

  /// 验证文件格式是否支持
  ///
  /// 通过文件扩展名判断，仅接受 JPEG、PNG、WebP 格式。
  /// 返回 null 表示验证通过，返回错误信息字符串表示不通过。
  static String? validateFormat(String filePath) {
    final ext = p.extension(filePath).toLowerCase();
    if (!supportedExtensions.contains(ext)) {
      return '仅支持 JPEG、PNG、WebP 格式的图片';
    }
    return null;
  }

  /// 验证文件大小是否在限制范围内
  ///
  /// 文件大小不得超过 10MB（10 × 1024 × 1024 字节）。
  /// 返回 null 表示验证通过，返回错误信息字符串表示不通过。
  static String? validateFileSize(int fileSizeBytes) {
    if (fileSizeBytes > maxFileSizeBytes) {
      return '文件大小不能超过 10MB';
    }
    return null;
  }

  /// 综合验证文件格式和大小
  ///
  /// 依次检查格式和大小，返回第一个不通过的错误信息。
  /// 返回 null 表示全部验证通过。
  static String? validateFile(String filePath, int fileSizeBytes) {
    final formatError = validateFormat(filePath);
    if (formatError != null) return formatError;

    final sizeError = validateFileSize(fileSizeBytes);
    if (sizeError != null) return sizeError;

    return null;
  }

  // ─────────────────────────────────────────────
  // 图片处理方法
  // ─────────────────────────────────────────────

  /// 将图片缩放为 512×512 PNG 格式
  ///
  /// 先按短边 center-crop 裁切成正方形，再缩放到 512×512。
  /// 避免非方形原图被直接拉伸变形（如 1280×720 横图 → 压扁的头像）。
  ///
  /// 抛出异常：
  /// - [FileSystemException] 文件读取/写入失败
  /// - [Exception] 图片解码失败
  static Future<File> resizeToAvatarPng(
    String sourcePath,
    String outputPath,
  ) async {
    // 读取源文件字节
    final sourceFile = File(sourcePath);
    final bytes = await sourceFile.readAsBytes();

    // 解码图片
    final codec = await ui.instantiateImageCodec(bytes);
    final frame = await codec.getNextFrame();
    final sourceImage = frame.image;

    try {
      // 计算 center-crop 区域：按较短的边裁切成正方形
      final srcWidth = sourceImage.width.toDouble();
      final srcHeight = sourceImage.height.toDouble();
      final cropSize = srcWidth < srcHeight ? srcWidth : srcHeight;
      final offsetX = (srcWidth - cropSize) / 2;
      final offsetY = (srcHeight - cropSize) / 2;

      // 使用 Canvas 绘制 center-crop + 缩放后的图片
      final recorder = ui.PictureRecorder();
      final canvas = Canvas(recorder);

      final srcRect = Rect.fromLTWH(offsetX, offsetY, cropSize, cropSize);
      final dstRect = Rect.fromLTWH(
        0,
        0,
        avatarSize.toDouble(),
        avatarSize.toDouble(),
      );

      // 绘制缩放后的图片
      canvas.drawImageRect(sourceImage, srcRect, dstRect, Paint());

      // 生成图片
      final picture = recorder.endRecording();
      final resizedImage = await picture.toImage(avatarSize, avatarSize);

      // 编码为 PNG
      final pngData =
          await resizedImage.toByteData(format: ui.ImageByteFormat.png);
      if (pngData == null) {
        throw Exception('图片编码为 PNG 失败');
      }

      // 写入输出文件
      final outputFile = File(outputPath);
      await outputFile.parent.create(recursive: true);
      await outputFile.writeAsBytes(pngData.buffer.asUint8List());

      return outputFile;
    } finally {
      sourceImage.dispose();
    }
  }
}
