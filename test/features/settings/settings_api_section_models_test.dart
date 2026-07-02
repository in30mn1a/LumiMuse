import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/models/app_settings.dart';
import 'package:lumimuse/core/providers/llm_service_provider.dart';
import 'package:lumimuse/core/providers/settings_provider.dart';
import 'package:lumimuse/core/services/llm_service.dart';
import 'package:lumimuse/features/settings/widgets/settings_sections.dart';

class _StaticSettingsNotifier extends SettingsNotifier {
  final AppSettings settings;

  _StaticSettingsNotifier(this.settings);

  @override
  Future<AppSettings> build() async => settings;
}

class _ModelsLlmService extends LlmService {
  final List<String>? models;
  final Object? error;

  _ModelsLlmService({this.models, this.error});

  @override
  Future<List<String>> fetchModels({
    required String apiBase,
    required String apiKey,
    bool forceRefresh = false,
  }) async {
    if (error != null) throw error!;
    return models ?? const <String>[];
  }

  @override
  void dispose() {}
}

Widget _buildApp(LlmService llm) {
  return ProviderScope(
    overrides: [
      llmServiceProvider.overrideWithValue(llm),
      settingsProvider.overrideWith(
        () => _StaticSettingsNotifier(
          const AppSettings(
            apiBase: 'http://127.0.0.1',
            apiKey: 'sk-visible-field-key',
            model: 'test-model',
          ),
        ),
      ),
    ],
    child: const MaterialApp(home: Scaffold(body: ApiSection())),
  );
}

void main() {
  testWidgets('ApiSection 模型拉取失败时显示脱敏错误', (tester) async {
    await tester.pumpWidget(
      _buildApp(
        _ModelsLlmService(
          error: const FetchModelsException(
            '模型列表拉取失败: sk-error-secret-abcdefghijklmnopqrstuvwxyz',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('获取模型'));
    await tester.pumpAndSettle();

    expect(find.textContaining('模型列表拉取失败'), findsOneWidget);
    expect(
      find.textContaining('sk-error-secret-abcdefghijklmnopqrstuvwxyz'),
      findsNothing,
    );
  });

  testWidgets('ApiSection 真实空模型列表显示空列表提示', (tester) async {
    await tester.pumpWidget(_buildApp(_ModelsLlmService(models: const [])));
    await tester.pumpAndSettle();

    await tester.tap(find.text('获取模型'));
    await tester.pumpAndSettle();

    expect(find.text('服务返回空模型列表'), findsOneWidget);
  });
}
