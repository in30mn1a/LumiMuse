import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  group('设置页全量备份导出回归', () {
    test('Android 和 iOS 使用 FilePicker.saveFile 时必须传入 bytes', () {
      final page = File('lib/features/settings/settings_page.dart')
          .readAsStringSync();

      expect(page, contains('Platform.isAndroid || Platform.isIOS'));
      expect(page, contains('Uint8List.fromList(utf8.encode(jsonStr))'));
      expect(page, contains('bytes: exportBytes'));
      expect(page, contains('if (isMobileExport)'));
    });
  });
}
