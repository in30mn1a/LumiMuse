import 'dart:io';

import 'package:flutter/services.dart';

class GallerySaverService {
  static const MethodChannel _channel =
      MethodChannel('lumimuse/gallery_saver');

  static Future<void> saveImageToGallery(String imagePath) async {
    final trimmed = imagePath.trim();
    if (trimmed.isEmpty) {
      throw const GallerySaveException('图片路径为空');
    }
    if (!await File(trimmed).exists()) {
      throw const GallerySaveException('图片文件不存在');
    }

    try {
      await _channel.invokeMethod<void>('saveImageToGallery', {
        'path': trimmed,
      });
    } on PlatformException catch (e) {
      throw GallerySaveException(e.message ?? '保存到相册失败');
    }
  }
}

class GallerySaveException implements Exception {
  final String message;

  const GallerySaveException(this.message);

  @override
  String toString() => message;
}
