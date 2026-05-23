// test/widget/_helpers/test_image.dart
//
// 多个图片相关的 widget 测试都需要在临时目录里写 PNG 文件，再让
// FileImage / Image.file 真正可解码。这里集中两类工具：
//
// 1. [writeTestPng]   —— 同步、固定 1×1 透明像素。适合"图片本身不重要、
//                        只要文件存在且能被引擎解码"的场景。
// 2. [writeColoredTestPng] —— 异步、按颜色生成 12×12 PNG。适合需要靠像素
//                              内容/路径区分多张图的场景。
//
// 把 helper 抽到这里，避免每个测试文件复制一份字节数组或 PictureRecorder
// 样板，后续新增图片相关 widget 测试时复用即可。

import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/painting.dart';

/// 最小可解码 PNG（1×1，IHDR + 单像素 IDAT + IEND）。
///
/// 体积小、Flutter 引擎能正常解码，足以让 `Image.file` 触发 frame 回调。
const List<int> _tinyPngBytes = <int>[
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // 文件头
  0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, // IHDR length + tag
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1×1
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89,
  0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, // IDAT
  0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05,
  0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4,
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, // IEND
  0xAE, 0x42, 0x60, 0x82,
];

/// 同步在 [dir] 中写入一份名为 [name] 的最小 PNG，返回写入的 [File]。
///
/// 适合不关心图片像素内容、只想让 `Image.file` 解码不抛错的场景。
File writeTestPng(Directory dir, String name) {
  final file = File('${dir.path}${Platform.pathSeparator}$name');
  file.writeAsBytesSync(_tinyPngBytes);
  return file;
}

/// 异步生成一张 12×12 的纯色 PNG 写入 [dir]/[name]，返回写入的 [File]。
///
/// 适合需要靠像素差异或路径区分多张图的场景（如版本切换）。
Future<File> writeColoredTestPng(
  Directory dir,
  String name,
  Color color,
) async {
  final recorder = ui.PictureRecorder();
  final canvas = Canvas(recorder);
  final paint = Paint()..color = color;
  canvas.drawRect(const Rect.fromLTWH(0, 0, 12, 12), paint);
  final image = await recorder.endRecording().toImage(12, 12);
  final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
  final file = File('${dir.path}${Platform.pathSeparator}$name');
  await file.writeAsBytes(bytes!.buffer.asUint8List());
  return file;
}
