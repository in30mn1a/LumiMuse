// 图片文件验证属性测试
// Feature: flutter-visual-polish, Property 5: Image file validation
// Validates: Requirements 8.3, 8.9

import 'package:glados/glados.dart';
import 'package:lumimuse/core/utils/image_utils.dart';

/// 有效的图片扩展名
final _validExtensions = ['.jpg', '.jpeg', '.png', '.webp'];

/// 无效的图片扩展名
final _invalidExtensions = [
  '.gif',
  '.bmp',
  '.tiff',
  '.svg',
  '.ico',
  '.raw',
  '.heic',
  '.avif',
  '.pdf',
  '.txt',
  '.mp4',
  '.doc',
  '',
];

/// 所有可能的扩展名（有效 + 无效）
final _allExtensions = [..._validExtensions, ..._invalidExtensions];

/// 最大文件大小常量：10MB
const _maxFileSize = 10 * 1024 * 1024;

void main() {
  // Tag: Feature: flutter-visual-polish, Property 5: Image file validation
  group('Property 5: Image file validation', tags: [
    'flutter-visual-polish',
    'image-file-validation',
  ], () {
    // ─────────────────────────────────────────────
    // 属性测试：格式验证
    // 验证有效格式被接受，无效格式被拒绝
    // ─────────────────────────────────────────────

    Glados(any.intInRange(0, _allExtensions.length - 1))
        .test(
      '格式验证：有效格式接受，无效格式拒绝',
      (extIndex) {
        final ext = _allExtensions[extIndex];
        final filePath = '/path/to/image$ext';
        final result = ImageUtils.validateFormat(filePath);

        if (_validExtensions.contains(ext)) {
          // 有效格式应被接受（返回 null）
          expect(result, isNull,
              reason: '扩展名 "$ext" 应被接受为有效格式');
        } else {
          // 无效格式应被拒绝（返回错误信息）
          expect(result, isNotNull,
              reason: '扩展名 "$ext" 应被拒绝为无效格式');
        }
      },
    );

    // ─────────────────────────────────────────────
    // 属性测试：大小验证
    // 验证 ≤10MB 被接受，>10MB 被拒绝
    // ─────────────────────────────────────────────

    Glados(any.intInRange(0, _maxFileSize * 2))
        .test(
      '大小验证：≤10MB 接受，>10MB 拒绝',
      (fileSize) {
        final result = ImageUtils.validateFileSize(fileSize);

        if (fileSize <= _maxFileSize) {
          // 大小在限制内应被接受
          expect(result, isNull,
              reason: '文件大小 $fileSize 字节（≤10MB）应被接受');
        } else {
          // 大小超出限制应被拒绝
          expect(result, isNotNull,
              reason: '文件大小 $fileSize 字节（>10MB）应被拒绝');
        }
      },
    );

    // ─────────────────────────────────────────────
    // 属性测试：综合验证（格式 + 大小）
    // 当且仅当格式有效且大小≤10MB时接受
    // ─────────────────────────────────────────────

    Glados2(
      any.intInRange(0, _allExtensions.length - 1),
      any.intInRange(0, _maxFileSize * 2),
    ).test(
      '综合验证：当且仅当格式有效且大小≤10MB时接受',
      (extIndex, fileSize) {
        final ext = _allExtensions[extIndex];
        final filePath = '/path/to/file$ext';
        final result = ImageUtils.validateFile(filePath, fileSize);

        final isValidFormat = _validExtensions.contains(ext);
        final isValidSize = fileSize <= _maxFileSize;

        if (isValidFormat && isValidSize) {
          // 格式有效且大小合规 → 接受
          expect(result, isNull,
              reason:
                  '格式 "$ext" 有效且大小 $fileSize ≤ 10MB，应被接受');
        } else {
          // 格式无效或大小超限 → 拒绝
          expect(result, isNotNull,
              reason:
                  '格式 "$ext" 或大小 $fileSize 不合规，应被拒绝');
        }
      },
    );

    // ─────────────────────────────────────────────
    // 属性测试：大小写不敏感的格式验证
    // ─────────────────────────────────────────────

    Glados(any.intInRange(0, _validExtensions.length - 1))
        .test(
      '格式验证对大小写不敏感',
      (extIndex) {
        final ext = _validExtensions[extIndex];
        // 测试大写变体
        final upperPath = '/path/to/image${ext.toUpperCase()}';
        final result = ImageUtils.validateFormat(upperPath);

        expect(result, isNull,
            reason: '大写扩展名 "${ext.toUpperCase()}" 也应被接受');
      },
    );

    // ─────────────────────────────────────────────
    // 边界值测试
    // ─────────────────────────────────────────────

    test('边界值：恰好 10MB 应被接受', () {
      final result = ImageUtils.validateFileSize(_maxFileSize);
      expect(result, isNull, reason: '恰好 10MB 应被接受');
    });

    test('边界值：10MB + 1 字节应被拒绝', () {
      final result = ImageUtils.validateFileSize(_maxFileSize + 1);
      expect(result, isNotNull, reason: '超过 10MB 一个字节应被拒绝');
    });

    test('边界值：0 字节应被接受', () {
      final result = ImageUtils.validateFileSize(0);
      expect(result, isNull, reason: '0 字节文件大小应被接受');
    });
  });
}
