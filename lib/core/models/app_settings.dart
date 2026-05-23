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

  // 供应商
  final String activeProviderId;

  // 图片生成
  final ImageGenSettings imageGen;

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
    this.activeProviderId = '',
    this.imageGen = const ImageGenSettings(),
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
    String? activeProviderId,
    ImageGenSettings? imageGen,
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
      memoryTriggerIntervalEnabled: memoryTriggerIntervalEnabled ?? this.memoryTriggerIntervalEnabled,
      memoryInterval: memoryInterval ?? this.memoryInterval,
      memoryTriggerTimeEnabled: memoryTriggerTimeEnabled ?? this.memoryTriggerTimeEnabled,
      memoryTriggerTimeHours: memoryTriggerTimeHours ?? this.memoryTriggerTimeHours,
      memoryTriggerKeywordEnabled: memoryTriggerKeywordEnabled ?? this.memoryTriggerKeywordEnabled,
      memoryTriggerKeywords: memoryTriggerKeywords ?? this.memoryTriggerKeywords,
      memoryMaxInject: memoryMaxInject ?? this.memoryMaxInject,
      limitInject: limitInject ?? this.limitInject,
      theme: theme ?? this.theme,
      language: language ?? this.language,
      fontStyle: fontStyle ?? this.fontStyle,
      activeProviderId: activeProviderId ?? this.activeProviderId,
      imageGen: imageGen ?? this.imageGen,
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
    this.sdNegativePrompt = 'lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark',
    this.naiApiKey = '',
    this.naiModel = 'nai-diffusion-4-5-full',
    this.naiSampler = 'k_euler_ancestral',
    this.naiNoiseSchedule = 'karras',
    this.naiSteps = 28,
    this.naiScale = 5.5,
    this.naiCfgRescale = 0,
    this.naiWidth = 832,
    this.naiHeight = 1216,
    this.naiNegativePrompt = 'lowres, bad anatomy, bad hands, text, error, missing fingers',
    this.naiArtistTags = '',
    this.comfyuiUrl = 'http://127.0.0.1:8188',
    this.comfyuiWorkflow = '',
    this.customUrl = '',
    this.customApiKey = '',
    this.customModel = 'dall-e-3',
    this.customSize = '1024x1024',
    this.qualityTags = 'best quality, amazing quality, very aesthetic, masterpiece',
    this.autoGenerate = false,
    this.autoGenerateKeywords = '画,生图,来一张,看看',
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
      sdNegativePrompt: json['sd_negative_prompt'] as String? ?? 'lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark',
      naiApiKey: json['nai_api_key'] as String? ?? '',
      naiModel: json['nai_model'] as String? ?? 'nai-diffusion-4-5-full',
      naiSampler: json['nai_sampler'] as String? ?? 'k_euler_ancestral',
      naiNoiseSchedule: json['nai_noise_schedule'] as String? ?? 'karras',
      naiSteps: json['nai_steps'] as int? ?? 28,
      naiScale: (json['nai_scale'] as num?)?.toDouble() ?? 5.5,
      naiCfgRescale: (json['nai_cfg_rescale'] as num?)?.toDouble() ?? 0,
      naiWidth: json['nai_width'] as int? ?? 832,
      naiHeight: json['nai_height'] as int? ?? 1216,
      naiNegativePrompt: json['nai_negative_prompt'] as String? ?? 'lowres, bad anatomy, bad hands, text, error, missing fingers',
      naiArtistTags: json['nai_artist_tags'] as String? ?? '',
      comfyuiUrl: json['comfyui_url'] as String? ?? 'http://127.0.0.1:8188',
      comfyuiWorkflow: json['comfyui_workflow'] as String? ?? '',
      customUrl: json['custom_url'] as String? ?? '',
      customApiKey: json['custom_api_key'] as String? ?? '',
      customModel: json['custom_model'] as String? ?? 'dall-e-3',
      customSize: json['custom_size'] as String? ?? '1024x1024',
      qualityTags: json['quality_tags'] as String? ?? 'best quality, amazing quality, very aesthetic, masterpiece',
      autoGenerate: json['auto_generate'] as bool? ?? false,
      autoGenerateKeywords: json['auto_generate_keywords'] as String? ?? '画,生图,来一张,看看',
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
    return {
      'id': id,
      'name': name,
      'tags': tags,
    };
  }

  ArtistString copyWith({
    String? id,
    String? name,
    String? tags,
  }) {
    return ArtistString(
      id: id ?? this.id,
      name: name ?? this.name,
      tags: tags ?? this.tags,
    );
  }
}

