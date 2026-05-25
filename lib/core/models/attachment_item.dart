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
  ///
  /// 字段读取策略：
  /// - `fileName` / `mimeType` / `type` 直接读取（必填）
  /// - `filePath` 优先读取新字段；缺失时回退到旧 `url` 字段（v1 备份兼容路径）
  /// - `fileSize` 缺失时回退到 0（旧数据未持久化此字段）
  /// - `thumbnailBytes` 不从 JSON 读取（不持久化）
  factory AttachmentItem.fromJson(Map<String, dynamic> json) {
    // FIX: filePath 优先取新字段，回退到旧 url 字段（v1 备份兼容）
    final filePath = (json['filePath'] as String?) ??
        (json['url'] as String?) ??
        '';
    return AttachmentItem(
      fileName: json['fileName'] as String,
      filePath: filePath,
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
  ///
  /// 字段写入策略：
  /// - `type` / `fileName` / `mimeType` 始终写出
  /// - `filePath` / `fileSize` 始终写出（修复：以前只对图片用 url 字段写出，
  ///   导致 fromJson 往返时 fileSize 永远丢失、filePath 仅对图片可恢复）
  /// - `url` 仅对图片附件冗余写出（与 filePath 等价），用于历史消费方
  ///   （如旧版气泡渲染只读 `url` 字段）保持向后兼容
  /// - `thumbnailBytes` 不写出（运行时缓存，不持久化）
  Map<String, dynamic> toJson() {
    final map = <String, dynamic>{
      'type': type.name,
      'fileName': fileName,
      'filePath': filePath, // FIX: 之前漏写，导致往返丢失
      'fileSize': fileSize, // FIX: 之前漏写，导致往返丢失
      'mimeType': mimeType,
    };
    // 历史兼容：图片附件保留 url 字段供旧消费方使用（filePath == url 等价）
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
