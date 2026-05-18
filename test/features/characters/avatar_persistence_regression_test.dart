import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  group('角色头像上传持久化回归', () {
    test('角色编辑页上传头像后会立即持久化到当前角色', () {
      final page = File(
        'lib/features/characters/character_edit_page.dart',
      ).readAsStringSync();

      expect(page, contains('Future<void> _handleAvatarChanged('));
      expect(page, contains('await actions.update('));
      expect(page, contains('avatarUrl: newPath'));
      expect(page, contains('onAvatarChanged: _handleAvatarChanged'));
    });
  });
}
