// Wave 13.2 冒烟测试：验证 5 个记忆管理子面板能在空 characterId 下渲染不崩溃。
// 覆盖：MemoryIndexPanel / MemoryDiagnosticsPanel / MemoryProfilePanel /
// MemoryArchivePanel / MemoryCandidatesPanel。
//
// 设计要点：
// - 用内存 Drift 数据库覆盖 databaseProvider，避免磁盘依赖
// - 用空列表覆盖 characterListProvider，避免 Drift StreamQueryStore 的清理
//   Timer 在 fakeAsync 区域悬挂导致 pending timers 报错
// - 用 _StaticSettingsNotifier 注入默认 AppSettings（enabled=false）
// - 用 _NoopLlmService 覆盖 llmServiceProvider，避免 Dio.close 在
//   ProviderScope dispose 时触发 pending timers
// - 只 pump 一次，不调用 pumpAndSettle：MemoryIndexPanel 的 Timer.periodic
//   在 pending/processing > 0 时才启动，空 characterId 下 status 为空，
//   不会启动轮询；但 post-frame 回调是异步的，pumpAndSettle 可能会等待
//   Drift 内部 StreamQueryStore 的清理 Timer，故用 pump 更稳

import 'package:drift/drift.dart' hide isNotNull, isNull, Column;
import 'package:drift/native.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/core/models/app_settings.dart';
import 'package:lumimuse/core/providers/character_provider.dart';
import 'package:lumimuse/core/providers/database_provider.dart';
import 'package:lumimuse/core/providers/llm_service_provider.dart';
import 'package:lumimuse/core/providers/settings_provider.dart';
import 'package:lumimuse/core/services/llm_service.dart';
import 'package:lumimuse/features/settings/widgets/settings_sections.dart';

AppDatabase _createTestDb() {
  driftRuntimeOptions.dontWarnAboutMultipleDatabases = true;
  return AppDatabase.forTesting(NativeDatabase.memory());
}

class _StaticSettingsNotifier extends SettingsNotifier {
  final AppSettings settings;

  _StaticSettingsNotifier(this.settings);

  @override
  Future<AppSettings> build() async => settings;
}

/// 空实现 LlmService — 避免真实 Dio.close 在 ProviderScope dispose 时
/// 触发 pending timers。冒烟测试不实际调用 LLM。
class _NoopLlmService extends LlmService {
  @override
  void dispose() {}
}

void main() {
  group('Memory Panels Smoke · Wave 13.2', () {
    testWidgets('空 characterId 时 5 个面板能渲染', (tester) async {
      final db = _createTestDb();
      addTearDown(() => db.close());

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            databaseProvider.overrideWithValue(db),
            settingsProvider.overrideWith(
              () => _StaticSettingsNotifier(const AppSettings()),
            ),
            characterListProvider.overrideWith((ref) async* {
              yield <Character>[];
            }),
            llmServiceProvider.overrideWithValue(_NoopLlmService()),
          ],
          child: const MaterialApp(
            home: Scaffold(
              body: SingleChildScrollView(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    MemoryIndexPanel(characterId: ''),
                    MemoryDiagnosticsPanel(characterId: ''),
                    MemoryProfilePanel(characterId: ''),
                    MemoryArchivePanel(characterId: ''),
                    MemoryCandidatesPanel(characterId: ''),
                  ],
                ),
              ),
            ),
          ),
        ),
      );
      // 触发首帧 + post-frame 回调（_loadStatus / _load / _loadMemories）
      await tester.pump();
      // 再 pump 一次让异步 setState 完成
      await tester.pump();

      expect(find.byType(MemoryIndexPanel), findsOneWidget);
      expect(find.byType(MemoryDiagnosticsPanel), findsOneWidget);
      expect(find.byType(MemoryProfilePanel), findsOneWidget);
      expect(find.byType(MemoryArchivePanel), findsOneWidget);
      expect(find.byType(MemoryCandidatesPanel), findsOneWidget);
    });

    testWidgets('MemoryEngineSection 在 enabled=true 时显示 5 个面板', (tester) async {
      final db = _createTestDb();
      addTearDown(() => db.close());

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            databaseProvider.overrideWithValue(db),
            settingsProvider.overrideWith(
              () => _StaticSettingsNotifier(
                const AppSettings(
                  memoryEngine: MemoryEngineSettings(enabled: true),
                ),
              ),
            ),
            characterListProvider.overrideWith((ref) async* {
              yield <Character>[];
            }),
            llmServiceProvider.overrideWithValue(_NoopLlmService()),
          ],
          child: const MaterialApp(
            home: Scaffold(
              body: SingleChildScrollView(
                child: MemoryEngineSection(),
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump();

      // enabled=true 时 5 个面板应该都渲染
      expect(find.byType(MemoryIndexPanel), findsOneWidget);
      expect(find.byType(MemoryDiagnosticsPanel), findsOneWidget);
      expect(find.byType(MemoryProfilePanel), findsOneWidget);
      expect(find.byType(MemoryArchivePanel), findsOneWidget);
      expect(find.byType(MemoryCandidatesPanel), findsOneWidget);
    });

    testWidgets('MemoryEngineSection 在 enabled=false 时不显示 5 个面板', (tester) async {
      final db = _createTestDb();
      addTearDown(() => db.close());

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            databaseProvider.overrideWithValue(db),
            settingsProvider.overrideWith(
              () => _StaticSettingsNotifier(
                const AppSettings(
                  memoryEngine: MemoryEngineSettings(enabled: false),
                ),
              ),
            ),
            characterListProvider.overrideWith((ref) async* {
              yield <Character>[];
            }),
            llmServiceProvider.overrideWithValue(_NoopLlmService()),
          ],
          child: const MaterialApp(
            home: Scaffold(
              body: SingleChildScrollView(
                child: MemoryEngineSection(),
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump();

      // enabled=false 时 5 个面板都不渲染
      expect(find.byType(MemoryIndexPanel), findsNothing);
      expect(find.byType(MemoryDiagnosticsPanel), findsNothing);
      expect(find.byType(MemoryProfilePanel), findsNothing);
      expect(find.byType(MemoryArchivePanel), findsNothing);
      expect(find.byType(MemoryCandidatesPanel), findsNothing);
    });
  });
}
