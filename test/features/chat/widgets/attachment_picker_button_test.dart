import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/features/chat/widgets/attachment_picker_button.dart';

Widget _buildTestApp(Widget child) {
  return MaterialApp(
    home: Scaffold(body: Center(child: child)),
  );
}

void main() {
  testWidgets('达到附件上限时点击按钮会显示上限反馈', (tester) async {
    await tester.pumpWidget(
      _buildTestApp(
        AttachmentPickerButton(
          currentCount: AttachmentPickerButton.maxAttachments,
          onPicked: (_) {},
        ),
      ),
    );

    await tester.tap(find.byIcon(Icons.attach_file));
    await tester.pump();

    expect(find.text('最多附带 5 个附件'), findsOneWidget);
  });

  testWidgets('生成中禁用时点击按钮不显示上限反馈', (tester) async {
    await tester.pumpWidget(
      _buildTestApp(
        AttachmentPickerButton(
          currentCount: AttachmentPickerButton.maxAttachments,
          disabled: true,
          onPicked: (_) {},
        ),
      ),
    );

    await tester.tap(find.byIcon(Icons.attach_file));
    await tester.pump();

    expect(find.text('最多附带 5 个附件'), findsNothing);
  });
}
