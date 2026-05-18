// 附件处理工具属性测试
// Feature: flutter-core-features, Task 1.2
// Property 1: File size validation boundary
// Property 2: Multimodal content assembly with size-based degradation
// Property 3: Text file reading with format and truncation
// Validates: Requirements 1.3, 1.6, 1.7, 1.8, 1.9

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, test, group, setUp, tearDown;
import 'package:lumimuse/core/models/attachment_item.dart';
import 'package:lumimuse/core/utils/attachment_processor.dart';

void main() {
  group('Property 1: File size validation boundary', () {
    Glados<int>(any.intInRange(0, 20 * 1024 * 1024)).test(
      '任意非负字节数：≤10MB 通过，>10MB 不通过',
      (bytes) {
        final result = AttachmentProcessor.validateFileSize(bytes);
        if (bytes <= AttachmentProcessor.maxFileSize) {
          expect(result, isTrue,
              reason: '$bytes 字节应通过验证（≤10MB）');
        } else {
          expect(result, isFalse,
              reason: '$bytes 字节应不通过验证（>10MB）');
        }
      },
    );

    Glados<int>(any.intInRange(0, 100)).test(
      '小文件始终通过验证',
      (bytes) {
        expect(AttachmentProcessor.validateFileSize(bytes), isTrue);
      },
    );

    Glados<int>(any.intInRange(10 * 1024 * 1024 + 1, 50 * 1024 * 1024)).test(
      '超过 10MB 的文件始终不通过验证',
      (bytes) {
        expect(AttachmentProcessor.validateFileSize(bytes), isFalse);
      },
    );
  });

  group('Property 2: Multimodal content assembly', () {
    Glados<String>(any.choose(['alpha', 'beta', 'gamma', 'hello', 'world', 'test123', 'foo', 'bar'])).test(
      '非空文本始终生成至少一个 text 条目',
      (text) async {
        if (text.isEmpty) return;
        final result = await AttachmentProcessor.buildMultimodalContent(
          text,
          [],
        );
        expect(result.isNotEmpty, isTrue);
        expect(result.first['type'], 'text');
        expect(result.first['text'], text);
      },
    );

    test('空文本 + 空附件 → 空结果', () async {
      final result = await AttachmentProcessor.buildMultimodalContent('', []);
      expect(result, isEmpty);
    });

    test('大图片附件降级为文字描述（不生成 image_url）', () async {
      final tempDir = Directory.systemTemp.createTempSync('prop_test_');
      try {
        // 创建 4MB 文件（base64 后 > 5MB）
        final file = File('${tempDir.path}/big.png');
        await file.writeAsBytes(List.filled(4 * 1024 * 1024, 0xAB));

        final attachment = AttachmentItem(
          fileName: 'big.png',
          filePath: file.path,
          mimeType: 'image/png',
          type: AttachmentType.image,
          fileSize: 4 * 1024 * 1024,
        );

        final result = await AttachmentProcessor.buildMultimodalContent(
          '看图',
          [attachment],
        );

        // 应有 text + 降级文字描述
        final imageUrlEntries =
            result.where((e) => e['type'] == 'image_url');
        expect(imageUrlEntries, isEmpty,
            reason: '大图片不应生成 image_url 条目');

        final degradedEntries = result.where(
            (e) => e['type'] == 'text' && e['text'] == AttachmentProcessor.imageTooLargeDescription);
        expect(degradedEntries.length, 1,
            reason: '大图片应降级为文字描述');
      } finally {
        tempDir.deleteSync(recursive: true);
      }
    });

    test('小图片附件生成 image_url 条目', () async {
      final tempDir = Directory.systemTemp.createTempSync('prop_test_small_');
      try {
        final file = File('${tempDir.path}/tiny.jpg');
        await file.writeAsBytes(List.filled(100, 0xFF));

        final attachment = AttachmentItem(
          fileName: 'tiny.jpg',
          filePath: file.path,
          mimeType: 'image/jpeg',
          type: AttachmentType.image,
          fileSize: 100,
        );

        final result = await AttachmentProcessor.buildMultimodalContent(
          '',
          [attachment],
        );

        final imageUrlEntries =
            result.where((e) => e['type'] == 'image_url');
        expect(imageUrlEntries.length, 1);
        final url = (imageUrlEntries.first['image_url'] as Map)['url'] as String;
        expect(url, startsWith('data:image/jpeg;base64,'));
      } finally {
        tempDir.deleteSync(recursive: true);
      }
    });

    test('文本类型附件不被处理为 image_url', () async {
      const attachment = AttachmentItem(
        fileName: 'data.csv',
        filePath: '/fake/path',
        mimeType: 'text/csv',
        type: AttachmentType.text,
        fileSize: 100,
      );

      final result = await AttachmentProcessor.buildMultimodalContent(
        '分析',
        [attachment],
      );

      // 文本附件被跳过（内容应在调用前已追加到 text 参数）
      expect(result.length, 1);
      expect(result[0]['type'], 'text');
    });
  });

  group('Property 3: Text file reading with format and truncation', () {
    late Directory tempDir;

    setUp(() {
      tempDir = Directory.systemTemp.createTempSync('prop_text_');
    });

    tearDown(() {
      tempDir.deleteSync(recursive: true);
    });

    Glados<String>(any.choose(['readme.md', 'notes.txt', 'data.json', 'report.csv', 'config', 'hello'])).test(
      '任意文件名：输出始终以 "[附件: {fileName}]\\n" 开头',
      (fileName) async {
        if (fileName.isEmpty) return; // 跳过空字符串
        final file = File('${tempDir.path}/test_file.txt');
        await file.writeAsString('content');

        final result = await AttachmentProcessor.readTextFile(
          file.path,
          fileName: fileName,
        );

        expect(result, startsWith('[附件: $fileName]\n'));
      },
    );

    Glados<int>(any.intInRange(1, 50000)).test(
      '≤50000 字符的内容不被截断',
      (length) async {
        final content = 'X' * length;
        final file = File('${tempDir.path}/short.txt');
        await file.writeAsString(content);

        final result = await AttachmentProcessor.readTextFile(
          file.path,
          fileName: 'short.txt',
        );

        expect(result.contains(AttachmentProcessor.truncationNotice), isFalse);
        expect(result, contains(content));
      },
    );

    Glados<int>(any.intInRange(50001, 100000)).test(
      '>50000 字符的内容被截断并追加提示',
      (length) async {
        final content = 'Y' * length;
        final file = File('${tempDir.path}/long.txt');
        await file.writeAsString(content);

        final result = await AttachmentProcessor.readTextFile(
          file.path,
          fileName: 'long.txt',
        );

        expect(result, contains(AttachmentProcessor.truncationNotice));
        // 截断后内容长度 = "[附件: long.txt]\n" + 50000 字符 + 截断提示
        const prefix = '[附件: long.txt]\n';
        expect(result.startsWith(prefix), isTrue);
        final bodyStart = result.indexOf('\n') + 1;
        final body = result.substring(bodyStart);
        expect(body.length, 50000 + AttachmentProcessor.truncationNotice.length);
      },
    );
  });
}
