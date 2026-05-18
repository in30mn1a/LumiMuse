// 附件处理工具单元测试
// 验证 AttachmentProcessor 的文件大小验证、文本读取和多模态内容构建

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/models/attachment_item.dart';
import 'package:lumimuse/core/utils/attachment_processor.dart';

void main() {
  group('AttachmentProcessor.validateFileSize', () {
    test('0 字节应通过验证', () {
      expect(AttachmentProcessor.validateFileSize(0), isTrue);
    });

    test('恰好 10MB 应通过验证', () {
      expect(
        AttachmentProcessor.validateFileSize(10 * 1024 * 1024),
        isTrue,
      );
    });

    test('10MB + 1 字节应不通过验证', () {
      expect(
        AttachmentProcessor.validateFileSize(10 * 1024 * 1024 + 1),
        isFalse,
      );
    });

    test('1 字节应通过验证', () {
      expect(AttachmentProcessor.validateFileSize(1), isTrue);
    });

    test('5MB 应通过验证', () {
      expect(
        AttachmentProcessor.validateFileSize(5 * 1024 * 1024),
        isTrue,
      );
    });

    test('20MB 应不通过验证', () {
      expect(
        AttachmentProcessor.validateFileSize(20 * 1024 * 1024),
        isFalse,
      );
    });
  });

  group('AttachmentProcessor.imageToBase64', () {
    late Directory tempDir;

    setUp(() {
      tempDir = Directory.systemTemp.createTempSync('attachment_test_');
    });

    tearDown(() {
      tempDir.deleteSync(recursive: true);
    });

    test('小图片文件正确编码为 base64', () async {
      // 创建一个小的测试文件
      final file = File('${tempDir.path}/small.png');
      final testBytes = List.filled(100, 0xFF);
      await file.writeAsBytes(testBytes);

      final result = await AttachmentProcessor.imageToBase64(file.path);

      expect(result, isNotNull);
      expect(result, base64Encode(testBytes));
    });

    test('base64 超过 5MB 时返回 null', () async {
      // 创建一个足够大的文件使 base64 超过 5MB
      // base64 编码后大小约为原始大小的 4/3
      // 要使 base64 > 5MB，原始文件需要约 3.75MB
      final file = File('${tempDir.path}/large.png');
      final largeBytes = List.filled(4 * 1024 * 1024, 0xAB); // 4MB 原始数据
      await file.writeAsBytes(largeBytes);

      final result = await AttachmentProcessor.imageToBase64(file.path);

      // 4MB 原始 → ~5.33MB base64，应超过 5MB 限制
      expect(result, isNull);
    });

    test('恰好不超过 5MB base64 限制时返回编码结果', () async {
      // base64 编码后每 3 字节变 4 字符
      // 要使 base64 恰好 ≤ 5MB (5242880 字符)，原始字节 ≤ 5242880 * 3 / 4 = 3932160
      final file = File('${tempDir.path}/borderline.png');
      final bytes = List.filled(3900000, 0x42); // 略小于边界
      await file.writeAsBytes(bytes);

      final result = await AttachmentProcessor.imageToBase64(file.path);

      expect(result, isNotNull);
    });
  });

  group('AttachmentProcessor.readTextFile', () {
    late Directory tempDir;

    setUp(() {
      tempDir = Directory.systemTemp.createTempSync('attachment_text_test_');
    });

    tearDown(() {
      tempDir.deleteSync(recursive: true);
    });

    test('正常文本文件以正确格式输出', () async {
      final file = File('${tempDir.path}/notes.txt');
      await file.writeAsString('这是测试内容');

      final result = await AttachmentProcessor.readTextFile(
        file.path,
        fileName: 'notes.txt',
      );

      expect(result, '[附件: notes.txt]\n这是测试内容');
    });

    test('未指定 fileName 时使用文件路径中的文件名', () async {
      final file = File('${tempDir.path}/readme.md');
      await file.writeAsString('# 标题');

      final result = await AttachmentProcessor.readTextFile(file.path);

      expect(result, '[附件: readme.md]\n# 标题');
    });

    test('内容恰好 50000 字符时不截断', () async {
      final file = File('${tempDir.path}/exact.txt');
      final content = 'A' * 50000;
      await file.writeAsString(content);

      final result = await AttachmentProcessor.readTextFile(
        file.path,
        fileName: 'exact.txt',
      );

      expect(result, '[附件: exact.txt]\n$content');
      expect(result.contains(AttachmentProcessor.truncationNotice), isFalse);
    });

    test('内容超过 50000 字符时截断并追加提示', () async {
      final file = File('${tempDir.path}/long.txt');
      final content = 'B' * 60000;
      await file.writeAsString(content);

      final result = await AttachmentProcessor.readTextFile(
        file.path,
        fileName: 'long.txt',
      );

      final expectedContent = 'B' * 50000 + AttachmentProcessor.truncationNotice;
      expect(result, '[附件: long.txt]\n$expectedContent');
    });

    test('空文件正确处理', () async {
      final file = File('${tempDir.path}/empty.txt');
      await file.writeAsString('');

      final result = await AttachmentProcessor.readTextFile(
        file.path,
        fileName: 'empty.txt',
      );

      expect(result, '[附件: empty.txt]\n');
    });
  });

  group('AttachmentProcessor.buildMultimodalContent', () {
    late Directory tempDir;

    setUp(() {
      tempDir = Directory.systemTemp.createTempSync('attachment_multi_test_');
    });

    tearDown(() {
      tempDir.deleteSync(recursive: true);
    });

    test('纯文本消息生成单个 text 条目', () async {
      final result = await AttachmentProcessor.buildMultimodalContent(
        '你好',
        [],
      );

      expect(result.length, 1);
      expect(result[0]['type'], 'text');
      expect(result[0]['text'], '你好');
    });

    test('空文本不生成 text 条目', () async {
      final result = await AttachmentProcessor.buildMultimodalContent(
        '',
        [],
      );

      expect(result, isEmpty);
    });

    test('小图片附件生成 image_url 条目', () async {
      // 创建小图片文件
      final file = File('${tempDir.path}/small.jpg');
      final testBytes = List.filled(100, 0xFF);
      await file.writeAsBytes(testBytes);

      final attachment = AttachmentItem(
        fileName: 'small.jpg',
        filePath: file.path,
        mimeType: 'image/jpeg',
        type: AttachmentType.image,
        fileSize: 100,
      );

      final result = await AttachmentProcessor.buildMultimodalContent(
        '看这张图',
        [attachment],
      );

      expect(result.length, 2);
      expect(result[0]['type'], 'text');
      expect(result[0]['text'], '看这张图');
      expect(result[1]['type'], 'image_url');
      expect(
        (result[1]['image_url'] as Map)['url'],
        startsWith('data:image/jpeg;base64,'),
      );
    });

    test('大图片附件降级为文字描述', () async {
      // 创建大图片文件（base64 超过 5MB）
      final file = File('${tempDir.path}/large.png');
      final largeBytes = List.filled(4 * 1024 * 1024, 0xAB);
      await file.writeAsBytes(largeBytes);

      final attachment = AttachmentItem(
        fileName: 'large.png',
        filePath: file.path,
        mimeType: 'image/png',
        type: AttachmentType.image,
        fileSize: largeBytes.length,
      );

      final result = await AttachmentProcessor.buildMultimodalContent(
        '看图',
        [attachment],
      );

      expect(result.length, 2);
      expect(result[0]['type'], 'text');
      expect(result[1]['type'], 'text');
      expect(result[1]['text'], AttachmentProcessor.imageTooLargeDescription);
    });

    test('文本附件不被 buildMultimodalContent 处理为 image_url', () async {
      const attachment = AttachmentItem(
        fileName: 'data.csv',
        filePath: '/fake/path/data.csv',
        mimeType: 'text/csv',
        type: AttachmentType.text,
        fileSize: 256,
      );

      final result = await AttachmentProcessor.buildMultimodalContent(
        '分析这个文件',
        [attachment],
      );

      // 文本附件不会被处理为 image_url（文本内容应在调用前已追加到 text）
      expect(result.length, 1);
      expect(result[0]['type'], 'text');
      expect(result[0]['text'], '分析这个文件');
    });
  });

  group('AttachmentProcessor 常量', () {
    test('maxFileSize 为 10MB', () {
      expect(AttachmentProcessor.maxFileSize, 10 * 1024 * 1024);
    });

    test('maxBase64Size 为 5MB', () {
      expect(AttachmentProcessor.maxBase64Size, 5 * 1024 * 1024);
    });

    test('maxTextLength 为 50000', () {
      expect(AttachmentProcessor.maxTextLength, 50000);
    });
  });
}
