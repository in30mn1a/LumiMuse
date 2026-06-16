// Feature: flutter-parity-gaps-fill, Property 3: localeProvider 状态同步
// Validates: Requirements R2.1, R2.3, R2.4
//
// 设计说明
// ────────
// design.md §Correctness Properties §Property 3 / requirements.md §R2 要求：
//   对任意「初始 DB 字段 language0 ∈ {'zh','en','xx',null,''}」+
//   「后续 N 次 updateSettings(language=L_i) 调用（L_i ∈ {'zh','en'}）」
//   构成的合法操作序列，在序列每一步执行后均成立：
//
//   localeProvider.state.languageCode
//     == _languageToLocale(currentSettings.language).languageCode
//
//   且非法 language0（'xx' / null / ''）的回退结果恒为 Locale('zh')。
//
// 与 design.md §Components and Interfaces §组件 3 的一致性：
//   - SettingsNotifier.build 读完 DB 后立即写 localeProvider；
//   - SettingsNotifier.updateSettings 在写库之后立即写 localeProvider；
//   - _languageToLocale 是私有纯函数（仅 'en' → Locale('en')，其它一律
//     回退 Locale('zh')），本测试按相同契约就地复刻 [_expectedLocale]，
//     避免暴露 lib 私有 API。
//
// 测试基础设施
// ────────────
//   - 内存 Drift（`AppDatabase.forTesting(NativeDatabase.memory())`）
//     注入 `databaseProvider`；每次属性运行结束后关闭数据库。
//   - 用 `ProviderContainer(overrides: [...])` 隔离 Riverpod 状态，
//     不污染其它测试。
//   - 测试通过 SettingsNotifier 公开 API（updateSettings）走生产路径，
//     不绕过写库 + 写 Provider 的同栈契约（落实 R2.6）。
//   - 序列长度 1 ~ 10、初始 language0 五种合法 / 非法形态，glados 默认
//     `runs ≥ 100` 并自动 shrink。

import 'dart:convert';
import 'dart:math' as math;

import 'package:drift/drift.dart' hide isNull, isNotNull;
import 'package:drift/native.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test;
import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/core/models/app_settings.dart';
import 'package:lumimuse/core/providers/database_provider.dart';
import 'package:lumimuse/core/providers/settings_provider.dart';
import 'package:lumimuse/core/services/secret_storage_service.dart';

// ──────────────────────────────────────────────────────────────────────────
// 用例数据结构与生成器
// ──────────────────────────────────────────────────────────────────────────

/// 初始 DB 中 language 字段的五种形态。
///
/// - `zh` / `en`：合法值，`_languageToLocale` 应直接产出对应 Locale。
/// - `xx` / 空串 ``：非法字符串（不在 {'zh','en'} 内），回退 `Locale('zh')`。
/// - `nullValue`：DB 中根本不存在 language 行，模拟首次启动；
///   `_loadFromDb` 取 map 时拿到 null，`_mapToSettings` 用 `?? 'zh'` 兜底
///   为 'zh'，因此 `currentSettings.language == 'zh'`。
enum _InitLanguage { zh, en, xx, nullValue, empty }

/// 把 `_InitLanguage` 还原为 DB 中实际写入的字符串值；
/// `nullValue` 返回 `null` 表示「不要插入这一行」。
String? _initLangToValue(_InitLanguage k) {
  switch (k) {
    case _InitLanguage.zh:
      return 'zh';
    case _InitLanguage.en:
      return 'en';
    case _InitLanguage.xx:
      return 'xx';
    case _InitLanguage.empty:
      return '';
    case _InitLanguage.nullValue:
      return null;
  }
}

/// 单条 update 选择的语言（生产路径只允许 `'zh' | 'en'`）。
const List<String> _kUpdateLanguages = <String>['zh', 'en'];

/// 一次属性运行的完整输入：初始 DB 语言 + 后续 update 序列。
class _LocaleSyncCase {
  final _InitLanguage initLanguage;
  final List<String> updates; // 每一项 ∈ {'zh','en'}，长度 1 ~ 10

  const _LocaleSyncCase({required this.initLanguage, required this.updates});

  @override
  String toString() =>
      '_LocaleSyncCase(initLanguage=$initLanguage, updates=$updates)';
}

extension on Any {
  /// 生成 _LocaleSyncCase：
  ///
  /// - `initIdx ∈ [0, 4]`：等概率选取五种 _InitLanguage；
  /// - `seqLen ∈ [1, 10]`：序列长度（含两端）；
  /// - `seed`：构造确定性 Random，决定每一步 update 选 'zh' 还是 'en'，
  ///   保证 glados shrink 失败重放可复现。
  Generator<_LocaleSyncCase> get localeSyncCase {
    return combine3<int, int, int, _LocaleSyncCase>(
      intInRange(0, 5), // initIdx ∈ [0, 4]
      intInRange(1, 11), // seqLen ∈ [1, 10]
      intInRange(0, 1 << 30),
      (initIdx, seqLen, seed) {
        final init = _InitLanguage.values[initIdx];
        final rng = math.Random(seed);
        final updates = List<String>.generate(seqLen, (_) {
          return _kUpdateLanguages[rng.nextInt(_kUpdateLanguages.length)];
        });
        return _LocaleSyncCase(initLanguage: init, updates: updates);
      },
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 与 settings_provider.dart `_languageToLocale` 同契约的测试侧实现
//
// 因为 `_languageToLocale` 是 lib 私有函数，本测试不暴露它而是按 design.md
// 给出的契约就地复刻：'en' → Locale('en')，其它一律回退 Locale('zh')。
// 一旦生产代码契约被改动，这里也必须同步更新。
// ──────────────────────────────────────────────────────────────────────────
Locale _expectedLocale(String? language) {
  if (language == 'en') return const Locale('en');
  return const Locale('zh');
}

// ──────────────────────────────────────────────────────────────────────────
// 内存数据库工厂与种子工具
// ──────────────────────────────────────────────────────────────────────────

AppDatabase _createTestDb() {
  driftRuntimeOptions.dontWarnAboutMultipleDatabases = true;
  return AppDatabase.forTesting(NativeDatabase.memory());
}

class _MemorySecretStorageBackend implements SecretStorageBackend {
  final Map<String, String> values = {};

  @override
  Future<void> delete({required String key}) async {
    values.remove(key);
  }

  @override
  Future<String?> read({required String key}) async {
    return values[key];
  }

  @override
  Future<void> write({required String key, required String value}) async {
    values[key] = value;
  }
}

ProviderContainer _createContainer(AppDatabase db) {
  return ProviderContainer(
    overrides: [
      databaseProvider.overrideWithValue(db),
      secretStorageServiceProvider.overrideWithValue(
        SecretStorageService(backend: _MemorySecretStorageBackend()),
      ),
    ],
  );
}

/// 在 settings 表中写入初始 language 字段；`null` 表示完全不插入这一行，
/// 模拟「首次启动 / DB 中尚未保存过 language」的真实路径。
Future<void> _seedInitLanguage(AppDatabase db, String? value) async {
  if (value == null) return;
  // SettingsNotifier._loadFromDb 会对 row.value 做 jsonDecode；为了让
  // 解析后真的拿到字符串值（而不是被当成 raw key），统一写 JSON-encoded
  // 字符串。
  await db
      .into(db.settings)
      .insertOnConflictUpdate(
        SettingsCompanion.insert(key: 'language', value: jsonEncode(value)),
      );
}

// ──────────────────────────────────────────────────────────────────────────
// 测试主体
// ──────────────────────────────────────────────────────────────────────────

void main() {
  group('Property 3: localeProvider 与 settings.language 严格同步', () {
    Glados<_LocaleSyncCase>(
      any.localeSyncCase,
      ExploreConfig(numRuns: 100),
    ).test('每一步后 localeProvider == _languageToLocale(currentSettings.language)；'
        '非法初始 language 回退 Locale("zh")', (c) async {
      final db = _createTestDb();
      ProviderContainer? container;
      try {
        // ── 1. 预先种入初始 language 字段 ─────────────────────────────
        await _seedInitLanguage(db, _initLangToValue(c.initLanguage));

        // ── 2. 用 ProviderContainer 隔离运行 settingsProvider ─────────
        container = _createContainer(db);

        // ── 3. 触发 SettingsNotifier.build：读 DB → 写 localeProvider ──
        // 用 .future 等待 build 完成，确保 build 内部对 localeProvider
        // 的同步写入已经生效。
        final initialSettings = await container.read(settingsProvider.future);

        // ── 4. 断言初始状态：localeProvider 与 currentSettings.language
        // 经 _languageToLocale 投影后一致 ─────────────────────────────
        {
          final expected = _expectedLocale(
            initialSettings.language,
          ).languageCode;
          final actual = container.read(localeProvider).languageCode;
          expect(
            actual,
            equals(expected),
            reason:
                '初始状态：localeProvider 应等于 _languageToLocale(currentSettings.language)。\n'
                '  init = ${c.initLanguage}\n'
                '  currentSettings.language = "${initialSettings.language}"\n'
                '  expected = "$expected"\n'
                '  actual   = "$actual"',
          );
        }

        // ── 5. 非法初始 language 回退断言（R2.3）：当初始为 'xx' / null
        // / '' 时，localeProvider.languageCode 必须是 'zh'。
        final isInitInvalid =
            c.initLanguage == _InitLanguage.xx ||
            c.initLanguage == _InitLanguage.nullValue ||
            c.initLanguage == _InitLanguage.empty;
        if (isInitInvalid) {
          expect(
            container.read(localeProvider).languageCode,
            equals('zh'),
            reason:
                '非法 language0 (${c.initLanguage}) 应回退为 Locale("zh")，'
                '当前为 ${container.read(localeProvider)}',
          );
        }

        // ── 6. 顺序执行 update 序列，每一步后断言同步不变量 ───────────
        AppSettings current = initialSettings;
        final notifier = container.read(settingsProvider.notifier);
        for (var i = 0; i < c.updates.length; i++) {
          final newLang = c.updates[i];
          current = current.copyWith(language: newLang);
          await notifier.updateSettings(current);

          // 6a. localeProvider 必须与 currentSettings.language 同步
          final expected = _expectedLocale(current.language).languageCode;
          final actualLocale = container.read(localeProvider);
          expect(
            actualLocale.languageCode,
            equals(expected),
            reason:
                'update 序列第 $i 步后 localeProvider 与 settings 不同步。\n'
                '  step       = $i / ${c.updates.length}\n'
                '  newLang    = "$newLang"\n'
                '  settings   = "${current.language}"\n'
                '  expected   = "$expected"\n'
                '  actual     = "${actualLocale.languageCode}"\n'
                '  case       = $c',
          );

          // 6b. settings AsyncValue 也应同步更新到 newLang
          final stateNow = container.read(settingsProvider).valueOrNull;
          expect(
            stateNow?.language,
            equals(newLang),
            reason:
                'updateSettings 后 settingsProvider.value 未同步到 newLang。\n'
                '  step    = $i\n'
                '  newLang = "$newLang"\n'
                '  state   = "${stateNow?.language}"',
          );
        }
      } finally {
        container?.dispose();
        await db.close();
      }
    });

    // ────────────────────────────────────────────────
    // 例测：把契约的关键边界用具体输入再固化一次（双层保护）
    // ────────────────────────────────────────────────

    test('初始 language 为 "en" → 冷启动后 localeProvider == Locale("en")', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedInitLanguage(db, 'en');
      final container = _createContainer(db);
      addTearDown(container.dispose);

      final settings = await container.read(settingsProvider.future);
      expect(settings.language, 'en');
      expect(container.read(localeProvider), const Locale('en'));
    });

    test('初始 language 为 "xx" → 回退 Locale("zh")', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedInitLanguage(db, 'xx');
      final container = _createContainer(db);
      addTearDown(container.dispose);

      final settings = await container.read(settingsProvider.future);
      // currentSettings.language 保留原始 DB 字符串 'xx'
      expect(settings.language, 'xx');
      // 但 localeProvider 必须经 _languageToLocale 回退到 zh
      expect(container.read(localeProvider), const Locale('zh'));
    });

    test('初始 language 缺失（DB 无 language 行） → 默认 Locale("zh")', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      // 不种入任何 language 行
      final container = _createContainer(db);
      addTearDown(container.dispose);

      final settings = await container.read(settingsProvider.future);
      // _mapToSettings 用 `?? 'zh'` 兜底
      expect(settings.language, 'zh');
      expect(container.read(localeProvider), const Locale('zh'));
    });

    test('updateSettings("en") 后 localeProvider 立即同步到 Locale("en")', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedInitLanguage(db, 'zh');
      final container = _createContainer(db);
      addTearDown(container.dispose);

      final settings = await container.read(settingsProvider.future);
      expect(container.read(localeProvider), const Locale('zh'));

      await container
          .read(settingsProvider.notifier)
          .updateSettings(settings.copyWith(language: 'en'));
      expect(container.read(localeProvider), const Locale('en'));
      expect(container.read(settingsProvider).valueOrNull?.language, 'en');

      // 再切回 'zh'，验证可逆
      await container
          .read(settingsProvider.notifier)
          .updateSettings(settings.copyWith(language: 'zh'));
      expect(container.read(localeProvider), const Locale('zh'));
    });

    test(
      'updateSetting("theme", "dark") 后 themeModeProvider 立即同步为 dark',
      () async {
        final db = _createTestDb();
        addTearDown(() => db.close());
        final container = _createContainer(db);
        addTearDown(container.dispose);

        await container.read(settingsProvider.future);

        await container
            .read(settingsProvider.notifier)
            .updateSetting('theme', 'dark');

        expect(container.read(themeModeProvider), ThemeMode.dark);
        expect(container.read(settingsProvider).valueOrNull?.theme, 'dark');
      },
    );

    test(
      'updateSetting("font_scale", 1.2) 后 settings 与 fontScaleProvider 同步',
      () async {
        final db = _createTestDb();
        addTearDown(() => db.close());
        final container = _createContainer(db);
        addTearDown(container.dispose);

        await container.read(settingsProvider.future);

        await container
            .read(settingsProvider.notifier)
            .updateSetting('font_scale', 1.2);

        expect(container.read(settingsProvider).valueOrNull?.fontScale, 1.2);
        expect(container.read(fontScaleProvider), 1.2);
      },
    );

    test('冷启动 theme=dark 时 themeModeProvider 同步为 dark', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await db
          .into(db.settings)
          .insertOnConflictUpdate(
            SettingsCompanion.insert(key: 'theme', value: jsonEncode('dark')),
          );
      final container = _createContainer(db);
      addTearDown(container.dispose);

      final settings = await container.read(settingsProvider.future);
      expect(settings.theme, 'dark');
      expect(container.read(themeModeProvider), ThemeMode.dark);
    });

    test(
      'updateSetting("auto_resume_last_conversation", true) 后设置项保存',
      () async {
        final db = _createTestDb();
        addTearDown(() => db.close());
        final container = _createContainer(db);
        addTearDown(container.dispose);

        await container.read(settingsProvider.future);

        await container
            .read(settingsProvider.notifier)
            .updateSetting('auto_resume_last_conversation', true);

        expect(
          container
              .read(settingsProvider)
              .valueOrNull
              ?.autoResumeLastConversation,
          isTrue,
        );
      },
    );
  });
}
