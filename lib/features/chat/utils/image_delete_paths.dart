/// 生图气泡删除相关的纯函数 helpers（任务 3.2 / 3.3 共享）
///
/// 设计动机：`chat_view.dart` 中 `_deleteGeneratedImage` /
/// `_deleteGeneratedImageVersion` 的核心 metadata 操作（匹配 / 收集 / 移除）
/// 与 Drift 写库、`ImageGenService` 调用无关，是纯字典/列表变换。把它们
/// 提取为顶层纯函数后：
///   - chat_view 的回调实现保持等价（只是把内联逻辑替换为函数调用）；
///   - 任务 3.3 的属性测试可以在不构造 widget / Drift / Riverpod 的前提下，
///     直接对 metadata 形态做随机生成与差集断言（参考 design.md Property 5）。
///
/// 与 `local_asset_utils.dart` 的关系：
///   - 这里的 `collectImagePaths` 兼容旧数据，**同时**读取 `path` 与 `url` 字段
///     （以 `path` 优先），与 chat_view 既有删除回调的入参集合保持一致；
///   - `extractLocalPaths`（在 local_asset_utils 中）只读 `url` 字段并过滤本地资产，
///     用于「事务前后差集」语义。两者口径不同但都被 design.md Property 5 覆盖到。
///
/// 所有函数都不就地修改入参，返回新 Map / Set，方便属性测试反复调用。
library;

/// 判断 metadata 中的一条 image 是否匹配 [imageId]
///
/// 与 `MessageBubble._resolveImageId` 的语义对齐：
///   1. 优先按 `id` 字段精确匹配；
///   2. 旧数据缺失 `id` 时退化为「本地路径」兜底匹配（path / url 任一）。
bool imageMatches(Map image, String imageId) {
  final id = image['id'];
  if (id is String && id.isNotEmpty && id == imageId) return true;
  final p = image['path'] as String? ?? image['url'] as String?;
  return p != null && p.isNotEmpty && p == imageId;
}

/// 收集一条 image 涉及的所有本地路径（顶层 + versions）
///
/// 注意：兼容旧数据，对每个条目都尝试 `path` 字段，再回退到 `url` 字段。
/// 不做 `isLocalAssetPath` 过滤——chat_view 的删除回调会把所有路径都丢给
/// `ImageGenService.deleteImage`，由后者在前置短路里过滤非本地资产；
/// 这里只负责「该 image 涉及的全部本地路径候选」。
Set<String> collectImagePaths(Map<String, dynamic> image) {
  final paths = <String>{};
  final top = image['path'] as String? ?? image['url'] as String?;
  if (top != null && top.isNotEmpty) paths.add(top);
  final versions = image['versions'];
  if (versions is List) {
    for (final v in versions) {
      if (v is Map) {
        final vp = v['path'] as String? ?? v['url'] as String?;
        if (vp != null && vp.isNotEmpty) paths.add(vp);
      }
    }
  }
  return paths;
}

/// 「删除整条生图气泡」对应的 metadata 变换：在 [meta] 的
/// `generatedImages` 数组中移除第一个匹配 [imageId] 的条目，返回新 metadata。
///
/// - 入参 [meta] 不被就地修改，返回的 Map 是浅拷贝（`generatedImages` 列表
///   被替换为筛选后的新列表，列表内的 image Map 引用保持原样——这与
///   chat_view 当前的等价语义一致：被移除的 image 不再被引用，其他 image
///   引用保持不变）。
/// - 找不到匹配 image 时返回的 metadata 与入参语义等价（`generatedImages`
///   长度不变）。
/// - `generatedImages` 缺失或非 List 时按空列表处理，返回的 metadata
///   `generatedImages` 字段会写为空 List。
Map<String, dynamic> removeGeneratedImage(
  Map<String, dynamic> meta,
  String imageId,
) {
  final next = Map<String, dynamic>.from(meta);
  final images = (meta['generatedImages'] as List<dynamic>?) ?? const [];
  final newImages = images
      .where((img) => !(img is Map && imageMatches(img, imageId)))
      .toList();
  next['generatedImages'] = newImages;
  return next;
}

/// 「删除当前展示版本」对应的 metadata 变换：在 [meta] 的
/// `generatedImages` 中找到匹配 [imageId] 的条目，移除其 `versions` 中
/// `path`/`url` 等于 [versionLocalPath] 的那一项；并按以下规则维护一致性：
///
///   1. 若移除版本后 `versions` 为空、且顶层 `path/url` 也等于 [versionLocalPath]
///      （或本就没有 `versions`）→ 整条 image 一起移除；
///   2. 若移除版本后 `versions` 非空、且顶层 `path/url` 等于 [versionLocalPath]
///      → 顶层 `path` 替换为剩余 `versions` 第一项的 path/url；
///   3. `activeVersion` 越界（`>= newVersions.length`）时退到最后一个有效版本。
///
/// [versionLocalPath] 为空字符串、或找不到匹配 image / 找不到匹配 version 时，
/// 返回的 metadata 与入参语义等价（`didMutate == false`）。
///
/// 入参 [meta] 不被就地修改；列表与匹配到的 image Map 都做浅拷贝。
Map<String, dynamic> removeGeneratedImageVersion(
  Map<String, dynamic> meta,
  String imageId,
  String versionLocalPath,
) {
  if (versionLocalPath.isEmpty) {
    return Map<String, dynamic>.from(meta);
  }

  final next = Map<String, dynamic>.from(meta);
  final images = (meta['generatedImages'] as List<dynamic>?) ?? const [];
  final newImages = <dynamic>[];
  bool didMutate = false;

  for (final img in images) {
    if (img is! Map || !imageMatches(img, imageId)) {
      newImages.add(img);
      continue;
    }
    // 拷贝匹配 image 后再修改，避免就地变更入参
    final imgMap = Map<String, dynamic>.from(img.cast<String, dynamic>());
    final versions = (imgMap['versions'] as List<dynamic>?) ?? const [];
    final newVersions = versions.where((v) {
      if (v is! Map) return true;
      final vp = v['path'] as String? ?? v['url'] as String?;
      return vp != versionLocalPath;
    }).toList();

    final topPath = imgMap['path'] as String? ?? imgMap['url'] as String?;
    final topRemoved = topPath == versionLocalPath;

    if (newVersions.isEmpty && (topRemoved || versions.isEmpty)) {
      // versions 空且顶层路径也被删 / 本就没有 versions → 整条 image 移除
      didMutate = true;
      continue;
    }

    // 部分版本删除：保留稳定 image.id，仅替换 versions / 顶层路径
    if (topRemoved && newVersions.isNotEmpty) {
      final firstVer = newVersions.first;
      if (firstVer is Map) {
        final fp = firstVer['path'] as String? ?? firstVer['url'] as String?;
        if (fp != null && fp.isNotEmpty) {
          imgMap['path'] = fp;
        }
      }
    }
    imgMap['versions'] = newVersions;
    final prevActive = imgMap['activeVersion'];
    if (prevActive is int &&
        newVersions.isNotEmpty &&
        prevActive >= newVersions.length) {
      imgMap['activeVersion'] = newVersions.length - 1;
    }
    newImages.add(imgMap);
    didMutate = true;
  }

  if (!didMutate) {
    // 没找到匹配的 image / version：返回浅拷贝，语义等价
    return next;
  }
  next['generatedImages'] = newImages;
  return next;
}
