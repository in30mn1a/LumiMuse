// 系统提示词 basic_info / other_info 注入位置属性测试
// Feature: flutter-data-management, Task 3.3
// Property 2: basic_info/other_info 系统提示词注入
// **Validates: Requirements 1.5**

import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, test, group;
import 'package:lumimuse/core/utils/system_prompt_builder.dart';

/// 自定义生成器：生成非空文本内容
extension SystemPromptGenerators on Any {
  /// 生成非空文本（用于 basicInfo / otherInfo）
  Generator<String> get nonEmptyText => any.choose([
        '18岁，猫耳女仆',
        '来自异世界的魔法师',
        '角色背景设定详细描述',
        '不要提及现实世界的事情',
        '特殊规则：每次回复不超过200字',
        'A character from the future',
        '性格温柔，喜欢撒娇',
        '校园背景，高中二年级',
        '注意事项：保持神秘感',
        '补充说明：角色有隐藏身份',
      ]);

  /// 生成性格描述
  Generator<String> get personalityText => any.choose([
        '温柔善良',
        '冷酷无情',
        '活泼开朗',
        '内向害羞',
        '傲娇但关心人',
      ]);

  /// 生成场景描述
  Generator<String> get scenarioText => any.choose([
        '现代都市',
        '中世纪奇幻',
        '校园日常',
        '末世废土',
        '太空站',
      ]);
}

void main() {
  group('Property 2: basic_info/other_info 系统提示词注入位置', () {
    // ─── 当 basicInfo 非空时，"## 基本信息"出现在"## 角色性格"之前 ───
    Glados<String>(any.nonEmptyText).test(
      '**Validates: Requirements 1.5** — basicInfo 非空时，"## 基本信息"出现在"## 角色性格"之前',
      (basicInfo) {
        final result = SystemPromptBuilder.build(
          systemPrompt: '你是一个角色',
          basicInfo: basicInfo,
          personality: '温柔善良',
          scenario: '现代都市',
          otherInfo: '',
          memoryText: '',
        );

        final basicInfoIdx = result.indexOf('## 基本信息');
        final personalityIdx = result.indexOf('## 角色性格');

        expect(basicInfoIdx, greaterThanOrEqualTo(0),
            reason: 'basicInfo 非空时应包含"## 基本信息"段落');
        expect(personalityIdx, greaterThanOrEqualTo(0),
            reason: '应包含"## 角色性格"段落');
        expect(basicInfoIdx, lessThan(personalityIdx),
            reason: '"## 基本信息"应出现在"## 角色性格"之前');

        // 验证段落包含实际内容
        expect(result.contains(basicInfo), isTrue,
            reason: '"## 基本信息"段落应包含 basicInfo 内容');
      },
    );

    // ─── 当 otherInfo 非空时，"## 其他补充信息"出现在"## 场景设定"之后、"## 记忆上下文"之前 ───
    Glados<String>(any.nonEmptyText).test(
      '**Validates: Requirements 1.5** — otherInfo 非空时，"## 其他补充信息"出现在"## 场景设定"之后',
      (otherInfo) {
        final result = SystemPromptBuilder.build(
          systemPrompt: '你是一个角色',
          basicInfo: '',
          personality: '温柔善良',
          scenario: '现代都市',
          otherInfo: otherInfo,
          memoryText: '1. 用户喜欢猫',
        );

        final scenarioIdx = result.indexOf('## 场景设定');
        final otherInfoIdx = result.indexOf('## 其他补充信息');
        final memoryIdx = result.indexOf('## 记忆上下文');

        expect(scenarioIdx, greaterThanOrEqualTo(0),
            reason: '应包含"## 场景设定"段落');
        expect(otherInfoIdx, greaterThanOrEqualTo(0),
            reason: 'otherInfo 非空时应包含"## 其他补充信息"段落');
        expect(memoryIdx, greaterThanOrEqualTo(0),
            reason: '应包含"## 记忆上下文"段落');
        expect(otherInfoIdx, greaterThan(scenarioIdx),
            reason: '"## 其他补充信息"应出现在"## 场景设定"之后');
        expect(otherInfoIdx, lessThan(memoryIdx),
            reason: '"## 其他补充信息"应出现在"## 记忆上下文"之前');

        // 验证段落包含实际内容
        expect(result.contains(otherInfo), isTrue,
            reason: '"## 其他补充信息"段落应包含 otherInfo 内容');
      },
    );

    // ─── 当两者都为空时，两个段落都不出现 ───
    Glados2<String, String>(any.personalityText, any.scenarioText).test(
      '**Validates: Requirements 1.5** — basicInfo 和 otherInfo 都为空时，两个段落都不出现',
      (personality, scenario) {
        final result = SystemPromptBuilder.build(
          systemPrompt: '你是一个角色',
          basicInfo: '',
          personality: personality,
          scenario: scenario,
          otherInfo: '',
          memoryText: '',
        );

        expect(result.contains('## 基本信息'), isFalse,
            reason: 'basicInfo 为空时不应包含"## 基本信息"段落');
        expect(result.contains('## 其他补充信息'), isFalse,
            reason: 'otherInfo 为空时不应包含"## 其他补充信息"段落');
      },
    );

    // ─── 当两者都非空时，完整顺序验证 ───
    Glados2<String, String>(any.nonEmptyText, any.nonEmptyText).test(
      '**Validates: Requirements 1.5** — basicInfo 和 otherInfo 都非空时，完整段落顺序正确',
      (basicInfo, otherInfo) {
        final result = SystemPromptBuilder.build(
          systemPrompt: '系统提示词',
          basicInfo: basicInfo,
          personality: '性格描述',
          scenario: '场景描述',
          otherInfo: otherInfo,
          memoryText: '记忆内容',
        );

        final basicInfoIdx = result.indexOf('## 基本信息');
        final personalityIdx = result.indexOf('## 角色性格');
        final scenarioIdx = result.indexOf('## 场景设定');
        final otherInfoIdx = result.indexOf('## 其他补充信息');
        final memoryIdx = result.indexOf('## 记忆上下文');
        final behaviorIdx = result.indexOf('## 行为要求');

        // 所有段落都应存在
        expect(basicInfoIdx, greaterThanOrEqualTo(0));
        expect(personalityIdx, greaterThanOrEqualTo(0));
        expect(scenarioIdx, greaterThanOrEqualTo(0));
        expect(otherInfoIdx, greaterThanOrEqualTo(0));
        expect(memoryIdx, greaterThanOrEqualTo(0));
        expect(behaviorIdx, greaterThanOrEqualTo(0));

        // 验证顺序：基本信息 < 角色性格 < 场景设定 < 其他补充信息 < 记忆 < 行为要求
        expect(basicInfoIdx, lessThan(personalityIdx),
            reason: '基本信息 应在 角色性格 之前');
        expect(personalityIdx, lessThan(scenarioIdx),
            reason: '角色性格 应在 场景设定 之前');
        expect(scenarioIdx, lessThan(otherInfoIdx),
            reason: '场景设定 应在 其他补充信息 之前');
        expect(otherInfoIdx, lessThan(memoryIdx),
            reason: '其他补充信息 应在 记忆上下文 之前');
        expect(memoryIdx, lessThan(behaviorIdx),
            reason: '记忆上下文 应在 行为要求 之前');
      },
    );

    // ─── 单元测试：具体示例验证 ───
    test('具体示例：basicInfo 非空，otherInfo 为空', () {
      final result = SystemPromptBuilder.build(
        systemPrompt: '你是小猫娘',
        basicInfo: '18岁，猫耳女仆',
        personality: '温柔可爱',
        scenario: '咖啡厅',
        otherInfo: '',
        memoryText: '',
      );

      expect(result.contains('## 基本信息\n18岁，猫耳女仆'), isTrue);
      expect(result.contains('## 其他补充信息'), isFalse);

      final basicIdx = result.indexOf('## 基本信息');
      final persIdx = result.indexOf('## 角色性格');
      expect(basicIdx, lessThan(persIdx));
    });

    test('具体示例：basicInfo 为空，otherInfo 非空', () {
      final result = SystemPromptBuilder.build(
        systemPrompt: '你是小猫娘',
        basicInfo: '',
        personality: '温柔可爱',
        scenario: '咖啡厅',
        otherInfo: '不要提及现实世界',
        memoryText: '1. 用户叫小明',
      );

      expect(result.contains('## 基本信息'), isFalse);
      expect(result.contains('## 其他补充信息\n不要提及现实世界'), isTrue);

      final scenIdx = result.indexOf('## 场景设定');
      final otherIdx = result.indexOf('## 其他补充信息');
      final memIdx = result.indexOf('## 记忆上下文');
      expect(otherIdx, greaterThan(scenIdx));
      expect(otherIdx, lessThan(memIdx));
    });

    test('具体示例：两者都非空', () {
      final result = SystemPromptBuilder.build(
        systemPrompt: '',
        basicInfo: '角色背景信息',
        personality: '活泼开朗',
        scenario: '校园',
        otherInfo: '特殊规则说明',
        memoryText: '',
      );

      expect(result.contains('## 基本信息\n角色背景信息'), isTrue);
      expect(result.contains('## 其他补充信息\n特殊规则说明'), isTrue);

      final basicIdx = result.indexOf('## 基本信息');
      final persIdx = result.indexOf('## 角色性格');
      final scenIdx = result.indexOf('## 场景设定');
      final otherIdx = result.indexOf('## 其他补充信息');

      expect(basicIdx, lessThan(persIdx));
      expect(persIdx, lessThan(scenIdx));
      expect(scenIdx, lessThan(otherIdx));
    });

    test('具体示例：两者都为空', () {
      final result = SystemPromptBuilder.build(
        systemPrompt: '系统指令',
        basicInfo: '',
        personality: '冷酷',
        scenario: '末世',
        otherInfo: '',
        memoryText: '记忆',
      );

      expect(result.contains('## 基本信息'), isFalse);
      expect(result.contains('## 其他补充信息'), isFalse);
      expect(result.contains('## 角色性格'), isTrue);
      expect(result.contains('## 场景设定'), isTrue);
      expect(result.contains('## 记忆上下文'), isTrue);
    });
  });

  // ─────────────────────────────────────────────
  // C1：记忆上下文格式对齐（对照主项目 normalizeMemoryContextText /
  //     renderLegacyMemoryContext / buildSystemPrompt）
  // ─────────────────────────────────────────────
  group('C1: 记忆上下文格式对齐', () {
    test('build 注入记忆段含标题/正文/使用原则三段', () {
      final memoryText = SystemPromptBuilder.renderLegacyMemoryContext(
        const ['用户喜欢猫', '用户怕打雷'],
      );
      final result = SystemPromptBuilder.build(
        systemPrompt: '你是一个角色',
        basicInfo: '',
        personality: '温柔',
        scenario: '现代都市',
        otherInfo: '',
        memoryText: memoryText,
      );

      expect(result, contains('## 记忆上下文'));
      expect(result, contains('### 本轮相关回忆'));
      expect(result, contains('- 用户喜欢猫'));
      expect(result, contains('- 用户怕打雷'));
      expect(result, contains('### 记忆使用原则'));
      // 原则段关键约束逐字出现
      expect(result, contains('以当前消息为准'));
      expect(result, contains('不得覆盖用户当前消息'));
      // 不再使用旧标题
      expect(result, isNot(contains('## 你需要记住的事')));
    });

    test('normalizeMemoryContextText 能剥离已有前缀与原则段后重组（幂等）', () {
      const raw = '### 本轮相关回忆\n- A\n- B';
      final once = SystemPromptBuilder.normalizeMemoryContextText(raw);
      final twice = SystemPromptBuilder.normalizeMemoryContextText(once);

      expect(once, twice, reason: '已规范化文本再次规范化应保持不变（幂等）');
      // 重组后只出现一次标题与一次原则段
      expect('## 记忆上下文'.allMatches(once).length, 1);
      expect('### 记忆使用原则'.allMatches(once).length, 1);
      expect(once, contains('### 本轮相关回忆'));
    });

    test('normalizeMemoryContextText 空白输入返回空串', () {
      expect(SystemPromptBuilder.normalizeMemoryContextText('   '), '');
    });

    test('renderLegacyMemoryContext 跳过空白条目，全空返回空串', () {
      expect(
        SystemPromptBuilder.renderLegacyMemoryContext(const ['', '  ']),
        '',
      );
      final rendered = SystemPromptBuilder.renderLegacyMemoryContext(
        const ['', '有效记忆'],
      );
      expect(rendered, '### 本轮相关回忆\n- 有效记忆');
    });

    test('renderLegacyMemoryContext 预算裁剪：超预算的尾部条目被丢弃', () {
      // 用极小预算逼出裁剪：第一条即超 budget=1 时一条都进不去
      final none = SystemPromptBuilder.renderLegacyMemoryContext(
        const ['这是一条比较长的记忆内容用于占用 token'],
        budget: 1,
      );
      expect(none, '', reason: 'budget=1 时任何非空记忆都超预算，应返回空串');

      // 足够大的预算下两条都保留
      final both = SystemPromptBuilder.renderLegacyMemoryContext(
        const ['甲', '乙'],
        budget: 12000,
      );
      expect(both, '### 本轮相关回忆\n- 甲\n- 乙');
    });
  });
}
