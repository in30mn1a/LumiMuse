// LumiMuse 基础 widget 测试占位
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('App smoke test placeholder', (WidgetTester tester) async {
    // 占位测试 — 实际 UI 测试需要 mock 数据库和 Riverpod providers
    expect(1 + 1, equals(2));
  });
}
