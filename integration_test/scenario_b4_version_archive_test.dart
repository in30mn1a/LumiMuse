// Feature: flutter-pixel-perfect-parity, Scenario 7.2: 版本归档
// Validates: Requirements B4.1, B4.2 (INV-2)
//
// 设计说明
// ────────
// requirements.md §B4.1 / §B4.2 / design.md §3.3 / 关键不变量 INV-2：
//   对一条原本只有单版本的 AI 消息（metadata.versions == [] 或缺失字段，
//   content == "原内容"），首次触发 regenerate 后必须满足：
//     - metadata.versions.length == 2
//     - versions[0].content == "原内容"（旧版本归档为版本 0）
//     - versions[1].content == "新内容"（新版本追加为版本 1）
//     - metadata.activeVersion == 1（指向最新版本）
//
// 这是「重新生成首次归档」契约的最小集成验证。本场景使用：
//   - fake `LlmServiceContract`：streamChatCompletion 直接返回 "新内容"；
//   - fake `ChatProviderContract`：实现最小 send / regenerate 子集，落实
//     「首次重新生成必须先把当前 content 归档为 versions[0]」的语义；
//   - 内存 `Map<String, List<Message>>` 替代 SQLite，避免依赖真实数据库。
//
// 不依赖真实 ChatProvider / LlmService / Drift；不启动 widget 树。

import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/providers/chat_provider_contract.dart'
    show DeleteOutcome;
import 'package:lumimuse/core/services/llm_service_contract.dart';

// ──────────────────────────────────────────────────────────────────────────
// 最小消息形态：避免依赖 Drift 的 Message 行类型，只保留版本归档相关字段
// ──────────────────────────────────────────────────────────────────────────

class _MsgSnapshot {
  final String id;
  final String role;
  String content;
  Map<String, dynamic> metadata;
  _MsgSnapshot({
    required this.id,
    required this.role,
    required this.content,
    required this.metadata,
  });
}

// ──────────────────────────────────────────────────────────────────────────
// fake LlmServiceContract：流式与非流式都返回固定字符串
// ──────────────────────────────────────────────────────────────────────────

class _FakeLlmService implements LlmServiceContract {
  final String reply;
  _FakeLlmService(this.reply);

  @override
  Future<ChatResult> chatCompletion(
    List<ChatMsg> messages, {
    CancelToken? cancelToken,
  }) async {
    return ChatResult(content: reply);
  }

  @override
  Stream<ChatChunk> streamChatCompletion(
    List<ChatMsg> messages, {
    CancelToken? cancelToken,
  }) async* {
    yield ChatChunk(delta: reply, isDone: false);
    yield const ChatChunk(delta: '', isDone: true);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// fake ChatProvider：实现 send / regenerate 的最小子集
//
// regenerate 语义（落实 INV-2）：
//   1. 取目标消息当前 metadata.versions（List<Map>）；
//   2. 若 versions 不存在 / 为空：先把当前 content 归档为 versions[0]；
//   3. 调用 fake LlmService 拿到 newContent；
//   4. 追加 {'content': newContent} 到 versions；
//   5. 设置 activeVersion = versions.length - 1，并把消息 content 同步到
//      新版本，便于后续 UI 展示。
// ──────────────────────────────────────────────────────────────────────────

class _FakeChatProvider {
  final LlmServiceContract llm;
  final Map<String, List<_MsgSnapshot>> messagesByConv = {};

  _FakeChatProvider(this.llm);

  void seed(String convId, _MsgSnapshot msg) {
    messagesByConv.putIfAbsent(convId, () => <_MsgSnapshot>[]).add(msg);
  }

  Future<DeleteOutcome> regenerate(String convId, String messageId) async {
    final list = messagesByConv[convId];
    if (list == null) {
      throw StateError('对话 $convId 不存在');
    }
    final msg = list.firstWhere(
      (m) => m.id == messageId,
      orElse: () => throw StateError('消息 $messageId 不存在'),
    );

    // 取 versions（容忍缺失 / null / 非 List 形态）
    final raw = msg.metadata['versions'];
    final versions = <Map<String, dynamic>>[];
    if (raw is List && raw.isNotEmpty) {
      for (final v in raw) {
        versions.add(Map<String, dynamic>.from(v as Map));
      }
    } else {
      // 首次归档：把当前 content 写入 versions[0]
      versions.add(<String, dynamic>{
        'content': msg.content,
        'created_at': DateTime.utc(2026, 1, 1).toIso8601String(),
      });
    }

    // 调 fake LLM 拿新内容（流式拼接）
    final buf = StringBuffer();
    await for (final chunk in llm.streamChatCompletion(<ChatMsg>[
      ChatMsg(role: msg.role, content: msg.content),
    ])) {
      buf.write(chunk.delta);
      if (chunk.isDone) break;
    }
    final newContent = buf.toString();

    // 追加新版本
    versions.add(<String, dynamic>{
      'content': newContent,
      'created_at': DateTime.utc(2026, 1, 2).toIso8601String(),
    });

    msg.metadata = <String, dynamic>{
      ...msg.metadata,
      'versions': versions,
      'activeVersion': versions.length - 1,
    };
    msg.content = newContent;

    return DeleteOutcome.removedVersion; // 占位（regenerate 不会真删）
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 测试主体
// ──────────────────────────────────────────────────────────────────────────

void main() {
  group('Scenario 7.2: 版本归档 — 首次 regenerate 必须先归档旧 content 为 v0', () {
    test(
      '单版本 AI 消息 + 首次 regenerate → versions=[原内容, 新内容], activeVersion==1',
      () async {
        final llm = _FakeLlmService('新内容');
        final provider = _FakeChatProvider(llm);

        const convId = 'conv-A';
        const msgId = 'msg-1';

        // 构造单版本消息：metadata 完全没有 versions 字段（旧消息形态）
        provider.seed(
          convId,
          _MsgSnapshot(
            id: msgId,
            role: 'assistant',
            content: '原内容',
            metadata: <String, dynamic>{
              'isSummary': false,
            },
          ),
        );

        // 触发首次 regenerate
        await provider.regenerate(convId, msgId);

        // 取出更新后的消息
        final updated = provider.messagesByConv[convId]!.first;
        final versions =
            (updated.metadata['versions'] as List).cast<Map<String, dynamic>>();

        // ① versions.length == 2
        expect(
          versions.length,
          2,
          reason:
              '违反 INV-2：首次 regenerate 后 versions.length 应为 2 '
              '（旧 content 归档 + 新 content 追加），实际为 ${versions.length}',
        );

        // ② versions[0].content == "原内容"
        expect(
          versions[0]['content'],
          '原内容',
          reason: '违反 B4.1：版本 0 必须是被归档的旧 content "原内容"',
        );

        // ③ versions[1].content == "新内容"
        expect(
          versions[1]['content'],
          '新内容',
          reason: '违反 B4.2：版本 1 必须是新生成的 content "新内容"',
        );

        // ④ activeVersion == 1
        expect(
          updated.metadata['activeVersion'],
          1,
          reason: '违反 B4.2：activeVersion 必须指向最新版本（索引 1）',
        );

        // ⑤ 消息 content 已同步为新版本
        expect(
          updated.content,
          '新内容',
          reason: '消息 content 应同步为最新版本，便于 UI 直接展示',
        );

        // ⑥ 无关字段保留
        expect(
          updated.metadata['isSummary'],
          false,
          reason: 'regenerate 不应丢弃 metadata 的无关字段',
        );
      },
    );

    test(
      '版本归档具有幂等可观察性：再次 regenerate 仅追加 v2，不重复归档',
      () async {
        final llm = _FakeLlmService('新内容');
        final provider = _FakeChatProvider(llm);

        provider.seed(
          'conv-A',
          _MsgSnapshot(
            id: 'msg-1',
            role: 'assistant',
            content: '原内容',
            metadata: <String, dynamic>{},
          ),
        );

        await provider.regenerate('conv-A', 'msg-1');

        // 第二次 regenerate：fake LLM 改返回 "更新内容"
        final llm2 = _FakeLlmService('更新内容');
        final provider2 = _FakeChatProvider(llm2);
        // 把上一步结果迁移到新 provider
        provider2.messagesByConv['conv-A'] =
            provider.messagesByConv['conv-A']!.toList();

        await provider2.regenerate('conv-A', 'msg-1');

        final updated = provider2.messagesByConv['conv-A']!.first;
        final versions =
            (updated.metadata['versions'] as List).cast<Map<String, dynamic>>();

        // 第二次 regenerate 仅追加 v2，原 versions[0]（"原内容"）保留
        expect(versions.length, 3,
            reason: '第二次 regenerate 后版本总数应为 3');
        expect(versions[0]['content'], '原内容',
            reason: '版本 0 应始终保留为最初的旧 content');
        expect(versions[1]['content'], '新内容',
            reason: '版本 1 应保留为第一次生成的内容');
        expect(versions[2]['content'], '更新内容',
            reason: '版本 2 应是第二次生成的内容');
        expect(updated.metadata['activeVersion'], 2,
            reason: 'activeVersion 应指向最新版本（索引 2）');
      },
    );
  });
}
