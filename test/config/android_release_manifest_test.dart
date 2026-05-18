import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  group('Android release manifest', () {
    test('main manifest grants network access for release APK', () {
      final manifest = File('android/app/src/main/AndroidManifest.xml')
          .readAsStringSync();

      expect(
        manifest,
        contains(
          '<uses-permission android:name="android.permission.INTERNET"/>',
        ),
      );
      expect(manifest, contains('android:usesCleartextTraffic="true"'));
    });

    test('main manifest declares mobile image picking and cropper requirements', () {
      final manifest = File('android/app/src/main/AndroidManifest.xml')
          .readAsStringSync();

      expect(manifest, contains('android.permission.CAMERA'));
      expect(manifest, contains('android.permission.READ_MEDIA_IMAGES'));
      expect(
        manifest,
        contains('android.permission.READ_MEDIA_VISUAL_USER_SELECTED'),
      );
      expect(manifest, contains('android.permission.READ_EXTERNAL_STORAGE'));
      expect(manifest, contains('android.permission.WRITE_EXTERNAL_STORAGE'));
      expect(manifest, contains('com.yalantis.ucrop.UCropActivity'));
      expect(manifest, contains('@style/Theme.AppCompat.Light.NoActionBar'));
    });
  });
}
