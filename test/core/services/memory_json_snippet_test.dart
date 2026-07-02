import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/services/memory_engine.dart';

void main() {
  // 对齐主项目 src/lib/memory-engine.ts:459-491 的 findBalancedJsonSnippet
  // spec Task 14a：花括号配对扫描，多候选优先返回含 memories 字段的块
  // 测试覆盖：多候选优先级、思考前置包裹、无候选、单候选、字符串内花括号、嵌套配对

  test('多个 JSON 块：返回含 memories 的块（跳过思考块）', () {
    const raw = '{ "思考": "正在分析对话" } { "memories": [{"content": "x"}] }';
    final result = MemoryEngine.findBalancedJsonSnippet(raw);
    expect(result, isNotNull);
    expect(result!, contains('"memories"'));
    expect(result, isNot(contains('思考')));
  });

  test('思考前置包裹 memories：返回 memories 块', () {
    const raw = '思考一下... { "memories": [] }';
    final result = MemoryEngine.findBalancedJsonSnippet(raw);
    expect(result, isNotNull);
    expect(result!, '{ "memories": [] }');
  });

  test('无效 JSON（无花括号）：返回 null', () {
    const raw = '这不是 JSON，没有花括号';
    final result = MemoryEngine.findBalancedJsonSnippet(raw);
    expect(result, isNull);
  });

  test('单个完整 JSON：返回该块', () {
    const raw = '{ "memories": [] }';
    final result = MemoryEngine.findBalancedJsonSnippet(raw);
    expect(result, isNotNull);
    expect(result!, '{ "memories": [] }');
  });

  test('字符串内的花括号不破坏配对（对齐主项目字符串/转义处理）', () {
    // 第一个块的 content 字符串含 `}`，不应触发 depth--；
    // 第一个候选完整闭合后，第二个候选含 memories 应被优先返回
    const raw = '{ "content": "包含}花括号" } { "memories": [] }';
    final result = MemoryEngine.findBalancedJsonSnippet(raw);
    expect(result, isNotNull);
    expect(result!, contains('"memories"'));
  });

  test('嵌套花括号正确配对：内层对象不提前闭合', () {
    const raw = '{ "memories": [ { "content": "嵌套" } ] }';
    final result = MemoryEngine.findBalancedJsonSnippet(raw);
    expect(result, isNotNull);
    expect(result!, '{ "memories": [ { "content": "嵌套" } ] }');
  });

  test('无 memories 字段时返回第一个完整块', () {
    const raw = '{ "a": 1 } { "b": 2 }';
    final result = MemoryEngine.findBalancedJsonSnippet(raw);
    expect(result, isNotNull);
    expect(result!, '{ "a": 1 }');
  });

  test('字符串内的转义引号不翻转 inString 状态', () {
    // `\"` 应被识别为转义，不翻转字符串状态，从而字符串内的 `}` 不破坏配对
    const raw = '{ "content": "包含\\"引号}和花括号" } { "memories": [] }';
    final result = MemoryEngine.findBalancedJsonSnippet(raw);
    expect(result, isNotNull);
    expect(result!, contains('"memories"'));
  });

  test('花括号未闭合：返回 null（无完整候选）', () {
    const raw = '{ "memories": []  缺少右花括号';
    final result = MemoryEngine.findBalancedJsonSnippet(raw);
    expect(result, isNull);
  });
}
