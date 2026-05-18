// Feature: flutter-parity-completion, Property 5: NAI 参数集随模型名变化
// Feature: flutter-parity-completion, Property 6: seed 与 extra_noise_seed 范围
//
// **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5**
//
// 用 `package:glados` 生成 `(cfg, model)`，断言 v4 字段集合按
// `model.contains('4')` 与 `model.contains('4-5') || model.contains('4.5')`
// 两个条件分支正确开关；并对 seed / extra_noise_seed 的取值范围做属性测试，
// 最后用 `nai-diffusion-4-5-curated-preview` 例测覆盖 v4 全部字段与
// `skip_cfg_above_sigma=null` 同时存在的语义。
//
// 与 Node.js 端 `src/app/api/image-gen/route.ts` 的 NovelAI parameters
// 构造逻辑对齐，详见 design.md「P1 / R2」。
//
// 设计原则（参见 tasks.md 4.2 / 4.3 / 4.4）：
// - `_buildNaiParameters` 是私有方法，通过 `@visibleForTesting` 别名
//   `ImageGenService.buildNaiParametersForTesting` 暴露给测试，避免在
//   线上调用方与测试调用方之间产生第二份分支逻辑。
// - 模型名只取一组覆盖性样本，让 glados 在 100 次迭代内同时探查
//   「不含 '4'」「含 '4' 但不含 '4-5' / '4.5'」「含 '4-5'」「含 '4.5'」四个分支。
// - 默认 100 次迭代（glados ExploreConfig 默认值）。

import 'dart:math' as math;

import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test;
import 'package:lumimuse/core/models/app_settings.dart';
import 'package:lumimuse/core/services/image_gen_service.dart';

/// v4 模型必须写入的 8 个专属字段（与 design.md「P1 / R2」对齐）。
///
/// 不含 `seed` / `extra_noise_seed`（始终写入，对所有 NAI 请求都生效）。
/// 不含 `skip_cfg_above_sigma`（仅 v4.5 写入，单独断言）。
const List<String> _kV4Fields = <String>[
  'params_version',
  'legacy',
  'prefer_brownian',
  'quality_toggle',
  'autoSmea',
  'dynamic_thresholding',
  'v4_prompt',
  'v4_negative_prompt',
];

/// 模型名候选样本：刻意覆盖四个分支。
///
/// - 不含 '4'：v3 / 其它后端 / 空串 / 任意字符串。
/// - 含 '4' 但不含 '4-5' 与 '4.5'：v4 base 模型 / 仅含数字 4 的字符串。
/// - 含 '4-5'：v4.5 系列模型（NAI 官方写法）。
/// - 含 '4.5'：v4.5 小数点写法（向前兼容）。
const List<String> _kModelSamples = <String>[
  // 不含 '4'
  'nai-diffusion-3',
  'nai-diffusion-2',
  'stable-diffusion',
  '',
  'foo-bar',
  // 含 '4' 但不含 '4-5' / '4.5'
  'nai-diffusion-4',
  'nai-diffusion-4-curated-preview',
  'nai-diffusion-4-full',
  'foo4bar',
  // 含 '4-5'
  'nai-diffusion-4-5-curated-preview',
  'nai-diffusion-4-5-full',
  'foo-4-5-bar',
  // 含 '4.5'
  'nai-diffusion-4.5',
  'foo-4.5-bar',
];

/// 仅覆写 `naiModel`，其它字段全部取默认值。
///
/// `_buildNaiParameters` 的分支判定只看 `naiModel`，其它字段（width / height /
/// scale 等）只是被透传到结果 Map，不影响 v4 / v4.5 字段开关。
ImageGenSettings _makeCfg(String model) =>
    const ImageGenSettings().copyWith(naiModel: model);

void main() {
  _registerProperty5();
  _registerProperty6();
  _registerNaiV45ExampleTest();
}

// ──────────────────────────────────────────────────────────────────────────
// Property 5: NAI 参数集随模型名变化（Validates: Requirements 2.1, 2.2, 2.3）
// ──────────────────────────────────────────────────────────────────────────

void _registerProperty5() {
  group('Property 5: NAI 参数集随模型名变化（2.1, 2.2, 2.3）', () {
    Glados<String>(any.choose(_kModelSamples)).test(
      'v4 字段集合按 model.contains(\'4\') 与 4-5 / 4.5 两条件分支开关',
      (model) {
        final cfg = _makeCfg(model);
        final params = ImageGenService.buildNaiParametersForTesting(
          cfg: cfg,
          fullPrompt: 'p',
          fullNeg: 'n',
          seed: 42,
          extraNoiseSeed: 43,
        );

        final isV4 = model.contains('4');
        final isV45 = model.contains('4-5') || model.contains('4.5');

        // 不变量 1：v4 专属 8 字段的存在性必须严格等于 isV4 的判定
        for (final field in _kV4Fields) {
          expect(
            params.containsKey(field),
            isV4,
            reason:
                'v4 字段「$field」在 model="$model"（isV4=$isV4）时存在性应与 isV4 一致',
          );
        }

        // 不变量 2：skip_cfg_above_sigma 仅在 isV45 时存在，且值必为 null
        expect(
          params.containsKey('skip_cfg_above_sigma'),
          isV45,
          reason:
              'skip_cfg_above_sigma 在 model="$model"（isV45=$isV45）时存在性应与 isV45 一致',
        );
        if (isV45) {
          expect(
            params['skip_cfg_above_sigma'],
            isNull,
            reason: 'v4.5 模型 skip_cfg_above_sigma 字段值必须为 null',
          );
        }

        // 不变量 3：v4 字段命中时具体值与 design.md 给出的字面量一致
        if (isV4) {
          expect(params['params_version'], 3);
          expect(params['legacy'], false);
          expect(params['prefer_brownian'], true);
          expect(params['quality_toggle'], true);
          expect(params['autoSmea'], true);
          expect(params['dynamic_thresholding'], false);
          expect(params['v4_prompt'], isA<Map<String, dynamic>>());
          expect(params['v4_negative_prompt'], isA<Map<String, dynamic>>());
        }
      },
    );

    // 例测：边界场景显式断言，与属性测试形成双层保护。
    test('v3 模型不写入任何 v4 / v4.5 专属字段', () {
      final params = ImageGenService.buildNaiParametersForTesting(
        cfg: _makeCfg('nai-diffusion-3'),
        fullPrompt: 'p',
        fullNeg: 'n',
        seed: 0,
        extraNoiseSeed: 0,
      );
      for (final field in _kV4Fields) {
        expect(params.containsKey(field), isFalse,
            reason: 'v3 模型不应写入 v4 字段「$field」');
      }
      expect(params.containsKey('skip_cfg_above_sigma'), isFalse);
    });

    test('v4 base 模型写入 v4 字段但不写 skip_cfg_above_sigma', () {
      final params = ImageGenService.buildNaiParametersForTesting(
        cfg: _makeCfg('nai-diffusion-4-curated-preview'),
        fullPrompt: 'p',
        fullNeg: 'n',
        seed: 0,
        extraNoiseSeed: 0,
      );
      for (final field in _kV4Fields) {
        expect(params.containsKey(field), isTrue,
            reason: 'v4 base 模型必须写入 v4 字段「$field」');
      }
      expect(params.containsKey('skip_cfg_above_sigma'), isFalse,
          reason: 'v4 base 模型不应写 skip_cfg_above_sigma');
    });
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Property 6: seed 与 extra_noise_seed 范围（Validates: Requirements 2.4）
//
// 模拟生产代码 `Random().nextInt(1 << 32)` 的取值规则，多次调用
// `_buildNaiParameters`，断言返回 Map 中 `seed` 与 `extra_noise_seed`
// 均为整数且属于 `[0, 2^32)`。
// ──────────────────────────────────────────────────────────────────────────

void _registerProperty6() {
  group('Property 6: seed 与 extra_noise_seed 范围（2.4）', () {
    Glados<int>(any.intInRange(0, 1 << 30)).test(
      'seed / extra_noise_seed 始终为整数且属于 [0, 2^32)',
      (seedSource) {
        // 与生产代码 `_naiRandom.nextInt(1 << 32)` 一致的整数生成规则
        final rng = math.Random(seedSource);
        final seed = rng.nextInt(1 << 32);
        final extraNoiseSeed = rng.nextInt(1 << 32);

        final params = ImageGenService.buildNaiParametersForTesting(
          cfg: _makeCfg('nai-diffusion-4-5-full'),
          fullPrompt: 'p',
          fullNeg: 'n',
          seed: seed,
          extraNoiseSeed: extraNoiseSeed,
        );

        final s = params['seed'];
        final e = params['extra_noise_seed'];

        expect(s, isA<int>(), reason: 'seed 必须为整数');
        expect(e, isA<int>(), reason: 'extra_noise_seed 必须为整数');

        expect(s, greaterThanOrEqualTo(0), reason: 'seed >= 0');
        expect(s, lessThan(1 << 32), reason: 'seed < 2^32');
        expect(e, greaterThanOrEqualTo(0), reason: 'extra_noise_seed >= 0');
        expect(e, lessThan(1 << 32), reason: 'extra_noise_seed < 2^32');

        // 不变量：参数透传忠实，返回值必须等于传入值（无截断 / 偏移）
        expect(s, seed, reason: 'seed 必须忠实透传');
        expect(e, extraNoiseSeed, reason: 'extra_noise_seed 必须忠实透传');
      },
    );

    // 例测：边界值 0 与 (2^32 - 1) 均能被忠实写入
    test('seed=0 与 seed=2^32-1 边界值忠实透传', () {
      final paramsZero = ImageGenService.buildNaiParametersForTesting(
        cfg: _makeCfg('nai-diffusion-3'),
        fullPrompt: 'p',
        fullNeg: 'n',
        seed: 0,
        extraNoiseSeed: 0,
      );
      expect(paramsZero['seed'], 0);
      expect(paramsZero['extra_noise_seed'], 0);

      const maxSeed = (1 << 32) - 1;
      final paramsMax = ImageGenService.buildNaiParametersForTesting(
        cfg: _makeCfg('nai-diffusion-3'),
        fullPrompt: 'p',
        fullNeg: 'n',
        seed: maxSeed,
        extraNoiseSeed: maxSeed,
      );
      expect(paramsMax['seed'], maxSeed);
      expect(paramsMax['extra_noise_seed'], maxSeed);
    });
  });
}

// ──────────────────────────────────────────────────────────────────────────
// 例测：nai-diffusion-4-5-curated-preview 完整字段断言
// （Validates: Requirements 2.5）
//
// 与 tasks.md 4.4 对齐：返回 JSON 同时包含 v4 全部字段与 skip_cfg_above_sigma=null。
// ──────────────────────────────────────────────────────────────────────────

void _registerNaiV45ExampleTest() {
  group('NAI v4.5 完整字段例测（2.5）', () {
    test(
      'model="nai-diffusion-4-5-curated-preview" 同时写入 v4 全部字段与 skip_cfg_above_sigma=null',
      () {
        final params = ImageGenService.buildNaiParametersForTesting(
          cfg: _makeCfg('nai-diffusion-4-5-curated-preview'),
          fullPrompt: 'masterpiece, 1girl',
          fullNeg: 'lowres, bad anatomy',
          seed: 12345,
          extraNoiseSeed: 67890,
        );

        // v4 全部 8 字段及其字面量
        expect(params['params_version'], 3);
        expect(params['legacy'], false);
        expect(params['prefer_brownian'], true);
        expect(params['quality_toggle'], true);
        expect(params['autoSmea'], true);
        expect(params['dynamic_thresholding'], false);

        // v4_prompt 嵌套结构（caption / use_coords / use_order）
        final v4Prompt = params['v4_prompt'] as Map<String, dynamic>;
        final caption = v4Prompt['caption'] as Map<String, dynamic>;
        expect(caption['base_caption'], 'masterpiece, 1girl');
        expect(caption['char_captions'], isEmpty);
        expect(v4Prompt['use_coords'], false);
        expect(v4Prompt['use_order'], true);

        // v4_negative_prompt 嵌套结构（与正向不同：use_order=false）
        final v4Neg = params['v4_negative_prompt'] as Map<String, dynamic>;
        final negCaption = v4Neg['caption'] as Map<String, dynamic>;
        expect(negCaption['base_caption'], 'lowres, bad anatomy');
        expect(negCaption['char_captions'], isEmpty);
        expect(v4Neg['use_coords'], false);
        expect(v4Neg['use_order'], false);

        // v4.5 专属：skip_cfg_above_sigma 必须存在且值为 null
        expect(params.containsKey('skip_cfg_above_sigma'), isTrue,
            reason: 'v4.5 必须写入 skip_cfg_above_sigma 键');
        expect(params['skip_cfg_above_sigma'], isNull,
            reason: 'v4.5 的 skip_cfg_above_sigma 字段值必须为 null');

        // seed / extra_noise_seed 透传无损
        expect(params['seed'], 12345);
        expect(params['extra_noise_seed'], 67890);
      },
    );
  });
}
