import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:drift/native.dart';
import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/core/models/app_settings.dart';
import 'package:lumimuse/core/providers/database_provider.dart';
import 'package:lumimuse/core/providers/llm_service_provider.dart';
import 'package:lumimuse/core/providers/settings_provider.dart';
import 'package:lumimuse/core/services/llm_service.dart';
import 'package:lumimuse/features/chat/widgets/chat_input.dart';

Widget _buildTestApp({
  required Future<void> Function(String text) onSend,
  TargetPlatform platform = TargetPlatform.windows,
}) {
  return ProviderScope(
    child: MaterialApp(
      theme: ThemeData(platform: platform),
      home: Scaffold(
        body: ChatInput(
          disabled: false,
          isGenerating: false,
          onSend: (text, attachments) => onSend(text),
        ),
      ),
    ),
  );
}

class _StaticSettingsNotifier extends SettingsNotifier {
  final AppSettings settings;

  _StaticSettingsNotifier(this.settings);

  @override
  Future<AppSettings> build() async => settings;
}

class _FailingModelsLlmService extends LlmService {
  @override
  Future<List<String>> fetchModels({
    required String apiBase,
    required String apiKey,
  }) async {
    throw const FetchModelsException(
      '模型列表拉取失败: sk-secret-abcdefghijklmnopqrstuvwxyz',
    );
  }

  @override
  void dispose() {}
}

void main() {
  group('ChatInput 桌面键盘发送', () {
    testWidgets('TextField 聚焦时按 Enter 会发送消息', (tester) async {
      final sent = <String>[];
      await tester.pumpWidget(
        _buildTestApp(onSend: (text) async => sent.add(text)),
      );

      await tester.enterText(find.byType(TextField), '你好');
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();

      expect(sent, ['你好']);
    });

    testWidgets('TextField 聚焦时按 Shift+Enter 不发送消息', (tester) async {
      final sent = <String>[];
      await tester.pumpWidget(
        _buildTestApp(onSend: (text) async => sent.add(text)),
      );

      await tester.enterText(find.byType(TextField), '你好');
      await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
      await tester.pump();

      expect(sent, isEmpty);
    });
  });

  group('ChatInput 移动端键盘换行', () {
    testWidgets('Android 平台按 Enter 不发送消息', (tester) async {
      final sent = <String>[];
      await tester.pumpWidget(
        _buildTestApp(
          platform: TargetPlatform.android,
          onSend: (text) async => sent.add(text),
        ),
      );

      await tester.enterText(find.byType(TextField), '你好');
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();

      expect(sent, isEmpty);
    });
  });

  group('ChatInput 模型拉取提示', () {
    testWidgets('模型拉取失败时显示脱敏 SnackBar', (tester) async {
      final db = AppDatabase.forTesting(NativeDatabase.memory());
      addTearDown(() => db.close());
      final fakeLlm = _FailingModelsLlmService();

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            databaseProvider.overrideWithValue(db),
            llmServiceProvider.overrideWithValue(fakeLlm),
            settingsProvider.overrideWith(
              () => _StaticSettingsNotifier(
                const AppSettings(
                  apiBase: 'http://127.0.0.1',
                  apiKey: 'sk-secret-abcdefghijklmnopqrstuvwxyz',
                  model: 'test-model',
                ),
              ),
            ),
          ],
          child: MaterialApp(
            theme: ThemeData(platform: TargetPlatform.windows),
            home: Scaffold(
              body: ChatInput(
                disabled: false,
                isGenerating: false,
                currentModel: 'test-model',
                onModelChange: (_) {},
                onSend: (_, _) async {},
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('test-model'));
      await tester.pumpAndSettle();

      expect(find.byType(SnackBar), findsOneWidget);
      expect(find.textContaining('模型列表拉取失败'), findsOneWidget);
      expect(
        find.textContaining('sk-secret-abcdefghijklmnopqrstuvwxyz'),
        findsNothing,
      );
    });
  });
}
