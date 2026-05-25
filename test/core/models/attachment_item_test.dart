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

    // FIX(C7)：toJson 现在持久化 filePath / fileSize，并对图片附件冗余写出
    // url 字段做向后兼容（旧消费方仍可读取 url）。原断言"toJson 不含 filePath/fileSize"
    // 已与新写入策略冲突，改为正向断言。
    test('toJson 序列化包含 type/fileName/filePath/fileSize/mimeType（图片附件还含 url）', () {
      const textItem = AttachmentItem(
        fileName: 'notes.txt',
        filePath: '/path/to/notes.txt',
        mimeType: 'text/plain',
        type: AttachmentType.text,
        fileSize: 512,
      );

      final textJson = textItem.toJson();

      expect(textJson['type'], 'text');
      expect(textJson['fileName'], 'notes.txt');
      expect(textJson['mimeType'], 'text/plain');
      expect(textJson['filePath'], '/path/to/notes.txt');
      expect(textJson['fileSize'], 512);
      // 文本附件不写 url（仅图片附件保留 url 兼容旧消费方）
      expect(textJson.containsKey('url'), isFalse);

      const imageItem = AttachmentItem(
        fileName: 'photo.jpg',
        filePath: '/path/to/photo.jpg',
        mimeType: 'image/jpeg',
        type: AttachmentType.image,
        fileSize: 1024,
      );
      final imageJson = imageItem.toJson();
      expect(imageJson['filePath'], '/path/to/photo.jpg');
      expect(imageJson['fileSize'], 1024);
      // 图片附件冗余写 url 字段（与 filePath 等价）做向后兼容
      expect(imageJson['url'], '/path/to/photo.jpg');
    });

    // FIX(C7)：fromJson 现在能从 filePath 与 fileSize 恢复字段，并对旧数据
    // 仅有 url 字段的情况做兼容回退（filePath 缺失 → 读 url）。
    test('fromJson 反序列化正确恢复 filePath 与 fileSize', () {
      final json = {
        'type': 'image',
        'fileName': 'avatar.png',
        'mimeType': 'image/png',
        'filePath': '/path/to/avatar.png',
        'fileSize': 2048,
      };

      final item = AttachmentItem.fromJson(json);

      expect(item.type, AttachmentType.image);
      expect(item.fileName, 'avatar.png');
      expect(item.mimeType, 'image/png');
      expect(item.filePath, '/path/to/avatar.png');
      expect(item.fileSize, 2048);
      expect(item.thumbnailBytes, isNull);
    });

    test('fromJson 在 filePath 缺失时回退读取 url（旧数据兼容）', () {
      final json = {
        'type': 'image',
        'fileName': 'legacy.png',
        'mimeType': 'image/png',
        'url': '/legacy/path/legacy.png', // 旧数据只写 url
      };

      final item = AttachmentItem.fromJson(json);

      expect(item.filePath, '/legacy/path/legacy.png');
      expect(item.fileSize, 0); // 无 fileSize 时默认 0
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

    // FIX(C7)：往返现在能完整保留 filePath 与 fileSize（之前只保 type/fileName/mimeType）
    test('toJson → fromJson 往返序列化完整保留 filePath/fileSize', () {
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
      expect(restored.filePath, original.filePath);
      expect(restored.fileSize, original.fileSize);
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
