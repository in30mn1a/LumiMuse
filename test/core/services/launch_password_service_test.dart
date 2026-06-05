// Feature: flutter-parity-completion, Property 22: 启动密码哈希 round-trip
//
// **Validates: Requirements 13.2, 13.5, 13.6**
//
// 通过内存 Drift（`AppDatabase.forTesting`）+ `package:glados` 生成长度
// ≥ 4 的字符串 `p`，覆盖以下三条性质：
//   - setPassword(p) 后 verifyPassword(p) == true
//   - 对任意 q != p，verifyPassword(q) == false
//   - disable(p) 后 isEnabled() == false
//
// 注意：PBKDF2 600000 次迭代在测试中过于昂贵，这里通过
// `LaunchPasswordService.forTesting(db, iterations: 100)` 注入 100 次迭代，
// 默认线上是 600000 次（OWASP 2023+ 推荐）。两者算法路径一致，密码哈希
// round-trip 性质与迭代次数无关，因此调低迭代不会削弱属性覆盖度。
//
// 默认 100 次迭代（glados ExploreConfig 默认值）。

import 'package:drift/drift.dart' hide isNull, isNotNull;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, expectLater, group, test;
import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/core/services/launch_password_service.dart';

/// 创建内存数据库 — 与现有 PBT 测试保持一致的工厂用法。
AppDatabase _createTestDb() {
  driftRuntimeOptions.dontWarnAboutMultipleDatabases = true;
  return AppDatabase.forTesting(NativeDatabase.memory());
}

/// 测试用迭代次数 — 100 次足以覆盖算法路径，远低于线上 600000 次。
const int _kTestIterations = 100;

/// 字符样本：覆盖 ASCII / CJK / 数字 / 标点 / 空格，由整数种子拼装确定性密码。
///
/// 不包含换行符，避免 UI 输入框语义之外的边界。密码长度由调用方控制为 ≥ 4。
const _charPalette = <String>[
  'a', 'B', 'c', 'D', 'e', 'F',
  '0', '1', '2', '3',
  '!', '@', '#', '?', ' ',
  '猫', '光', '星', '夜', '茶',
];

/// 由 `(seed, lengthSeed)` 派生确定性密码字符串，长度 ∈ [4, 20]。
String _passwordFromSeed(int seed, int lengthSeed) {
  final length = 4 + (lengthSeed.abs() % 17); // [4, 20]
  final buf = StringBuffer();
  var s = seed.abs() | 1; // 避免全 0 退化
  for (var i = 0; i < length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    buf.write(_charPalette[s % _charPalette.length]);
  }
  return buf.toString();
}

/// 由 `(p, qSeed)` 派生一个保证 `q != p` 的密码字符串。
///
/// 简单策略：在 p 末尾追加一个由 qSeed 选出的字符，且若该字符等于 p 末位
/// 字符就再换一个，确保差异；同时保留 ≥ 4 长度（p 自身已 ≥ 4）。
String _differentPassword(String p, int qSeed) {
  final idx = qSeed.abs() % _charPalette.length;
  var ch = _charPalette[idx];
  if (p.isNotEmpty && p[p.length - 1] == ch) {
    ch = _charPalette[(idx + 1) % _charPalette.length];
  }
  return p + ch;
}

void main() {
  group('Property 22: 启动密码哈希 round-trip', () {
    Glados3<int, int, int>(
      any.intInRange(0, 1 << 20), // 密码内容种子
      any.intInRange(0, 1 << 10), // 密码长度种子（确保长度 ≥ 4）
      any.intInRange(0, 1 << 20), // 用于派生 q != p 的差异种子
      ExploreConfig(numRuns: 100),
    ).test(
      'setPassword(p) → verify(p)==true / verify(q)==false / disable(p) → isEnabled==false',
      (contentSeed, lengthSeed, qSeed) async {
        final db = _createTestDb();
        try {
          final service =
              LaunchPasswordService.forTesting(db, iterations: _kTestIterations);

          final p = _passwordFromSeed(contentSeed, lengthSeed);
          expect(p.length, greaterThanOrEqualTo(4),
              reason: '生成的密码必须满足 ≥ 4 长度的前置条件');

          // 1) setPassword(p) 后 isEnabled == true，verifyPassword(p) == true
          await service.setPassword(p);
          expect(await service.isEnabled(), isTrue,
              reason: 'setPassword 后启用状态应为 true');
          expect(await service.verifyPassword(p), isTrue,
              reason: '同一密码经 PBKDF2 派生后应通过校验');

          // 2) 任意 q != p：verifyPassword(q) == false
          final q = _differentPassword(p, qSeed);
          expect(q == p, isFalse, reason: '生成器必须保证 q != p');
          expect(await service.verifyPassword(q), isFalse,
              reason: '不同密码不应通过校验');

          // 3) disable(p) 后 isEnabled == false
          await service.disable(p);
          expect(await service.isEnabled(), isFalse,
              reason: 'disable 成功后启用状态应回到 false');
        } finally {
          await db.close();
        }
      },
    );

    // 例测：极简边界（最短长度 4 的纯 ASCII 密码）
    test('最短长度 4 的密码可正确 round-trip', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      final service =
          LaunchPasswordService.forTesting(db, iterations: _kTestIterations);
      const p = '12ab';
      await service.setPassword(p);
      expect(await service.isEnabled(), isTrue);
      expect(await service.verifyPassword(p), isTrue);
      expect(await service.verifyPassword('12ac'), isFalse);
      await service.disable(p);
      expect(await service.isEnabled(), isFalse);
    });

    test('CJK 密码同样可正确 round-trip', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      final service =
          LaunchPasswordService.forTesting(db, iterations: _kTestIterations);
      const p = '夜茶猫光';
      await service.setPassword(p);
      expect(await service.verifyPassword(p), isTrue);
      expect(await service.verifyPassword('夜茶猫光1'), isFalse);
      await service.disable(p);
      expect(await service.isEnabled(), isFalse);
    });

    test('未启用时 isEnabled 直接为 false', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      final service =
          LaunchPasswordService.forTesting(db, iterations: _kTestIterations);
      expect(await service.isEnabled(), isFalse);
      // 未启用时 verifyPassword 也安全返回 false（不抛异常）
      expect(await service.verifyPassword('anything'), isFalse);
    });

    test('setPassword rolls back salt when hash write fails', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await db.customStatement('''
        CREATE TRIGGER fail_launch_password_hash_insert
        BEFORE INSERT ON settings
        WHEN NEW.key = 'launch_password_hash'
        BEGIN
          SELECT RAISE(FAIL, 'hash write failed');
        END
      ''');
      final service =
          LaunchPasswordService.forTesting(db, iterations: _kTestIterations);

      await expectLater(
        service.setPassword('pass1234'),
        throwsA(isA<Exception>()),
      );

      final rows = await (db.select(db.settings)
            ..where((t) => t.key.equals('launch_password_salt')))
          .get();
      expect(rows, isEmpty, reason: '三键写入失败时 salt 不应残留');
      expect(await service.isEnabled(), isFalse);
    });

    test('disable 验证失败时抛 StateError 且密码仍生效', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      final service =
          LaunchPasswordService.forTesting(db, iterations: _kTestIterations);
      const p = 'pass1234';
      await service.setPassword(p);
      // 用错误密码尝试禁用 → 应抛 StateError 并保留启用状态
      Object? caught;
      try {
        await service.disable('wrong-password');
      } catch (e) {
        caught = e;
      }
      expect(caught, isA<StateError>(),
          reason: '错误密码调用 disable 应抛 StateError');
      expect(await service.isEnabled(), isTrue,
          reason: '禁用失败后启用状态应保持 true');
      expect(await service.verifyPassword(p), isTrue,
          reason: '禁用失败不应破坏已保存的密码');
    });
  });
}
