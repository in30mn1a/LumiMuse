// 内联生图提示词（inline image prompt）— 与主项目
// `src/lib/inline-image-prompt.ts` 逐字对齐。
//
// 思路：让聊天模型在正常回复的末尾，用 [IMG]...[/IMG] 包裹一段 danbooru 风格的
// 生图提示词。聊天本身是流式且很快的，相当于「顺风车」捎带把提示词生成了，
// 出图时直接复用，免去单独调用慢速的 image-gen/prompt（推理模型生成数千 token
// 要等数十秒）。
//
// 约定：
// - 标记用 [IMG] / [/IMG]，大小写不敏感
// - 提示词为英文 danbooru tag，逗号分隔
// - 提取后会从正文中剥离，保证上下文 / 记忆 / token 统计干净，前端也不展示该块

/// 匹配 [IMG]...[/IMG] 块（含标记本身），大小写不敏感、跨行、非贪婪。
///
/// Dart RegExp 用 `caseSensitive: false` 对应 JS 的 `/i` 标志，
/// `[\s\S]` 用于跨行匹配任意字符（含换行）。
final RegExp _kInlineImgBlock =
    RegExp(r'\[IMG\]([\s\S]*?)\[/IMG\]', caseSensitive: false);

/// 流式过程中可能只输出了开头的 [IMG 而尚未闭合，用于实时隐藏未闭合的尾巴。
final RegExp _kInlineImgOpenTail =
    RegExp(r'\[IMG\b[\s\S]*$', caseSensitive: false);

/// 仅匹配 `[IMG` 开头（不含闭合），用于判断是否残留未闭合尾巴。
final RegExp _kInlineImgOpenPrefix = RegExp(r'\[IMG\b', caseSensitive: false);

/// 内联生图提示词的指令文本。
///
/// 重要：经实测，deepseek 等模型把该指令放在 system prompt 里时，会被角色长人设 +
/// 「回复必须是纯粹角色对话内容」约束 + 历史回复惯性压制，输出极不稳定（常常不输出）。
/// 把它作为**最后一条 user 消息的尾部追加**，约束力最强，可稳定触发。
///
/// 该指令只在发给模型的请求里临时追加，绝不落库 —— 否则会污染对话记录、记忆提取与
/// 前端显示。
///
/// 措辞经实测调校：保持单段紧凑（指令过长模型会整段忽略），但明确「不少于 35 个标签」+
/// 六个覆盖维度，以保证 tag 数量充足。开头「系统附加要求…不算跳出角色」用于压过角色
/// 人设里「回复必须是纯粹角色对话内容」之类的强约束。
///
/// [imageTags] 角色固定外貌标签，要求模型务必包含，保证人物外观一致
/// [userImageTags] 用户本人外貌标签，仅当用户出现在画面中时才包含（单人/独白场景忽略）
String buildInlinePromptInstruction({
  String? imageTags,
  String? userImageTags,
}) {
  final tagPart = (imageTags != null && imageTags.trim().isNotEmpty)
      ? '，且必须含固定外貌标签：${imageTags.trim()}'
      : '';
  final userPart = (userImageTags != null && userImageTags.trim().isNotEmpty)
      ? '；若本条画面中出现用户本人（非单人/独白场景），需包含用户外貌标签：${userImageTags.trim()}（用户未出场则忽略）'
      : '';
  return '（系统附加要求，务必执行，不算跳出角色）在以上角色对话正文之后，另起一行追加一段英文 danbooru 文生图标签串，用 [IMG] 和 [/IMG] 包裹，描述本条回复对应的画面。要求：不少于 35 个标签，英文逗号分隔；依次覆盖【画面构成】(分级 sfw/nsfw、人数如 1girl、画幅、视角、镜头)、【外貌】(发型发色瞳色体型$tagPart$userPart)、【服饰】(逐件列出)、【动作】(贴合本条剧情)、【表情】(视线情绪面部细节)、【场景】(地点环境时间光影)；第三人称、禁止 pov；[IMG] 块只出现一次放最后；正文不要提及标签；无论对话长短都不要省略。';
}

/// 从完整回复文本中提取内联提示词。
///
/// 返回 prompt 为提取到的提示词（去除标记、trim），未找到则为空串。
String extractInlinePrompt(String text) {
  final m = _kInlineImgBlock.firstMatch(text);
  if (m == null) return '';
  return m.group(1)?.trim() ?? '';
}

/// 从文本中剥离 [IMG]...[/IMG] 块，返回干净的正文。
///
/// 同时处理流式中途「只有开头标记、尚未闭合」的情况，避免半截标记闪现给用户。
/// 最后去掉尾部空白，与主项目 `replace(/\s+$/,'')` 一致。
String stripInlinePrompt(String text) {
  // 先去掉所有已闭合的 [IMG]...[/IMG] 块
  String result = text.replaceAll(_kInlineImgBlock, '');
  // 已闭合的块去掉后，若仍残留未闭合的 [IMG...（流式中间态），一并去掉尾部。
  // 与主项目一致：先用块正则 test（false 表示无闭合块），再用前缀正则判断是否还有 [IMG。
  if (!_kInlineImgBlock.hasMatch(result) &&
      _kInlineImgOpenPrefix.hasMatch(result)) {
    result = result.replaceAll(_kInlineImgOpenTail, '');
  }
  // 去掉尾部空白（不改变中间内容）
  return result.replaceFirst(RegExp(r'\s+$'), '');
}
