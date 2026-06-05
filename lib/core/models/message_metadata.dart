import 'dart:convert';

/// 消息元数据强类型模型 — 替代散布各处的 jsonDecode(metadata) + `Map<String,dynamic>` 访问
///
/// 所有字段均可空，缺失时返回合理默认值，无需 try/catch。
/// 序列化/反序列化通过 [MessageMetadata.fromJson] / [MessageMetadata.toJson] 统一处理。
class MessageMetadata {
  /// 附件列表
  final List<AttachmentData> attachments;

  /// 生成的图片列表
  final List<GeneratedImage> generatedImages;

  /// 消息版本历史（重新生成时旧内容归档）
  final List<MessageVersion> versions;

  /// 当前激活的版本索引
  final int? activeVersion;

  /// 是否已提取记忆
  final bool memoryExtracted;

  /// 记忆提取时间
  final String? memoryExtractedAt;

  /// 是否忽略记忆提取
  final bool memoryIgnored;

  /// 是否为总结消息
  final bool isSummary;

  /// 被总结的消息 ID 列表（仅 isSummary=true 时有值）
  final List<String>? summarizedIds;

  /// 消息级别的图片版本历史
  final List<ImageVersion>? imageVersions;

  /// 消息级别的当前激活图片版本索引
  final int? activeImageVersion;

  const MessageMetadata({
    this.attachments = const [],
    this.generatedImages = const [],
    this.versions = const [],
    this.activeVersion,
    this.memoryExtracted = false,
    this.memoryExtractedAt,
    this.memoryIgnored = false,
    this.isSummary = false,
    this.summarizedIds,
    this.imageVersions,
    this.activeImageVersion,
  });

  /// 从 JSON 字符串解析，解析失败返回空元数据
  factory MessageMetadata.fromJsonString(String? json) {
    if (json == null || json.isEmpty || json == '{}') {
      return const MessageMetadata();
    }
    try {
      final map = jsonDecode(json) as Map<String, dynamic>;
      return MessageMetadata.fromJson(map);
    } catch (_) {
      return const MessageMetadata();
    }
  }

  /// 从 Map 解析
  factory MessageMetadata.fromJson(Map<String, dynamic> json) {
    return MessageMetadata(
      attachments: (json['attachments'] as List<dynamic>?)
              ?.map((e) => AttachmentData.fromJson(e as Map<String, dynamic>))
              .toList() ??
          const [],
      generatedImages: (json['generatedImages'] as List<dynamic>?)
              ?.map((e) => GeneratedImage.fromJson(e as Map<String, dynamic>))
              .toList() ??
          const [],
      versions: (json['versions'] as List<dynamic>?)
              ?.map((e) => MessageVersion.fromJson(e as Map<String, dynamic>))
              .toList() ??
          const [],
      activeVersion: json['activeVersion'] as int?,
      memoryExtracted: json['memory_extracted'] as bool? ?? false,
      memoryExtractedAt: json['memory_extracted_at'] as String?,
      memoryIgnored: json['memory_ignored'] as bool? ?? false,
      isSummary: json['isSummary'] as bool? ?? false,
      summarizedIds: (json['summarizedIds'] as List<dynamic>?)?.cast<String>(),
      imageVersions: (json['image_versions'] as List<dynamic>?)
              ?.map((e) => ImageVersion.fromJson(e as Map<String, dynamic>))
              .toList(),
      activeImageVersion: json['activeImageVersion'] as int?,
    );
  }

  /// 序列化为 JSON 字符串
  String toJsonString() => jsonEncode(toJson());

  /// 序列化为 Map
  Map<String, dynamic> toJson() {
    final map = <String, dynamic>{};
    if (attachments.isNotEmpty) {
      map['attachments'] = attachments.map((e) => e.toJson()).toList();
    }
    if (generatedImages.isNotEmpty) {
      map['generatedImages'] = generatedImages.map((e) => e.toJson()).toList();
    }
    if (versions.isNotEmpty) {
      map['versions'] = versions.map((e) => e.toJson()).toList();
    }
    if (activeVersion != null) {
      map['activeVersion'] = activeVersion;
    }
    if (memoryExtracted) {
      map['memory_extracted'] = true;
    }
    if (memoryExtractedAt != null) {
      map['memory_extracted_at'] = memoryExtractedAt;
    }
    if (memoryIgnored) {
      map['memory_ignored'] = true;
    }
    if (isSummary) {
      map['isSummary'] = true;
    }
    if (summarizedIds != null && summarizedIds!.isNotEmpty) {
      map['summarizedIds'] = summarizedIds;
    }
    if (imageVersions != null && imageVersions!.isNotEmpty) {
      map['image_versions'] = imageVersions!.map((e) => e.toJson()).toList();
    }
    if (activeImageVersion != null) {
      map['activeImageVersion'] = activeImageVersion;
    }
    return map;
  }

  /// copyWith
  ///
  /// 注意（已知语义陷阱）：本方法对 nullable 字段沿用 `value ?? this.value` 写法，
  /// 因此**传入 `null` 等同于「未传该参数」**，无法把已有值清空为 null。
  ///
  /// 设计选择（保守方案）：
  /// - 全工程已有 8+ 处调用方依赖「传 null = 不变」的隐式语义（chat_provider /
  ///   message_provider / conversation_provider / memory_extraction_service /
  ///   character_images_actions / summarize_service 等），统一改造为哨兵方案
  ///   风险大、收益小。
  /// - 真正需要置空的 nullable 字段，改用专用的 `clearXxx()` 方法显式表达意图，
  ///   语义清晰且不影响现有调用方。详见下方 [clearActiveVersion] 等方法。
  MessageMetadata copyWith({
    List<AttachmentData>? attachments,
    List<GeneratedImage>? generatedImages,
    List<MessageVersion>? versions,
    int? activeVersion,
    bool? memoryExtracted,
    String? memoryExtractedAt,
    bool? memoryIgnored,
    bool? isSummary,
    List<String>? summarizedIds,
    List<ImageVersion>? imageVersions,
    int? activeImageVersion,
  }) {
    return MessageMetadata(
      attachments: attachments ?? this.attachments,
      generatedImages: generatedImages ?? this.generatedImages,
      versions: versions ?? this.versions,
      activeVersion: activeVersion ?? this.activeVersion,
      memoryExtracted: memoryExtracted ?? this.memoryExtracted,
      memoryExtractedAt: memoryExtractedAt ?? this.memoryExtractedAt,
      memoryIgnored: memoryIgnored ?? this.memoryIgnored,
      isSummary: isSummary ?? this.isSummary,
      summarizedIds: summarizedIds ?? this.summarizedIds,
      imageVersions: imageVersions ?? this.imageVersions,
      activeImageVersion: activeImageVersion ?? this.activeImageVersion,
    );
  }

  // FIX: 新增专用 clearXxx 方法，弥补 copyWith 无法把 nullable 字段清空为 null 的缺陷。
  // 仅对 MessageMetadata 中可空字段提供，方便业务在「真的需要清空」时显式表达意图。

  /// 清空 [activeVersion] 为 null（其余字段保持不变）
  MessageMetadata clearActiveVersion() {
    return MessageMetadata(
      attachments: attachments,
      generatedImages: generatedImages,
      versions: versions,
      activeVersion: null,
      memoryExtracted: memoryExtracted,
      memoryExtractedAt: memoryExtractedAt,
      memoryIgnored: memoryIgnored,
      isSummary: isSummary,
      summarizedIds: summarizedIds,
      imageVersions: imageVersions,
      activeImageVersion: activeImageVersion,
    );
  }

  /// 清空 [memoryExtractedAt] 为 null（其余字段保持不变）
  MessageMetadata clearMemoryExtractedAt() {
    return MessageMetadata(
      attachments: attachments,
      generatedImages: generatedImages,
      versions: versions,
      activeVersion: activeVersion,
      memoryExtracted: memoryExtracted,
      memoryExtractedAt: null,
      memoryIgnored: memoryIgnored,
      isSummary: isSummary,
      summarizedIds: summarizedIds,
      imageVersions: imageVersions,
      activeImageVersion: activeImageVersion,
    );
  }

  /// 清空 [summarizedIds] 为 null（其余字段保持不变）
  MessageMetadata clearSummarizedIds() {
    return MessageMetadata(
      attachments: attachments,
      generatedImages: generatedImages,
      versions: versions,
      activeVersion: activeVersion,
      memoryExtracted: memoryExtracted,
      memoryExtractedAt: memoryExtractedAt,
      memoryIgnored: memoryIgnored,
      isSummary: isSummary,
      summarizedIds: null,
      imageVersions: imageVersions,
      activeImageVersion: activeImageVersion,
    );
  }

  /// 清空 [imageVersions] 为 null（其余字段保持不变）
  MessageMetadata clearImageVersions() {
    return MessageMetadata(
      attachments: attachments,
      generatedImages: generatedImages,
      versions: versions,
      activeVersion: activeVersion,
      memoryExtracted: memoryExtracted,
      memoryExtractedAt: memoryExtractedAt,
      memoryIgnored: memoryIgnored,
      isSummary: isSummary,
      summarizedIds: summarizedIds,
      imageVersions: null,
      activeImageVersion: activeImageVersion,
    );
  }

  /// 清空 [activeImageVersion] 为 null（其余字段保持不变）
  MessageMetadata clearActiveImageVersion() {
    return MessageMetadata(
      attachments: attachments,
      generatedImages: generatedImages,
      versions: versions,
      activeVersion: activeVersion,
      memoryExtracted: memoryExtracted,
      memoryExtractedAt: memoryExtractedAt,
      memoryIgnored: memoryIgnored,
      isSummary: isSummary,
      summarizedIds: summarizedIds,
      imageVersions: imageVersions,
      activeImageVersion: null,
    );
  }
}

/// 附件数据
class AttachmentData {
  final String type;
  final String url;
  final String? name;
  final int? size;

  const AttachmentData({
    required this.type,
    required this.url,
    this.name,
    this.size,
  });

  factory AttachmentData.fromJson(Map<String, dynamic> json) {
    return AttachmentData(
      type: json['type'] as String? ?? 'image',
      url: json['url'] as String? ?? '',
      name: json['name'] as String?,
      size: json['size'] as int?,
    );
  }

  Map<String, dynamic> toJson() => {
        'type': type,
        'url': url,
        if (name != null) 'name': name,
        if (size != null) 'size': size,
      };
}

/// 生成的图片
class GeneratedImage {
  final String id;
  final String url;
  final String? path;
  final String? prompt;
  final String? error;
  final String status; // 'pending' | 'pending_prompt' | 'pending_image' | 'ready' | 'failed'
  final List<ImageVersion> versions;
  final int activeVersion;

  const GeneratedImage({
    required this.id,
    required this.url,
    this.path,
    this.prompt,
    this.error,
    this.status = 'pending',
    this.versions = const [],
    this.activeVersion = 0,
  });

  factory GeneratedImage.fromJson(Map<String, dynamic> json) {
    final status = json['status'] as String?;
    return GeneratedImage(
      id: json['id'] as String? ?? '',
      url: json['url'] as String? ?? '',
      path: json['path'] as String?,
      prompt: json['prompt'] as String?,
      error: json['error'] as String?,
      // 向后兼容：旧数据无 status 字段时，有路径视为 ready，否则视为 pending
      status: status ??
          ((json['path'] != null && (json['path'] as String).isNotEmpty)
              ? 'ready'
              : 'pending'),
      versions: (json['versions'] as List<dynamic>?)
              ?.map((e) => ImageVersion.fromJson(e as Map<String, dynamic>))
              .toList() ??
          const [],
      activeVersion: json['activeVersion'] as int? ?? 0,
    );
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'url': url,
        if (path != null) 'path': path,
        if (prompt != null) 'prompt': prompt,
        if (error != null) 'error': error,
        'status': status,
        if (versions.isNotEmpty) 'versions': versions.map((e) => e.toJson()).toList(),
        'activeVersion': activeVersion,
      };

  GeneratedImage copyWith({
    String? id,
    String? url,
    String? path,
    String? prompt,
    String? error,
    String? status,
    List<ImageVersion>? versions,
    int? activeVersion,
  }) {
    return GeneratedImage(
      id: id ?? this.id,
      url: url ?? this.url,
      path: path ?? this.path,
      prompt: prompt ?? this.prompt,
      error: error ?? this.error,
      status: status ?? this.status,
      versions: versions ?? this.versions,
      activeVersion: activeVersion ?? this.activeVersion,
    );
  }

  // FIX: 新增专用 clearXxx 方法，弥补 copyWith 对 nullable 字段无法置 null 的缺陷。
  // 仅对真正可能需要清空的字段提供（path / prompt / error）。

  /// 清空 [path] 为 null（其余字段保持不变）
  GeneratedImage clearPath() => GeneratedImage(
        id: id,
        url: url,
        path: null,
        prompt: prompt,
        error: error,
        status: status,
        versions: versions,
        activeVersion: activeVersion,
      );

  /// 清空 [prompt] 为 null（其余字段保持不变）
  GeneratedImage clearPrompt() => GeneratedImage(
        id: id,
        url: url,
        path: path,
        prompt: null,
        error: error,
        status: status,
        versions: versions,
        activeVersion: activeVersion,
      );

  /// 清空 [error] 为 null（其余字段保持不变，常用于重试时清除上一次错误）
  GeneratedImage clearError() => GeneratedImage(
        id: id,
        url: url,
        path: path,
        prompt: prompt,
        error: null,
        status: status,
        versions: versions,
        activeVersion: activeVersion,
      );
}

/// 图片版本
class ImageVersion {
  final String id;
  final String url;
  final String? path;
  final String? prompt;
  final String? createdAt;

  const ImageVersion({
    required this.id,
    required this.url,
    this.path,
    this.prompt,
    this.createdAt,
  });

  factory ImageVersion.fromJson(Map<String, dynamic> json) {
    return ImageVersion(
      id: json['id'] as String? ?? '',
      url: json['url'] as String? ?? '',
      path: json['path'] as String?,
      prompt: json['prompt'] as String?,
      createdAt: json['createdAt'] as String?,
    );
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'url': url,
        if (path != null) 'path': path,
        if (prompt != null) 'prompt': prompt,
        if (createdAt != null) 'createdAt': createdAt,
      };
}

/// 消息版本（重新生成时旧内容归档）
class MessageVersion {
  final String content;
  final int? tokenCount;
  final String? createdAt;

  const MessageVersion({
    required this.content,
    this.tokenCount,
    this.createdAt,
  });

  factory MessageVersion.fromJson(Map<String, dynamic> json) {
    return MessageVersion(
      content: json['content'] as String? ?? '',
      tokenCount: json['token_count'] as int?,
      createdAt: json['createdAt'] as String?,
    );
  }

  Map<String, dynamic> toJson() => {
        'content': content,
        if (tokenCount != null) 'token_count': tokenCount,
        if (createdAt != null) 'createdAt': createdAt,
      };

  MessageVersion copyWith({
    String? content,
    int? tokenCount,
    String? createdAt,
  }) {
    return MessageVersion(
      content: content ?? this.content,
      tokenCount: tokenCount ?? this.tokenCount,
      createdAt: createdAt ?? this.createdAt,
    );
  }

  // FIX: 新增专用 clearXxx 方法，弥补 copyWith 对 nullable 字段无法置 null 的缺陷。

  /// 清空 [tokenCount] 为 null（其余字段保持不变，用于强制下游重新估算）
  MessageVersion clearTokenCount() => MessageVersion(
        content: content,
        tokenCount: null,
        createdAt: createdAt,
      );

  /// 清空 [createdAt] 为 null（其余字段保持不变）
  MessageVersion clearCreatedAt() => MessageVersion(
        content: content,
        tokenCount: tokenCount,
        createdAt: null,
      );
}
