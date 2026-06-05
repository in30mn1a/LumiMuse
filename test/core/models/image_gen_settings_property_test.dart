// 图片生成设置属性测试
// Feature: flutter-core-features, Task 5.4 & 5.5
// Property 5: Settings persistence round-trip
// Property 6: Engine switch preserves parameters
// Validates: Requirements 2.9, 2.11

import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, test, group;
import 'package:lumimuse/core/models/app_settings.dart';

void main() {
  group('Property 5: Settings persistence round-trip (ImageGenSettings)', () {
    Glados<String>(any.choose(['sd', 'nai', 'comfyui', 'custom'])).test(
      '任意引擎值：toJson → fromJson 往返保持 engine 一致',
      (engine) {
        final original = ImageGenSettings(engine: engine);
        final json = original.toJson();
        final restored = ImageGenSettings.fromJson(json);
        expect(restored.engine, original.engine);
      },
    );

    Glados<bool>(any.bool).test(
      '任意 enabled 值：toJson → fromJson 往返保持一致',
      (enabled) {
        final original = ImageGenSettings(enabled: enabled);
        final json = original.toJson();
        final restored = ImageGenSettings.fromJson(json);
        expect(restored.enabled, original.enabled);
      },
    );

    Glados<int>(any.intInRange(1, 150)).test(
      '任意 sdSteps 值：toJson → fromJson 往返保持一致',
      (steps) {
        final original = ImageGenSettings(sdSteps: steps);
        final json = original.toJson();
        final restored = ImageGenSettings.fromJson(json);
        expect(restored.sdSteps, original.sdSteps);
      },
    );

    Glados<int>(any.intInRange(64, 2048)).test(
      '任意 sdWidth 值：toJson → fromJson 往返保持一致',
      (width) {
        final original = ImageGenSettings(sdWidth: width);
        final json = original.toJson();
        final restored = ImageGenSettings.fromJson(json);
        expect(restored.sdWidth, original.sdWidth);
      },
    );

    Glados<int>(any.intInRange(64, 2048)).test(
      '任意 sdHeight 值：toJson → fromJson 往返保持一致',
      (height) {
        final original = ImageGenSettings(sdHeight: height);
        final json = original.toJson();
        final restored = ImageGenSettings.fromJson(json);
        expect(restored.sdHeight, original.sdHeight);
      },
    );

    test('完整 ImageGenSettings 往返序列化保持所有字段一致', () {
      const original = ImageGenSettings(
        enabled: true,
        engine: 'nai',
        sdUrl: 'http://custom:7860',
        sdModel: 'my-model',
        sdSampler: 'Euler a',
        sdSteps: 40,
        sdCfgScale: 12.5,
        sdWidth: 1024,
        sdHeight: 1024,
        sdNegativePrompt: 'bad quality',
        naiApiKey: 'sk-test-key',
        naiModel: 'nai-diffusion-3',
        naiSampler: 'k_dpmpp_2m',
        naiNoiseSchedule: 'native',
        naiSteps: 50,
        naiScale: 7.0,
        naiCfgRescale: 0.5,
        naiWidth: 1024,
        naiHeight: 1536,
        naiNegativePrompt: 'lowres',
        naiArtistTags: 'artist1, artist2',
        comfyuiUrl: 'http://comfy:8188',
        comfyuiWorkflow: '{"nodes":[]}',
        customUrl: 'https://api.custom.com/v1',
        customApiKey: 'custom-key',
        customModel: 'flux-1',
        customSize: '1792x1024',
        qualityTags: 'masterpiece, best quality',
        autoGenerate: true,
        autoGenerateKeywords: '画,来一张',
      );

      final json = original.toJson();
      final restored = ImageGenSettings.fromJson(json);

      expect(restored.enabled, original.enabled);
      expect(restored.engine, original.engine);
      expect(restored.sdUrl, original.sdUrl);
      expect(restored.sdModel, original.sdModel);
      expect(restored.sdSampler, original.sdSampler);
      expect(restored.sdSteps, original.sdSteps);
      expect(restored.sdCfgScale, original.sdCfgScale);
      expect(restored.sdWidth, original.sdWidth);
      expect(restored.sdHeight, original.sdHeight);
      expect(restored.sdNegativePrompt, original.sdNegativePrompt);
      expect(restored.naiApiKey, original.naiApiKey);
      expect(restored.naiModel, original.naiModel);
      expect(restored.naiSampler, original.naiSampler);
      expect(restored.naiNoiseSchedule, original.naiNoiseSchedule);
      expect(restored.naiSteps, original.naiSteps);
      expect(restored.naiScale, original.naiScale);
      expect(restored.naiCfgRescale, original.naiCfgRescale);
      expect(restored.naiWidth, original.naiWidth);
      expect(restored.naiHeight, original.naiHeight);
      expect(restored.naiNegativePrompt, original.naiNegativePrompt);
      expect(restored.naiArtistTags, original.naiArtistTags);
      expect(restored.comfyuiUrl, original.comfyuiUrl);
      expect(restored.comfyuiWorkflow, original.comfyuiWorkflow);
      expect(restored.customUrl, original.customUrl);
      expect(restored.customApiKey, original.customApiKey);
      expect(restored.customModel, original.customModel);
      expect(restored.customSize, original.customSize);
      expect(restored.qualityTags, original.qualityTags);
      expect(restored.autoGenerate, original.autoGenerate);
      expect(restored.autoGenerateKeywords, original.autoGenerateKeywords);
    });

    test('fromJson 对缺失字段使用默认值', () {
      final restored = ImageGenSettings.fromJson({});

      const defaults = ImageGenSettings();
      expect(restored.enabled, defaults.enabled);
      expect(restored.engine, defaults.engine);
      expect(restored.sdUrl, defaults.sdUrl);
      expect(restored.sdSteps, defaults.sdSteps);
      expect(restored.naiModel, defaults.naiModel);
      expect(restored.qualityTags, defaults.qualityTags);
    });
  });

  group('Property 6: Engine switch preserves parameters', () {
    Glados2<String, String>(
      any.choose(['sd', 'nai', 'comfyui', 'custom']),
      any.choose(['sd', 'nai', 'comfyui', 'custom']),
    ).test(
      '切换引擎时，其他引擎的参数值保持不变',
      (fromEngine, toEngine) {
        // 设置初始状态：所有引擎都有自定义参数
        const settings = ImageGenSettings(
          engine: 'sd',
          sdUrl: 'http://my-sd:7860',
          sdSteps: 42,
          naiApiKey: 'my-nai-key',
          naiSteps: 35,
          comfyuiUrl: 'http://my-comfy:8188',
          customUrl: 'https://my-api.com',
        );

        // 模拟引擎切换：只改变 engine 字段
        final switched = settings.copyWith(engine: toEngine);

        // 验证所有引擎参数保持不变
        expect(switched.sdUrl, settings.sdUrl,
            reason: 'SD URL 应在引擎切换后保持不变');
        expect(switched.sdSteps, settings.sdSteps,
            reason: 'SD steps 应在引擎切换后保持不变');
        expect(switched.naiApiKey, settings.naiApiKey,
            reason: 'NAI API key 应在引擎切换后保持不变');
        expect(switched.naiSteps, settings.naiSteps,
            reason: 'NAI steps 应在引擎切换后保持不变');
        expect(switched.comfyuiUrl, settings.comfyuiUrl,
            reason: 'ComfyUI URL 应在引擎切换后保持不变');
        expect(switched.customUrl, settings.customUrl,
            reason: 'Custom URL 应在引擎切换后保持不变');

        // 只有 engine 字段改变
        expect(switched.engine, toEngine);
      },
    );

    test('copyWith 只修改指定字段，其余保持不变', () {
      const original = ImageGenSettings(
        enabled: true,
        engine: 'sd',
        sdSteps: 28,
        naiSteps: 28,
        qualityTags: 'masterpiece',
      );

      final modified = original.copyWith(engine: 'nai', naiSteps: 50);

      expect(modified.engine, 'nai');
      expect(modified.naiSteps, 50);
      // 未修改的字段保持不变
      expect(modified.enabled, true);
      expect(modified.sdSteps, 28);
      expect(modified.qualityTags, 'masterpiece');
    });

    test('连续多次 copyWith 不丢失数据', () {
      const original = ImageGenSettings();

      final step1 = original.copyWith(engine: 'sd', sdSteps: 40);
      final step2 = step1.copyWith(engine: 'nai', naiSteps: 35);
      final step3 = step2.copyWith(engine: 'comfyui', comfyuiUrl: 'http://new:8188');
      final step4 = step3.copyWith(engine: 'sd'); // 切回 SD

      // 所有之前设置的值都应保留
      expect(step4.sdSteps, 40);
      expect(step4.naiSteps, 35);
      expect(step4.comfyuiUrl, 'http://new:8188');
      expect(step4.engine, 'sd');
    });
  });
}
