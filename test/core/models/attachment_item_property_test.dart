// 附件数据模型属性测试
// Feature: flutter-core-features, Task 1.3
// Property 4: Attachment metadata serialization round-trip
// Validates: Requirements 1.10

import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, test, group;
import 'package:lumimuse/core/models/attachment_item.dart';

void main() {
  group('Property 4: Attachment metadata serialization round-trip', () {
    Glados<String>(any.choose(['alpha', 'beta', 'gamma', 'delta', 'hello', 'world', 'test', 'foo', 'bar', 'xyz123'])).test(
      'toJson → fromJson 往返保持 type、fileName、mimeType 一致',
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

    test('toJson 不包含 filePath 和 fileSize（不持久化到 metadata）', () {
      const item = AttachmentItem(
        fileName: 'secret.txt',
        filePath: '/sensitive/path/secret.txt',
        mimeType: 'text/plain',
        type: AttachmentType.text,
        fileSize: 99999,
      );

      final json = item.toJson();

      expect(json.containsKey('filePath'), isFalse,
          reason: 'filePath 不应出现在序列化结果中');
      expect(json.containsKey('fileSize'), isFalse,
          reason: 'fileSize 不应出现在序列化结果中');
      expect(json.containsKey('thumbnailBytes'), isFalse,
          reason: 'thumbnailBytes 不应出现在序列化结果中');
    });

    test('toJson 输出恰好包含 3 个键', () {
      const item = AttachmentItem(
        fileName: 'data.json',
        filePath: '/path/data.json',
        mimeType: 'application/json',
        type: AttachmentType.text,
        fileSize: 512,
      );

      final json = item.toJson();
      expect(json.keys.length, 3);
      expect(json.keys.toSet(), {'type', 'fileName', 'mimeType'});
    });
  });
}

