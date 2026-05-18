// Feature: flutter-parity-completion, Property 1: NAI ZIP 解析 round-trip
// **Validates: Requirements 1.1, 1.2, 1.3**
//
// 用 `package:glados` 生成 `(payload, method ∈ {0, 8}, filenameLen, extraLen)`，
// 按 ZIP Local File Header 规范打包后传入 `ImageGenService.parseNaiZipForTesting`，
// 断言：
// - method=0（stored）：直接切片，返回字节等于原 payload。
// - method=8（deflate）：raw inflate 结果等于原 payload。
//
// 与 Node.js 端 `src/app/api/image-gen/route.ts` 的 ZIP 处理逻辑对齐：
// - offset 8（2 bytes LE）：compression method
// - offset 18（4 bytes LE）：compressed size
// - offset 26（2 bytes LE）：filename length
// - offset 28（2 bytes LE）：extra field length
// - 实际数据从 `30 + filenameLen + extraLen` 开始
//
// method=8 的测试样本用 `package:archive` 的 `Deflate` 构造（raw deflate，不带 zlib header），
// 与 NAI 实际返回格式一致。
//
// 默认 100 次迭代（glados ExploreConfig 默认值）。

import 'dart:math' as math;
import 'dart:typed_data';

import 'package:archive/archive.dart' show Deflate;
import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test;
import 'package:lumimuse/core/services/image_gen_service.dart';

/// 一组用于属性测试的 ZIP 输入参数。
///
/// - [payload]：原始字节序列，期望经过 round-trip 后被还原。
/// - [method]：ZIP 压缩方式，仅取 `0`（stored）或 `8`（deflate）。
/// - [filenameLen]：Local File Header 后的文件名长度（任意填充字节）。
/// - [extraLen]：Local File Header 后的扩展字段长度（任意填充字节）。
class _ZipInput {
  final Uint8List payload;
  final int method;
  final int filenameLen;
  final int extraLen;

  const _ZipInput({
    required this.payload,
    required this.method,
    required this.filenameLen,
    required this.extraLen,
  });
}

/// 自定义 glados 生成器：构造 `(payload, method, filenameLen, extraLen)` 元组。
extension _NaiZipGenerators on Any {
  /// 生成 ZIP 输入：
  /// - `payloadLen ∈ [0, 64]`：覆盖空 payload、单字节、和中等规模。
  /// - `method ∈ {0, 8}`：仅这两种合法 ZIP 压缩方式。
  /// - `filenameLen ∈ [0, 16]` / `extraLen ∈ [0, 16]`：保持小规模避免测试过慢。
  /// - 用 `seed` 构造确定性 `Random`，保证 glados 失败重放可复现。
  Generator<_ZipInput> get naiZipInput {
    return combine4<int, int, int, int, _ZipInput>(
      intInRange(0, 65), // payloadLen ∈ [0, 64]
      intInRange(0, 2), // methodIndex：0 → method=0，1 → method=8
      intInRange(0, 17), // filenameLen ∈ [0, 16]
      intInRange(0, 17), // extraLen ∈ [0, 16]
      (payloadLen, methodIndex, filenameLen, extraLen) {
        // 用 (payloadLen, methodIndex) 派生确定性 seed，保证可复现
        final rng = math.Random(payloadLen * 31 + methodIndex);
        final payload = Uint8List.fromList(
          List<int>.generate(payloadLen, (_) => rng.nextInt(256)),
        );
        return _ZipInput(
          payload: payload,
          method: methodIndex == 0 ? 0 : 8,
          filenameLen: filenameLen,
          extraLen: extraLen,
        );
      },
    );
  }
}

/// 把 `(method, payload, filenameLen, extraLen)` 打包成符合 NAI 期望格式的
/// ZIP Local File Header 字节序列。
///
/// 与 `_parseNaiZip` 仅依赖的字段保持最小一致：
/// - 前 4 字节签名 `PK\x03\x04`（实际 `_parseNaiZip` 由调用方决定是否读签名，
///   这里仍按规范填上，便于将来若解析逻辑校验签名也能通过）。
/// - offset 8：method（2 bytes LE）
/// - offset 18：compressed size（4 bytes LE，等于压缩后字节长度）
/// - offset 26：filename length（2 bytes LE）
/// - offset 28：extra field length（2 bytes LE）
/// - 之后依次填充任意 filename / extra / 压缩后的数据
Uint8List _packZip({
  required int method,
  required Uint8List compressed,
  required int filenameLen,
  required int extraLen,
}) {
  final total = 30 + filenameLen + extraLen + compressed.length;
  final buf = Uint8List(total);

  // ZIP Local File Header 签名 `PK\x03\x04`
  buf[0] = 0x50;
  buf[1] = 0x4B;
  buf[2] = 0x03;
  buf[3] = 0x04;

  // offset 4..7：version + flags（任意填 0，不影响 _parseNaiZip 解析）
  // offset 8..9：compression method（小端）
  buf[8] = method & 0xFF;
  buf[9] = (method >> 8) & 0xFF;

  // offset 10..17：mod time / date / crc32（任意填 0）

  // offset 18..21：compressed size（小端，4 字节）
  final compressedSize = compressed.length;
  buf[18] = compressedSize & 0xFF;
  buf[19] = (compressedSize >> 8) & 0xFF;
  buf[20] = (compressedSize >> 16) & 0xFF;
  buf[21] = (compressedSize >> 24) & 0xFF;

  // offset 22..25：uncompressed size（任意填 0）

  // offset 26..27：filename length（小端）
  buf[26] = filenameLen & 0xFF;
  buf[27] = (filenameLen >> 8) & 0xFF;

  // offset 28..29：extra field length（小端）
  buf[28] = extraLen & 0xFF;
  buf[29] = (extraLen >> 8) & 0xFF;

  // offset 30..：filename（任意 ASCII 占位）
  for (var i = 0; i < filenameLen; i++) {
    buf[30 + i] = 0x61; // 'a'
  }
  // 接着是 extra（任意占位）
  for (var i = 0; i < extraLen; i++) {
    buf[30 + filenameLen + i] = 0x62; // 'b'
  }
  // 最后是压缩后数据
  for (var i = 0; i < compressed.length; i++) {
    buf[30 + filenameLen + extraLen + i] = compressed[i];
  }
  return buf;
}

void main() {
  _registerProperty1();
  _registerProperty2();
  _registerProperty4();
}

void _registerProperty1() {
  group('Property 1: NAI ZIP 解析 round-trip', () {
    Glados<_ZipInput>(any.naiZipInput).test(
      'method=0（stored）直接切片等于原 payload（1.1, 1.2）',
      (input) {
        if (input.method != 0) return; // 仅断言 stored 分支

        // stored：compressed bytes 即 payload 本身
        final zipBytes = _packZip(
          method: 0,
          compressed: input.payload,
          filenameLen: input.filenameLen,
          extraLen: input.extraLen,
        );

        final result = ImageGenService.parseNaiZipForTesting(zipBytes);

        expect(result.length, input.payload.length);
        expect(result, equals(input.payload));
      },
    );

    Glados<_ZipInput>(any.naiZipInput).test(
      'method=8（deflate）inflate 结果等于原 payload（1.1, 1.3）',
      (input) {
        if (input.method != 8) return; // 仅断言 deflate 分支

        // 用 `package:archive` 的 Deflate 构造 raw deflate 字节流
        final compressed =
            Uint8List.fromList(Deflate(input.payload).getBytes());

        final zipBytes = _packZip(
          method: 8,
          compressed: compressed,
          filenameLen: input.filenameLen,
          extraLen: input.extraLen,
        );

        final result = ImageGenService.parseNaiZipForTesting(zipBytes);

        expect(result.length, input.payload.length);
        expect(result, equals(input.payload));
      },
    );

    // 例测：边界场景显式断言，与属性测试形成双层保护。
    test('method=0 空 payload + 空 filename + 空 extra 时返回空字节', () {
      final zipBytes = _packZip(
        method: 0,
        compressed: Uint8List(0),
        filenameLen: 0,
        extraLen: 0,
      );
      final result = ImageGenService.parseNaiZipForTesting(zipBytes);
      expect(result, isEmpty);
    });

    test('method=8 单字节 payload round-trip 正确', () {
      final payload = Uint8List.fromList([0x42]);
      final compressed = Uint8List.fromList(Deflate(payload).getBytes());
      final zipBytes = _packZip(
        method: 8,
        compressed: compressed,
        filenameLen: 3,
        extraLen: 5,
      );
      final result = ImageGenService.parseNaiZipForTesting(zipBytes);
      expect(result, equals(payload));
    });
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Feature: flutter-parity-completion, Property 2: NAI 不支持的压缩方式抛错
// **Validates: Requirements 1.4**
//
// 用 `package:glados` 生成 `compressionMethod ∈ [0, 65535] \ {0, 8}`，
// 复用 `_packZip` 按 ZIP Local File Header 规范打包，断言
// `ImageGenService.parseNaiZipForTesting` 抛出 `FormatException`，
// 且 message 含 `unsupportedCompressionMethod` 字段名。
//
// 与 Node.js 端 `src/app/api/image-gen/route.ts` 行为对齐：
// 仅 method=0（stored）与 method=8（deflate）合法，其它一律抛错。
//
// 默认 100 次迭代（glados ExploreConfig 默认值）。
// ──────────────────────────────────────────────────────────────────────────

/// 一组用于 Property 2 的「不支持压缩方式」输入。
///
/// - [method]：合法 16 位无符号整数，但已剔除 `{0, 8}` 两个支持值。
/// - [filenameLen] / [extraLen]：Local File Header 占位长度，用于覆盖偏移变化。
/// - [payloadLen]：压缩段任意填充字节长度（内容随机），保证 `compressedSize`
///   字段读取分支被覆盖。
class _UnsupportedZipInput {
  final int method;
  final int filenameLen;
  final int extraLen;
  final int payloadLen;

  const _UnsupportedZipInput({
    required this.method,
    required this.filenameLen,
    required this.extraLen,
    required this.payloadLen,
  });
}

/// 把 `[0, 65533]` 区间的索引映射到 `[1..7] ∪ [9..65535]`，确保跳过 `{0, 8}`。
int _toUnsupportedMethod(int index) {
  // 共 65534 个合法目标值（65536 - 2）。
  // 索引 0..6  → method 1..7
  // 索引 7..  → method 9..65535
  return index < 7 ? index + 1 : index + 2;
}

extension _UnsupportedNaiZipGenerators on Any {
  Generator<_UnsupportedZipInput> get unsupportedZipInput {
    return combine4<int, int, int, int, _UnsupportedZipInput>(
      intInRange(0, 65534), // 索引区间，对应 65534 个不支持的 method
      intInRange(0, 17), // filenameLen ∈ [0, 16]
      intInRange(0, 17), // extraLen ∈ [0, 16]
      intInRange(0, 33), // payloadLen ∈ [0, 32]
      (methodIndex, filenameLen, extraLen, payloadLen) {
        return _UnsupportedZipInput(
          method: _toUnsupportedMethod(methodIndex),
          filenameLen: filenameLen,
          extraLen: extraLen,
          payloadLen: payloadLen,
        );
      },
    );
  }
}

void _registerProperty2() {
  group('Property 2: NAI 不支持的压缩方式抛错', () {
    Glados<_UnsupportedZipInput>(any.unsupportedZipInput).test(
      'method ∉ {0, 8} 时抛 FormatException 且 message 含 unsupportedCompressionMethod（1.4）',
      (input) {
        // 用 (method, payloadLen) 派生确定性 seed，保证 glados shrink 可复现
        final rng = math.Random(input.method * 131 + input.payloadLen);
        final compressed = Uint8List.fromList(
          List<int>.generate(input.payloadLen, (_) => rng.nextInt(256)),
        );
        final zipBytes = _packZip(
          method: input.method,
          compressed: compressed,
          filenameLen: input.filenameLen,
          extraLen: input.extraLen,
        );

        expect(
          () => ImageGenService.parseNaiZipForTesting(zipBytes),
          throwsA(
            isA<FormatException>().having(
              (e) => e.message,
              'message',
              contains('unsupportedCompressionMethod'),
            ),
          ),
        );
      },
    );

    // 例测：边界压缩方式显式断言，与属性测试形成双层保护。
    test('method=1 时抛错且 message 含字段名与具体数值', () {
      final zipBytes = _packZip(
        method: 1,
        compressed: Uint8List(0),
        filenameLen: 0,
        extraLen: 0,
      );
      expect(
        () => ImageGenService.parseNaiZipForTesting(zipBytes),
        throwsA(
          isA<FormatException>().having(
            (e) => e.message,
            'message',
            allOf(
              contains('unsupportedCompressionMethod'),
              contains('1'),
            ),
          ),
        ),
      );
    });

    test('method=9 时抛错且 message 含字段名与具体数值', () {
      final zipBytes = _packZip(
        method: 9,
        compressed: Uint8List(0),
        filenameLen: 3,
        extraLen: 5,
      );
      expect(
        () => ImageGenService.parseNaiZipForTesting(zipBytes),
        throwsA(
          isA<FormatException>().having(
            (e) => e.message,
            'message',
            allOf(
              contains('unsupportedCompressionMethod'),
              contains('9'),
            ),
          ),
        ),
      );
    });

    test('method=65535（上界）时抛错且 message 含字段名', () {
      final zipBytes = _packZip(
        method: 65535,
        compressed: Uint8List(0),
        filenameLen: 0,
        extraLen: 0,
      );
      expect(
        () => ImageGenService.parseNaiZipForTesting(zipBytes),
        throwsA(
          isA<FormatException>().having(
            (e) => e.message,
            'message',
            contains('unsupportedCompressionMethod'),
          ),
        ),
      );
    });
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Feature: flutter-parity-completion, Property 4: PNG 签名校验
// **Validates: Requirements 1.6**
//
// 用 `package:glados` 生成任意字节序列，断言：
// - `ImageGenService.ensurePngSignatureForTesting` 抛错当且仅当
//   长度 < 4 或前 4 字节不等于 `[0x89, 0x50, 0x4E, 0x47]`；
// - 抛出的错误是 `FormatException` 且 message 含 `invalidPngSignature`。
//
// 与 Node.js 端 `src/app/api/image-gen/route.ts` 写入文件前的最终签名
// 兜底校验保持一致。默认 100 次迭代（glados ExploreConfig 默认值）。
// ──────────────────────────────────────────────────────────────────────────

/// PNG 签名常量：`0x89 0x50 0x4E 0x47`。
const List<int> _kPngSignature = <int>[0x89, 0x50, 0x4E, 0x47];

/// 判定一段字节是否以合法 PNG 签名开头。
///
/// 规则：长度 ≥ 4 且前 4 字节严格等于 `_kPngSignature`。
bool _hasValidPngSignature(Uint8List bytes) {
  if (bytes.length < 4) return false;
  for (var i = 0; i < 4; i++) {
    if (bytes[i] != _kPngSignature[i]) return false;
  }
  return true;
}

/// 自定义生成器：构造任意字节序列。
///
/// 规模控制在 `[0, 16]` 长度区间，避免测试过慢；
/// 同时通过两条互补的属性保证「合法 PNG 签名」分支也会被覆盖到。
extension _PngSignatureGenerators on Any {
  Generator<Uint8List> get arbitraryBytes {
    return any.list(any.intInRange(0, 256)).map(
          (List<int> xs) => Uint8List.fromList(
            xs.length > 16 ? xs.sublist(0, 16) : xs,
          ),
        );
  }

  /// 强制以 PNG 签名开头的字节序列：用于覆盖「不抛错」分支。
  Generator<Uint8List> get pngPrefixedBytes {
    return any.list(any.intInRange(0, 256)).map((List<int> tail) {
      final trimmed = tail.length > 12 ? tail.sublist(0, 12) : tail;
      return Uint8List.fromList(<int>[..._kPngSignature, ...trimmed]);
    });
  }
}

void _registerProperty4() {
  group('Property 4: PNG 签名校验', () {
    Glados<Uint8List>(any.arbitraryBytes).test(
      '抛错 ⇔ 长度 < 4 或前 4 字节不等于 PNG 签名（1.6）',
      (bytes) {
        final shouldThrow = !_hasValidPngSignature(bytes);

        if (shouldThrow) {
          // 既要抛 FormatException，也要 message 含 `invalidPngSignature`。
          expect(
            () => ImageGenService.ensurePngSignatureForTesting(bytes),
            throwsA(
              isA<FormatException>().having(
                (e) => e.message,
                'message',
                contains('invalidPngSignature'),
              ),
            ),
          );
        } else {
          // 合法 PNG 签名：不应抛任何异常。
          expect(
            () => ImageGenService.ensurePngSignatureForTesting(bytes),
            returnsNormally,
          );
        }
      },
    );

    Glados<Uint8List>(any.pngPrefixedBytes).test(
      '前 4 字节为 PNG 签名时不抛错（1.6 反向覆盖）',
      (bytes) {
        expect(
          () => ImageGenService.ensurePngSignatureForTesting(bytes),
          returnsNormally,
        );
      },
    );

    // 例测：边界场景显式断言，与属性测试形成双层保护。
    test('空字节序列抛错且 message 含字段名', () {
      expect(
        () => ImageGenService.ensurePngSignatureForTesting(Uint8List(0)),
        throwsA(
          isA<FormatException>().having(
            (e) => e.message,
            'message',
            contains('invalidPngSignature'),
          ),
        ),
      );
    });

    test('长度 3（< 4）即使前 3 字节匹配 PNG 签名也抛错', () {
      final bytes = Uint8List.fromList(<int>[0x89, 0x50, 0x4E]);
      expect(
        () => ImageGenService.ensurePngSignatureForTesting(bytes),
        throwsA(
          isA<FormatException>().having(
            (e) => e.message,
            'message',
            contains('invalidPngSignature'),
          ),
        ),
      );
    });

    test('恰好 4 字节合法 PNG 签名通过', () {
      final bytes = Uint8List.fromList(_kPngSignature);
      expect(
        () => ImageGenService.ensurePngSignatureForTesting(bytes),
        returnsNormally,
      );
    });

    test('第 1 字节差 1 即抛错', () {
      final bytes = Uint8List.fromList(<int>[0x88, 0x50, 0x4E, 0x47, 0x00]);
      expect(
        () => ImageGenService.ensurePngSignatureForTesting(bytes),
        throwsA(
          isA<FormatException>().having(
            (e) => e.message,
            'message',
            contains('invalidPngSignature'),
          ),
        ),
      );
    });
  });
}
