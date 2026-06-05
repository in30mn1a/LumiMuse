// 附件数据模型属性测试
// Feature: flutter-core-features, Task 1.3
// Property 4: Attachment metadata serialization round-trip
// Validates: Requirements 1.10

import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, test, group;
import 'package:lumimuse/core/models/attachment_item.dart';

void main() {
  group('Property 4: Attachment metadata serialization round-trip', () {
    // FIX(C7)：toJson 现在持久化 filePath / fileSize，往返能完整保留所有字段。
    // 同步把断言扩展为 5 个字段都校验，匹配新的写入策略。
    Glados<String>(any.choose(['alpha', 'beta', 'gamma', 'delta', 'hello', 'world', 'test', 'foo', 'bar', 'xyz123'])).test(
      'toJson → fromJson 往返完整保留 type/fileName/filePath/fileSize/mimeType',
      (fileName) {
        if (fileName.isEmpty) return;
        // 测试图片类型
        final imageItem = AttachmentItem(
          fileName: fileName,
          filePath: '/tmp/$fileName',
          mimeType: 'image/jpeg',
          type: AttachmentType.image,
          fileSize: 1024,
        );
        final imageJson = imageItem.toJson();
        final imageRestored = AttachmentItem.fromJson(imageJson);
        expect(imageRestored.type, imageItem.type);
        expect(imageRestored.fileName, imageItem.fileName);
        expect(imageRestored.mimeType, imageItem.mimeType);
        expect(imageRestored.filePath, imageItem.filePath);
        expect(imageRestored.fileSize, imageItem.fileSize);

        // 测试文本类型
        final textItem = AttachmentItem(
          fileName: fileName,
          filePath: '/tmp/$fileName',
          mimeType: 'text/plain',
          type: AttachmentType.text,
          fileSize: 512,
        );
        final textJson = textItem.toJson();
        final textRestored = AttachmentItem.fromJson(textJson);
        expect(textRestored.type, textItem.type);
        expect(textRestored.fileName, textItem.fileName);
        expect(textRestored.mimeType, textItem.mimeType);
        expect(textRestored.filePath, textItem.filePath);
        expect(textRestored.fileSize, textItem.fileSize);
      },
    );

    Glados<String>(any.choose(AttachmentType.values.map((e) => e.name).toList())).test(
      'fromJson 能正确解析所有有效 type 值',
      (typeName) {
        final json = {
          'type': typeName,
          'fileName': 'test.file',
          'mimeType': 'application/octet-stream',
        };

        final item = AttachmentItem.fromJson(json);
        expect(item.type.name, typeName);
      },
    );

    test('fromJson 对无效 type 回退为 text', () {
      final invalidTypes = ['video', 'audio', '', 'IMAGE', 'Text', 'unknown'];
      for (final invalidType in invalidTypes) {
        final json = {
          'type': invalidType,
          'fileName': 'file.bin',
          'mimeType': 'application/octet-stream',
        };
        final item = AttachmentItem.fromJson(json);
        expect(item.type, AttachmentType.text,
            reason: '无效 type "$invalidType" 应回退为 text');
      }
    });

    // FIX(C7)：filePath / fileSize 现在会持久化到 metadata（之前漏写导致往返丢失）。
    // 改为正向断言：toJson 必须包含这些字段；thumbnailBytes 仍不持久化。
    test('toJson 持久化 filePath 和 fileSize 到 metadata', () {
      const item = AttachmentItem(
        fileName: 'secret.txt',
        filePath: '/sensitive/path/secret.txt',
        mimeType: 'text/plain',
        type: AttachmentType.text,
        fileSize: 99999,
      );

      final json = item.toJson();

      expect(json['filePath'], '/sensitive/path/secret.txt',
          reason: 'filePath 必须持久化到序列化结果中（C7 修复）');
      expect(json['fileSize'], 99999,
          reason: 'fileSize 必须持久化到序列化结果中（C7 修复）');
      expect(json.containsKey('thumbnailBytes'), isFalse,
          reason: 'thumbnailBytes 不应出现在序列化结果中');
    });

    // FIX(C7)：键集合从原 {type, fileName, mimeType} 扩展为
    // {type, fileName, filePath, fileSize, mimeType}（共 5 个键）。
    // 图片附件还会冗余写出 url 兼容旧消费方，因此键数 ≥ 5。
    test('toJson 文本附件输出恰好 5 个键，图片附件再多 1 个 url 共 6 个键', () {
      const textItem = AttachmentItem(
        fileName: 'data.json',
        filePath: '/path/data.json',
        mimeType: 'application/json',
        type: AttachmentType.text,
        fileSize: 512,
      );

      final textJson = textItem.toJson();
      expect(textJson.keys.length, 5);
      expect(textJson.keys.toSet(),
          {'type', 'fileName', 'filePath', 'fileSize', 'mimeType'});

      const imageItem = AttachmentItem(
        fileName: 'photo.jpg',
        filePath: '/path/photo.jpg',
        mimeType: 'image/jpeg',
        type: AttachmentType.image,
        fileSize: 1024,
      );
      final imageJson = imageItem.toJson();
      expect(imageJson.keys.length, 6);
      expect(imageJson.keys.toSet(),
          {'type', 'fileName', 'filePath', 'fileSize', 'mimeType', 'url'});
    });
  });
}

