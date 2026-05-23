// 角色卡解析器属性测试
// Feature: flutter-data-management, Task 4.6
// Property 6: Chara Card v2 字段映射完整性
// Validates: Requirements 3.6

import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, test, group;
import 'package:lumimuse/core/utils/character_card_parser.dart';

/// 自定义生成器：生成随机 Chara Card v2 格式的 payload
extension CharaCardGenerators on Any {
  /// 生成非空角色名称
  Generator<String> get nonEmptyName => any.choose([
        'Alice',
        'Bob',
        '小明',
        'テスト',
        'Character_01',
        '角色名',
        'NPC-Alpha',
        '夜雨',
        'Lumina',
        '星辰',
      ]);

  /// 生成可选文本字段（可能为空）
  Generator<String> get optionalText => any.choose([
        '',
        'Hello world',
        '这是一段描述文本',
        'Some personality traits',
        '场景设定：现代都市',
        '你好，我是{char}',
        '<START>\n{{user}}: Hi\n{{char}}: Hello!',
        'You are a helpful assistant.',
        '历史后置指令内容',
        '创作者备注信息',
      ]);

  /// 生成 tags（可能是 `List<String>` 或 String）
  Generator<dynamic> get tagsValue => any.choose(<dynamic>[
        <String>['tag1', 'tag2', 'tag3'],
        <String>['fantasy', 'romance'],
        <String>[],
        'single_tag',
        'tag_a, tag_b',
        '',
        <String>['长发', '蓝眼', '制服'],
      ]);
}

void main() {
  group('Property 6: Chara Card v2 字段映射完整性', () {
    // 核心属性：任何包含 data.name 的 Chara Card v2 JSON，
    // normalize 必须返回非 null 的 map，且包含所有预期 key，每个值都是 String
    Glados<String>(any.nonEmptyName).test(
      '**Validates: Requirements 3.6** — 任意有效 Chara Card v2（含 data.name）产出完整字段映射',
      (name) {
        final payload = <String, dynamic>{
          'data': <String, dynamic>{
            'name': name,
            'description': '角色描述',
            'personality': '性格特征',
            'scenario': '场景',
            'first_mes': '开场白',
            'mes_example': '示例对话',
            'system_prompt': '系统提示',
            'post_history_instructions': '后置指令',
            'creator_notes': '创作者备注',
            'tags': <String>['tag1', 'tag2'],
            'avatar': 'https://example.com/avatar.png',
            'creator': '创作者',
            'character_version': '1.0',
          },
        };

        final result = CharacterCardParser.normalize(payload);

        // 必须返回非 null
        expect(result, isNotNull, reason: '包含 data.name 的 payload 应返回非 null');

        // 必须包含所有预期 key
        for (final key in CharacterCardParser.expectedKeys) {
          expect(result!.containsKey(key), isTrue,
              reason: '结果应包含 key: $key');
          expect(result[key], isA<String>(),
              reason: 'key "$key" 的值应为 String 类型');
        }

        // name 必须与输入一致
        expect(result!['name'], equals(name));
      },
    );

    Glados<String>(any.nonEmptyName).test(
      '最小化 Chara Card v2（仅含 data.name）也能产出完整映射',
      (name) {
        // 最小有效 payload：只有 data.name
        final payload = <String, dynamic>{
          'data': <String, dynamic>{
            'name': name,
          },
        };

        final result = CharacterCardParser.normalize(payload);

        expect(result, isNotNull,
            reason: '仅含 data.name 的最小 payload 应返回非 null');

        for (final key in CharacterCardParser.expectedKeys) {
          expect(result!.containsKey(key), isTrue,
              reason: '结果应包含 key: $key');
          expect(result[key], isA<String>(),
              reason: 'key "$key" 的值应为 String 类型');
        }

        // 除 name 外其他字段应为空字符串
        expect(result!['name'], equals(name));
        expect(result['basic_info'], isA<String>());
        expect(result['personality'], equals(''));
        expect(result['scenario'], equals(''));
        expect(result['greeting'], equals(''));
        expect(result['example_dialogue'], equals(''));
        expect(result['system_prompt'], equals(''));
        expect(result['other_info'], isA<String>());
        expect(result['image_tags'], equals(''));
      },
    );

    Glados2<String, String>(any.nonEmptyName, any.optionalText).test(
      'Chara Card v2 各字段映射后值类型始终为 String',
      (name, optText) {
        final payload = <String, dynamic>{
          'data': <String, dynamic>{
            'name': name,
            'description': optText,
            'personality': optText,
            'scenario': optText,
            'first_mes': optText,
            'mes_example': optText,
            'system_prompt': optText,
            'post_history_instructions': optText,
            'creator_notes': optText,
            'tags': optText,
          },
        };

        final result = CharacterCardParser.normalize(payload);
        expect(result, isNotNull);

        for (final key in CharacterCardParser.expectedKeys) {
          expect(result!.containsKey(key), isTrue);
          expect(result[key], isA<String>());
        }
      },
    );

    test('data.tags 为 List 时正确转为逗号分隔字符串', () {
      final payload = <String, dynamic>{
        'data': <String, dynamic>{
          'name': 'TestChar',
          'tags': <String>['fantasy', 'romance', 'adventure'],
        },
      };

      final result = CharacterCardParser.normalize(payload);
      expect(result, isNotNull);
      expect(result!['image_tags'], equals('fantasy, romance, adventure'));
    });

    test('data.tags 为 String 时直接使用', () {
      final payload = <String, dynamic>{
        'data': <String, dynamic>{
          'name': 'TestChar',
          'tags': 'single_tag_string',
        },
      };

      final result = CharacterCardParser.normalize(payload);
      expect(result, isNotNull);
      expect(result!['image_tags'], equals('single_tag_string'));
    });

    test('缺少 data 字段时返回 null', () {
      final payload = <String, dynamic>{
        'spec': 'chara_card_v2',
      };

      final result = CharacterCardParser.normalize(payload);
      expect(result, isNull);
    });

    test('data.name 为空字符串时返回 null', () {
      final payload = <String, dynamic>{
        'data': <String, dynamic>{
          'name': '',
          'description': '有描述但无名称',
        },
      };

      final result = CharacterCardParser.normalize(payload);
      expect(result, isNull);
    });

    test('LumiMuse 格式（含 character 字段）正确解析', () {
      final payload = <String, dynamic>{
        'character': <String, dynamic>{
          'name': '夜雨',
          'basic_info': '基本信息',
          'personality': '温柔',
          'scenario': '现代都市',
          'greeting': '你好呀',
          'example_dialogue': '示例',
          'system_prompt': '系统提示',
          'other_info': '其他',
          'image_tags': '长发, 蓝眼',
          'avatar_url': 'https://example.com/avatar.png',
        },
      };

      final result = CharacterCardParser.normalize(payload);
      expect(result, isNotNull);
      expect(result!['name'], equals('夜雨'));
      expect(result['basic_info'], equals('基本信息'));
      expect(result['personality'], equals('温柔'));
      expect(result['avatar_url'], equals('https://example.com/avatar.png'));
    });

    test('LumiMuse 格式（根对象直接包含 name）正确解析', () {
      final payload = <String, dynamic>{
        'name': '星辰',
        'basic_info': '来自远方',
        'personality': '活泼',
        'scenario': '',
        'greeting': '嗨！',
        'example_dialogue': '',
        'system_prompt': '',
        'other_info': '',
        'image_tags': '',
      };

      final result = CharacterCardParser.normalize(payload);
      expect(result, isNotNull);
      expect(result!['name'], equals('星辰'));
      expect(result['basic_info'], equals('来自远方'));
    });
  });

  group('isLumiMuseBackup 检测', () {
    test('包含 character 字段时返回 true', () {
      expect(
        CharacterCardParser.isLumiMuseBackup({'character': {}}),
        isTrue,
      );
    });

    test('包含 characters 字段时返回 true', () {
      expect(
        CharacterCardParser.isLumiMuseBackup({'characters': []}),
        isTrue,
      );
    });

    test('包含 conversations 字段时返回 true', () {
      expect(
        CharacterCardParser.isLumiMuseBackup({'conversations': []}),
        isTrue,
      );
    });

    test('不包含任何标识字段时返回 false', () {
      expect(
        CharacterCardParser.isLumiMuseBackup({
          'data': {'name': 'test'},
        }),
        isFalse,
      );
    });

    test('空 map 返回 false', () {
      expect(
        CharacterCardParser.isLumiMuseBackup({}),
        isFalse,
      );
    });
  });

  group('joinSections 合并段落', () {
    test('多段非空内容正确合并', () {
      final result = CharacterCardParser.joinSections([
        ('标题一', '内容一'),
        ('标题二', '内容二'),
      ]);
      expect(result, equals('【标题一】\n内容一\n\n【标题二】\n内容二'));
    });

    test('过滤空内容段落', () {
      final result = CharacterCardParser.joinSections([
        ('标题一', '内容一'),
        ('空段', ''),
        ('标题三', '内容三'),
      ]);
      expect(result, equals('【标题一】\n内容一\n\n【标题三】\n内容三'));
    });

    test('全部为空时返回空字符串', () {
      final result = CharacterCardParser.joinSections([
        ('空一', ''),
        ('空二', '  '),
      ]);
      expect(result, equals(''));
    });

    test('内容前后空白被 trim', () {
      final result = CharacterCardParser.joinSections([
        ('标题', '  内容  '),
      ]);
      expect(result, equals('【标题】\n内容'));
    });

    test('空列表返回空字符串', () {
      final result = CharacterCardParser.joinSections([]);
      expect(result, equals(''));
    });
  });
}
