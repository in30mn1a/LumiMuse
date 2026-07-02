// Feature: flutter-parity-completion, Wave 5 E1: 图片格式 magic bytes 检测
//
// **Validates: 主项目 `src/app/api/image-gen/route.ts` 的 `detectImageFormat` + `extForFormat`**
//
// 断言：
// - PNG magic bytes `89 50 4E 47` → ImageFormat.png
// - JPEG magic bytes `FF D8 FF` → ImageFormat.jpeg
// - WEBP magic bytes `52 49 46 46 .. .. .. .. 57 45 42 50` → ImageFormat.webp
// - 长度 < 12 → null
// - 未识别格式 → null
// - extForFormat：jpeg → 'jpg'，png → 'png'，webp → 'webp'

import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/services/image_gen_service.dart';

void main() {
  group('E1: detectImageFormat magic bytes 检测', () {
    test('PNG：前 4 字节 89 50 4E 47 识别为 png', () {
      final bytes = Uint8List.fromList(
        <int>[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x00],
      );
      expect(ImageGenService.detectImageFormat(bytes), ImageFormat.png);
    });

    test('JPEG：前 3 字节 FF D8 FF 识别为 jpeg', () {
      final bytes = Uint8List.fromList(
        <int>[0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01],
      );
      expect(ImageGenService.detectImageFormat(bytes), ImageFormat.jpeg);
    });

    test('WEBP：RIFF....WEBP 识别为 webp', () {
      final bytes = Uint8List.fromList(
        <int>[
          0x52, 0x49, 0x46, 0x46, // RIFF
          0x00, 0x00, 0x00, 0x00, // size（任意）
          0x57, 0x45, 0x42, 0x50, // WEBP
        ],
      );
      expect(ImageGenService.detectImageFormat(bytes), ImageFormat.webp);
    });

    test('长度 < 12 返回 null（不足判定）', () {
      final pngShort = Uint8List.fromList(<int>[0x89, 0x50, 0x4E, 0x47]);
      expect(ImageGenService.detectImageFormat(pngShort), isNull);

      final jpegShort = Uint8List.fromList(<int>[0xFF, 0xD8, 0xFF, 0xE0]);
      expect(ImageGenService.detectImageFormat(jpegShort), isNull);

      final empty = Uint8List(0);
      expect(ImageGenService.detectImageFormat(empty), isNull);
    });

    test('未识别格式返回 null', () {
      final unknown = Uint8List.fromList(
        <int>[0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B],
      );
      expect(ImageGenService.detectImageFormat(unknown), isNull);

      // GIF 签名 47 49 46 38 不在支持列表
      final gif = Uint8List.fromList(
        <int>[0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
      );
      expect(ImageGenService.detectImageFormat(gif), isNull);
    });

    test('WEBP：RIFF 但 offset 8..11 不是 WEBP 返回 null', () {
      final riffOnly = Uint8List.fromList(
        <int>[
          0x52, 0x49, 0x46, 0x46, // RIFF
          0x00, 0x00, 0x00, 0x00,
          0x57, 0x41, 0x56, 0x45, // WAVE（不是 WEBP）
        ],
      );
      expect(ImageGenService.detectImageFormat(riffOnly), isNull);
    });
  });

  group('E1: extForFormat 扩展名', () {
    test('jpeg → jpg', () {
      expect(ImageGenService.extForFormat(ImageFormat.jpeg), 'jpg');
    });

    test('png → png', () {
      expect(ImageGenService.extForFormat(ImageFormat.png), 'png');
    });

    test('webp → webp', () {
      expect(ImageGenService.extForFormat(ImageFormat.webp), 'webp');
    });
  });
}
