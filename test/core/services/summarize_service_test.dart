// 对话总结服务测试 — 覆盖 Wave 12 改造点：
// - 基本总结流：插入 user/assistant 消息 → summarize → 验证 summary 系统消息落库
// - lastSummaryIdx 跳过：已有 summary 后只总结之后的消息
// - 消息少于 2 条不总结
// - 角色 4 字段（basic_info/personality/scenario/other_info）注入到 prompt
// - 记忆画像注入到 prompt（renderMemoryProfile）
// - 第一人称 prompt（含"第一人称口吻"约束）
// - user 标"你"而非"用户"
// - max_tokens = max(settings.max_tokens, reasoningSafeMaxTokens)
// 对齐主项目 src/app/api/summarize/route.ts。

import 'package:dio/dio.dart';
import 'package:drift/drift.dart' hide isNotNull, isNull;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/core/models/app_settings.dart';
import 'package:lumimuse/core/models/message_metadata.dart';
import 'package:lumimuse/core/services/llm_service.dart';
import 'package:lumimuse/core/services/memory_profile_service.dart';
import 'package:lumimuse/core/services/summarize_service.dart';

const _charId = 'char-summarize';
const _convId = 'conv-summarize';

/// 拦截 LLM 调用：捕获 settings + messages，返回固定 summary 内容。
/// 通过 [captured] 暴露最后一次调用的入参供断言。
class _CapturingLlm extends LlmService {
  _CapturingLlm(this.returnText);

  final String returnText;
  AppSettings? capturedSettings;
  List<ChatMessage>? capturedMessages;

  @override
  Future<String> chatCompletion({
    required AppSettings settings,
    required List<ChatMessage> messages,
    OnUsageCallback? onUsage,
    CancelToken? cancelToken,
  }) async {
    capturedSettings = settings;
    capturedMessages = messages;
    return returnText;
  }
}

AppDatabase _createTestDb() {
  driftRuntimeOptions.dontWarnAboutMultipleDatabases = true;
  return AppDatabase.forTesting(NativeDatabase.memory());
}

Future<void> _seedCharacter(
  AppDatabase db, {
  String id = _charId,
  String name = '艾莉丝',
  String basicInfo = '',
  String personality = '',
  String scenario = '',
  String otherInfo = '',
}) async {
  await db.into(db.characters).insert(
        CharactersCompanion.insert(
          id: id,
          name: Value(name),
          basicInfo:
              basicInfo.isNotEmpty ? Value(basicInfo) : const Value.absent(),
          personality: personality.isNotEmpty
              ? Value(personality)
              : const Value.absent(),
          scenario:
              scenario.isNotEmpty ? Value(scenario) : const Value.absent(),
          otherInfo:
              otherInfo.isNotEmpty ? Value(otherInfo) : const Value.absent(),
          createdAt: Value(DateTime(2026, 1, 1)),
          updatedAt: Value(DateTime(2026, 1, 1)),
        ),
      );
}

Future<String> _seedConversation(
  AppDatabase db, {
  String id = _convId,
  String characterId = _charId,
}) async {
  await db.into(db.conversations).insert(
        ConversationsCompanion.insert(
          id: id,
          characterId: characterId,
          title: const Value('测试对话'),
          createdAt: Value(DateTime(2026, 1, 1)),
          updatedAt: Value(DateTime(2026, 1, 1)),
        ),
      );
  return id;
}

Future<String> _insertMessage(
  AppDatabase db, {
  required String role,
  required String content,
  String conversationId = _convId,
  int seq = 1,
  DateTime? createdAt,
}) async {
  final id = 'msg-$role-$seq';
  await db.into(db.messages).insert(
        MessagesCompanion.insert(
          id: id,
          conversationId: conversationId,
          role: role,
          content: Value(content),
          seq: Value(seq),
          createdAt: Value(createdAt ?? DateTime(2026, 1, 1, 0, 0, seq)),
        ),
      );
  return id;
}

Future<void> _insertSummaryMessage(
  AppDatabase db, {
  required String content,
  required List<String> summarizedIds,
  String conversationId = _convId,
  int seq = 99,
}) async {
  await db.into(db.messages).insert(
        MessagesCompanion.insert(
          id: 'msg-summary-$seq',
          conversationId: conversationId,
          role: 'system',
          content: Value(content),
          seq: Value(seq),
          createdAt: Value(DateTime(2026, 1, 1, 0, 0, seq)),
          metadata: Value(
            MessageMetadata(
              isSummary: true,
              summarizedIds: summarizedIds,
            ).toJsonString(),
          ),
        ),
      );
}

AppSettings _baseSettings({int maxTokens = 1024}) {
  return AppSettings(
    apiBase: 'http://localhost',
    apiKey: 'k',
    model: 'm',
    maxTokens: maxTokens,
  );
}

void main() {
  // ─────────────────────────────────────────────────────────────
  // 组 1：基本总结流
  // ─────────────────────────────────────────────────────────────
  group('基本总结流', () {
    test('插入 user+assistant → summarize → 落库 system summary 消息', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);
      await _seedConversation(db);
      final u1 = await _insertMessage(db,
          role: 'user', content: '你好艾莉丝', seq: 1);
      final a1 = await _insertMessage(db,
          role: 'assistant', content: '主人你好喵', seq: 2);

      final llm = _CapturingLlm('## 📖 最近发生的事\n我刚刚和主人打了招呼。');
      final svc = SummarizeService(db, llm);
      await svc.summarize(_convId, _baseSettings());

      // 验证：summary 消息落库
      final allMsgs = await (db.select(db.messages)
            ..where((t) => t.conversationId.equals(_convId))
            ..orderBy([(t) => OrderingTerm.asc(t.seq)]))
          .get();
      expect(allMsgs.length, 3);
      final summary = allMsgs.last;
      expect(summary.role, 'system');
      expect(summary.content, '## 📖 最近发生的事\n我刚刚和主人打了招呼。');
      final meta = MessageMetadata.fromJsonString(summary.metadata);
      expect(meta.isSummary, isTrue);
      expect(meta.summarizedIds, [u1, a1]);
    });

    test('空 LLM 返回不落库 summary 消息', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);
      await _seedConversation(db);
      await _insertMessage(db, role: 'user', content: 'hi', seq: 1);
      await _insertMessage(db, role: 'assistant', content: 'hey', seq: 2);

      final llm = _CapturingLlm('   '); // 空白
      final svc = SummarizeService(db, llm);
      await svc.summarize(_convId, _baseSettings());

      final summaryCount = await (db.selectOnly(db.messages)
            ..addColumns([db.messages.id.count()])
            ..where(db.messages.role.equals('system')))
          .getSingle();
      expect(
        summaryCount.read(db.messages.id.count()),
        0,
      );
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 组 2：消息数量门槛
  // ─────────────────────────────────────────────────────────────
  group('消息数量门槛', () {
    test('少于 2 条消息不调用 LLM', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);
      await _seedConversation(db);
      await _insertMessage(db, role: 'user', content: 'only one', seq: 1);

      final llm = _CapturingLlm('summary');
      await SummarizeService(db, llm).summarize(_convId, _baseSettings());

      expect(llm.capturedMessages, isNull);
    });

    test('空消息列表不调用 LLM', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);
      await _seedConversation(db);

      final llm = _CapturingLlm('summary');
      await SummarizeService(db, llm).summarize(_convId, _baseSettings());
      expect(llm.capturedMessages, isNull);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 组 3：lastSummaryIdx 跳过
  // ─────────────────────────────────────────────────────────────
  group('lastSummaryIdx 跳过', () {
    test('已有 summary → 只总结 summary 之后的消息', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);
      await _seedConversation(db);
      // 旧消息（已被旧 summary 覆盖）
      await _insertMessage(db, role: 'user', content: '旧问题', seq: 1);
      await _insertMessage(db, role: 'assistant', content: '旧回答', seq: 2);
      await _insertSummaryMessage(
        db,
        content: '旧总结',
        summarizedIds: const ['msg-user-1', 'msg-assistant-2'],
        seq: 3,
      );
      // 新消息
      final u2 = await _insertMessage(db,
          role: 'user', content: '新问题', seq: 4);
      final a2 = await _insertMessage(db,
          role: 'assistant', content: '新回答', seq: 5);

      final llm = _CapturingLlm('新总结');
      await SummarizeService(db, llm).summarize(_convId, _baseSettings());

      // 验证：prompt 中只含新消息内容，不含旧消息
      final prompt = llm.capturedMessages!.single.content;
      expect(prompt, contains('新问题'));
      expect(prompt, contains('新回答'));
      expect(prompt, isNot(contains('旧问题')));
      expect(prompt, isNot(contains('旧回答')));

      // 验证：summarizedIds 只含新消息 id
      final summaries = await (db.select(db.messages)
            ..where((t) =>
                t.conversationId.equals(_convId) & t.role.equals('system')))
          .get();
      final newSummary = summaries.last;
      final meta = MessageMetadata.fromJsonString(newSummary.metadata);
      expect(meta.summarizedIds, [u2, a2]);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 组 4：角色 4 字段 + 画像注入
  // ─────────────────────────────────────────────────────────────
  group('角色字段与画像注入', () {
    test('basic_info/personality/scenario/other_info 都注入到 prompt', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(
        db,
        basicInfo: '猫娘 18 岁',
        personality: '活泼粘人',
        scenario: '现代都市',
        otherInfo: '喜欢鱼罐头',
      );
      await _seedConversation(db);
      await _insertMessage(db, role: 'user', content: 'hi', seq: 1);
      await _insertMessage(db, role: 'assistant', content: 'hey', seq: 2);

      final llm = _CapturingLlm('summary');
      await SummarizeService(db, llm).summarize(_convId, _baseSettings());

      final prompt = llm.capturedMessages!.single.content;
      expect(prompt, contains('【基本信息】'));
      expect(prompt, contains('猫娘 18 岁'));
      expect(prompt, contains('【性格特征】'));
      expect(prompt, contains('活泼粘人'));
      expect(prompt, contains('【场景与世界观】'));
      expect(prompt, contains('现代都市'));
      expect(prompt, contains('【其他信息】'));
      expect(prompt, contains('喜欢鱼罐头'));
      expect(prompt, contains('### 🎭 角色设定与记忆背景'));
    });

    test('空字段不注入', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db, basicInfo: '', personality: '');
      await _seedConversation(db);
      await _insertMessage(db, role: 'user', content: 'hi', seq: 1);
      await _insertMessage(db, role: 'assistant', content: 'hey', seq: 2);

      final llm = _CapturingLlm('summary');
      await SummarizeService(db, llm).summarize(_convId, _baseSettings());

      final prompt = llm.capturedMessages!.single.content;
      expect(prompt, isNot(contains('【基本信息】')));
      expect(prompt, isNot(contains('【性格特征】')));
    });

    test('画像存在时注入【当前记忆画像】', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);
      await _seedConversation(db);
      await _insertMessage(db, role: 'user', content: 'hi', seq: 1);
      await _insertMessage(db, role: 'assistant', content: 'hey', seq: 2);

      // 直接写一行画像
      await db.into(db.characterMemoryProfiles).insert(
            CharacterMemoryProfilesCompanion.insert(
              characterId: _charId,
              profileName: const Value('默认画像'),
              relationshipState: const Value('亲密伙伴'),
              recentStoryState: const Value('刚认识主人'),
              emotionalBaseline: const Value('开心'),
              openThreads: const Value('["明天吃什么"]'),
              userProfileSummary: const Value('主人很温柔'),
              pinnedSummary: const Value('喜欢被摸头'),
            ),
          );

      final llm = _CapturingLlm('summary');
      await SummarizeService(db, llm).summarize(_convId, _baseSettings());

      final prompt = llm.capturedMessages!.single.content;
      expect(prompt, contains('【当前记忆画像】'));
      expect(prompt, contains('亲密伙伴'));
      expect(prompt, contains('刚认识主人'));
      expect(prompt, contains('主人很温柔'));
      expect(prompt, contains('喜欢被摸头'));
    });

    test('画像不存在时不注入【当前记忆画像】', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);
      await _seedConversation(db);
      await _insertMessage(db, role: 'user', content: 'hi', seq: 1);
      await _insertMessage(db, role: 'assistant', content: 'hey', seq: 2);

      final llm = _CapturingLlm('summary');
      await SummarizeService(db, llm).summarize(_convId, _baseSettings());

      final prompt = llm.capturedMessages!.single.content;
      expect(prompt, isNot(contains('【当前记忆画像】')));
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 组 5：第一人称 prompt + user 标"你"
  // ─────────────────────────────────────────────────────────────
  group('第一人称 prompt + user 标签', () {
    test('prompt 含第一人称口吻约束', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db, name: '艾莉丝');
      await _seedConversation(db);
      await _insertMessage(db, role: 'user', content: 'hi', seq: 1);
      await _insertMessage(db, role: 'assistant', content: 'hey', seq: 2);

      final llm = _CapturingLlm('summary');
      await SummarizeService(db, llm).summarize(_convId, _baseSettings());

      final prompt = llm.capturedMessages!.single.content;
      expect(prompt, contains('第一人称口吻'));
      expect(prompt, contains('艾莉丝'));
      // 角色名出现在第一人称约束行
      expect(prompt, contains('以角色 艾莉丝 的第一人称口吻'));
    });

    test('user 消息标"你"而非"用户"', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db, name: '艾莉丝');
      await _seedConversation(db);
      await _insertMessage(db, role: 'user', content: '你好呀', seq: 1);
      await _insertMessage(db, role: 'assistant', content: '主人好', seq: 2);

      final llm = _CapturingLlm('summary');
      await SummarizeService(db, llm).summarize(_convId, _baseSettings());

      final prompt = llm.capturedMessages!.single.content;
      // user 标签是"你"
      expect(prompt, contains('你: 你好呀'));
      expect(prompt, isNot(contains('用户: ')));
      // assistant 标签是角色名
      expect(prompt, contains('艾莉丝: 主人好'));
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 组 6：max_tokens 安全下限
  // ─────────────────────────────────────────────────────────────
  group('max_tokens 安全下限', () {
    test('settings.max_tokens < reasoningSafeMaxTokens → 取下限', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);
      await _seedConversation(db);
      await _insertMessage(db, role: 'user', content: 'hi', seq: 1);
      await _insertMessage(db, role: 'assistant', content: 'hey', seq: 2);

      final llm = _CapturingLlm('summary');
      await SummarizeService(db, llm)
          .summarize(_convId, _baseSettings(maxTokens: 1024));

      expect(llm.capturedSettings!.maxTokens, reasoningSafeMaxTokens);
    });

    test('settings.max_tokens > reasoningSafeMaxTokens → 取较大值', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);
      await _seedConversation(db);
      await _insertMessage(db, role: 'user', content: 'hi', seq: 1);
      await _insertMessage(db, role: 'assistant', content: 'hey', seq: 2);

      final llm = _CapturingLlm('summary');
      const big = reasoningSafeMaxTokens + 1000;
      await SummarizeService(db, llm)
          .summarize(_convId, _baseSettings(maxTokens: big));

      expect(llm.capturedSettings!.maxTokens, big);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 组 7：角色 / 对话缺失兜底
  // ─────────────────────────────────────────────────────────────
  group('缺失兜底', () {
    test('对话不存在 → 不调用 LLM', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final llm = _CapturingLlm('summary');
      await SummarizeService(db, llm).summarize('no-such-conv', _baseSettings());
      expect(llm.capturedMessages, isNull);
    });

    test('角色不存在 → 不调用 LLM', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      // 只 seed 对话，不 seed 角色
      await db.into(db.conversations).insert(
            ConversationsCompanion.insert(
              id: 'conv-no-char',
              characterId: 'no-such-char',
              title: const Value('无角色对话'),
              createdAt: Value(DateTime(2026, 1, 1)),
              updatedAt: Value(DateTime(2026, 1, 1)),
            ),
          );
      await _insertMessage(
        db,
        role: 'user',
        content: 'hi',
        conversationId: 'conv-no-char',
        seq: 1,
      );
      await _insertMessage(
        db,
        role: 'assistant',
        content: 'hey',
        conversationId: 'conv-no-char',
        seq: 2,
      );

      final llm = _CapturingLlm('summary');
      await SummarizeService(db, llm)
          .summarize('conv-no-char', _baseSettings());
      expect(llm.capturedMessages, isNull);
    });
  });
}
