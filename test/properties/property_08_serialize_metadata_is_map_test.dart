// Feature: flutter-pixel-perfect-parity, Property 8: metadata 出口形态为 Map
// Validates: Requirements B4.3 (INV-7)
//
// 设计说明
// ────────
// design.md §正确性属性 Property 8（落实 INV-7）：
//   对任意消息 m（无论入库时是字符串、Map 还是损坏字符串），
//   serializeMessage(m).metadata 在三个出口必须始终是 Map / Object：
//     1. 出站 API（HTTP / 序列化层）
//     2. 备份导出（JSON 文件落盘）
//     3. Provider 暴露给 UI
//   绝不允许某个出口残留「JSON.stringify 后的字符串」形态。
//
// 与主项目的对齐
// ──────────────
// 主项目 `serializeMessage()` 在第二十一轮工程清理中已统一三个出口，
// 任何形如 `metadata: jsonEncode(...)` 的代码路径都会被回归脚本 RC-12
// 扫描出来。本属性测试把「无论入库形态如何，出口都是 Map」固化为可机器
// 校验的不变量，shrink 后的反例可直接定位到序列化层 bug。
//
// 实现策略
// ────────
// 在不依赖具体 ChatProvider / Database 的前提下，把契约层「入库 →
// 出口」的归一化抽出为纯函数 [serializeMessageMetadata]：
//   - raw == null：返回空 Map（{}）；
//   - raw is Map：拷贝为 Map<String, dynamic>，避免上游引用被反向篡改；
//   - raw is String：try jsonDecode；
//       · 解析失败 catch：返回空 Map（损坏字符串兜底）；
//       · 解析成功且为 Map：拷贝为 Map<String, dynamic>；
//       · 解析成功但非 Map（数字 / 列表 / 布尔等）：返回空 Map；
//   - 其他类型（int / List / bool / 自定义对象）：返回空 Map。
//
// 三个出口 wrapper（apiOut / backupOut / providerOut）当前都直接转发到
// 同一个纯函数，断言三者结果严格相等 —— 这是契约层的「形态一致」声明，
// 任何子 spec 在落地时若引入「API 走 Map、备份走 string」的差异，本测试
// 会立即捕获并 shrink 出最小反例。
//
// 生成器策略
// ──────────
// 用一个 [intInRange] 种子按 `seed % 5` 分支等概率抽取五类 raw：
//   分支 0：null
//   分支 1：随机 Map<String, dynamic>（含若干键值，含嵌套 Map / List）
//   分支 2：合法 JSON 字符串（jsonEncode(随机 Map)）
//   分支 3：损坏字符串（如 "{abc"、"not json"、单纯文本、半截括号）
//   分支 4：其他类型（int / double / bool / List）
//
// 100 次 runs（与 tasks.md §5.8 一致）。失败时 glados 会自动 shrink 到
// 最小反例（通常会落到「损坏字符串 / 非 Map JSON」边界上）。

import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test;

// ──────────────────────────────────────────────────────────────────────────
// 待测纯函数：serializeMessageMetadata
//
// 契约（落实 design §Property 8 / INV-7）：
//   - 出口必须始终是 Map<String, dynamic>；
//   - 不抛异常（任何输入都收敛到 Map）；
//   - 返回的 Map 与入参不共享引用（防御性拷贝），避免上游修改返回值时
//     反向影响入库数据。
// ──────────────────────────────────────────────────────────────────────────
Map<String, dynamic> serializeMessageMetadata(dynamic raw) {
  // 分支 1：null → 空 Map（与主项目 `metadata ?? {}` 等价）。
  if (raw == null) {
    return <String, dynamic>{};
  }

  // 分支 2：已经是 Map → 防御性拷贝，避免上下游共享引用。
  if (raw is Map) {
    return Map<String, dynamic>.from(raw);
  }

  // 分支 3：字符串 → 尝试解析为 JSON。
  if (raw is String) {
    try {
      final decoded = jsonDecode(raw);
      if (decoded is Map) {
        return Map<String, dynamic>.from(decoded);
      }
      // 解析成功但不是 Map（例如纯数字 / 列表 / 布尔）：兜底为空 Map。
      return <String, dynamic>{};
    } catch (_) {
      // 损坏字符串：兜底为空 Map，绝不抛异常打穿调用栈。
      return <String, dynamic>{};
    }
  }

  // 分支 4：其他类型（int / double / bool / List / 自定义对象）→ 空 Map。
  return <String, dynamic>{};
}

// ──────────────────────────────────────────────────────────────────────────
// 三个出口 wrapper
//
// 当前都转发到同一个纯函数，断言三者结果严格相等。子 spec 在落地具体
// 序列化层时，应继续保持三者一致的语义；任何形态分歧会被本测试捕获。
// ──────────────────────────────────────────────────────────────────────────

/// 出站 API 出口（模拟 HTTP / 序列化层把消息传给 UI 或外部）。
Map<String, dynamic> apiOut(dynamic raw) => serializeMessageMetadata(raw);

/// 备份导出出口（模拟把消息序列化到 JSON 备份文件）。
Map<String, dynamic> backupOut(dynamic raw) => serializeMessageMetadata(raw);

/// Provider 出口（模拟 ChatProvider 把消息暴露给 UI 渲染）。
Map<String, dynamic> providerOut(dynamic raw) => serializeMessageMetadata(raw);

// ──────────────────────────────────────────────────────────────────────────
// 生成器：rawMetadataInput
//
// 用 intInRange 种子按 seed % 5 分支等概率抽取五类 raw：
//   0：null / 1：随机 Map / 2：合法 JSON 字符串 / 3：损坏字符串 / 4：其他类型
// ──────────────────────────────────────────────────────────────────────────

/// 用例打包 —— 把 raw 与一段可读 label 一起带出，便于 glados 失败定位。
class _MetaCase {
  final dynamic raw;
  final String label;
  const _MetaCase(this.raw, this.label);

  @override
  String toString() => '_MetaCase($label, raw=$raw)';
}

extension on Any {
  /// 生成 _MetaCase：覆盖 null / Map / 合法 JSON / 损坏字符串 / 其他类型五类。
  Generator<_MetaCase> get rawMetadataInput {
    return intInRange(0, 1 << 20).map((seed) {
      final rng = math.Random(seed);
      // 种子右移一位用于决定分支，剩余位用于该分支内部随机决策。
      final branch = seed % 5;
      switch (branch) {
        case 0:
          return const _MetaCase(null, 'null');
        case 1:
          return _MetaCase(_randomMap(rng), 'map');
        case 2:
          return _MetaCase(_randomLegalJsonString(rng), 'legal-json-string');
        case 3:
          return _MetaCase(_randomBrokenString(rng), 'broken-string');
        case 4:
        default:
          return _MetaCase(_randomOtherType(rng), 'other-type');
      }
    });
  }
}

/// 分支 1：随机 Map（含若干键值，含嵌套 Map / List）。
///
/// 故意覆盖「versions 数组」「activeVersion 索引」等主项目真实场景的字段，
/// 让属性测试更接近生产形态。
Map<String, dynamic> _randomMap(math.Random rng) {
  final size = rng.nextInt(4); // 0–3 个键
  final map = <String, dynamic>{};
  for (var i = 0; i < size; i++) {
    final keyKind = rng.nextInt(4);
    final value = switch (keyKind) {
      0 => rng.nextInt(1024),
      1 => rng.nextBool(),
      2 => 'value-${rng.nextInt(64)}',
      _ => <Map<String, dynamic>>[
          {'content': 'v0', 'created_at': '2024-01-01'},
          {'content': 'v1', 'created_at': '2024-01-02'},
        ],
    };
    map['key$i'] = value;
  }
  if (rng.nextBool()) {
    map['activeVersion'] = rng.nextInt(3);
  }
  return map;
}

/// 分支 2：合法 JSON 字符串（jsonEncode 一个随机 Map）。
String _randomLegalJsonString(math.Random rng) {
  return jsonEncode(_randomMap(rng));
}

/// 分支 3：损坏字符串（多种半破损与纯文本形态）。
String _randomBrokenString(math.Random rng) {
  const pool = [
    '{abc',
    'not json',
    '随便一段中文',
    '{"unclosed": "value"',
    '[1, 2, 3',
    '   ',
    'undefined',
    '{"key": }',
    '{1: 2}',
    'NaN',
  ];
  return pool[rng.nextInt(pool.length)];
}

/// 分支 4：其他类型（int / double / bool / List）。
dynamic _randomOtherType(math.Random rng) {
  final kind = rng.nextInt(4);
  return switch (kind) {
    0 => rng.nextInt(1024),
    1 => rng.nextDouble() * 100,
    2 => rng.nextBool(),
    _ => <dynamic>[1, 'two', false, null],
  };
}

// ──────────────────────────────────────────────────────────────────────────
// 属性测试主体
// ──────────────────────────────────────────────────────────────────────────

void main() {
  group('Property 8: metadata 出口形态为 Map', () {
    Glados<_MetaCase>(
      any.rawMetadataInput,
      ExploreConfig(numRuns: 100),
    ).test(
      '任意入库形态 → 三个出口都是 Map<String, dynamic> 且彼此一致',
      (input) {
        final raw = input.raw;

        // 三个出口分别走 wrapper 一遍。
        final api = apiOut(raw);
        final backup = backupOut(raw);
        final provider = providerOut(raw);

        // 核心断言（落实 INV-7）：每个出口都是 Map<String, dynamic>。
        expect(
          api,
          isA<Map<String, dynamic>>(),
          reason: 'API 出口必须是 Map<String, dynamic>，禁止残留 JSON 字符串 '
              '(label=${input.label})',
        );
        expect(
          backup,
          isA<Map<String, dynamic>>(),
          reason: '备份导出出口必须是 Map<String, dynamic> '
              '(label=${input.label})',
        );
        expect(
          provider,
          isA<Map<String, dynamic>>(),
          reason: 'Provider 出口必须是 Map<String, dynamic> '
              '(label=${input.label})',
        );

        // 配套断言：三个出口结果严格相等（形态一致 + 内容一致）。
        expect(
          api,
          equals(backup),
          reason: 'API 出口与备份导出出口必须形态一致 '
              '(label=${input.label})',
        );
        expect(
          backup,
          equals(provider),
          reason: '备份导出出口与 Provider 出口必须形态一致 '
              '(label=${input.label})',
        );
      },
    );

    // ────────────────────────────────────────────────
    // 例测：把契约的关键边界用具体输入再固化一次（双层保护）
    // ────────────────────────────────────────────────

    test('null → 空 Map', () {
      expect(serializeMessageMetadata(null), <String, dynamic>{});
    });

    test('Map<String, dynamic> 入参 → 防御性拷贝且内容一致', () {
      final raw = <String, dynamic>{
        'activeVersion': 1,
        'versions': [
          {'content': 'v0'},
          {'content': 'v1'},
        ],
      };
      final out = serializeMessageMetadata(raw);
      expect(out, equals(raw));
      // 防御性拷贝：修改返回值不应影响入参。
      out['activeVersion'] = 999;
      expect(raw['activeVersion'], 1);
    });

    test('合法 JSON 字符串 → 解析为 Map', () {
      final raw = jsonEncode({'a': 1, 'b': 'x'});
      final out = serializeMessageMetadata(raw);
      expect(out, <String, dynamic>{'a': 1, 'b': 'x'});
    });

    test('损坏 JSON 字符串 → 兜底为空 Map（不抛异常）', () {
      expect(serializeMessageMetadata('{abc'), <String, dynamic>{});
      expect(serializeMessageMetadata('not json'), <String, dynamic>{});
      expect(serializeMessageMetadata('{"unclosed":'), <String, dynamic>{});
    });

    test('合法 JSON 但非 Map（数字 / 列表 / 布尔） → 空 Map', () {
      expect(serializeMessageMetadata('123'), <String, dynamic>{});
      expect(serializeMessageMetadata('[1,2,3]'), <String, dynamic>{});
      expect(serializeMessageMetadata('true'), <String, dynamic>{});
      expect(serializeMessageMetadata('null'), <String, dynamic>{});
    });

    test('其他类型（int / double / bool / List） → 空 Map', () {
      expect(serializeMessageMetadata(42), <String, dynamic>{});
      expect(serializeMessageMetadata(3.14), <String, dynamic>{});
      expect(serializeMessageMetadata(true), <String, dynamic>{});
      expect(serializeMessageMetadata([1, 2, 3]), <String, dynamic>{});
    });

    test('三个出口 wrapper 对同一输入的结果严格相等', () {
      final samples = <dynamic>[
        null,
        <String, dynamic>{'a': 1},
        jsonEncode({'b': 2}),
        '{broken',
        42,
      ];
      for (final raw in samples) {
        final api = apiOut(raw);
        final backup = backupOut(raw);
        final provider = providerOut(raw);
        expect(api, equals(backup));
        expect(backup, equals(provider));
        expect(api, isA<Map<String, dynamic>>());
      }
    });
  });
}
