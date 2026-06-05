import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/theme/app_widgets.dart';

void main() {
  group('LumiNetworkImage 本地路径识别', () {
    testWidgets('Android 绝对文件路径使用 Image.file，而不是 Image.network', (
      tester,
    ) async {
      const avatarPath =
          '/data/user/0/com.lumimuse.lumimuse/app_flutter/avatars/avatar.png';

      await tester.pumpWidget(
        const MaterialApp(home: LumiNetworkImage(url: avatarPath)),
      );

      final image = tester.widget<Image>(find.byType(Image));
      expect(image.image, isA<FileImage>());
      expect((image.image as FileImage).file.path, avatarPath);
    });

    testWidgets('主项目 web 头像路径仍使用 Image.network', (tester) async {
      const webAvatarPath = '/avatars/avatar.png';

      await tester.pumpWidget(
        const MaterialApp(home: LumiNetworkImage(url: webAvatarPath)),
      );

      final image = tester.widget<Image>(find.byType(Image));
      expect(image.image, isA<NetworkImage>());
    });
  });
}
