import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/models/message_metadata.dart';

/// D1/D2/D3 测试：MessageMetadata 新增字段（lastUsage / lastMemoryInjection /
/// generationStopped / generationStopReason）的序列化往返与默认值。
void main() {
  group('MessageMetadata 新增字段 round-trip', () {
    test('lastUsage 序列化往返', () {
      const meta = MessageMetadata(
        lastUsage: {
          'prompt_tokens': 100,
          'completion_tokens': 50,
          'total_tokens': 150,
        },
      );
      final json = meta.toJson();
      expect(json['last_usage'], {
        'prompt_tokens': 100,
        'completion_tokens': 50,
        'total_tokens': 150,
      });
      final restored = MessageMetadata.fromJson(json);
      expect(restored.lastUsage, {
        'prompt_tokens': 100,
        'completion_tokens': 50,
        'total_tokens': 150,
      });
    });

    test('lastUsage 为 null 时不写入 last_usage 键', () {
      const meta = MessageMetadata();
      final json = meta.toJson();
      expect(json.containsKey('last_usage'), isFalse);
      final restored = MessageMetadata.fromJson(json);
      expect(restored.lastUsage, isNull);
    });

    test('lastMemoryInjection 序列化往返', () {
      const meta = MessageMetadata(
        lastMemoryInjection: MemoryInjectionInfo(
          count: 3,
          tokens: 120,
          mode: 'local',
        ),
      );
      final json = meta.toJson();
      expect(json['last_memory_injection'], {
        'count': 3,
        'tokens': 120,
        'mode': 'local',
      });
      final restored = MessageMetadata.fromJson(json);
      expect(restored.lastMemoryInjection, isNotNull);
      expect(restored.lastMemoryInjection!.count, 3);
      expect(restored.lastMemoryInjection!.tokens, 120);
      expect(restored.lastMemoryInjection!.mode, 'local');
    });

    test('lastMemoryInjection 为 null 时不写入键', () {
      const meta = MessageMetadata();
      final json = meta.toJson();
      expect(json.containsKey('last_memory_injection'), isFalse);
    });

    test('generationStopped 默认 false；非默认值往返', () {
      const meta = MessageMetadata(
        generationStopped: true,
        generationStopReason: 'abort',
      );
      final json = meta.toJson();
      expect(json['generation_stopped'], true);
      expect(json['generation_stop_reason'], 'abort');
      final restored = MessageMetadata.fromJson(json);
      expect(restored.generationStopped, true);
      expect(restored.generationStopReason, 'abort');
    });

    test('generationStopped 默认 false 不写入键', () {
      const meta = MessageMetadata();
      final json = meta.toJson();
      expect(json.containsKey('generation_stopped'), isFalse);
      expect(json.containsKey('generation_stop_reason'), isFalse);
      final restored = MessageMetadata.fromJson(json);
      expect(restored.generationStopped, false);
      expect(restored.generationStopReason, isNull);
    });

    test('完整 metadata JSON 字符串往返', () {
      const meta = MessageMetadata(
        versions: [MessageVersion(content: 'hello', tokenCount: 5)],
        activeVersion: 0,
        lastUsage: {
          'prompt_tokens': 7,
          'completion_tokens': 3,
          'total_tokens': 10,
        },
        lastMemoryInjection: MemoryInjectionInfo(
          count: 2,
          tokens: 50,
          mode: 'local',
        ),
        generationStopped: false,
      );
      final jsonStr = meta.toJsonString();
      // 确认 JSON 可正常解码且字段完整
      final decoded = jsonDecode(jsonStr) as Map<String, dynamic>;
      expect(decoded['last_usage'], isNotNull);
      expect(decoded['last_memory_injection'], isNotNull);
      final restored = MessageMetadata.fromJsonString(jsonStr);
      expect(restored.lastUsage?['prompt_tokens'], 7);
      expect(restored.lastMemoryInjection?.count, 2);
      expect(restored.generationStopped, false);
    });
  });

  group('MessageMetadata.copyWith 新增字段', () {
    test('copyWith 传 lastUsage 覆盖', () {
      const meta = MessageMetadata(
        lastUsage: {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2},
      );
      final updated = meta.copyWith(
        lastUsage: {'prompt_tokens': 9, 'completion_tokens': 8, 'total_tokens': 17},
      );
      expect(updated.lastUsage?['prompt_tokens'], 9);
    });

    test('copyWith 不传 lastUsage 保持原值（?? 语义）', () {
      const meta = MessageMetadata(
        lastUsage: {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2},
      );
      final updated = meta.copyWith();
      expect(updated.lastUsage?['prompt_tokens'], 1);
    });

    test('clearLastUsage 把 lastUsage 置为 null', () {
      const meta = MessageMetadata(
        lastUsage: {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2},
      );
      expect(meta.clearLastUsage().lastUsage, isNull);
    });

    test('clearLastMemoryInjection 把 lastMemoryInjection 置为 null', () {
      const meta = MessageMetadata(
        lastMemoryInjection: MemoryInjectionInfo(count: 1, tokens: 1, mode: 'local'),
      );
      expect(meta.clearLastMemoryInjection().lastMemoryInjection, isNull);
    });

    test('clearGenerationStopReason 把 generationStopReason 置为 null', () {
      const meta = MessageMetadata(
        generationStopped: true,
        generationStopReason: 'abort',
      );
      final cleared = meta.clearGenerationStopReason();
      expect(cleared.generationStopReason, isNull);
      // generationStopped 不受影响
      expect(cleared.generationStopped, true);
    });
  });

  group('MemoryInjectionInfo.fromJson 容错', () {
    test('字段缺失走默认值', () {
      final info = MemoryInjectionInfo.fromJson({});
      expect(info.count, 0);
      expect(info.tokens, 0);
      expect(info.mode, 'local');
    });
  });
}
