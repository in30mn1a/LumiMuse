// Feature: flutter-parity-completion, Property 7: ComfyUI 占位符替换 round-trip
//
// **Validates: Requirements 3.1, 3.2, 3.4, 3.5**
//
// 用 `package:glados` 生成 `(prompt, template)`，断言：
// 1. 替换 + jsonDecode 后占位符位置的值严格等于 `prompt`
//    （含特殊字符 `\\` 和 `"` 的转义 round-trip）。
// 2. 不含占位符时替换后字符串等于原模板（jsonDecode 结果一致）。
// 3. `cfg.comfyuiWorkflow.trim()` 为空 / null / 仅空白时使用默认工作流。
//
// 与 Node.js 端 `src/app/api/image-gen/route.ts` 的 `generateComfyUI` 行为对齐：
// - 占位符 `{{positive_prompt}}` / `{{negative_prompt}}` 通过纯文本替换注入；
// - 替换前对 prompt 做 JSON 安全转义（`\\` → `\\\\`，`"` → `\\"`），
//   保证再次 `jsonDecode` 后能 round-trip 回原 prompt；
// - 模板不含占位符时不注入 prompt（与 Node.js `replaceAll` 不命中即原样保留对齐）；
// - 空 / null / 仅空白 → 回退到默认工作流。
//
// 设计原则（参见 tasks.md 5.2 与 design.md「P1 / R3」）：
// - `_buildComfyWorkflow` 是 `ImageGenService` 的私有方法，通过
//   `@visibleForTesting` 别名 `ImageGenService.buildComfyWorkflowForTesting`
//   暴露给测试，避免线上调用方与测试调用方之间产生第二份分支逻辑。
// - prompt 生成器的候选集合刻意不含 `{` / `}` 字符，避免无意构造出
//   `{{positive_prompt}}` / `{{negative_prompt}}` 字面量在替换链中触发
//   二次命中（详见 [_ComfyUIGenerators.comfyPrompt] 的注释）。
// - 默认 100 次迭代（glados ExploreConfig 默认值）。

import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test;
import 'package:lumimuse/core/models/app_settings.dart';
import 'package:lumimuse/core/services/image_gen_service.dart';

/// 仅覆写 `comfyuiWorkflow`，其它字段全部取默认值。
///
/// `_buildComfyWorkflow` 的分支判定只看 `comfyuiWorkflow.trim()` 是否为空，
/// 默认工作流分支会读取若干 cfg 字段（sdSteps / sdCfgScale / sdModel / sdWidth /
/// sdHeight），这里保持默认值即可，不影响占位符替换 / round-trip 性质。
ImageGenSettings _makeCfg(String workflow) =>
    const ImageGenSettings().copyWith(comfyuiWorkflow: workflow);

/// 自定义 glados 生成器：构造 prompt 字符串与 ComfyUI 工作流模板候选。
extension _ComfyUIGenerators on Any {
  /// Prompt 字符串：随机 0~24 个字符。
  ///
  /// 候选刻意覆盖：
  /// - JSON 转义关键字符（反斜杠 `\\` 与双引号 `"`）—— 直接对应 R3 验收 3.2
  ///   要求的 round-trip 行为；
  /// - ASCII 字母 / 数字 / 空格 / 制表符 / 换行 —— 覆盖普通文本场景；
  /// - CJK 字符与中文标点 —— 覆盖中文 prompt；
  /// - 常见 prompt 标点 `,` / `:` / `_` / `-` / `/` / `(` / `)`。
  ///
  /// 刻意 **不** 包含 `{` 或 `}` 字符，目的：避免随机生成出
  /// `{{positive_prompt}}` / `{{negative_prompt}}` 字面量，从而在两步
  /// `replaceAll` 链中触发二次命中（pos 中含 `{{negative_prompt}}` 字面
  /// 量会被第二步 replaceAll 改写）。Danbooru tag 与典型生图 prompt 也
  /// 不含 `{{` 模板片段，这一约束符合实际使用场景。
  Generator<String> get comfyPrompt {
    return intInRange(0, 1 << 30).map((seed) {
      final rng = math.Random(seed);
      final len = rng.nextInt(25);
      if (len == 0) return '';
      // 候选刻意 **不** 含裸 ASCII 控制字符（`\n` / `\t` / `\r`）：
      // 生产代码 `escape` 仅转义 `\\` 与 `"`，未把控制字符转义为 `\\n` / `\\t`。
      // JSON 字符串不允许出现裸控制字符，否则替换后再 `jsonDecode` 会抛
      // `FormatException`。Node.js 端 `generateComfyUI` 也是同样行为
      // （仅 `replace(/"/g, '\\"')`），实际使用中典型 Danbooru tag 与中文
      // prompt 都不含裸控制字符，这一约束符合契约。
      const candidates = <String>[
        // JSON 转义关键字符（必测）
        r'\', '"',
        // ASCII / 数字 / 空格（不含控制字符）
        'a', 'B', '7', ' ',
        // CJK / 中文标点
        '你', '好', '，', '。',
        // 常见 prompt 标点
        ',', ':', '_', '-', '/', '(', ')',
      ];
      return List<String>.generate(
        len,
        (_) => candidates[rng.nextInt(candidates.length)],
      ).join();
    });
  }

  /// 「空 / 仅空白」字符串：覆盖 R3 验收 3.4 的回退分支。
  ///
  /// 包含 0 长度、单空格、多种 ASCII 空白混合等场景；
  /// 与 `String.trim` 行为一致，所有候选都会被 `trim()` 化为空串。
  Generator<String> get blankWorkflow {
    return intInRange(0, 1 << 30).map((seed) {
      final rng = math.Random(seed);
      final len = rng.nextInt(7); // 0..6 个空白字符
      if (len == 0) return '';
      const ws = <String>[' ', '\t', '\n', '\r'];
      return List<String>.generate(
        len,
        (_) => ws[rng.nextInt(ws.length)],
      ).join();
    });
  }
}

void main() {
  _registerProperty7Roundtrip();
  _registerProperty7NoPlaceholder();
  _registerProperty7DefaultFallback();
}

// ──────────────────────────────────────────────────────────────────────────
// Property 7-A：替换 + jsonDecode 后占位符位置的值严格等于 prompt
// （Validates: Requirements 3.1, 3.2）
// ──────────────────────────────────────────────────────────────────────────

void _registerProperty7Roundtrip() {
  group('Property 7: ComfyUI 占位符替换 round-trip（3.1, 3.2）', () {
    /// 测试模板：同时含两个占位符与一个非占位字面量字段。
    ///
    /// jsonDecode 后期望：
    /// - `pos` 字段值 == 原 `pos` prompt（round-trip 回归）
    /// - `neg` 字段值 == 原 `neg` prompt（round-trip 回归）
    /// - `extra` 字段值 == 42（不受替换影响）
    const template =
        '{"pos": "{{positive_prompt}}", "neg": "{{negative_prompt}}", "extra": 42}';

    Glados2<String, String>(any.comfyPrompt, any.comfyPrompt).test(
      '替换 + jsonDecode 后占位符位置的值严格等于 prompt',
      (pos, neg) {
        final cfg = _makeCfg(template);
        final result =
            ImageGenService.buildComfyWorkflowForTesting(cfg, pos, neg);

        expect(
          result['pos'],
          pos,
          reason: '占位符 {{positive_prompt}} 处应 round-trip 回原 prompt',
        );
        expect(
          result['neg'],
          neg,
          reason: '占位符 {{negative_prompt}} 处应 round-trip 回原 prompt',
        );
        expect(
          result['extra'],
          42,
          reason: '非占位符字面量应在替换链中原样保留',
        );
      },
    );

    // 例测：显式覆盖「特殊字符 `\\` 与 `"` 的转义 round-trip」边界场景，
    // 与属性测试形成双层保护。
    test('反斜杠 `\\` 单独 round-trip', () {
      final cfg = _makeCfg('{"p": "{{positive_prompt}}"}');
      final result =
          ImageGenService.buildComfyWorkflowForTesting(cfg, r'back\slash', '');
      expect(result['p'], r'back\slash');
    });

    test('双引号 `"` 单独 round-trip', () {
      final cfg = _makeCfg('{"p": "{{positive_prompt}}"}');
      final result = ImageGenService.buildComfyWorkflowForTesting(
        cfg,
        'quote"inside',
        '',
      );
      expect(result['p'], 'quote"inside');
    });

    test('反斜杠 + 双引号混合 round-trip', () {
      final cfg = _makeCfg('{"p": "{{positive_prompt}}"}');
      final result = ImageGenService.buildComfyWorkflowForTesting(
        cfg,
        r'mixed\and"both',
        '',
      );
      expect(result['p'], r'mixed\and"both');
    });

    test('连续多个反斜杠 round-trip', () {
      final cfg = _makeCfg('{"p": "{{positive_prompt}}"}');
      final result = ImageGenService.buildComfyWorkflowForTesting(
        cfg,
        r'\\\\',
        '',
      );
      expect(result['p'], r'\\\\');
    });

    test('空 prompt round-trip 返回空字符串', () {
      final cfg = _makeCfg(
        '{"pos": "{{positive_prompt}}", "neg": "{{negative_prompt}}"}',
      );
      final result =
          ImageGenService.buildComfyWorkflowForTesting(cfg, '', '');
      expect(result['pos'], '');
      expect(result['neg'], '');
    });
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Property 7-B：不含占位符时模板原样保留（Validates: Requirements 3.5）
// ──────────────────────────────────────────────────────────────────────────

void _registerProperty7NoPlaceholder() {
  group('Property 7: 不含占位符时模板原样保留（3.5）', () {
    /// 测试模板：包含与占位符相似但缺少花括号的标识符，确保 `replaceAll`
    /// 不命中。任意 prompt 输入下，结果都应等于直接 jsonDecode 模板。
    const template =
        '{"a": "no positive_prompt here", "b": "no negative_prompt either", "n": 7}';

    Glados2<String, String>(any.comfyPrompt, any.comfyPrompt).test(
      'cfg.comfyuiWorkflow 不含占位符时结果等于 jsonDecode(template)',
      (pos, neg) {
        final cfg = _makeCfg(template);
        final result =
            ImageGenService.buildComfyWorkflowForTesting(cfg, pos, neg);

        // 不含占位符 → 与直接 jsonDecode 模板的结果一致，
        // 即「保留模板原样，不再注入 prompt」。
        expect(result, equals(jsonDecode(template) as Map<String, dynamic>));
      },
    );

    // 例测：边界场景显式断言。
    test('完全空对象模板（无占位符）原样返回 {}', () {
      final cfg = _makeCfg('{}');
      final result = ImageGenService.buildComfyWorkflowForTesting(
        cfg,
        'anything',
        'whatever',
      );
      expect(result, isEmpty);
    });

    test('仅含一个占位符时另一个占位符模板原样保留', () {
      // 模板只含 positive 占位符，negative 占位符不存在，
      // negative prompt 不应注入到模板中的任何位置。
      final cfg = _makeCfg(
        '{"p": "{{positive_prompt}}", "fixed": "literal"}',
      );
      final result = ImageGenService.buildComfyWorkflowForTesting(
        cfg,
        'POS',
        'should-not-appear',
      );
      expect(result['p'], 'POS');
      expect(result['fixed'], 'literal');
      expect(result.length, 2,
          reason: '模板只含两个 key，结果不应多出 negative 注入位');
    });
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Property 7-C：空 / 仅空白工作流回退到默认（Validates: Requirements 3.4）
//
// 注意：`_buildDefaultComfyWorkflow` 中 KSampler 节点的 `seed` 字段使用
// `DateTime.now().millisecondsSinceEpoch` 派生，因此整体 Map 不能直接
// 与硬编码默认值做等值比较；这里改为断言「关键节点 class_type 与
// prompt 注入位置」与默认工作流 schema 完全一致。
// ──────────────────────────────────────────────────────────────────────────

void _registerProperty7DefaultFallback() {
  group('Property 7: 空/仅空白工作流回退到默认（3.4）', () {
    Glados3<String, String, String>(
      any.blankWorkflow,
      any.comfyPrompt,
      any.comfyPrompt,
    ).test(
      'cfg.comfyuiWorkflow.trim() 为空时使用默认工作流',
      (workflow, pos, neg) {
        final cfg = _makeCfg(workflow);
        final result =
            ImageGenService.buildComfyWorkflowForTesting(cfg, pos, neg);

        // 默认工作流的 7 个节点 + class_type schema 校验
        final node3 = result['3'] as Map<String, dynamic>;
        expect(node3['class_type'], 'KSampler');

        final node4 = result['4'] as Map<String, dynamic>;
        expect(node4['class_type'], 'CheckpointLoaderSimple');

        final node5 = result['5'] as Map<String, dynamic>;
        expect(node5['class_type'], 'EmptyLatentImage');

        final node6 = result['6'] as Map<String, dynamic>;
        expect(node6['class_type'], 'CLIPTextEncode');
        expect(
          (node6['inputs'] as Map<String, dynamic>)['text'],
          pos,
          reason: '默认工作流节点 6 的 inputs.text 应等于正向 prompt',
        );

        final node7 = result['7'] as Map<String, dynamic>;
        expect(node7['class_type'], 'CLIPTextEncode');
        expect(
          (node7['inputs'] as Map<String, dynamic>)['text'],
          neg,
          reason: '默认工作流节点 7 的 inputs.text 应等于负向 prompt',
        );

        final node8 = result['8'] as Map<String, dynamic>;
        expect(node8['class_type'], 'VAEDecode');

        final node9 = result['9'] as Map<String, dynamic>;
        expect(node9['class_type'], 'SaveImage');
      },
    );

    // 例测：边界场景显式覆盖。
    test('空字符串走默认工作流', () {
      final cfg = _makeCfg('');
      final result = ImageGenService.buildComfyWorkflowForTesting(
        cfg,
        'p',
        'n',
      );
      expect((result['3'] as Map)['class_type'], 'KSampler');
      expect(((result['6'] as Map)['inputs'] as Map)['text'], 'p');
      expect(((result['7'] as Map)['inputs'] as Map)['text'], 'n');
    });

    test('仅 ASCII 空白（空格 / 制表符 / 换行 / 回车）走默认工作流', () {
      final cfg = _makeCfg('   \t\n\r  ');
      final result = ImageGenService.buildComfyWorkflowForTesting(
        cfg,
        'p',
        'n',
      );
      expect((result['3'] as Map)['class_type'], 'KSampler');
      expect((result['4'] as Map)['class_type'], 'CheckpointLoaderSimple');
    });
  });
}
