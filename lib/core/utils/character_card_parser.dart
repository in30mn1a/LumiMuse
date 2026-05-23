// 第三方角色卡解析器
// 支持 Chara Card v2 格式和 LumiMuse 备份格式，统一解析为字段映射

/// 角色卡解析工具类 — 纯静态方法，无需实例化
class CharacterCardParser {
  CharacterCardParser._(); // 禁止实例化

  /// 所有输出 map 中应包含的字段 key
  static const List<String> expectedKeys = [
    'name',
    'avatar_url',
    'basic_info',
    'personality',
    'scenario',
    'greeting',
    'example_dialogue',
    'system_prompt',
    'other_info',
    'image_tags',
  ];

  /// 判断是否为 LumiMuse 备份格式
  ///
  /// 检测是否包含 character / characters / conversations / memories / settings 顶层字段
  static bool isLumiMuseBackup(Map<String, dynamic> payload) {
    return payload.containsKey('character') ||
        payload.containsKey('characters') ||
        payload.containsKey('conversations') ||
        payload.containsKey('memories') ||
        payload.containsKey('settings');
  }

  /// 解析角色卡 JSON，返回统一字段映射
  ///
  /// 支持两种格式：
  /// 1. LumiMuse 格式 — 直接提取 character 对象或根对象中的字段
  /// 2. Chara Card v2 格式 — 从 data.* 字段映射
  ///
  /// 返回 null 表示格式无法识别（缺少必要的 name 字段）
  static Map<String, String>? normalize(Map<String, dynamic> payload) {
    // 优先尝试 LumiMuse 格式
    final lumimuseCharacter = _asRecord(payload['character']) ?? payload;
    final lumiName = _text(lumimuseCharacter['name']);
    if (lumiName.isNotEmpty) {
      return {
        'name': lumiName,
        'avatar_url': _firstText([
          lumimuseCharacter['avatar_url'],
          lumimuseCharacter['avatar'],
        ]),
        'basic_info': _text(lumimuseCharacter['basic_info']),
        'personality': _text(lumimuseCharacter['personality']),
        'scenario': _text(lumimuseCharacter['scenario']),
        'greeting': _text(lumimuseCharacter['greeting']),
        'example_dialogue': _text(lumimuseCharacter['example_dialogue']),
        'system_prompt': _text(lumimuseCharacter['system_prompt']),
        'other_info': _text(lumimuseCharacter['other_info']),
        'image_tags': _text(lumimuseCharacter['image_tags']),
      };
    }

    // 尝试 Chara Card v2 格式
    final data = _asRecord(payload['data']);
    if (data == null) return null;

    final dataName = _text(data['name']);
    if (dataName.isEmpty) return null;

    return {
      'name': dataName,
      'avatar_url': _firstText([data['avatar'], data['avatar_url']]),
      'basic_info': joinSections([
        ('角色描述', _text(data['description'])),
      ]),
      'personality': _text(data['personality']),
      'scenario': _text(data['scenario']),
      'greeting': _firstText([data['first_mes'], data['greeting']]),
      'example_dialogue':
          _firstText([data['mes_example'], data['example_dialogue']]),
      'system_prompt': _text(data['system_prompt']),
      'other_info': joinSections([
        ('创作者', _text(data['creator'])),
        ('版本', _text(data['character_version'])),
        ('历史后置指令', _text(data['post_history_instructions'])),
        ('作者备注', _text(data['creator_notes'])),
      ]),
      'image_tags': _tagsToText(data['tags']),
    };
  }

  /// 合并多段文本为"【标题】\n内容"格式
  ///
  /// 过滤掉内容为空的段落，各段之间用双换行分隔
  static String joinSections(List<(String, String)> sections) {
    return sections
        .where((section) => section.$2.trim().isNotEmpty)
        .map((section) => '【${section.$1}】\n${section.$2.trim()}')
        .join('\n\n');
  }

  // ─── 内部辅助方法 ───

  /// 安全地将 dynamic 转为 `Map<String, dynamic>`
  static Map<String, dynamic>? _asRecord(dynamic value) {
    if (value is Map<String, dynamic>) return value;
    if (value is Map) {
      return value.map((k, v) => MapEntry(k.toString(), v));
    }
    return null;
  }

  /// 安全地将 dynamic 转为 String（非字符串返回空串）
  static String _text(dynamic value) {
    return value is String ? value : '';
  }

  /// 从多个候选值中取第一个非空字符串
  static String _firstText(List<dynamic> values) {
    for (final v in values) {
      final s = _text(v);
      if (s.trim().isNotEmpty) return s;
    }
    return '';
  }

  /// 将 tags 转为文本
  ///
  /// 如果是 List，用 ", " 连接非空字符串元素；
  /// 如果是 String，直接返回
  static String _tagsToText(dynamic value) {
    if (value is List) {
      return value
          .where((item) => item is String && item.trim().isNotEmpty)
          .map((item) => (item as String).trim())
          .join(', ');
    }
    return _text(value);
  }
}
