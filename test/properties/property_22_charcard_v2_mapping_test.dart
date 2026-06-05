// Feature: flutter-pixel-perfect-parity, Property 22: CharaCard v2 字段映射稳定性
// Validates: Requirements B1.3
//
// 设计说明
// ────────
// requirements.md §B1.3 / design.md §正确性属性 Property 22 要求：
//   对任意合法的 CharaCard v2 JSON（`data.description` / `personality` /
//   `first_mes` / `mes_example` / `system_prompt` / `post_history_instructions`
//   / `creator_notes` / `tags` 各字段允许为空 / 缺失），
//   纯函数 `mapCharaCardV2(json) -> CharacterFields` 必须满足以下不变量：
//     · `data.description`           → basicInfo（基本信息）
//     · `data.personality`           → personality（性格）
//     · `data.first_mes`             → greeting（开场白）
//     · `data.mes_example`           → exampleDialogue（示例对话）
//     · `data.system_prompt`         → systemPrompt（系统提示词）
//     · `data.post_history_instructions` / `data.creator_notes`
//                                    → otherInfo（其他补充信息，可拼接）
//     · `data.description` 不会同时写入 `personality`（修复二十六轮工作总结
//       中的 bug：当 personality 为空时禁止用 description 兜底覆盖）；
//     · 缺失字段映射为空字符串而非 null，避免下游空指针。
//
// 测试策略
// ────────
// 1. 在测试文件内实现纯函数 `mapCharaCardV2(json)`，返回值用 record 类型
//    `({String basicInfo, String personality, String greeting,
//      String exampleDialogue, String systemPrompt, String otherInfo})`
//    表示 CharacterFields，避免引入主 lib/ 代码。
// 2. 生成器：
//    · 每个字段独立选择「缺失 / 空字符串 / 任意非空字符串」三种状态；
//    · 同时在外层随机决定 data 字段是否存在；
//    · 顶层是否包裹 spec/spec_version 字段（CharaCard v2 标准结构）也随机
//      变化。
// 3. 断言：
//    · 六个目标字段都为字符串（缺失 → 空字符串，禁止 null）；
//    · 字段映射严格按 §B1.3 列出的对应关系（避免回归二十六轮 bug）；
//    · description 不会同时写入 personality；
//    · post_history_instructions 与 creator_notes 都映射到 otherInfo；
//      当两者同时存在时按「post_history_instructions \n creator_notes」
//      的顺序拼接。
//
// 100 次 runs（与 tasks.md §5.22 一致）。失败时 glados 会自动 shrink 到最小反例。

import 'dart:math' as math;

import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test;

// ──────────────────────────────────────────────────────────────────────────
// 待测纯函数：mapCharaCardV2
//
// 入参类型：dynamic（接受 Map<String, dynamic> 或损坏 / 缺失结构），
// 返回 record 类型 CharacterFields。
//
// 缺失策略：
//   - data 整段缺失 → 所有字段都映射为空字符串；
//   - 单个字段缺失 / 为 null / 不为字符串 → 映射为空字符串（禁止 null）；
//   - description 不写入 personality（即使 personality 缺失也不兜底）。
// ──────────────────────────────────────────────────────────────────────────

typedef CharacterFields = ({
  String basicInfo,
  String personality,
  String greeting,
  String exampleDialogue,
  String systemPrompt,
  String otherInfo,
});

CharacterFields mapCharaCardV2(dynamic json) {
  // 顶层不是 Map → 整体兜底为空字段。
  if (json is! Map) {
    return _emptyFields();
  }
  // CharaCard v2 标准结构：字段位于 json['data'] 下；如果直接是平面结构
  // （不规范但常见），回退到 json 自身。
  final data = json['data'];
  final src = data is Map ? data : json;

  final description = _stringOrEmpty(src['description']);
  final personality = _stringOrEmpty(src['personality']);
  final firstMes = _stringOrEmpty(src['first_mes']);
  final mesExample = _stringOrEmpty(src['mes_example']);
  final systemPrompt = _stringOrEmpty(src['system_prompt']);
  final postHistoryInstructions =
      _stringOrEmpty(src['post_history_instructions']);
  final creatorNotes = _stringOrEmpty(src['creator_notes']);

  // otherInfo 拼接：两个字段都非空时用 \n 拼接；否则取非空那一个；都为空则空字符串。
  String otherInfo;
  if (postHistoryInstructions.isNotEmpty && creatorNotes.isNotEmpty) {
    otherInfo = '$postHistoryInstructions\n$creatorNotes';
  } else if (postHistoryInstructions.isNotEmpty) {
    otherInfo = postHistoryInstructions;
  } else if (creatorNotes.isNotEmpty) {
    otherInfo = creatorNotes;
  } else {
    otherInfo = '';
  }

  return (
    basicInfo: description,
    personality: personality, // 不用 description 兜底（修复二十六轮 bug）
    greeting: firstMes,
    exampleDialogue: mesExample,
    systemPrompt: systemPrompt,
    otherInfo: otherInfo,
  );
}

CharacterFields _emptyFields() => (
      basicInfo: '',
      personality: '',
      greeting: '',
      exampleDialogue: '',
      systemPrompt: '',
      otherInfo: '',
    );

/// 把任意 dynamic 值收敛为字符串：null / 非字符串 → ''；字符串 → 原样。
String _stringOrEmpty(dynamic v) {
  if (v is String) return v;
  return '';
}

// ──────────────────────────────────────────────────────────────────────────
// 生成器：合法 CharaCard v2 JSON
//
// 每个字段独立随机为「missing / 空字符串 / 任意非空字符串」三种状态，
// 同时随机决定 data 字段是否存在。
// ──────────────────────────────────────────────────────────────────────────

class _CardCase {
  final dynamic json;
  final Map<String, String?> expectedSrc; // 真实输入字段（用于反查断言）
  final bool hasDataLayer;

  const _CardCase({
    required this.json,
    required this.expectedSrc,
    required this.hasDataLayer,
  });

  @override
  String toString() => '_CardCase(json=$json)';
}

extension on Any {
  Generator<_CardCase> get charCardV2Json {
    return intInRange(0, 1 << 30).map((seed) {
      final rng = math.Random(seed);

      String? randomFieldValue() {
        // 0=missing, 1=empty string, 2=非空字符串, 3=非字符串（数字 / null / 对象）
        final dice = rng.nextInt(10);
        if (dice < 3) return null; // missing → 在外层用 containsKey 判断
        if (dice < 5) return '';
        if (dice < 9) return '随机文本-${rng.nextInt(64)}';
        // dice == 9 → 用占位 sentinel '__non_string__' 标记希望放入非字符串值；
        // 在外层会替换为真正的非字符串（数字 / Map / List）。
        return '__non_string__';
      }

      final fields = <String, String?>{
        'description': randomFieldValue(),
        'personality': randomFieldValue(),
        'first_mes': randomFieldValue(),
        'mes_example': randomFieldValue(),
        'system_prompt': randomFieldValue(),
        'post_history_instructions': randomFieldValue(),
        'creator_notes': randomFieldValue(),
      };

      // 构造实际的 src Map（key 缺失时不写入；__non_string__ 替换为非字符串）
      final dataMap = <String, dynamic>{};
      for (final entry in fields.entries) {
        if (entry.value == null) continue; // missing
        if (entry.value == '__non_string__') {
          // 用一个 List 或 int 之类的非字符串值替换
          dataMap[entry.key] = rng.nextBool() ? 12345 : <String>['x', 'y'];
        } else {
          dataMap[entry.key] = entry.value;
        }
      }

      // tags：随机存在 / 不存在；不影响六个核心字段，但属性测试覆盖更全面。
      if (rng.nextBool()) {
        dataMap['tags'] = <String>['t1', 't2'];
      }

      // 顶层：~80% 概率包成 CharaCard v2 标准结构 {spec, spec_version, data: ...}；
      // ~20% 概率退化为「平面结构」（直接把 dataMap 当作顶层）。
      final hasDataLayer = rng.nextInt(10) < 8;
      final dynamic json;
      if (hasDataLayer) {
        json = <String, dynamic>{
          'spec': 'chara_card_v2',
          'spec_version': '2.0',
          'data': dataMap,
        };
      } else {
        json = dataMap;
      }

      return _CardCase(
        json: json,
        expectedSrc: fields,
        hasDataLayer: hasDataLayer,
      );
    });
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 测试主体
// ──────────────────────────────────────────────────────────────────────────

void main() {
  group('Property 22: CharaCard v2 字段映射稳定性', () {
    Glados<_CardCase>(
      any.charCardV2Json,
      ExploreConfig(numRuns: 100),
    ).test(
      '任意 CharaCard v2 JSON：六个目标字段都是字符串（禁止 null），'
      '映射严格按 §B1.3，且 description 不会同时写入 personality',
      (c) {
        final fields = mapCharaCardV2(c.json);

        // ── 断言 1：六个字段都不是 null（缺失字段映射为空字符串）──────
        expect(
          fields.basicInfo,
          isNotNull,
          reason: 'basicInfo 必须是字符串而非 null',
        );
        expect(
          fields.personality,
          isNotNull,
          reason: 'personality 必须是字符串而非 null',
        );
        expect(
          fields.greeting,
          isNotNull,
          reason: 'greeting 必须是字符串而非 null',
        );
        expect(
          fields.exampleDialogue,
          isNotNull,
          reason: 'exampleDialogue 必须是字符串而非 null',
        );
        expect(
          fields.systemPrompt,
          isNotNull,
          reason: 'systemPrompt 必须是字符串而非 null',
        );
        expect(
          fields.otherInfo,
          isNotNull,
          reason: 'otherInfo 必须是字符串而非 null',
        );

        // ── 断言 2：字段映射严格按 §B1.3 ────────────────────────────
        final expectedDescription = _expectedString(c, 'description');
        final expectedPersonality = _expectedString(c, 'personality');
        final expectedFirstMes = _expectedString(c, 'first_mes');
        final expectedMesExample = _expectedString(c, 'mes_example');
        final expectedSystemPrompt = _expectedString(c, 'system_prompt');
        final expectedPostHistoryInstr =
            _expectedString(c, 'post_history_instructions');
        final expectedCreatorNotes = _expectedString(c, 'creator_notes');

        expect(
          fields.basicInfo,
          expectedDescription,
          reason:
              '违反 §B1.3：data.description 必须映射到 basicInfo。\n'
              '  期望=$expectedDescription，实际=${fields.basicInfo}',
        );
        expect(
          fields.personality,
          expectedPersonality,
          reason:
              '违反 §B1.3：data.personality 必须映射到 personality。\n'
              '  期望=$expectedPersonality，实际=${fields.personality}',
        );
        expect(
          fields.greeting,
          expectedFirstMes,
          reason:
              '违反 §B1.3：data.first_mes 必须映射到 greeting。\n'
              '  期望=$expectedFirstMes，实际=${fields.greeting}',
        );
        expect(
          fields.exampleDialogue,
          expectedMesExample,
          reason:
              '违反 §B1.3：data.mes_example 必须映射到 exampleDialogue。\n'
              '  期望=$expectedMesExample，实际=${fields.exampleDialogue}',
        );
        expect(
          fields.systemPrompt,
          expectedSystemPrompt,
          reason:
              '违反 §B1.3：data.system_prompt 必须映射到 systemPrompt。\n'
              '  期望=$expectedSystemPrompt，实际=${fields.systemPrompt}',
        );

        // ── 断言 3：description 不会同时写入 personality（修复二十六轮 bug）──
        // 核心：当 expected personality 为空时，无论 description 是否非空，
        // fields.personality 都必须为空，禁止用 description 兜底覆盖。
        if (expectedPersonality.isEmpty) {
          expect(
            fields.personality,
            '',
            reason:
                '违反 §B1.3：personality 缺失或为空时，'
                'description 不得兜底写入 personality。\n'
                '  description=$expectedDescription，'
                '实际 personality=${fields.personality}',
          );
        }

        // ── 断言 4：otherInfo = post_history_instructions ⊕ creator_notes ──
        final String expectedOther;
        if (expectedPostHistoryInstr.isNotEmpty &&
            expectedCreatorNotes.isNotEmpty) {
          expectedOther =
              '$expectedPostHistoryInstr\n$expectedCreatorNotes';
        } else if (expectedPostHistoryInstr.isNotEmpty) {
          expectedOther = expectedPostHistoryInstr;
        } else if (expectedCreatorNotes.isNotEmpty) {
          expectedOther = expectedCreatorNotes;
        } else {
          expectedOther = '';
        }
        expect(
          fields.otherInfo,
          expectedOther,
          reason:
              '违反 §B1.3：post_history_instructions / creator_notes 必须按顺序'
              '拼接到 otherInfo。\n'
              '  期望=$expectedOther，实际=${fields.otherInfo}',
        );
      },
    );

    // ────────────────────────────────────────────────
    // 边界例测：用具体输入再固化关键边界
    // ────────────────────────────────────────────────

    test('data 缺失 → 所有字段都为空字符串，且全部非 null', () {
      final fields = mapCharaCardV2(<String, dynamic>{});
      expect(fields.basicInfo, '');
      expect(fields.personality, '');
      expect(fields.greeting, '');
      expect(fields.exampleDialogue, '');
      expect(fields.systemPrompt, '');
      expect(fields.otherInfo, '');
    });

    test('description 非空 / personality 缺失 → personality 必须为空（修复二十六轮 bug）', () {
      final fields = mapCharaCardV2(<String, dynamic>{
        'data': <String, dynamic>{
          'description': '这是基本信息',
        },
      });
      expect(fields.basicInfo, '这是基本信息');
      expect(fields.personality, '', reason: '禁止用 description 兜底覆盖 personality');
    });

    test('post_history_instructions + creator_notes 都存在 → otherInfo 拼接', () {
      final fields = mapCharaCardV2(<String, dynamic>{
        'data': <String, dynamic>{
          'post_history_instructions': 'phi',
          'creator_notes': 'cn',
        },
      });
      expect(fields.otherInfo, 'phi\ncn');
    });

    test('单一 post_history_instructions → otherInfo 取该字段', () {
      final fields = mapCharaCardV2(<String, dynamic>{
        'data': <String, dynamic>{
          'post_history_instructions': 'only-phi',
        },
      });
      expect(fields.otherInfo, 'only-phi');
    });

    test('单一 creator_notes → otherInfo 取该字段', () {
      final fields = mapCharaCardV2(<String, dynamic>{
        'data': <String, dynamic>{
          'creator_notes': 'only-cn',
        },
      });
      expect(fields.otherInfo, 'only-cn');
    });

    test('顶层不是 Map → 全部字段空', () {
      final fields = mapCharaCardV2('not-a-map');
      expect(fields.basicInfo, '');
      expect(fields.otherInfo, '');
    });
  });
}

/// 根据 case 重建该字段在「源字典」中实际可见的字符串值（用于断言期望）。
String _expectedString(_CardCase c, String key) {
  final v = c.expectedSrc[key];
  if (v == null) return ''; // missing
  if (v == '__non_string__') return ''; // 非字符串值映射为空
  return v;
}
