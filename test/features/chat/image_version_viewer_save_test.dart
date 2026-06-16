import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  group('大图预览保存到相册回归', () {
    test('ImageVersionViewer 长按当前大图会打开保存到相册菜单', () {
      final viewer =
          File('lib/features/chat/widgets/image_version_viewer.dart')
              .readAsStringSync();

      expect(viewer, contains('onLongPress: _showSaveMenu'));
      expect(viewer, contains('image.viewer.saveToGallery'));
      expect(viewer, contains('GallerySaverService.saveImageToGallery'));
    });

    test('Android MainActivity 提供 saveImageToGallery 平台通道实现', () {
      final activity = File(
        'android/app/src/main/kotlin/com/lumimuse/lumimuse/MainActivity.kt',
      ).readAsStringSync();

      expect(activity, contains('lumimuse/gallery_saver'));
      expect(activity, contains('saveImageToGallery'));
      expect(activity, contains('ensureLegacyWritePermission'));
      expect(activity, contains('WRITE_EXTERNAL_STORAGE'));
      expect(activity, contains('MediaStore.Images.Media'));
      expect(activity, contains('RELATIVE_PATH'));
    });

    test('iOS AppDelegate 提供 saveImageToGallery 相册写入实现', () {
      final appDelegate = File('ios/Runner/AppDelegate.swift').readAsStringSync();
      final info = File('ios/Runner/Info.plist').readAsStringSync();

      expect(appDelegate, contains('lumimuse/gallery_saver'));
      expect(appDelegate, contains('PHPhotoLibrary'));
      expect(appDelegate, contains('creationRequestForAssetFromImage'));
      expect(info, contains('NSPhotoLibraryAddUsageDescription'));
      expect(info, contains('NSPhotoLibraryUsageDescription'));
      expect(info, contains('NSCameraUsageDescription'));
    });
  });
}
