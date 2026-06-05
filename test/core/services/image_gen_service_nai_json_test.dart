// Feature: flutter-parity-completion, Property 3: NAI JSON 兜底 round-trip
//
// **Validates: Requirements 1.5**
//
// 用 `glados` 生成任意字节序列 `payload`，base64 编码后包成
// `{"output":["<base64>"]}` 形式 UTF-8 字节传入 `decodeNaiJsonOutput`，
// 断言解码结果严格等于原 `payload`。
//
// 与 Node.js 端 `src/app/api/image-gen/route.ts` 的 JSON 兜底分支
// （`application/json` → `JSON.parse → output[0] → atob`）行为对齐。
//
// 注：本属性不需要把 payload 限制为合法 PNG，重点在于
// JSON → base64 → 字节 round-trip 性质本身。
//
// 默认 100 次迭代（glados 默认值）。

import 'dart:convert';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test;
import 'package:lumimuse/core/services/image_gen_service.dart';

/// 由 `(length, seed)` 派生确定性字节序列 `payload`。
///
/// - `length == 0` 时返回空字节序列（覆盖空 payload 边界）。
/// - 否则用 `seed` 构造 `math.Random`，逐字节填充 `[0, 255]` 区间。
/// - 用 Set/确定性方式保证 glados 失败重放可复现。
Uint8List _buildPayload(int length, int seed) {
  if (length <= 0) return Uint8List(0);
  final rng = math.Random(seed);
  final bytes = Uint8List(length);
  for (var i = 0; i < length; i++) {
    bytes[i] = rng.nextInt(256);
  }
  return bytes;
}

/// 把 `payload` 包成 `{"output":["<base64>"]}` 后的 UTF-8 字节序列，
/// 即 NovelAI JSON 兜底响应的二进制形式。
Uint8List _wrapAsNaiJson(Uint8List payload) {
  final body = <String, dynamic>{
    'output': <String>[base64Encode(payload)],
  };
  return Uint8List.fromList(utf8.encode(jsonEncode(body)));
}

void main() {
  group('Property 3: NAI JSON 兜底 round-trip', () {
    Glados2<int, int>(
      // payload 长度 [0, 256]：覆盖空、单字节、典型小尺寸到中等尺寸。
      // 上限刻意压小以保持单次 100 次迭代时长可控（design.md 默认要求）。
      any.intInRange(0, 257),
      // 用于派生 `math.Random` 的 seed，保证 glados shrink 时反例可复现。
      any.intInRange(0, 1 << 30),
    ).test(
      '任意字节序列经 JSON+base64 包装后 decodeNaiJsonOutput 还原相等',
      (length, seed) {
        final payload = _buildPayload(length, seed);
        final wrapped = _wrapAsNaiJson(payload);

        final decoded = ImageGenService.decodeNaiJsonOutput(wrapped);

        // 长度必须严格相等
        expect(decoded.length, payload.length,
            reason: 'round-trip 后字节长度必须等于原 payload');
        // 内容必须按位严格相等
        expect(decoded, orderedEquals(payload),
            reason: 'round-trip 后字节内容必须等于原 payload');
      },
    );

    // 例测 1：空 payload 边界 — 显式覆盖空字节序列场景。
    test('空 payload 经包装后解码仍为空字节序列（边界例测）', () {
      final wrapped = _wrapAsNaiJson(Uint8List(0));
      final decoded = ImageGenService.decodeNaiJsonOutput(wrapped);
      expect(decoded, isEmpty);
    });

    // 例测 2：典型 PNG 头字节（仅前 8 字节）— 与真实 NovelAI 响应形态一致。
    test('PNG 签名头字节 round-trip 完整保留 8 字节', () {
      final pngHeader = Uint8List.fromList(
        const <int>[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A],
      );
      final wrapped = _wrapAsNaiJson(pngHeader);
      final decoded = ImageGenService.decodeNaiJsonOutput(wrapped);
      expect(decoded, orderedEquals(pngHeader));
    });

    // 例测 3：JSON 顶层不是对象时抛 FormatException。
    // 与 Node.js 端「output 缺失即视为不可解析」对齐。
    test('JSON 顶层不是对象时抛 FormatException', () {
      final wrapped = Uint8List.fromList(utf8.encode('[1,2,3]'));
      expect(
        () => ImageGenService.decodeNaiJsonOutput(wrapped),
        throwsA(isA<FormatException>()),
      );
    });

    // 例测 4：缺少 output 字段时抛 FormatException。
    test('缺少 output 字段时抛 FormatException', () {
      final wrapped = Uint8List.fromList(utf8.encode('{"foo":"bar"}'));
      expect(
        () => ImageGenService.decodeNaiJsonOutput(wrapped),
        throwsA(isA<FormatException>()),
      );
    });

    // 例测 5：output 是空数组时抛 FormatException。
    test('output 为空数组时抛 FormatException', () {
      final wrapped = Uint8List.fromList(utf8.encode('{"output":[]}'));
      expect(
        () => ImageGenService.decodeNaiJsonOutput(wrapped),
        throwsA(isA<FormatException>()),
      );
    });
  });
}
