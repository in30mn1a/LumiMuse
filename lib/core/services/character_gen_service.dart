import 'dart:convert';
import '../models/app_settings.dart';
import 'llm_service.dart';

/// AI 角色生成服务 — 根据用户需求自动生成角色字段
class CharacterGenService {
  final LlmService _llm;

  CharacterGenService() : _llm = LlmService();

  /// 生成角色
  /// 返回 Map 包含: name, personality, scenario, greeting, example_dialogue, system_prompt, image_tags
  Future<Map<String, String>> generateCharacter(
    AppSettings settings,
    String requirement,
  ) async {
    const systemPrompt = '''你是一个角色设计专家。根据用户的要求，生成一个完整的角色设定。
请严格以 JSON 格式输出，包含以下字段：
- name: 角色名称
- basic_info: 角色基本信息（背景设定、身份、年龄、职业等基础信息）
- personality: 角色性格描述（详细，包含说话风格、习惯、情绪特点）
- scenario: 场景设定（角色所处的世界观和背景）
- greeting: 开场白（角色第一次见到用户时说的话，要符合角色性格）
- example_dialogue: 示例对话（格式为 {{user}}: xxx\\n{{char}}: xxx，至少3轮）
- other_info: 其他补充信息（特殊设定、注意事项等）
- system_prompt: 系统提示词（指导AI如何扮演这个角色的详细指令）
- image_tags: 生图标签（英文，逗号分隔，描述角色外貌特征，用于AI绘图）

只输出 JSON，不要有其他文字。确保 JSON 格式正确可解析。''';

    final messages = [
      const ChatMessage(role: 'system', content: systemPrompt),
      ChatMessage(role: 'user', content: requirement),
    ];

    // 使用 jsonMode 设置来请求 JSON 输出
    final jsonSettings = AppSettings(
      apiBase: settings.apiBase,
      apiKey: settings.apiKey,
      model: settings.model,
      jsonMode: true,
      temperature: 0.8,
      maxTokens: settings.maxTokens,
      contextWindow: settings.contextWindow,
      streaming: false,
    );

    final result = await _llm.chatCompletion(
      settings: jsonSettings,
      messages: messages,
    );

    // 解析 JSON 结果
    try {
      final parsed = jsonDecode(result) as Map<String, dynamic>;
      return {
        'name': parsed['name']?.toString() ?? '',
        'basic_info': parsed['basic_info']?.toString() ?? '',
        'personality': parsed['personality']?.toString() ?? '',
        'scenario': parsed['scenario']?.toString() ?? '',
        'greeting': parsed['greeting']?.toString() ?? '',
        'example_dialogue': parsed['example_dialogue']?.toString() ?? '',
        'other_info': parsed['other_info']?.toString() ?? '',
        'system_prompt': parsed['system_prompt']?.toString() ?? '',
        'image_tags': parsed['image_tags']?.toString() ?? '',
      };
    } catch (_) {
      // 尝试从文本中提取 JSON
      final jsonMatch = RegExp(r'\{[\s\S]*\}').firstMatch(result);
      if (jsonMatch != null) {
        try {
          final parsed = jsonDecode(jsonMatch.group(0)!) as Map<String, dynamic>;
          return {
            'name': parsed['name']?.toString() ?? '',
            'basic_info': parsed['basic_info']?.toString() ?? '',
            'personality': parsed['personality']?.toString() ?? '',
            'scenario': parsed['scenario']?.toString() ?? '',
            'greeting': parsed['greeting']?.toString() ?? '',
            'example_dialogue': parsed['example_dialogue']?.toString() ?? '',
            'other_info': parsed['other_info']?.toString() ?? '',
            'system_prompt': parsed['system_prompt']?.toString() ?? '',
            'image_tags': parsed['image_tags']?.toString() ?? '',
          };
        } catch (_) {}
      }
      throw Exception('AI 返回的格式无法解析，请重试');
    }
  }

  void dispose() {
    _llm.dispose();
  }
}
