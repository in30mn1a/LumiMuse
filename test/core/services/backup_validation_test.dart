// 导入验证拒绝无效输入属性测试
// Feature: flutter-visual-polish, Property 4: Import validation rejects invalid input
// Validates: Requirements 7.6

import 'dart:convert';

import 'package:glados/glados.dart';
import 'package:lumimuse/core/services/backup_service.dart';

/// 必需的顶层字段
const _requiredFields = ['conversations', 'characters', 'memories'];

/// 生成有效的备份 JSON 字符串（包含所有必需字段）
String _buildValidBackupJson({
  List<dynamic> conversations = const [],
  List<dynamic> characters = const [],
  List<dynamic> memories = const [],
}) {
  return jsonEncode({
    'version': 1,
    'conversations': conversations,
    'characters': characters,
    'memories': memories,
  });
}

void main() {
  // Tag: Feature: flutter-visual-polish, Property 4: Import validation rejects invalid input
  group('Property 4: Import validation rejects invalid input', tags: [
    'flutter-visual-polish',
    'import-validation-rejects-invalid',
  ], () {
    // ─────────────────────────────────────────────
    // 属性测试 1：随机非 JSON 字符串应被拒绝
    // 生成随机字符串，验证非法 JSON 被拒绝
    // ─────────────────────────────────────────────

    Glados(any.letterOrDigits)
        .test(
      '随机非 JSON 字符串应被拒绝',
      (randomStr) {
        // 确保生成的字符串不是有效 JSON 对象
        // letterOrDigits 生成的纯字母数字字符串不会是有效 JSON 对象
        final result = BackupService.validateBackupJson(randomStr);

        expect(result.isValid, isFalse,
            reason: '非 JSON 字符串 "$randomStr" 应被拒绝');
        expect(result.errorMessage, isNotNull,
            reason: '拒绝时应提供错误信息');
      },
    );

    // ─────────────────────────────────────────────
    // 属性测试 2：缺少必需字段的 JSON 应被拒绝
    // 随机选择要移除的字段子集，验证缺少字段时被拒绝
    // ─────────────────────────────────────────────

    Glados(any.intInRange(1, 7))
        .test(
      '缺少必需字段的有效 JSON 应被拒绝',
      (fieldBitmask) {
        // 使用位掩码决定哪些必需字段被移除（1-7 确保至少移除一个）
        final data = <String, dynamic>{
          'version': 1,
        };

        // 只有当对应位为 0 时才包含该字段
        for (int i = 0; i < _requiredFields.length; i++) {
          if ((fieldBitmask & (1 << i)) == 0) {
            data[_requiredFields[i]] = [];
          }
        }

        // 确认至少缺少一个必需字段
        final hasMissing = _requiredFields.any((f) => !data.containsKey(f));
        if (!hasMissing) {
          // 位掩码 7 (111) 表示全部移除，一定缺少字段
          // 但如果所有字段都在，跳过此测试用例
          return;
        }

        final jsonStr = jsonEncode(data);
        final result = BackupService.validateBackupJson(jsonStr);

        expect(result.isValid, isFalse,
            reason: '缺少必需字段的 JSON 应被拒绝，位掩码: $fieldBitmask');
        expect(result.errorMessage, isNotNull,
            reason: '拒绝时应提供错误信息');
      },
    );

    // ─────────────────────────────────────────────
    // 属性测试 3：包含所有必需字段的有效 JSON 应被接受
    // 验证正确格式的 JSON 通过验证
    // ─────────────────────────────────────────────

    Glados(any.intInRange(0, 50))
        .test(
      '包含所有必需字段（数组类型）的有效 JSON 应被接受',
      (itemCount) {
        // 生成包含随机数量空对象的有效备份 JSON
        final conversations = List.generate(itemCount, (_) => {});
        final characters = List.generate(itemCount, (_) => {});
        final memories = List.generate(itemCount, (_) => {});

        final jsonStr = _buildValidBackupJson(
          conversations: conversations,
          characters: characters,
          memories: memories,
        );

        final result = BackupService.validateBackupJson(jsonStr);

        expect(result.isValid, isTrue,
            reason: '包含所有必需字段的有效 JSON 应被接受');
        expect(result.conversationCount, equals(itemCount),
            reason: '对话数量应为 $itemCount');
        expect(result.characterCount, equals(itemCount),
            reason: '角色数量应为 $itemCount');
        expect(result.memoryCount, equals(itemCount),
            reason: '记忆数量应为 $itemCount');
      },
    );

    // ─────────────────────────────────────────────
    // 属性测试 4：必需字段类型不是数组时应被拒绝
    // 验证字段存在但类型错误时的拒绝行为
    // ─────────────────────────────────────────────

    Glados(any.intInRange(0, 2))
        .test(
      '必需字段类型不是数组时应被拒绝',
      (fieldIndex) {
        // 将某个必需字段设为非数组类型
        final data = <String, dynamic>{
          'version': 1,
          'conversations': <dynamic>[],
          'characters': <dynamic>[],
          'memories': <dynamic>[],
        };

        // 将选中的字段改为字符串（非数组类型）
        data[_requiredFields[fieldIndex]] = 'not_an_array';

        final jsonStr = jsonEncode(data);
        final result = BackupService.validateBackupJson(jsonStr);

        expect(result.isValid, isFalse,
            reason:
                '字段 "${_requiredFields[fieldIndex]}" 类型为字符串时应被拒绝');
        expect(result.errorMessage, isNotNull,
            reason: '拒绝时应提供错误信息');
      },
    );

    // ─────────────────────────────────────────────
    // 属性测试 5：JSON 数组（非对象）应被拒绝
    // 验证顶层不是 Map 时被拒绝
    // ─────────────────────────────────────────────

    Glados(any.intInRange(0, 20))
        .test(
      'JSON 数组（非对象）应被拒绝',
      (length) {
        // 生成一个 JSON 数组而非对象
        final jsonStr = jsonEncode(List.generate(length, (i) => i));
        final result = BackupService.validateBackupJson(jsonStr);

        expect(result.isValid, isFalse,
            reason: 'JSON 数组应被拒绝，只接受 JSON 对象');
        expect(result.errorMessage, isNotNull,
            reason: '拒绝时应提供错误信息');
      },
    );

    // ─────────────────────────────────────────────
    // 边界值测试
    // ─────────────────────────────────────────────

    test('空字符串应被拒绝', () {
      final result = BackupService.validateBackupJson('');
      expect(result.isValid, isFalse);
      expect(result.errorMessage, isNotNull);
    });

    test('空 JSON 对象（无必需字段）应被拒绝', () {
      final result = BackupService.validateBackupJson('{}');
      expect(result.isValid, isFalse);
      expect(result.errorMessage, isNotNull);
    });

    test('null JSON 值应被拒绝', () {
      final result = BackupService.validateBackupJson('null');
      expect(result.isValid, isFalse);
      expect(result.errorMessage, isNotNull);
    });

    test('JSON 数字应被拒绝', () {
      final result = BackupService.validateBackupJson('42');
      expect(result.isValid, isFalse);
      expect(result.errorMessage, isNotNull);
    });

    test('JSON 布尔值应被拒绝', () {
      final result = BackupService.validateBackupJson('true');
      expect(result.isValid, isFalse);
      expect(result.errorMessage, isNotNull);
    });

    test('包含所有必需字段的最小有效 JSON 应被接受', () {
      final jsonStr = _buildValidBackupJson();
      final result = BackupService.validateBackupJson(jsonStr);
      expect(result.isValid, isTrue);
      expect(result.characterCount, equals(0));
      expect(result.conversationCount, equals(0));
      expect(result.memoryCount, equals(0));
    });

    test('截断的 JSON 应被拒绝', () {
      final result =
          BackupService.validateBackupJson('{"conversations": [');
      expect(result.isValid, isFalse);
      expect(result.errorMessage, isNotNull);
    });
  });
}
