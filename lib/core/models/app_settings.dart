/// LumiMuse 应用设置模型 — 与 Next.js 版 Settings 接口保持一致
class AppSettings {
  // LLM 配置
  final String apiBase;
  final String apiKey;
  final String model;
  final bool jsonMode;
  final double temperature;
  final int maxTokens;
  final int contextWindow;
  final bool streaming;

  // 聊天行为
  final bool exampleDialogue;
  final bool memoryInject;
  final bool showTimestamps;

  // 记忆触发
  final bool memoryTriggerIntervalEnabled;
  final int memoryInterval;
  final bool memoryTriggerTimeEnabled;
  final int memoryTriggerTimeHours;
  final bool memoryTriggerKeywordEnabled;
  final String memoryTriggerKeywords;
  final int memoryMaxInject;
  final bool limitInject;

  // 显示
  final String theme; // 'light' / 'dark'
  final String language; // 'zh' / 'en'
  final String fontStyle; // 'wenkai' / 'system' / 'serif'
  final double fontScale;
  final bool autoResumeLastConversation;
  final String lastConversationCharacterId;
  final String lastConversationId;

  // 供应商
  final String activeProviderId;

  // 图片生成
  final ImageGenSettings imageGen;

  // 记忆引擎（对照主项目 Settings.memory_engine 嵌套对象）
  final MemoryEngineSettings memoryEngine;
  // 后台任务（记忆提取/画像/总结）专用模型；留空则回退到主聊天模型 model。
  final String memoryBackgroundModel;
  // 后台任务专用供应商 ID；留空则使用主接口的 api_base/api_key。
  final String memoryBackgroundProviderId;
  // 后台任务使用 DeepSeek 模型时关闭 thinking，避免思考内容耗尽输出 token。
  final bool disableDeepseekThinkingForBackground;

  // 画师串管理
  final List<ArtistString> artistStrings;

  const AppSettings({
    this.apiBase = '',
    this.apiKey = '',
    this.model = '',
    this.jsonMode = false,
    this.temperature = 1.0,
    this.maxTokens = 4096,
    this.contextWindow = 131072,
    this.streaming = true,
    this.exampleDialogue = true,
    this.memoryInject = true,
    this.showTimestamps = true,
    this.memoryTriggerIntervalEnabled = true,
    this.memoryInterval = 3,
    this.memoryTriggerTimeEnabled = false,
    this.memoryTriggerTimeHours = 24,
    this.memoryTriggerKeywordEnabled = true,
    this.memoryTriggerKeywords = '晚安',
    this.memoryMaxInject = 30,
    this.limitInject = false,
    this.theme = 'light',
    this.language = 'zh',
    this.fontStyle = 'wenkai',
    this.fontScale = 1.0,
    this.autoResumeLastConversation = false,
    this.lastConversationCharacterId = '',
    this.lastConversationId = '',
    this.activeProviderId = '',
    this.imageGen = const ImageGenSettings(),
    this.memoryEngine = const MemoryEngineSettings(),
    this.memoryBackgroundModel = '',
    this.memoryBackgroundProviderId = '',
    this.disableDeepseekThinkingForBackground = false,
    this.artistStrings = const [],
  });

  AppSettings copyWith({
    String? apiBase,
    String? apiKey,
    String? model,
    bool? jsonMode,
    double? temperature,
    int? maxTokens,
    int? contextWindow,
    bool? streaming,
    bool? exampleDialogue,
    bool? memoryInject,
    bool? showTimestamps,
    bool? memoryTriggerIntervalEnabled,
    int? memoryInterval,
    bool? memoryTriggerTimeEnabled,
    int? memoryTriggerTimeHours,
    bool? memoryTriggerKeywordEnabled,
    String? memoryTriggerKeywords,
    int? memoryMaxInject,
    bool? limitInject,
    String? theme,
    String? language,
    String? fontStyle,
    double? fontScale,
    bool? autoResumeLastConversation,
    String? lastConversationCharacterId,
    String? lastConversationId,
    String? activeProviderId,
    ImageGenSettings? imageGen,
    MemoryEngineSettings? memoryEngine,
    String? memoryBackgroundModel,
    String? memoryBackgroundProviderId,
    bool? disableDeepseekThinkingForBackground,
    List<ArtistString>? artistStrings,
  }) {
    return AppSettings(
      apiBase: apiBase ?? this.apiBase,
      apiKey: apiKey ?? this.apiKey,
      model: model ?? this.model,
      jsonMode: jsonMode ?? this.jsonMode,
      temperature: temperature ?? this.temperature,
      maxTokens: maxTokens ?? this.maxTokens,
      contextWindow: contextWindow ?? this.contextWindow,
      streaming: streaming ?? this.streaming,
      exampleDialogue: exampleDialogue ?? this.exampleDialogue,
      memoryInject: memoryInject ?? this.memoryInject,
      showTimestamps: showTimestamps ?? this.showTimestamps,
      memoryTriggerIntervalEnabled:
          memoryTriggerIntervalEnabled ?? this.memoryTriggerIntervalEnabled,
      memoryInterval: memoryInterval ?? this.memoryInterval,
      memoryTriggerTimeEnabled:
          memoryTriggerTimeEnabled ?? this.memoryTriggerTimeEnabled,
      memoryTriggerTimeHours:
          memoryTriggerTimeHours ?? this.memoryTriggerTimeHours,
      memoryTriggerKeywordEnabled:
          memoryTriggerKeywordEnabled ?? this.memoryTriggerKeywordEnabled,
      memoryTriggerKeywords:
          memoryTriggerKeywords ?? this.memoryTriggerKeywords,
      memoryMaxInject: memoryMaxInject ?? this.memoryMaxInject,
      limitInject: limitInject ?? this.limitInject,
      theme: theme ?? this.theme,
      language: language ?? this.language,
      fontStyle: fontStyle ?? this.fontStyle,
      fontScale: fontScale ?? this.fontScale,
      autoResumeLastConversation:
          autoResumeLastConversation ?? this.autoResumeLastConversation,
      lastConversationCharacterId:
          lastConversationCharacterId ?? this.lastConversationCharacterId,
      lastConversationId: lastConversationId ?? this.lastConversationId,
      activeProviderId: activeProviderId ?? this.activeProviderId,
      imageGen: imageGen ?? this.imageGen,
      memoryEngine: memoryEngine ?? this.memoryEngine,
      memoryBackgroundModel:
          memoryBackgroundModel ?? this.memoryBackgroundModel,
      memoryBackgroundProviderId:
          memoryBackgroundProviderId ?? this.memoryBackgroundProviderId,
      disableDeepseekThinkingForBackground:
          disableDeepseekThinkingForBackground ??
          this.disableDeepseekThinkingForBackground,
      artistStrings: artistStrings ?? this.artistStrings,
    );
  }
}

/// 图片生成设置
class ImageGenSettings {
  final bool enabled;
  final String engine; // 'sd' / 'nai' / 'comfyui' / 'custom'

  // SD WebUI
  final String sdUrl;
  final String sdModel;
  final String sdSampler;
  final int sdSteps;
  final double sdCfgScale;
  final int sdWidth;
  final int sdHeight;
  final String sdNegativePrompt;

  // NovelAI
  final String naiApiKey;
  final String naiModel;
  final String naiSampler;
  final String naiNoiseSchedule;
  final int naiSteps;
  final double naiScale;
  final double naiCfgRescale;
  final int naiWidth;
  final int naiHeight;
  final String naiNegativePrompt;
  final String naiArtistTags;

  // ComfyUI
  final String comfyuiUrl;
  final String comfyuiWorkflow;

  // 自定义 API
  final String customUrl;
  final String customApiKey;
  final String customModel;
  final String customSize;

  // 通用
  final String qualityTags;
  final bool autoGenerate;
  final String autoGenerateKeywords;
  // 内联提示词：让 AI 在聊天回复末尾用 [IMG]...[/IMG] 附带生图提示词，
  // 出图时直接复用该提示词，跳过单独的（慢速）提示词生成请求。
  // 对照主项目 `src/types/index.ts` 的 `inline_prompt` 字段。
  final bool inlinePrompt;

  const ImageGenSettings({
    this.enabled = false,
    this.engine = 'sd',
    this.sdUrl = 'http://127.0.0.1:7860',
    this.sdModel = '',
    this.sdSampler = 'DPM++ 2M Karras',
    this.sdSteps = 28,
    this.sdCfgScale = 7,
    this.sdWidth = 512,
    this.sdHeight = 768,
    this.sdNegativePrompt =
        'lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark',
    this.naiApiKey = '',
    this.naiModel = 'nai-diffusion-4-5-full',
    this.naiSampler = 'k_euler_ancestral',
    this.naiNoiseSchedule = 'karras',
    this.naiSteps = 28,
    this.naiScale = 5.5,
    this.naiCfgRescale = 0,
    this.naiWidth = 832,
    this.naiHeight = 1216,
    this.naiNegativePrompt =
        'lowres, bad anatomy, bad hands, text, error, missing fingers',
    this.naiArtistTags = '',
    this.comfyuiUrl = 'http://127.0.0.1:8188',
    this.comfyuiWorkflow = '',
    this.customUrl = '',
    this.customApiKey = '',
    this.customModel = 'dall-e-3',
    this.customSize = '1024x1024',
    this.qualityTags =
        'best quality, amazing quality, very aesthetic, masterpiece',
    this.autoGenerate = false,
    this.autoGenerateKeywords = '画,生图,来一张,看看',
    this.inlinePrompt = false,
  });

  /// 从 JSON Map 反序列化
  factory ImageGenSettings.fromJson(Map<String, dynamic> json) {
    return ImageGenSettings(
      enabled: json['enabled'] as bool? ?? false,
      engine: json['engine'] as String? ?? 'sd',
      sdUrl: json['sd_url'] as String? ?? 'http://127.0.0.1:7860',
      sdModel: json['sd_model'] as String? ?? '',
      sdSampler: json['sd_sampler'] as String? ?? 'DPM++ 2M Karras',
      sdSteps: json['sd_steps'] as int? ?? 28,
      sdCfgScale: (json['sd_cfg_scale'] as num?)?.toDouble() ?? 7,
      sdWidth: json['sd_width'] as int? ?? 512,
      sdHeight: json['sd_height'] as int? ?? 768,
      sdNegativePrompt:
          json['sd_negative_prompt'] as String? ??
          'lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark',
      naiApiKey: json['nai_api_key'] as String? ?? '',
      naiModel: json['nai_model'] as String? ?? 'nai-diffusion-4-5-full',
      naiSampler: json['nai_sampler'] as String? ?? 'k_euler_ancestral',
      naiNoiseSchedule: json['nai_noise_schedule'] as String? ?? 'karras',
      naiSteps: json['nai_steps'] as int? ?? 28,
      naiScale: (json['nai_scale'] as num?)?.toDouble() ?? 5.5,
      naiCfgRescale: (json['nai_cfg_rescale'] as num?)?.toDouble() ?? 0,
      naiWidth: json['nai_width'] as int? ?? 832,
      naiHeight: json['nai_height'] as int? ?? 1216,
      naiNegativePrompt:
          json['nai_negative_prompt'] as String? ??
          'lowres, bad anatomy, bad hands, text, error, missing fingers',
      naiArtistTags: json['nai_artist_tags'] as String? ?? '',
      comfyuiUrl: json['comfyui_url'] as String? ?? 'http://127.0.0.1:8188',
      comfyuiWorkflow: json['comfyui_workflow'] as String? ?? '',
      customUrl: json['custom_url'] as String? ?? '',
      customApiKey: json['custom_api_key'] as String? ?? '',
      customModel: json['custom_model'] as String? ?? 'dall-e-3',
      customSize: json['custom_size'] as String? ?? '1024x1024',
      qualityTags:
          json['quality_tags'] as String? ??
          'best quality, amazing quality, very aesthetic, masterpiece',
      autoGenerate: json['auto_generate'] as bool? ?? false,
      autoGenerateKeywords:
          json['auto_generate_keywords'] as String? ?? '画,生图,来一张,看看',
      inlinePrompt: json['inline_prompt'] as bool? ?? false,
    );
  }

  /// 序列化为 JSON Map
  Map<String, dynamic> toJson() {
    return {
      'enabled': enabled,
      'engine': engine,
      'sd_url': sdUrl,
      'sd_model': sdModel,
      'sd_sampler': sdSampler,
      'sd_steps': sdSteps,
      'sd_cfg_scale': sdCfgScale,
      'sd_width': sdWidth,
      'sd_height': sdHeight,
      'sd_negative_prompt': sdNegativePrompt,
      'nai_api_key': naiApiKey,
      'nai_model': naiModel,
      'nai_sampler': naiSampler,
      'nai_noise_schedule': naiNoiseSchedule,
      'nai_steps': naiSteps,
      'nai_scale': naiScale,
      'nai_cfg_rescale': naiCfgRescale,
      'nai_width': naiWidth,
      'nai_height': naiHeight,
      'nai_negative_prompt': naiNegativePrompt,
      'nai_artist_tags': naiArtistTags,
      'comfyui_url': comfyuiUrl,
      'comfyui_workflow': comfyuiWorkflow,
      'custom_url': customUrl,
      'custom_api_key': customApiKey,
      'custom_model': customModel,
      'custom_size': customSize,
      'quality_tags': qualityTags,
      'auto_generate': autoGenerate,
      'auto_generate_keywords': autoGenerateKeywords,
      'inline_prompt': inlinePrompt,
    };
  }

  /// 创建副本并覆盖指定字段
  ImageGenSettings copyWith({
    bool? enabled,
    String? engine,
    String? sdUrl,
    String? sdModel,
    String? sdSampler,
    int? sdSteps,
    double? sdCfgScale,
    int? sdWidth,
    int? sdHeight,
    String? sdNegativePrompt,
    String? naiApiKey,
    String? naiModel,
    String? naiSampler,
    String? naiNoiseSchedule,
    int? naiSteps,
    double? naiScale,
    double? naiCfgRescale,
    int? naiWidth,
    int? naiHeight,
    String? naiNegativePrompt,
    String? naiArtistTags,
    String? comfyuiUrl,
    String? comfyuiWorkflow,
    String? customUrl,
    String? customApiKey,
    String? customModel,
    String? customSize,
    String? qualityTags,
    bool? autoGenerate,
    String? autoGenerateKeywords,
    bool? inlinePrompt,
  }) {
    return ImageGenSettings(
      enabled: enabled ?? this.enabled,
      engine: engine ?? this.engine,
      sdUrl: sdUrl ?? this.sdUrl,
      sdModel: sdModel ?? this.sdModel,
      sdSampler: sdSampler ?? this.sdSampler,
      sdSteps: sdSteps ?? this.sdSteps,
      sdCfgScale: sdCfgScale ?? this.sdCfgScale,
      sdWidth: sdWidth ?? this.sdWidth,
      sdHeight: sdHeight ?? this.sdHeight,
      sdNegativePrompt: sdNegativePrompt ?? this.sdNegativePrompt,
      naiApiKey: naiApiKey ?? this.naiApiKey,
      naiModel: naiModel ?? this.naiModel,
      naiSampler: naiSampler ?? this.naiSampler,
      naiNoiseSchedule: naiNoiseSchedule ?? this.naiNoiseSchedule,
      naiSteps: naiSteps ?? this.naiSteps,
      naiScale: naiScale ?? this.naiScale,
      naiCfgRescale: naiCfgRescale ?? this.naiCfgRescale,
      naiWidth: naiWidth ?? this.naiWidth,
      naiHeight: naiHeight ?? this.naiHeight,
      naiNegativePrompt: naiNegativePrompt ?? this.naiNegativePrompt,
      naiArtistTags: naiArtistTags ?? this.naiArtistTags,
      comfyuiUrl: comfyuiUrl ?? this.comfyuiUrl,
      comfyuiWorkflow: comfyuiWorkflow ?? this.comfyuiWorkflow,
      customUrl: customUrl ?? this.customUrl,
      customApiKey: customApiKey ?? this.customApiKey,
      customModel: customModel ?? this.customModel,
      customSize: customSize ?? this.customSize,
      qualityTags: qualityTags ?? this.qualityTags,
      autoGenerate: autoGenerate ?? this.autoGenerate,
      autoGenerateKeywords: autoGenerateKeywords ?? this.autoGenerateKeywords,
      inlinePrompt: inlinePrompt ?? this.inlinePrompt,
    );
  }
}

/// 画师串预设模型
class ArtistString {
  final String id;
  final String name;
  final String tags;

  const ArtistString({
    required this.id,
    required this.name,
    required this.tags,
  });

  factory ArtistString.fromJson(Map<String, dynamic> json) {
    return ArtistString(
      id: json['id'] as String? ?? '',
      name: json['name'] as String? ?? '',
      tags: json['tags'] as String? ?? '',
    );
  }

  Map<String, dynamic> toJson() {
    return {'id': id, 'name': name, 'tags': tags};
  }

  ArtistString copyWith({String? id, String? name, String? tags}) {
    return ArtistString(
      id: id ?? this.id,
      name: name ?? this.name,
      tags: tags ?? this.tags,
    );
  }
}

/// 记忆引擎设置 — 对照主项目 `src/types/index.ts` 的 `MemoryEngineSettings`
/// 接口与 `DEFAULT_MEMORY_ENGINE_SETTINGS` 默认值。
///
/// 字段命名使用 camelCase（Dart 风格），[toJson]/[fromJson] 时转为
/// snake_case 对齐主项目 DB key。
class MemoryEngineSettings {
  final bool enabled;
  final bool allowMemoryContextInChat;
  final bool allowExternalMemoryPayloads;
  final String retrievalMode; // 'local' / 'hybrid' / 'vector'
  final bool embeddingEnabled;
  final String embeddingApiBase;
  final String embeddingApiKey; // 走 SecretStorage
  final String embeddingModel;
  final int embeddingDimension;
  final bool rerankerEnabled;
  final String rerankerApiBase;
  final String rerankerApiKey; // 走 SecretStorage
  final String rerankerModel;
  final bool fallbackLocalEnabled;
  final int memoryPackageTokenBudget;
  final int retrievalTokenBudget;
  final int vectorTopK;
  final int keywordTopK;
  final int rerankerTopK;
  final int finalTopK;
  final int embeddingTimeoutMs;
  final int rerankerTimeoutMs;
  final int totalRetrievalTimeoutMs;

  const MemoryEngineSettings({
    this.enabled = false,
    this.allowMemoryContextInChat = true,
    this.allowExternalMemoryPayloads = true,
    this.retrievalMode = 'local',
    this.embeddingEnabled = false,
    this.embeddingApiBase = '',
    this.embeddingApiKey = '',
    this.embeddingModel = '',
    this.embeddingDimension = 0,
    this.rerankerEnabled = false,
    this.rerankerApiBase = '',
    this.rerankerApiKey = '',
    this.rerankerModel = '',
    this.fallbackLocalEnabled = true,
    this.memoryPackageTokenBudget = 12000,
    this.retrievalTokenBudget = 8000,
    this.vectorTopK = 80,
    this.keywordTopK = 20,
    this.rerankerTopK = 40,
    this.finalTopK = 30,
    this.embeddingTimeoutMs = 1500,
    this.rerankerTimeoutMs = 2000,
    this.totalRetrievalTimeoutMs = 2500,
  });

  /// 从 JSON Map 反序列化（key 为 snake_case，对齐主项目 DB key）。
  factory MemoryEngineSettings.fromJson(Map<String, dynamic> json) {
    return MemoryEngineSettings(
      enabled: json['enabled'] as bool? ?? false,
      allowMemoryContextInChat:
          json['allow_memory_context_in_chat'] as bool? ?? true,
      allowExternalMemoryPayloads:
          json['allow_external_memory_payloads'] as bool? ?? true,
      retrievalMode: json['retrieval_mode'] as String? ?? 'local',
      embeddingEnabled: json['embedding_enabled'] as bool? ?? false,
      embeddingApiBase: json['embedding_api_base'] as String? ?? '',
      embeddingApiKey: json['embedding_api_key'] as String? ?? '',
      embeddingModel: json['embedding_model'] as String? ?? '',
      embeddingDimension: json['embedding_dimension'] as int? ?? 0,
      rerankerEnabled: json['reranker_enabled'] as bool? ?? false,
      rerankerApiBase: json['reranker_api_base'] as String? ?? '',
      rerankerApiKey: json['reranker_api_key'] as String? ?? '',
      rerankerModel: json['reranker_model'] as String? ?? '',
      fallbackLocalEnabled: json['fallback_local_enabled'] as bool? ?? true,
      memoryPackageTokenBudget:
          json['memory_package_token_budget'] as int? ?? 12000,
      retrievalTokenBudget: json['retrieval_token_budget'] as int? ?? 8000,
      vectorTopK: json['vector_top_k'] as int? ?? 80,
      keywordTopK: json['keyword_top_k'] as int? ?? 20,
      rerankerTopK: json['reranker_top_k'] as int? ?? 40,
      finalTopK: json['final_top_k'] as int? ?? 30,
      embeddingTimeoutMs: json['embedding_timeout_ms'] as int? ?? 1500,
      rerankerTimeoutMs: json['reranker_timeout_ms'] as int? ?? 2000,
      totalRetrievalTimeoutMs:
          json['total_retrieval_timeout_ms'] as int? ?? 2500,
    );
  }

  /// 序列化为 JSON Map（key 为 snake_case，对齐主项目 DB key）。
  Map<String, dynamic> toJson() {
    return {
      'enabled': enabled,
      'allow_memory_context_in_chat': allowMemoryContextInChat,
      'allow_external_memory_payloads': allowExternalMemoryPayloads,
      'retrieval_mode': retrievalMode,
      'embedding_enabled': embeddingEnabled,
      'embedding_api_base': embeddingApiBase,
      'embedding_api_key': embeddingApiKey,
      'embedding_model': embeddingModel,
      'embedding_dimension': embeddingDimension,
      'reranker_enabled': rerankerEnabled,
      'reranker_api_base': rerankerApiBase,
      'reranker_api_key': rerankerApiKey,
      'reranker_model': rerankerModel,
      'fallback_local_enabled': fallbackLocalEnabled,
      'memory_package_token_budget': memoryPackageTokenBudget,
      'retrieval_token_budget': retrievalTokenBudget,
      'vector_top_k': vectorTopK,
      'keyword_top_k': keywordTopK,
      'reranker_top_k': rerankerTopK,
      'final_top_k': finalTopK,
      'embedding_timeout_ms': embeddingTimeoutMs,
      'reranker_timeout_ms': rerankerTimeoutMs,
      'total_retrieval_timeout_ms': totalRetrievalTimeoutMs,
    };
  }

  /// 创建副本并覆盖指定字段。
  MemoryEngineSettings copyWith({
    bool? enabled,
    bool? allowMemoryContextInChat,
    bool? allowExternalMemoryPayloads,
    String? retrievalMode,
    bool? embeddingEnabled,
    String? embeddingApiBase,
    String? embeddingApiKey,
    String? embeddingModel,
    int? embeddingDimension,
    bool? rerankerEnabled,
    String? rerankerApiBase,
    String? rerankerApiKey,
    String? rerankerModel,
    bool? fallbackLocalEnabled,
    int? memoryPackageTokenBudget,
    int? retrievalTokenBudget,
    int? vectorTopK,
    int? keywordTopK,
    int? rerankerTopK,
    int? finalTopK,
    int? embeddingTimeoutMs,
    int? rerankerTimeoutMs,
    int? totalRetrievalTimeoutMs,
  }) {
    return MemoryEngineSettings(
      enabled: enabled ?? this.enabled,
      allowMemoryContextInChat:
          allowMemoryContextInChat ?? this.allowMemoryContextInChat,
      allowExternalMemoryPayloads:
          allowExternalMemoryPayloads ?? this.allowExternalMemoryPayloads,
      retrievalMode: retrievalMode ?? this.retrievalMode,
      embeddingEnabled: embeddingEnabled ?? this.embeddingEnabled,
      embeddingApiBase: embeddingApiBase ?? this.embeddingApiBase,
      embeddingApiKey: embeddingApiKey ?? this.embeddingApiKey,
      embeddingModel: embeddingModel ?? this.embeddingModel,
      embeddingDimension: embeddingDimension ?? this.embeddingDimension,
      rerankerEnabled: rerankerEnabled ?? this.rerankerEnabled,
      rerankerApiBase: rerankerApiBase ?? this.rerankerApiBase,
      rerankerApiKey: rerankerApiKey ?? this.rerankerApiKey,
      rerankerModel: rerankerModel ?? this.rerankerModel,
      fallbackLocalEnabled: fallbackLocalEnabled ?? this.fallbackLocalEnabled,
      memoryPackageTokenBudget:
          memoryPackageTokenBudget ?? this.memoryPackageTokenBudget,
      retrievalTokenBudget: retrievalTokenBudget ?? this.retrievalTokenBudget,
      vectorTopK: vectorTopK ?? this.vectorTopK,
      keywordTopK: keywordTopK ?? this.keywordTopK,
      rerankerTopK: rerankerTopK ?? this.rerankerTopK,
      finalTopK: finalTopK ?? this.finalTopK,
      embeddingTimeoutMs: embeddingTimeoutMs ?? this.embeddingTimeoutMs,
      rerankerTimeoutMs: rerankerTimeoutMs ?? this.rerankerTimeoutMs,
      totalRetrievalTimeoutMs:
          totalRetrievalTimeoutMs ?? this.totalRetrievalTimeoutMs,
    );
  }
}
