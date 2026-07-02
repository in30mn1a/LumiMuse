import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'package:archive/archive.dart' show Inflate;
import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';
import 'package:path/path.dart' as p;
import 'package:uuid/uuid.dart';
import '../models/app_settings.dart';
import '../providers/character_images_actions.dart';
import '../utils/local_asset_utils.dart';

/// NovelAI ZIP 解析结果（R1）
/// - [pngBytes]：解压 / 切片后的首文件字节，期望为合法 PNG
/// - [compressionMethod]：ZIP Local File Header offset 8 的压缩方式（0=stored, 8=deflate）
class _NaiZipResult {
  final Uint8List pngBytes;
  final int compressionMethod;
  const _NaiZipResult(this.pngBytes, this.compressionMethod);
}

/// 图片格式枚举 — 对齐主项目 `src/app/api/image-gen/route.ts` 的 `ImageFormat`。
///
/// 生图上游（SD WebUI / NovelAI / ComfyUI / 自定义 API）可能返回 PNG / JPEG / WEBP
/// 三种格式，落地时按真实 magic bytes 选择文件扩展名，避免把 JPEG 存成 `.png`。
enum ImageFormat { png, jpeg, webp }

/// 图片生成服务 — 支持 SD WebUI / NovelAI / ComfyUI / 自定义 API
class ImageGenService {
  final Dio _dio;
  static const _uuid = Uuid();

  ImageGenService({Dio? dio}) : _dio = dio ?? _createDefaultDio();

  static Dio _createDefaultDio() {
    return Dio(BaseOptions(
      connectTimeout: const Duration(seconds: 30),
      // 图像生成（SD/NAI/ComfyUI）耗时较长，给到 5 分钟
      receiveTimeout: const Duration(minutes: 5),
      sendTimeout: const Duration(seconds: 60),
    ));
  }

  // FIX(Major-4): 与 Dio receiveTimeout 5 分钟保持一致，避免轮询提前超时但 Dio 仍在等。
  // 旧代码硬编码 60 次 × 2 秒 = 120 秒，比 receiveTimeout 短一半，长任务会先被
  // ComfyUI 轮询循环判定为"生成超时"抛出，但 ComfyUI 服务端实际仍在出图。
  // 提到 150 次 × 2 秒 = 300 秒（5 分钟）正好对齐 Dio 的 receiveTimeout。
  static const int _comfyUIPollMaxAttempts = 150;
  static const Duration _comfyUIPollInterval = Duration(seconds: 2);

  /// NovelAI seed 与 extra_noise_seed 的随机源
  /// 与 Node.js 端 `Math.floor(Math.random() * 2 ** 32)` 等价
  static final Random _naiRandom = Random();

  /// 生成图片，返回本地文件路径
  Future<String> generate({
    required String prompt,
    String negativePrompt = '',
    required ImageGenSettings settings,
  }) async {
    switch (settings.engine) {
      case 'sd':
        return _generateSD(prompt, negativePrompt, settings);
      case 'nai':
        return _generateNAI(prompt, negativePrompt, settings);
      case 'comfyui':
        return _generateComfyUI(prompt, negativePrompt, settings);
      case 'custom':
        return _generateCustom(prompt, settings);
      default:
        throw Exception('不支持的引擎: ${settings.engine}');
    }
  }

  /// 确保输出目录存在
  Future<String> _ensureOutputDir() async {
    final dir = await getApplicationDocumentsDirectory();
    final outputDir = Directory(p.join(dir.path, 'LumiMuse', 'generated'));
    if (!await outputDir.exists()) {
      await outputDir.create(recursive: true);
    }
    return outputDir.path;
  }

  /// 保存 base64 图片
  ///
  /// 解码后用 [detectImageFormat] 校验 magic bytes，非法格式抛
  /// `FormatException('invalidImageSignature: ...')`；按真实格式选择扩展名
  /// （PNG→png / JPEG→jpg / WEBP→webp），避免把 JPEG 存成 `.png`。
  /// 对照主项目 `src/app/api/image-gen/route.ts` 的 `saveBase64Image` +
  /// `persistImageBuffer`。
  Future<String> _saveBase64Image(String base64) async {
    final dir = await _ensureOutputDir();
    final bytes = base64Decode(base64);
    final fmt = detectImageFormat(bytes);
    if (fmt == null) {
      throw const FormatException(
        'invalidImageSignature: 未识别的图片格式（仅支持 PNG / JPEG / WEBP）',
      );
    }
    final filename = '${_uuid.v4()}.${extForFormat(fmt)}';
    final filepath = p.join(dir, filename);
    await File(filepath).writeAsBytes(bytes);
    return filepath;
  }

  /// 保存远程图片
  ///
  /// 下载后用 [detectImageFormat] 校验 magic bytes，非法格式抛
  /// `FormatException('invalidImageSignature: ...')`；按真实格式选择扩展名。
  Future<String> _saveRemoteImage(String imageUrl) async {
    final dir = await _ensureOutputDir();
    final response = await _dio.get<List<int>>(
      imageUrl,
      options: Options(responseType: ResponseType.bytes),
    );
    final bytes = Uint8List.fromList(response.data!);
    final fmt = detectImageFormat(bytes);
    if (fmt == null) {
      throw const FormatException(
        'invalidImageSignature: 未识别的图片格式（仅支持 PNG / JPEG / WEBP）',
      );
    }
    final filename = '${_uuid.v4()}.${extForFormat(fmt)}';
    final filepath = p.join(dir, filename);
    await File(filepath).writeAsBytes(bytes);
    return filepath;
  }

  /// SD WebUI
  Future<String> _generateSD(String prompt, String negativePrompt, ImageGenSettings cfg) async {
    final fullPrompt = cfg.qualityTags.isNotEmpty ? '${cfg.qualityTags}, $prompt' : prompt;
    final fullNeg = negativePrompt.isNotEmpty ? negativePrompt : cfg.sdNegativePrompt;

    final url = '${cfg.sdUrl.replaceAll(RegExp(r'/$'), '')}/sdapi/v1/txt2img';
    final response = await _dio.post(url, data: {
      'prompt': fullPrompt,
      'negative_prompt': fullNeg,
      'steps': cfg.sdSteps,
      'cfg_scale': cfg.sdCfgScale,
      'width': cfg.sdWidth,
      'height': cfg.sdHeight,
      'sampler_name': cfg.sdSampler,
      'batch_size': 1,
      'n_iter': 1,
    });

    final images = response.data['images'];
    final base64 = images is List && images.isNotEmpty
        ? images.first as String?
        : null;
    if (base64 == null) throw Exception('SD WebUI 未返回图片');
    return _saveBase64Image(base64);
  }

  /// NovelAI
  Future<String> _generateNAI(String prompt, String negativePrompt, ImageGenSettings cfg) async {
    var fullPrompt = '';
    if (cfg.naiArtistTags.isNotEmpty) fullPrompt += '${cfg.naiArtistTags}, ';
    if (cfg.qualityTags.isNotEmpty) fullPrompt += '${cfg.qualityTags}, ';
    fullPrompt += prompt;

    final fullNeg = negativePrompt.isNotEmpty ? negativePrompt : cfg.naiNegativePrompt;
    final model = cfg.naiModel;

    // 先生成 seed / extra_noise_seed，再交给 _buildNaiParameters 组装请求体
    // 与 Node.js 端 `Math.floor(Math.random() * 2 ** 32)` 等价
    final seed = _naiRandom.nextInt(1 << 32);
    final extraNoiseSeed = _naiRandom.nextInt(1 << 32);

    final parameters = _buildNaiParameters(
      cfg: cfg,
      fullPrompt: fullPrompt,
      fullNeg: fullNeg,
      seed: seed,
      extraNoiseSeed: extraNoiseSeed,
    );

    final response = await _dio.post(
      'https://image.novelai.net/ai/generate-image',
      data: {
        'input': fullPrompt,
        'model': model,
        'action': 'generate',
        'parameters': parameters,
      },
      options: Options(
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ${cfg.naiApiKey}',
        },
        responseType: ResponseType.bytes,
      ),
    );

    final bytes = response.data as List<int>;
    final uint8 = Uint8List.fromList(bytes);

    // 解析 NAI 响应：参考 Node.js 端 src/app/api/image-gen/route.ts
    // - application/json：取 output[0] base64 解码
    // - PK\x03\x04 开头：ZIP，调用 _parseNaiZip 处理 stored/deflate
    // - PNG 签名开头：直接落盘
    // - 其它：抛错
    final contentType = (response.headers.value('content-type') ?? '').toLowerCase();

    Uint8List pngBytes;
    if (contentType.contains('application/json')) {
      // JSON 兜底：{"output":["<base64>"]}，复用纯函数 decodeNaiJsonOutput 方便属性测试
      pngBytes = decodeNaiJsonOutput(uint8);
    } else if (uint8.length >= 4 &&
        uint8[0] == 0x50 &&
        uint8[1] == 0x4B &&
        uint8[2] == 0x03 &&
        uint8[3] == 0x04) {
      // ZIP（PK\x03\x04）：解析 Local File Header 后切片或 raw inflate
      pngBytes = _parseNaiZip(uint8).pngBytes;
    } else if (uint8.length >= 4 &&
        uint8[0] == 0x89 &&
        uint8[1] == 0x50 &&
        uint8[2] == 0x4E &&
        uint8[3] == 0x47) {
      // 直接是 PNG
      pngBytes = uint8;
    } else {
      throw FormatException(
        'NovelAI 返回了无法解析的响应（content-type=$contentType, length=${uint8.length}）',
      );
    }

    // 写文件前再统一校验 PNG 签名，避免任何分支落入损坏字节
    _ensurePngSignature(pngBytes);

    final dir = await _ensureOutputDir();
    final filename = '${_uuid.v4()}.png';
    final filepath = p.join(dir, filename);
    await File(filepath).writeAsBytes(pngBytes);
    return filepath;
  }

  /// 测试用别名：暴露 [_buildNaiParameters] 以便属性测试在不发起真实 HTTP
  /// 请求的前提下覆盖 v4 / v4.5 字段开关与 seed 范围性质。
  ///
  /// 仅 `@visibleForTesting`，业务代码请直接调用 [_buildNaiParameters]。
  @visibleForTesting
  static Map<String, dynamic> buildNaiParametersForTesting({
    required ImageGenSettings cfg,
    required String fullPrompt,
    required String fullNeg,
    required int seed,
    required int extraNoiseSeed,
  }) =>
      _buildNaiParameters(
        cfg: cfg,
        fullPrompt: fullPrompt,
        fullNeg: fullNeg,
        seed: seed,
        extraNoiseSeed: extraNoiseSeed,
      );

  /// 构造 NovelAI 请求 `parameters` 字段（R2）
  ///
  /// 与 Node.js 端 `src/app/api/image-gen/route.ts` 对齐：
  /// - 始终写入 `seed` 与 `extra_noise_seed`
  /// - 模型名包含 `4` 时追加 v4 字段：
  ///   `params_version=3, legacy=false, prefer_brownian=true, quality_toggle=true,`
  ///   `autoSmea=true, dynamic_thresholding=false, v4_prompt, v4_negative_prompt`
  /// - 模型名包含 `4-5` 或 `4.5` 时再写入 `skip_cfg_above_sigma=null`
  /// - 模型名不含 `4` 时不写入上述 v4 专属字段
  static Map<String, dynamic> _buildNaiParameters({
    required ImageGenSettings cfg,
    required String fullPrompt,
    required String fullNeg,
    required int seed,
    required int extraNoiseSeed,
  }) {
    final model = cfg.naiModel;
    final isV4 = model.contains('4');
    final isV45 = model.contains('4-5') || model.contains('4.5');

    final parameters = <String, dynamic>{
      'width': cfg.naiWidth,
      'height': cfg.naiHeight,
      'scale': cfg.naiScale,
      'cfg_rescale': cfg.naiCfgRescale,
      'sampler': cfg.naiSampler,
      'noise_schedule': cfg.naiNoiseSchedule,
      'steps': cfg.naiSteps,
      'n_samples': 1,
      'ucPreset': 0,
      'negative_prompt': fullNeg,
      'seed': seed,
      'extra_noise_seed': extraNoiseSeed,
    };

    if (isV4) {
      parameters['params_version'] = 3;
      parameters['legacy'] = false;
      parameters['prefer_brownian'] = true;
      parameters['quality_toggle'] = true;
      parameters['autoSmea'] = true;
      parameters['dynamic_thresholding'] = false;
      parameters['v4_prompt'] = {
        'caption': {'base_caption': fullPrompt, 'char_captions': []},
        'use_coords': false,
        'use_order': true,
      };
      parameters['v4_negative_prompt'] = {
        'caption': {'base_caption': fullNeg, 'char_captions': []},
        'use_coords': false,
        'use_order': false,
      };
      if (isV45) {
        parameters['skip_cfg_above_sigma'] = null;
      }
    }

    return parameters;
  }

  /// 解析 NovelAI JSON 兜底响应（R1 验收标准 1.5）
  ///
  /// 输入：UTF-8 字节序列，期望解析为 `{"output":["<base64>"], ...}` 形式的 JSON 对象。
  /// 输出：`output[0]` 字段经 base64 解码后的原始字节。
  ///
  /// 与 Node.js 端 `src/app/api/image-gen/route.ts` 行为一致：
  /// - JSON 解析失败 → 抛 `FormatException`（来自 `jsonDecode` / `utf8.decode`）
  /// - 顶层不是 Map / `output` 不是 List / 列表为空 / `output[0]` 不是 String
  ///   → 抛带「NovelAI JSON 响应缺少 output[0] base64 字段」语义的 `FormatException`
  /// - base64 解码失败 → 抛 `FormatException`（来自 `base64Decode`）
  ///
  /// 抽出为公开静态方法（仅 `@visibleForTesting` 暴露）以便属性测试在不发起真实 HTTP
  /// 请求的前提下覆盖 JSON 兜底分支的 round-trip 性质。
  @visibleForTesting
  static Uint8List decodeNaiJsonOutput(Uint8List bytes) {
    final decoded = jsonDecode(utf8.decode(bytes));
    if (decoded is! Map<String, dynamic>) {
      throw const FormatException('NovelAI JSON 响应顶层必须是对象');
    }
    final output = decoded['output'];
    if (output is! List || output.isEmpty || output.first is! String) {
      throw const FormatException('NovelAI JSON 响应缺少 output[0] base64 字段');
    }
    return Uint8List.fromList(base64Decode(output.first as String));
  }

  /// 解析 NovelAI 返回的 ZIP（仅取 Local File Header 之后的首文件）
  ///
  /// 与 Node.js 端 `src/app/api/image-gen/route.ts` 行为一致：
  /// - offset 8（2 bytes LE）：compression method，0=stored，8=deflate
  /// - offset 18（4 bytes LE）：compressed size
  /// - offset 26（2 bytes LE）：filename length
  /// - offset 28（2 bytes LE）：extra field length
  /// - dataStart = 30 + filenameLen + extraLen
  ///
  /// method=0 直接切片，method=8 调用 `archive` 包 `Inflate(...).getBytes()` 做 raw inflate；
  /// 其它压缩方式抛 `FormatException('unsupportedCompressionMethod=$method')`。
  static _NaiZipResult _parseNaiZip(Uint8List uint8) {
    if (uint8.length < 30) {
      throw const FormatException('NovelAI ZIP 长度不足以容纳 Local File Header');
    }
    final method = uint8[8] | (uint8[9] << 8);
    final compressedSize = uint8[18] |
        (uint8[19] << 8) |
        (uint8[20] << 16) |
        (uint8[21] << 24);
    final filenameLen = uint8[26] | (uint8[27] << 8);
    final extraLen = uint8[28] | (uint8[29] << 8);
    final dataStart = 30 + filenameLen + extraLen;
    if (dataStart > uint8.length) {
      throw const FormatException('NovelAI ZIP 文件名 / 扩展段越界');
    }
    final dataEnd =
        compressedSize > 0 ? dataStart + compressedSize : uint8.length;
    if (dataEnd > uint8.length || dataEnd < dataStart) {
      throw const FormatException('NovelAI ZIP compressed size 越界');
    }
    final compressed = uint8.sublist(dataStart, dataEnd);

    if (method == 0) {
      // stored：未压缩，直接使用
      return _NaiZipResult(Uint8List.fromList(compressed), 0);
    } else if (method == 8) {
      // deflate：raw inflate（无 zlib header），与 Node.js inflateRawSync 等价
      final inflated = Inflate(compressed).getBytes();
      return _NaiZipResult(Uint8List.fromList(inflated), 8);
    } else {
      throw FormatException('unsupportedCompressionMethod=$method');
    }
  }

  /// 测试用别名：暴露 [_parseNaiZip] 的 PNG 字节切片，用于属性测试覆盖
  /// stored / deflate 两个分支的 round-trip 性质。
  ///
  /// 这里只暴露 `Uint8List` 而不是私有的 [_NaiZipResult]，避免把内部数据结构
  /// 泄露到测试代码里。
  @visibleForTesting
  static Uint8List parseNaiZipForTesting(Uint8List uint8) =>
      _parseNaiZip(uint8).pngBytes;

  /// 校验图片 magic bytes，识别 PNG / JPEG / WEBP。
  ///
  /// 与主项目 `src/app/api/image-gen/route.ts` 的 `detectImageFormat` 行为一致：
  /// - 长度 < 12 → 返回 null（不足以判定任何格式）
  /// - PNG：前 4 字节为 `89 50 4E 47`
  /// - JPEG：前 3 字节为 `FF D8 FF`
  /// - WEBP：前 4 字节为 `52 49 46 46`（RIFF）且 offset 8..11 为 `57 45 42 50`（WEBP）
  /// - 其它 → 返回 null，调用方应据此拒绝写入
  @visibleForTesting
  static ImageFormat? detectImageFormat(Uint8List bytes) {
    if (bytes.length < 12) return null;
    // PNG: 89 50 4E 47 0D 0A 1A 0A（仅校验前 4 字节，与主项目一致）
    if (bytes[0] == 0x89 &&
        bytes[1] == 0x50 &&
        bytes[2] == 0x4E &&
        bytes[3] == 0x47) {
      return ImageFormat.png;
    }
    // JPEG: FF D8 FF
    if (bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF) {
      return ImageFormat.jpeg;
    }
    // WEBP: 'RIFF' .. .. .. .. 'WEBP'
    if (bytes[0] == 0x52 &&
        bytes[1] == 0x49 &&
        bytes[2] == 0x46 &&
        bytes[3] == 0x46 &&
        bytes[8] == 0x57 &&
        bytes[9] == 0x45 &&
        bytes[10] == 0x42 &&
        bytes[11] == 0x50) {
      return ImageFormat.webp;
    }
    return null;
  }

  /// 根据 [ImageFormat] 返回对应的文件扩展名（不含 `.`）。
  ///
  /// 与主项目 `extForFormat` 一致：JPEG 用 `jpg`，其余直接用枚举名。
  static String extForFormat(ImageFormat fmt) {
    return fmt == ImageFormat.jpeg ? 'jpg' : fmt.name;
  }

  /// 校验 PNG 签名 `0x89 0x50 0x4E 0x47`（R1 验收标准 1.6）
  ///
  /// 长度 < 4 或前 4 字节不匹配时抛带 `invalidPngSignature` 字段名的异常。
  ///
  /// 保留该方法以兼容现有 PNG 属性测试（`ensurePngSignatureForTesting`）；
  /// NAI 分支输出固定为 PNG，继续走此路径。SD / ComfyUI / 自定义 API 等可能
  /// 返回 JPEG / WEBP 的分支改用 [detectImageFormat] 统一判定。
  static void _ensurePngSignature(Uint8List bytes) {
    if (bytes.length < 4 ||
        bytes[0] != 0x89 ||
        bytes[1] != 0x50 ||
        bytes[2] != 0x4E ||
        bytes[3] != 0x47) {
      throw const FormatException('invalidPngSignature: 写入字节不是合法 PNG');
    }
  }

  /// 测试用别名：暴露 [_ensurePngSignature]，供属性测试覆盖
  /// 「长度 < 4 或前 4 字节不等于 PNG 签名时抛错」这一性质。
  ///
  /// 仅 `@visibleForTesting`，业务代码请直接调用 [_ensurePngSignature]。
  @visibleForTesting
  static void ensurePngSignatureForTesting(Uint8List bytes) =>
      _ensurePngSignature(bytes);

  /// 构造 ComfyUI 工作流（R3）
  ///
  /// 与 Node.js 端 `src/app/api/image-gen/route.ts` 的 `generateComfyUI` 对齐：
  /// - `cfg.comfyuiWorkflow.trim()` 非空 → 使用用户自定义模板：
  ///   1. 先 `jsonDecode` 验证 JSON 合法性，失败抛
  ///      「ComfyUI 工作流 JSON 格式错误: $e」并附带原始 `FormatException`。
  ///   2. 对 `fullPrompt` / `fullNeg` 做 JSON 安全转义（先 `\\` → `\\\\`，
  ///      再 `"` → `\\"`），以纯文本 `replaceAll` 替换 `{{positive_prompt}}` /
  ///      `{{negative_prompt}}` 占位符；占位符不存在时保留模板原样，不注入 prompt。
  ///   3. 替换后再 `jsonDecode` 得到工作流 `Map<String, dynamic>`。
  /// - 空字符串 / 仅空白 → 回退到与原硬编码完全一致的默认工作流。
  ///
  /// Node.js 端原本仅做 `"` 转义，这里额外补 `\\` → `\\\\` 转义更稳，
  /// 不破坏向前兼容。
  @visibleForTesting
  static Map<String, dynamic> buildComfyWorkflowForTesting(
    ImageGenSettings cfg,
    String fullPrompt,
    String fullNeg,
  ) =>
      _buildComfyWorkflow(cfg, fullPrompt, fullNeg);

  static Map<String, dynamic> _buildComfyWorkflow(
    ImageGenSettings cfg,
    String fullPrompt,
    String fullNeg,
  ) {
    final template = cfg.comfyuiWorkflow.trim();
    if (template.isEmpty) {
      return _buildDefaultComfyWorkflow(cfg, fullPrompt, fullNeg);
    }

    // 1. 先验证 JSON 合法性
    try {
      jsonDecode(template);
    } on FormatException catch (e) {
      throw FormatException('ComfyUI 工作流 JSON 格式错误: $e');
    }

    // 2. JSON 安全转义后替换占位符（占位符不存在时保留原样）
    //    必须转义反斜杠、双引号，以及 JSON 字符串中不允许裸露的控制字符
    //    （\n \r \t 及其他 U+0000~U+001F），否则第 3 步 jsonDecode 会抛
    //    FormatException。用 jsonEncode 编码再剥掉外层引号最稳妥，覆盖全部边界。
    String escape(String raw) {
      final encoded = jsonEncode(raw);
      return encoded.substring(1, encoded.length - 1);
    }
    final replaced = template
        .replaceAll('{{positive_prompt}}', escape(fullPrompt))
        .replaceAll('{{negative_prompt}}', escape(fullNeg));

    // 3. 再次 jsonDecode 得到工作流 Map
    try {
      final decoded = jsonDecode(replaced);
      if (decoded is! Map<String, dynamic>) {
        throw const FormatException('ComfyUI 工作流必须是 JSON 对象');
      }
      return decoded;
    } on FormatException catch (e) {
      throw FormatException('ComfyUI 工作流 JSON 格式错误: $e');
    }
  }

  /// 默认 ComfyUI 文生图工作流（与原硬编码完全一致）
  static Map<String, dynamic> _buildDefaultComfyWorkflow(
    ImageGenSettings cfg,
    String fullPrompt,
    String fullNeg,
  ) {
    return <String, dynamic>{
      '3': {
        'class_type': 'KSampler',
        'inputs': {
          'seed': DateTime.now().millisecondsSinceEpoch % (1 << 32),
          'steps': cfg.sdSteps,
          'cfg': cfg.sdCfgScale,
          'sampler_name': 'euler',
          'scheduler': 'normal',
          'denoise': 1,
          'model': ['4', 0],
          'positive': ['6', 0],
          'negative': ['7', 0],
          'latent_image': ['5', 0],
        },
      },
      '4': {
        'class_type': 'CheckpointLoaderSimple',
        'inputs': {
          'ckpt_name':
              cfg.sdModel.isNotEmpty ? cfg.sdModel : 'model.safetensors',
        },
      },
      '5': {
        'class_type': 'EmptyLatentImage',
        'inputs': {
          'width': cfg.sdWidth,
          'height': cfg.sdHeight,
          'batch_size': 1,
        },
      },
      '6': {
        'class_type': 'CLIPTextEncode',
        'inputs': {'text': fullPrompt, 'clip': ['4', 1]},
      },
      '7': {
        'class_type': 'CLIPTextEncode',
        'inputs': {'text': fullNeg, 'clip': ['4', 1]},
      },
      '8': {
        'class_type': 'VAEDecode',
        'inputs': {
          'samples': ['3', 0],
          'vae': ['4', 2],
        },
      },
      '9': {
        'class_type': 'SaveImage',
        'inputs': {'filename_prefix': 'LumiMuse', 'images': ['8', 0]},
      },
    };
  }

  /// ComfyUI
  Future<String> _generateComfyUI(String prompt, String negativePrompt, ImageGenSettings cfg) async {
    final fullPrompt = cfg.qualityTags.isNotEmpty ? '${cfg.qualityTags}, $prompt' : prompt;
    final fullNeg = negativePrompt.isNotEmpty ? negativePrompt : cfg.sdNegativePrompt;
    final baseUrl = cfg.comfyuiUrl.replaceAll(RegExp(r'/$'), '');

    // 与 Node.js 端 src/app/api/image-gen/route.ts 的 generateComfyUI 对齐：
    // - cfg.comfyuiWorkflow 非空（去除空白后）→ 使用用户自定义模板，
    //   先 jsonDecode 验证 JSON 合法，再以纯文本替换 {{positive_prompt}} /
    //   {{negative_prompt}} 占位符（替换前对 prompt 做 JSON 安全转义），最后再
    //   jsonDecode 得到 Map；占位符不存在时保留模板原样不注入 prompt。
    // - 空 / null / 仅空白 → 回退到与原硬编码完全一致的默认工作流。
    final Map<String, dynamic> workflow =
        _buildComfyWorkflow(cfg, fullPrompt, fullNeg);

    final queueRes = await _dio.post('$baseUrl/prompt', data: {'prompt': workflow});
    final promptId = queueRes.data['prompt_id'] as String;

    // FIX(Major-4): 用类常量替代硬编码 60×2s，与 Dio receiveTimeout 5 分钟对齐。
    for (int i = 0; i < _comfyUIPollMaxAttempts; i++) {
      await Future.delayed(_comfyUIPollInterval);
      final historyRes = await _dio.get('$baseUrl/history/$promptId');
      final result = historyRes.data[promptId];
      if (result == null) continue;

      final outputs = result['outputs'] as Map<String, dynamic>? ?? {};
      for (final nodeOutput in outputs.values) {
        final images = nodeOutput['images'] as List?;
        if (images != null && images.isNotEmpty) {
          final img = images[0] as Map<String, dynamic>;
          // 对齐主项目 image-gen/route.ts:483：从 history 转发 subfolder 与 type。
          // SaveImage 节点可输出到子目录，部分节点发出 type='temp'；缺这两个参数
          // 会让 /view 返回 404 / 空，表现为生图"成功"但下载保存失败。
          final filename =
              Uri.encodeComponent(img['filename'] as String? ?? '');
          final type = img['type'] as String? ?? 'output';
          final subfolder = img['subfolder'] as String? ?? '';
          final subfolderParam = subfolder.isEmpty
              ? ''
              : '&subfolder=${Uri.encodeComponent(subfolder)}';
          final imgUrl =
              '$baseUrl/view?filename=$filename&type=$type$subfolderParam';
          return _saveRemoteImage(imgUrl);
        }
      }
    }

    throw Exception('ComfyUI 生成超时');
  }

  /// 自定义 API（OpenAI DALL-E 兼容）
  Future<String> _generateCustom(String prompt, ImageGenSettings cfg) async {
    final fullPrompt = cfg.qualityTags.isNotEmpty ? '${cfg.qualityTags}, $prompt' : prompt;

    final headers = <String, String>{'Content-Type': 'application/json'};
    if (cfg.customApiKey.isNotEmpty) {
      headers['Authorization'] = 'Bearer ${cfg.customApiKey}';
    }

    final response = await _dio.post(
      cfg.customUrl,
      data: {
        'model': cfg.customModel,
        'prompt': fullPrompt,
        'n': 1,
        'size': cfg.customSize,
        'response_format': 'b64_json',
      },
      options: Options(headers: headers),
    );

    final data = response.data;
    if (data['data']?[0]?['b64_json'] != null) {
      return _saveBase64Image(data['data'][0]['b64_json'] as String);
    }
    if (data['data']?[0]?['url'] != null) {
      return _saveRemoteImage(data['data'][0]['url'] as String);
    }
    if (data['images']?[0] != null) {
      return _saveBase64Image(data['images'][0] as String);
    }

    throw Exception('自定义 API 返回格式无法解析');
  }

  void dispose() {
    _dio.close();
  }

  /// 单张本地生图文件的安全删除入口（R1）
  ///
  /// 语义对齐 Node.js 主项目 `src/app/api/image-gen/delete/route.ts`：
  /// 「在确保该路径不再被任何消息 metadata 或角色 avatar 引用时，才真正
  /// 从磁盘删除文件」。底层复用已有的 [CharacterImagesActions.scanAndDeleteOrphanFiles]，
  /// 不在本方法内重写引用扫描。
  ///
  /// 行为：
  /// - [localPath] 为 `null` 或 `trim()` 后为空 → 直接返回，不写日志、不抛异常。
  /// - `isLocalAssetPath(localPath)` 返回 false（远程 URL / data URL）→
  ///   写一条「跳过:非本地资产路径」的调试日志后返回。
  /// - 命中本地资产 → 调用 `imagesActions.scanAndDeleteOrphanFiles({localPath})`。
  ///   该方法会扫描全库 messages.metadata 与 characters.avatar_url 中的本地路径,
  ///   仅当 [localPath] 不再被任何引用时才真正删除文件;删除失败仅记日志不抛错。
  /// - 任何来自 [CharacterImagesActions.scanAndDeleteOrphanFiles] 的异常都会
  ///   被本方法捕获并写日志,**不**重抛。
  ///
  /// 调用方应保证:调用 [deleteImage] **之前**已经把 [localPath] 从待删消息的
  /// metadata 中移除并写库(否则 `scanAndDeleteOrphanFiles` 会判定仍被引用而不删文件)。
  Future<void> deleteImage(
    String? localPath, {
    required CharacterImagesActions imagesActions,
  }) async {
    // 1) null / 空白:静默返回,不写日志、不抛异常,也不发起扫描
    if (localPath == null || localPath.trim().isEmpty) {
      return;
    }

    // 2) 非本地资产(http/https/data 等):仅写一条调试日志后返回
    if (!isLocalAssetPath(localPath)) {
      debugPrint(
        '[ImageGenService.deleteImage] 跳过:非本地资产路径 $localPath',
      );
      return;
    }

    // 3) 本地资产:委托给 scanAndDeleteOrphanFiles 做「全库引用扫描 + 安全删除」,
    //    底层异常仅记录日志不重抛,保证调用方 `await` 永远正常完成
    try {
      await imagesActions.scanAndDeleteOrphanFiles(<String>{localPath});
    } catch (e) {
      debugPrint(
        '[ImageGenService.deleteImage] 引用扫描失败:$localPath($e)',
      );
    }
  }
}
