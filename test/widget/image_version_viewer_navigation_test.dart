import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/features/chat/widgets/image_version_viewer.dart';

import '_helpers/test_image.dart';

FileImage _currentFileImage(WidgetTester tester) {
  final images = tester.widgetList<Image>(find.byType(Image)).toList();
  expect(images, isNotEmpty);
  return images.first.image as FileImage;
}

void main() {
  group('Widget · ImageVersionViewer navigation', () {
    late Directory dir;
    late File first;
    late File second;
    late File third;

    setUp(() async {
      dir = await Directory.systemTemp.createTemp('lumimuse-viewer-test-');
      first = await writeColoredTestPng(dir, 'first.png', Colors.red);
      second = await writeColoredTestPng(dir, 'second.png', Colors.green);
      third = await writeColoredTestPng(dir, 'third.png', Colors.blue);
    });

    tearDown(() async {
      if (await dir.exists()) {
        await dir.delete(recursive: true);
      }
    });

    testWidgets(
      'left button shows previous image and right button shows next image',
      (tester) async {
        await tester.pumpWidget(
          ProviderScope(
            child: MaterialApp(
              home: ImageVersionViewer(
                imagePaths: [first.path, second.path, third.path],
                initialIndex: 1,
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();

        expect(_currentFileImage(tester).file.path, second.path);

        await tester.tap(find.byIcon(Icons.chevron_left));
        await tester.pumpAndSettle();
        expect(_currentFileImage(tester).file.path, first.path);

        await tester.tap(find.byIcon(Icons.chevron_right));
        await tester.pumpAndSettle();
        expect(_currentFileImage(tester).file.path, second.path);
      },
    );
  });
}
