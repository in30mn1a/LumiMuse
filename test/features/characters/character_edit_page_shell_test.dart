import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/core/providers/character_provider.dart';
import 'package:lumimuse/features/characters/character_edit_page.dart';
import 'package:lumimuse/theme/app_shell.dart';

const _characterId = 'char-edit-shell';

Widget _host() {
  return ProviderScope(
    overrides: [
      characterProvider.overrideWith((ref, id) async* {
        yield Character(
          id: _characterId,
          name: '新角色',
          avatarUrl: null,
          personality: '',
          scenario: '',
          greeting: '',
          exampleDialogue: '',
          systemPrompt: '',
          basicInfo: '',
          otherInfo: '',
          imageTags: '',
          userImageTags: '',
          sortOrder: 0,
          createdAt: DateTime(2026, 1, 1),
          updatedAt: DateTime(2026, 1, 1),
        );
      }),
    ],
    child: const MaterialApp(
      home: CharacterEditPage(characterId: _characterId),
    ),
  );
}

void main() {
  testWidgets('CharacterEditPage owns an AppShell background layer', (
    tester,
  ) async {
    await tester.pumpWidget(_host());
    await tester.pump();

    expect(find.byType(AppShell), findsOneWidget);
  });
}
