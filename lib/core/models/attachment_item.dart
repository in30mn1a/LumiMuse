import 'dart:typed_data';

/// 附件类型枚举 — 区分图片和文本文件
enum AttachmentType {
  /// 图片附件（JPEG、PNG、GIF、WebP）
  image,

  /// 文本附件（TXT、MD、JSON、CSV）
  text,
}

/// 附件数据模型 — 表示用户在聊天中附带的文件
///
/// 包含文件基本信息和可选的缩略图数据，用于 UI 预览和后续处理。
class AttachmentItem {
  /// 文件名（含扩展名）
  final String fileName;

  /// 文件完整路径
  final String filePath;

  /// MIME 类型（如 image/jpeg、text/plain）
  final String mimeType;

  /// 附件类型（图片 / 文本）
  final AttachmentType type;

  /// 文件大小（字节）
  final int fileSize;

  /// 图片缩略图字节数据（仅图片附件有值）
  final Uint8List? thumbnailBytes;

  const AttachmentItem({
    required this.fileName,
    required this.filePath,
    required this.mimeType,
    required this.type,
    required this.fileSize,
    this.thumbnailBytes,
  });

  /// 从 JSON Map 反序列化（用于从消息 metadata 恢复附件信息）
  factory AttachmentItem.fromJson(Map<String, dynamic> json) {
    return AttachmentItem(
      fileName: json['fileName'] as String,
      filePath: json['filePath'] as String? ?? '',
      mimeType: json['mimeType'] as String,
      type: AttachmentType.values.firstWhere(
        (e) => e.name == json['type'],
        orElse: () => AttachmentType.text,
      ),
      fileSize: json['fileSize'] as int? ?? 0,
      thumbnailBytes: null, // 缩略图不持久化到 metadata
    );
  }

  /// 序列化为 JSON Map（用于持久化到消息 metadata.attachments）
  Map<String, dynamic> toJson() {
    final map = <String, dynamic>{
      'type': type.name,
      'fileName': fileName,
      'mimeType': mimeType,
    };
    // 图片附件：存储文件路径供后续显示
    if (type == AttachmentType.image) {
      map['url'] = filePath;
    }
    return map;
  }

  /// 创建副本并覆盖指定字段
  AttachmentItem copyWith({
    String? fileName,
    String? filePath,
    String? mimeType,
    AttachmentType? type,
    int? fileSize,
    Uint8List? thumbnailBytes,
  }) {
    return AttachmentItem(
      fileName: fileName ?? this.fileName,
      filePath: filePath ?? this.filePath,
      mimeType: mimeType ?? this.mimeType,
      type: type ?? this.type,
      fileSize: fileSize ?? this.fileSize,
      thumbnailBytes: thumbnailBytes ?? this.thumbnailBytes,
    );
  }
}
