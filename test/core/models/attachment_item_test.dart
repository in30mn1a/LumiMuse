// 附件数据模型单元测试
// 验证 AttachmentItem 的构造、序列化和反序列化

import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/models/attachment_item.dart';

void main() {
  group('AttachmentItem', () {
    test('构造函数正确初始化所有字段', () {
      const item = AttachmentItem(
        fileName: 'photo.jpg',
        filePath: '/path/to/photo.jpg',
        mimeType: 'image/jpeg',
        type: AttachmentType.image,
        fileSize: 1024,
      );

      expect(item.fileName, 'photo.jpg');
      expect(item.filePath, '/path/to/photo.jpg');
      expect(item.mimeType, 'image/jpeg');
      expect(item.type, AttachmentType.image);
      expect(item.fileSize, 1024);
      expect(item.thumbnailBytes, isNull);
    });

    test('toJson 序列化包含 type、fileName、mimeType', () {
      const item = AttachmentItem(
        fileName: 'notes.txt',
        filePath: '/path/to/notes.txt',
        mimeType: 'text/plain',
        type: AttachmentType.text,
        fileSize: 512,
      );

      final json = item.toJson();

      expect(json['type'], 'text');
      expect(json['fileName'], 'notes.txt');
      expect(json['mimeType'], 'text/plain');
      // filePath 和 fileSize 不持久化到 metadata
      expect(json.containsKey('filePath'), isFalse);
      expect(json.containsKey('fileSize'), isFalse);
    });

    test('fromJson 反序列化正确恢复字段', () {
      final json = {
        'type': 'image',
        'fileName': 'avatar.png',
        'mimeType': 'image/png',
      };

      final item = AttachmentItem.fromJson(json);

      expect(item.type, AttachmentType.image);
      expect(item.fileName, 'avatar.png');
      expect(item.mimeType, 'image/png');
      expect(item.filePath, ''); // 无 filePath 时默认空字符串
      expect(item.fileSize, 0); // 无 fileSize 时默认 0
      expect(item.thumbnailBytes, isNull);
    });

    test('fromJson 处理未知 type 时回退为 text', () {
      final json = {
        'type': 'unknown_type',
        'fileName': 'file.xyz',
        'mimeType': 'application/octet-stream',
      };

      final item = AttachmentItem.fromJson(json);

      expect(item.type, AttachmentType.text);
    });

    test('toJson → fromJson 往返序列化保持一致', () {
      const original = AttachmentItem(
        fileName: 'data.csv',
        filePath: '/tmp/data.csv',
        mimeType: 'text/csv',
        type: AttachmentType.text,
        fileSize: 2048,
      );

      final json = original.toJson();
      final restored = AttachmentItem.fromJson(json);

      expect(restored.type, original.type);
      expect(restored.fileName, original.fileName);
      expect(restored.mimeType, original.mimeType);
    });

    test('copyWith 正确覆盖指定字段', () {
      const original = AttachmentItem(
        fileName: 'old.txt',
        filePath: '/old/path',
        mimeType: 'text/plain',
        type: AttachmentType.text,
        fileSize: 100,
      );

      final modified = original.copyWith(
        fileName: 'new.txt',
        fileSize: 200,
      );

      expect(modified.fileName, 'new.txt');
      expect(modified.fileSize, 200);
      // 未覆盖的字段保持不变
      expect(modified.filePath, '/old/path');
      expect(modified.mimeType, 'text/plain');
      expect(modified.type, AttachmentType.text);
    });
  });

  group('AttachmentType', () {
    test('枚举包含 image 和 text 两个值', () {
      expect(AttachmentType.values.length, 2);
      expect(AttachmentType.values, contains(AttachmentType.image));
      expect(AttachmentType.values, contains(AttachmentType.text));
    });

    test('枚举 name 属性返回正确字符串', () {
      expect(AttachmentType.image.name, 'image');
      expect(AttachmentType.text.name, 'text');
    });
  });
}
