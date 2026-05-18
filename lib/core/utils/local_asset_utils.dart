/// 本地资产工具模块 — 为 R10（角色复制级联拷贝）和 R11（角色图片管理）共享
///
/// 与 Node.js 主项目 `src/lib/character-file-utils.ts` 在语义上等价，但适配
/// Flutter 端的本地文件系统路径形态：
/// - Node.js 端的本地资产以 `/avatars/...` 等 URL 路径承载，由 `proxy.ts` 代理。
/// - Flutter 端直接存储应用文档目录下的绝对文件路径（如
///   `<docs>/LumiMuse/generated/<uuid>.png`），无需经过 HTTP。
///
/// 因此，所有非 `http(s)` / `data:` / 空值的字符串都会被视为「可能的本地资产」，
/// 由 `copyLocalAsset` 真正落地复制时再做存在性校验。
library;

import 'dart:io';

import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:uuid/uuid.dart';

/// 判断给定 URL 是否指向应用本地文件路径
///
/// 规则（与 R10 / R11 复制语义保持一致）：
/// - `null` 或空白字符串 → 否
/// - 以 `http://` / `https://` 开头的远程 URL → 否
/// - 以 `data:` 开头的内联 base64 → 否
/// - 主项目 web 相对资产路径（`/avatars/` / `/generated/` /
///   `/attachments/` / `/api/files/`）→ 否
/// - 其他情况 → 视为本地路径（具体存在性留给 `copyLocalAsset` 校验）
bool isLocalAssetPath(String? url) {
  if (url == null) return false;
  final trimmed = url.trim();
  if (trimmed.isEmpty) return false;
  // 远程 URL 不算本地资产（大小写不敏感）
  final lower = trimmed.toLowerCase();
  if (lower.startsWith('http://') || lower.startsWith('https://')) return false;
  if (lower.startsWith('data:')) return false;
  if (trimmed.startsWith('/avatars/') ||
      trimmed.startsWith('/generated/') ||
      trimmed.startsWith('/attachments/') ||
      trimmed.startsWith('/api/files/')) {
    return false;
  }
  return true;
}

/// 扫描消息 metadata，提取其中所有本地资产路径
///
/// 仅扫描以下四个固定位置，避免误伤 metadata 中其它字段：
/// 1. `metadata.generatedImages[].url`           — 生图气泡当前展示版本
/// 2. `metadata.generatedImages[].versions[].url` — 生图版本历史
/// 3. `metadata.image_versions[].url`            — 消息级别图片版本历史
/// 4. `metadata.attachments[].url`               — 用户附件
///
/// 返回去重后的本地路径集合，供 R10 角色复制阶段构造「旧路径 → 新路径」映射，
/// 也供 R11 角色图片管理阶段做引用扫描。
Set<String> extractLocalPaths(Map<String, dynamic> metadata) {
  final result = <String>{};

  // 1) generatedImages 当前 url 与每个 version 的 url
  final generatedImages = metadata['generatedImages'];
  if (generatedImages is List) {
    for (final image in generatedImages) {
      if (image is Map) {
        _collectUrlIfLocal(image['url'], result);
        final versions = image['versions'];
        if (versions is List) {
          for (final v in versions) {
            if (v is Map) {
              _collectUrlIfLocal(v['url'], result);
            }
          }
        }
      }
    }
  }

  // 2) image_versions 顶层版本数组
  final imageVersions = metadata['image_versions'];
  if (imageVersions is List) {
    for (final v in imageVersions) {
      if (v is Map) {
        _collectUrlIfLocal(v['url'], result);
      }
    }
  }

  // 3) attachments 用户附件
  final attachments = metadata['attachments'];
  if (attachments is List) {
    for (final a in attachments) {
      if (a is Map) {
        _collectUrlIfLocal(a['url'], result);
      }
    }
  }

  return result;
}

/// 复制一份本地资产文件，返回新路径；失败抛带原路径的异常
///
/// 行为：
/// - 在 `path_provider` 提供的应用文档目录下，与 `sourcePath` 相同的子目录里创建副本。
/// - 新文件名规则：`<uuid 前缀 12 位><原扩展名>`（与 Node.js
///   `character-file-utils.ts` 的 `randomUUID().slice(0, 12)` 等价，避免冲突）。
/// - 源文件不存在或复制失败时，抛出包含原路径的 `Exception`，由调用方决定回滚策略。
Future<String> copyLocalAsset(String sourcePath) async {
  try {
    final source = File(sourcePath);
    if (!await source.exists()) {
      throw FileSystemException('源文件不存在', sourcePath);
    }

    // 用 path 解析扩展名与父目录，保持「头像 / 生图 / 附件」分类不变
    final ext = p.extension(sourcePath);
    final newFilename = '${_LocalAssetIds.shortUuid()}$ext';

    // 优先沿用源文件所在目录；若源路径无父目录（极少见），回退到应用文档目录
    String targetDir = p.dirname(sourcePath);
    if (targetDir.isEmpty || targetDir == '.') {
      final docs = await getApplicationDocumentsDirectory();
      targetDir = p.join(docs.path, 'LumiMuse', 'generated');
    }

    final targetDirHandle = Directory(targetDir);
    if (!await targetDirHandle.exists()) {
      await targetDirHandle.create(recursive: true);
    }

    final targetPath = p.join(targetDir, newFilename);
    await source.copy(targetPath);
    return targetPath;
  } catch (e) {
    // 统一封装为可读异常，附带原路径方便上层日志定位
    throw Exception('复制本地资产失败：$sourcePath（$e）');
  }
}

/// 用「旧路径 → 新路径」映射重写 metadata 中的所有本地资产引用
///
/// 仅作用于 [extractLocalPaths] 扫描的同一组位置，确保去重复制后所有引用一致。
/// 输入 metadata 不被就地修改，函数返回新的深拷贝结果。
Map<String, dynamic> remapLocalPaths(
  Map<String, dynamic> metadata,
  Map<String, String> mapping,
) {
  if (mapping.isEmpty) {
    // 无映射时直接深拷贝返回，调用方语义保持「永远不就地修改」
    return _deepCopyMap(metadata);
  }

  final next = _deepCopyMap(metadata);

  // 1) generatedImages
  final generatedImages = next['generatedImages'];
  if (generatedImages is List) {
    for (var i = 0; i < generatedImages.length; i++) {
      final image = generatedImages[i];
      if (image is Map) {
        final imageMap = Map<String, dynamic>.from(image);
        _remapUrlField(imageMap, mapping);

        final versions = imageMap['versions'];
        if (versions is List) {
          final newVersions = <dynamic>[];
          for (final v in versions) {
            if (v is Map) {
              final vMap = Map<String, dynamic>.from(v);
              _remapUrlField(vMap, mapping);
              newVersions.add(vMap);
            } else {
              newVersions.add(v);
            }
          }
          imageMap['versions'] = newVersions;
        }

        generatedImages[i] = imageMap;
      }
    }
  }

  // 2) image_versions
  final imageVersions = next['image_versions'];
  if (imageVersions is List) {
    for (var i = 0; i < imageVersions.length; i++) {
      final v = imageVersions[i];
      if (v is Map) {
        final vMap = Map<String, dynamic>.from(v);
        _remapUrlField(vMap, mapping);
        imageVersions[i] = vMap;
      }
    }
  }

  // 3) attachments
  final attachments = next['attachments'];
  if (attachments is List) {
    for (var i = 0; i < attachments.length; i++) {
      final a = attachments[i];
      if (a is Map) {
        final aMap = Map<String, dynamic>.from(a);
        _remapUrlField(aMap, mapping);
        attachments[i] = aMap;
      }
    }
  }

  return next;
}

// ───────────────────────── 内部辅助函数 ─────────────────────────

/// 仅当 url 是本地资产路径时，加入结果集合（去重由 Set 保证）
void _collectUrlIfLocal(dynamic url, Set<String> result) {
  if (url is String && isLocalAssetPath(url)) {
    result.add(url);
  }
}

/// 若 entry['url'] 命中映射，重写为新路径；其余情况保持原样
void _remapUrlField(Map<String, dynamic> entry, Map<String, String> mapping) {
  final url = entry['url'];
  if (url is String) {
    final mapped = mapping[url];
    if (mapped != null) {
      entry['url'] = mapped;
    }
  }
}

/// 对 JSON 风格 Map 做安全深拷贝，避免 [remapLocalPaths] 就地修改入参
Map<String, dynamic> _deepCopyMap(Map<String, dynamic> source) {
  final out = <String, dynamic>{};
  source.forEach((key, value) {
    out[key] = _deepCopyValue(value);
  });
  return out;
}

dynamic _deepCopyValue(dynamic value) {
  if (value is Map) {
    final copy = <String, dynamic>{};
    value.forEach((k, v) {
      copy[k.toString()] = _deepCopyValue(v);
    });
    return copy;
  }
  if (value is List) {
    return value.map(_deepCopyValue).toList();
  }
  // String / num / bool / null 等不可变值直接返回
  return value;
}

/// 集中管理新文件名 UUID 生成，方便单测时可替换
class _LocalAssetIds {
  static const _uuid = Uuid();

  /// 与 Node.js `randomUUID().slice(0, 12)` 等价的短 UUID
  static String shortUuid() {
    final v = _uuid.v4().replaceAll('-', '');
    return v.substring(0, 12);
  }
}
