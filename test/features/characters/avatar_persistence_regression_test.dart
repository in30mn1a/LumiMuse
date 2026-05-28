import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  group('角色头像上传保存回归', () {
    test('角色编辑页上传头像后先进入草稿，保存时持久化到当前角色', () {
      final page = File(
        'lib/features/characters/character_edit_page.dart',
      ).readAsStringSync();

      expect(page, contains('void _handleAvatarChanged(String? newPath)'));
      expect(page, contains('setState(() => _avatarPath = newPath);'));
      expect(page, contains('await actions.update('));
      expect(page, contains('avatarUrl: _avatarPath'));
      expect(page, contains('onAvatarChanged: _handleAvatarChanged'));
    });
  });
}
