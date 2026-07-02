// Feature: flutter-memory-lifecycle, Property 27: 承诺信号词校准不变量
// Validates: spec Task 13 / 19.4
//
// 设计说明
// ────────
// MemoryEngine.calibrateRawMemoryItem 对齐主项目 src/lib/memory-engine.ts:383-418
// 的 hasCharacterPromiseSignal + calibrateRawMemoryItem。
//
// 不变量（spec 19.4，忠实于代码实际语义）：
//   - 含承诺信号词（我会记得/我会记住/我答应/我承诺/以后我会/以后会/不会忘）
//     **且 memory_kind ∈ {user_fact, user_preference}** 的记忆 →
//     calibrate 后 memory_kind='character_promise', category='关系动态',
//     importance≥0.8, emotional_weight≥0.7
//   - 不含承诺信号词且原 memory_kind 非 character_promise 的记忆 →
//     calibrate 后 memory_kind 不会变成 character_promise
//
// 说明：calibrateRawMemoryItem 的承诺升级前置条件是 memory_kind 为 user_fact /
// user_preference（对齐主项目 memory-engine.ts:383-385），spec 任务描述的简化表述
// "含承诺信号词 → character_promise" 在代码层面有该前置条件。本测试忠实于代码
// 语义，把前置条件纳入断言：仅当 memory_kind ∈ {user_fact, user_preference} 时
// 才验证承诺升级。
//
// 随机化输入：随机 content（含/不含承诺信号词）+ 随机 memory_kind（七类）+
// 随机 category（七类）+ 随机 importance/emotional_weight（[0,1] 两位小数）。
// calibrateRawMemoryItem 是纯函数，不碰 DB；为构造 MemoryEngine 传入内存库。

import 'dart:math' as math;

import 'package:drift/drift.dart' hide isNull, isNotNull;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test;

import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/core/services/llm_service.dart';
import 'package:lumimuse/core/services/memory_engine.dart';

AppDatabase _createTestDb() {
  driftRuntimeOptions.dontWarnAboutMultipleDatabases = true;
  return AppDatabase.forTesting(NativeDatabase.memory());
}

// 承诺信号词（对齐 calibrateRawMemoryItem 的 promisePattern）
const _promiseSignals = [
  '我会记得',
  '我会记住',
  '我答应',
  '我承诺',
  '以后我会',
  '以后会',
  '不会忘',
];

const _memoryKinds = [
  'general',
  'user_fact',
  'user_preference',
  'relationship_event',
  'character_promise',
  'open_thread',
  'world_state',
];

const _categories = [
  '关系动态',
  '话题历史',
  '基础信息',
  '偏好习惯',
  '人格特质',
  '重要事件',
  '四季日常',
];

const _neutralContents = [
  '用户喜欢猫',
  '用户喜欢吃辣',
  '用户在写作业',
  '今天天气不错',
  '用户单身',
];

// ──────────────────────────────────────────────────────────────────────────
// glados 生成器：随机 content（含/不含承诺信号词）+ 随机 memory_kind/category/
// importance/emotional_weight
//
// - 50% 概率含承诺信号词（从七词池中选一个，拼接到中性内容前）
// - 50% 概率不含（仅中性内容）
// - memory_kind 七类等概率；importance/emotional_weight [0,1] 两位小数
// - 用 seed 构造确定性 Random，保证 glados 失败重放可复现
// ──────────────────────────────────────────────────────────────────────────

class _CalibrateCase {
  final String content;
  final String memoryKind;
  final String category;
  final double importance;
  final double emotionalWeight;
  const _CalibrateCase({
    required this.content,
    required this.memoryKind,
    required this.category,
    required this.importance,
    required this.emotionalWeight,
  });

  bool get hasPromiseSignal =>
      _promiseSignals.any((s) => content.contains(s));

  /// 是否满足承诺升级前置条件（含信号词 + memory_kind 为 user_fact/user_preference）
  bool get shouldUpgradeToPromise =>
      hasPromiseSignal &&
      (memoryKind == 'user_fact' || memoryKind == 'user_preference');

  @override
  String toString() =>
      '_CalibrateCase(kind=$memoryKind, hasSignal=$hasPromiseSignal, imp=$importance)';
}

extension on Any {
  Generator<_CalibrateCase> get calibrateCases {
    return combine2<int, int, _CalibrateCase>(
      intInRange(0, 1 << 30), // 决定 content 与 memory_kind 分支
      intInRange(0, 1 << 30), // 决定 importance / emotional_weight / category
      (branchSeed, valueSeed) {
        final branchRng = math.Random(branchSeed);
        final valueRng = math.Random(valueSeed);
        // 50% 概率含承诺信号词
        final hasSignal = branchRng.nextBool();
        String content;
        if (hasSignal) {
          final signal =
              _promiseSignals[branchRng.nextInt(_promiseSignals.length)];
          final neutral =
              _neutralContents[branchRng.nextInt(_neutralContents.length)];
          content = '$signal$neutral';
        } else {
          content = _neutralContents[branchRng.nextInt(_neutralContents.length)];
        }
        final memoryKind = _memoryKinds[valueRng.nextInt(_memoryKinds.length)];
        final category = _categories[valueRng.nextInt(_categories.length)];
        // importance / emotional_weight [0.00, 1.00] 两位小数
        final importance = valueRng.nextInt(101) / 100.0;
        final emotionalWeight = valueRng.nextInt(101) / 100.0;
        return _CalibrateCase(
          content: content,
          memoryKind: memoryKind,
          category: category,
          importance: importance,
          emotionalWeight: emotionalWeight,
        );
      },
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 测试主体
// ──────────────────────────────────────────────────────────────────────────

void main() {
  group('Property 27: 承诺信号词校准不变量', () {
    Glados<_CalibrateCase>(
      any.calibrateCases,
      ExploreConfig(numRuns: 200),
    ).test(
      '含承诺信号词 + user_fact/user_preference → character_promise + importance≥0.8 + emotional_weight≥0.7；不含则不升级',
      (c) {
        final db = _createTestDb();
        addTearDown(db.close);
        final engine = MemoryEngine(db, LlmService());

        final raw = <String, dynamic>{
          'content': c.content,
          'memory_kind': c.memoryKind,
          'category': c.category,
          'importance': c.importance,
          'emotional_weight': c.emotionalWeight,
        };

        final result = engine.calibrateRawMemoryItem(raw);

        if (c.shouldUpgradeToPromise) {
          // 命中承诺升级：memory_kind → character_promise，category → 关系动态，
          // importance≥0.8，emotional_weight≥0.7
          expect(result['memory_kind'], 'character_promise',
              reason: '含承诺信号词「${c.content}」+ ${c.memoryKind} '
                  '应升级为 character_promise');
          expect(result['category'], '关系动态',
              reason: '承诺升级后 category 应为关系动态');
          expect(
            (result['importance'] as num).toDouble(),
            greaterThanOrEqualTo(0.8),
            reason: 'character_promise 的 importance 必须 ≥ 0.8',
          );
          expect(
            (result['emotional_weight'] as num).toDouble(),
            greaterThanOrEqualTo(0.7),
            reason: 'character_promise 的 emotional_weight 必须 ≥ 0.7',
          );
        } else if (!c.hasPromiseSignal) {
          // 不含承诺信号词且原 memory_kind 非 character_promise → 不应升级为 character_promise
          // （若原 memory_kind 已是 character_promise，则保持并走 character_promise 分支，
          //   此处不检查 —— 只验证「无承诺信号词时不会新升级为 character_promise」）
          if (c.memoryKind != 'character_promise') {
            expect(
              result['memory_kind'],
              isNot('character_promise'),
              reason: '不含承诺信号词且原 memory_kind=${c.memoryKind}，'
                  '不应升级为 character_promise',
            );
          }
        }

        // 无副作用：原 Map 不被修改
        expect(raw['memory_kind'], c.memoryKind,
            reason: 'calibrateRawMemoryItem 不应修改入参 raw');
        expect(raw['category'], c.category);
        expect(raw['importance'], c.importance);
        expect(raw['emotional_weight'], c.emotionalWeight);
      },
    );
  });
}
