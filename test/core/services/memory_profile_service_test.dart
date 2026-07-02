// 角色画像服务测试 — 覆盖 15 个用例组：画像 CRUD + 版本快照 + patch 队列 +
// claim_token 租约 + processMemoryProfileUpdateTasks 三路径 + LLM patch 解析 +
// render + prompt 构造 + 默认生成器经 HttpServer mock。
// 对齐主项目 src/lib/memory-profile.ts 行为。

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:drift/drift.dart' hide isNotNull, isNull;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/core/models/app_settings.dart';
import 'package:lumimuse/core/services/llm_service.dart';
import 'package:lumimuse/core/services/memory_profile_service.dart';

// ─────────────────────────────────────────────────────────────
// 测试辅助
// ─────────────────────────────────────────────────────────────

const _charId = 'char-profile';
const _charId2 = 'char-profile-2';

/// 假 LLM：避免 DB 测试触发真实网络调用。
/// DB 测试组（1-11）均通过 generatePatch 回调注入或 config 走 HttpServer mock，
/// 不应走到此实例；若意外走到，返回空 patch 以触发 skipped 路径兜底。
class _FakeLlmService extends LlmService {
  _FakeLlmService();

  @override
  Future<String> chatCompletion({
    required AppSettings settings,
    required List<ChatMessage> messages,
    OnUsageCallback? onUsage,
    CancelToken? cancelToken,
  }) async {
    return '{"patch":{}}';
  }
}

AppDatabase _createTestDb() {
  driftRuntimeOptions.dontWarnAboutMultipleDatabases = true;
  return AppDatabase.forTesting(NativeDatabase.memory());
}

Future<void> _seedCharacter(
  AppDatabase db, {
  String id = _charId,
  String name = '测试角色',
  String basicInfo = '',
  String personality = '',
  String scenario = '',
  String otherInfo = '',
}) async {
  await db.into(db.characters).insert(
        CharactersCompanion.insert(
          id: id,
          name: Value(name),
          basicInfo: basicInfo.isNotEmpty ? Value(basicInfo) : const Value.absent(),
          personality:
              personality.isNotEmpty ? Value(personality) : const Value.absent(),
          scenario: scenario.isNotEmpty ? Value(scenario) : const Value.absent(),
          otherInfo: otherInfo.isNotEmpty ? Value(otherInfo) : const Value.absent(),
          createdAt: Value(DateTime(2026, 1, 1)),
          updatedAt: Value(DateTime(2026, 1, 1)),
        ),
      );
}

/// 直接向 character_memory_profile_update_tasks 写一行（绕过 service 入队逻辑，
/// 用于构造 processing/lease 过期等场景）。
Future<int> _insertTaskRow(
  AppDatabase db, {
  required String characterId,
  String reason = 'test',
  required String patchJson,
  String status = 'pending',
  String? claimToken,
  int? leaseExpiresAt,
  int retryCount = 0,
  String? errorMessage,
  DateTime? createdAt,
  DateTime? updatedAt,
}) async {
  final now = DateTime.now();
  return db.into(db.characterMemoryProfileUpdateTasks).insert(
        CharacterMemoryProfileUpdateTasksCompanion.insert(
          characterId: characterId,
          reason: reason,
          patchJson: patchJson,
          status: Value(status),
          claimToken: claimToken != null ? Value(claimToken) : const Value.absent(),
          leaseExpiresAt:
              leaseExpiresAt != null ? Value(leaseExpiresAt) : const Value.absent(),
          retryCount: Value(retryCount),
          errorMessage:
              errorMessage != null ? Value(errorMessage) : const Value.absent(),
          createdAt: Value(createdAt ?? now),
          updatedAt: Value(updatedAt ?? now),
        ),
      );
}

/// HttpServer mock LLM — 返回固定 JSON body。
Future<HttpServer> _serveJson(
  Object body, {
  int statusCode = 200,
  void Function(HttpRequest)? onRequest,
}) async {
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  unawaited(
    server.forEach((request) async {
      if (onRequest != null) onRequest(request);
      request.response.statusCode = statusCode;
      request.response.headers.contentType = ContentType.json;
      request.response.write(jsonEncode(body));
      await request.response.close();
    }),
  );
  return server;
}

/// 构造 OpenAI 兼容 chat completion 响应 body。
Map<String, dynamic> _chatCompletionBody(String content) {
  return {
    'choices': [
      {
        'message': {'role': 'assistant', 'content': content},
        'finish_reason': 'stop',
      }
    ],
  };
}

// ─────────────────────────────────────────────────────────────
// 测试主体
// ─────────────────────────────────────────────────────────────

void main() {
  driftRuntimeOptions.dontWarnAboutMultipleDatabases = true;

  // ═══════════════════════════════════════════════════════════════
  // 1. getOrCreateMemoryProfile
  // ═══════════════════════════════════════════════════════════════
  group('1. getOrCreateMemoryProfile', () {
    test('首次调用插入空画像行', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final llm = _FakeLlmService();
      final svc = MemoryProfileService(db, llm);

      final profile = await svc.getOrCreateMemoryProfile(_charId);
      expect(profile.characterId, _charId);
      expect(profile.profileName, '');
      expect(profile.relationshipState, '');
      expect(profile.recentStoryState, '');
      expect(profile.emotionalBaseline, '');
      expect(profile.openThreads, isEmpty);
      expect(profile.userProfileSummary, '');
      expect(profile.pinnedSummary, '');

      // DB 层确有一行
      final rows = await db.select(db.characterMemoryProfiles).get();
      expect(rows.length, 1);
      expect(rows.first.characterId, _charId);

      llm.dispose();
    });

    test('第二次调用返回同一行（不重复插入）', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final llm = _FakeLlmService();
      final svc = MemoryProfileService(db, llm);

      final first = await svc.getOrCreateMemoryProfile(_charId);
      final second = await svc.getOrCreateMemoryProfile(_charId);
      expect(second.characterId, first.characterId);

      final rows = await db.select(db.characterMemoryProfiles).get();
      expect(rows.length, 1);

      llm.dispose();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 2. patchMemoryProfile
  // ═══════════════════════════════════════════════════════════════
  group('2. patchMemoryProfile', () {
    test('单字段更新写入并回读正确', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final llm = _FakeLlmService();
      final svc = MemoryProfileService(db, llm);

      final updated = await svc.patchMemoryProfile(
        _charId,
        MemoryProfilePatch(relationshipState: '朋友'),
      );
      expect(updated.relationshipState, '朋友');
      expect(updated.recentStoryState, ''); // 未触碰字段仍为空

      final reread = await svc.readMemoryProfile(_charId);
      expect(reread!.relationshipState, '朋友');

      llm.dispose();
    });

    test('多字段同时更新', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final llm = _FakeLlmService();
      final svc = MemoryProfileService(db, llm);

      final updated = await svc.patchMemoryProfile(
        _charId,
        MemoryProfilePatch(
          profileName: '主线',
          relationshipState: '恋人',
          recentStoryState: '旅行中',
          emotionalBaseline: '安心',
          userProfileSummary: '主人喜欢咖啡',
          pinnedSummary: '重要的事',
        ),
      );
      expect(updated.profileName, '主线');
      expect(updated.relationshipState, '恋人');
      expect(updated.recentStoryState, '旅行中');
      expect(updated.emotionalBaseline, '安心');
      expect(updated.userProfileSummary, '主人喜欢咖啡');
      expect(updated.pinnedSummary, '重要的事');

      llm.dispose();
    });

    test('open_threads 序列化为 JSON 字符串存库', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final llm = _FakeLlmService();
      final svc = MemoryProfileService(db, llm);

      await svc.patchMemoryProfile(
        _charId,
        MemoryProfilePatch(openThreads: ['话题A', '话题B']),
      );

      // 直接读 DB 行：open_threads 字段应为 JSON 字符串
      final row = await (db.select(db.characterMemoryProfiles)
            ..where((t) => t.characterId.equals(_charId)))
          .getSingle();
      expect(row.openThreads, '["话题A","话题B"]');

      // 通过 service 回读应解析为 List<String>
      final reread = await svc.readMemoryProfile(_charId);
      expect(reread!.openThreads, ['话题A', '话题B']);

      llm.dispose();
    });

    test('updated_at 在 patch 后推进', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final llm = _FakeLlmService();
      final svc = MemoryProfileService(db, llm);

      // 用明显的旧时间戳直接插行，避免 Drift DateTimeColumn 秒级精度导致
      // getOrCreate 与 patch 两次 DateTime.now() 落在同一秒。
      final oldTime = DateTime(2020, 1, 1);
      await db.into(db.characterMemoryProfiles).insert(
            CharacterMemoryProfilesCompanion.insert(
              characterId: _charId,
              updatedAt: Value(oldTime),
            ),
          );

      await svc.patchMemoryProfile(
        _charId,
        MemoryProfilePatch(relationshipState: '朋友'),
      );

      final after = await svc.readMemoryProfile(_charId);
      // patch 后 updatedAt 必然晚于 2020-01-01
      expect(after!.updatedAt.isAfter(oldTime), isTrue);

      llm.dispose();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 3. createMemoryProfileVersion
  // ═══════════════════════════════════════════════════════════════
  group('3. createMemoryProfileVersion', () {
    test('snapshot 内容与当前画像一致；version_number 从 1 递增', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final llm = _FakeLlmService();
      final svc = MemoryProfileService(db, llm);

      await svc.patchMemoryProfile(
        _charId,
        MemoryProfilePatch(relationshipState: '朋友', recentStoryState: '相遇'),
      );

      final v1 = await svc.createMemoryProfileVersion(_charId, reason: 'first');
      expect(v1.versionNumber, 1);
      expect(v1.snapshot.relationshipState, '朋友');
      expect(v1.snapshot.recentStoryState, '相遇');
      expect(v1.reason, 'first');

      final v2 = await svc.createMemoryProfileVersion(_charId, reason: 'second');
      expect(v2.versionNumber, 2);

      llm.dispose();
    });

    test('连续创建超过 MAX 时 trim 到 100', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final llm = _FakeLlmService();
      final svc = MemoryProfileService(db, llm);

      // 创建 105 个版本，超过 MAX_MEMORY_PROFILE_VERSIONS=100
      for (var i = 0; i < 105; i++) {
        await svc.createMemoryProfileVersion(_charId);
      }

      final versions = await svc.getMemoryProfileVersions(_charId, limit: 200);
      // 应被 trim 到 100
      expect(versions.length, maxMemoryProfileVersions);
      // 保留 version_number DESC 前 100（即 6..105，version_number 值）
      expect(versions.first.versionNumber, 105);
      expect(versions.last.versionNumber, 6);

      llm.dispose();
    }, timeout: const Timeout(Duration(seconds: 30)));
  });

  // ═══════════════════════════════════════════════════════════════
  // 4. getMemoryProfileVersions
  // ═══════════════════════════════════════════════════════════════
  group('4. getMemoryProfileVersions', () {
    test('按 version_number DESC 排序', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final llm = _FakeLlmService();
      final svc = MemoryProfileService(db, llm);

      for (var i = 0; i < 3; i++) {
        await svc.createMemoryProfileVersion(_charId);
      }

      final versions = await svc.getMemoryProfileVersions(_charId);
      expect(versions.length, 3);
      expect(versions[0].versionNumber, 3);
      expect(versions[1].versionNumber, 2);
      expect(versions[2].versionNumber, 1);

      llm.dispose();
    });

    test('默认 limit=50', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final llm = _FakeLlmService();
      final svc = MemoryProfileService(db, llm);

      // 创建 60 个版本（不会触发 trim，因为 60 < 100）
      for (var i = 0; i < 60; i++) {
        await svc.createMemoryProfileVersion(_charId);
      }

      final defaultResult = await svc.getMemoryProfileVersions(_charId);
      expect(defaultResult.length, 50);

      final explicitResult =
          await svc.getMemoryProfileVersions(_charId, limit: 60);
      expect(explicitResult.length, 60);

      llm.dispose();
    }, timeout: const Timeout(Duration(seconds: 30)));

    test('limit 上限为 100', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final llm = _FakeLlmService();
      final svc = MemoryProfileService(db, llm);

      for (var i = 0; i < 105; i++) {
        await svc.createMemoryProfileVersion(_charId);
      }
      // trim 后剩 100 个；显式请求 limit=200 也只能拿到 100
      final result = await svc.getMemoryProfileVersions(_charId, limit: 200);
      expect(result.length, 100);

      llm.dispose();
    }, timeout: const Timeout(Duration(seconds: 30)));

    test('offset 分页', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final llm = _FakeLlmService();
      final svc = MemoryProfileService(db, llm);

      for (var i = 0; i < 5; i++) {
        await svc.createMemoryProfileVersion(_charId);
      }

      final page1 = await svc.getMemoryProfileVersions(_charId, limit: 2, offset: 0);
      final page2 = await svc.getMemoryProfileVersions(_charId, limit: 2, offset: 2);
      expect(page1.length, 2);
      expect(page2.length, 2);
      // page1 是 v5/v4，page2 是 v3/v2，不应重叠
      expect(page1.first.versionNumber, 5);
      expect(page2.first.versionNumber, 3);

      llm.dispose();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 5. deleteMemoryProfileVersion
  // ═══════════════════════════════════════════════════════════════
  group('5. deleteMemoryProfileVersion', () {
    test('删除存在的版本返回 true', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final llm = _FakeLlmService();
      final svc = MemoryProfileService(db, llm);

      final v = await svc.createMemoryProfileVersion(_charId);
      final deleted = await svc.deleteMemoryProfileVersion(_charId, v.id);
      expect(deleted, isTrue);

      final remaining = await svc.getMemoryProfileVersions(_charId);
      expect(remaining, isEmpty);

      llm.dispose();
    });

    test('删除不存在的版本返回 false', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final llm = _FakeLlmService();
      final svc = MemoryProfileService(db, llm);

      final deleted = await svc.deleteMemoryProfileVersion(_charId, 99999);
      expect(deleted, isFalse);

      llm.dispose();
    });

    test('characterId 不匹配时返回 false', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);
      await _seedCharacter(db, id: _charId2);

      final llm = _FakeLlmService();
      final svc = MemoryProfileService(db, llm);

      final v = await svc.createMemoryProfileVersion(_charId);
      // 用 _charId2 去删 _charId 的版本：characterId 不匹配，应返回 false
      final deleted = await svc.deleteMemoryProfileVersion(_charId2, v.id);
      expect(deleted, isFalse);

      llm.dispose();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 6. rollbackMemoryProfile
  // ═══════════════════════════════════════════════════════════════
  group('6. rollbackMemoryProfile', () {
    test('rollback 到指定 version 应用其 snapshot', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final llm = _FakeLlmService();
      final svc = MemoryProfileService(db, llm);

      // 初始画像：朋友
      await svc.patchMemoryProfile(
        _charId,
        MemoryProfilePatch(relationshipState: '朋友'),
      );
      final v1 = await svc.createMemoryProfileVersion(_charId, reason: 'v1');

      // 推进：恋人
      await svc.patchMemoryProfile(
        _charId,
        MemoryProfilePatch(relationshipState: '恋人'),
      );
      final afterSecond = await svc.readMemoryProfile(_charId);
      expect(afterSecond!.relationshipState, '恋人');

      // rollback 到 v1
      final rolled = await svc.rollbackMemoryProfile(_charId, v1.id);
      expect(rolled.relationshipState, '朋友');

      llm.dispose();
    });

    test('snapshot 空内容时返回 getOrCreate 结果', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final llm = _FakeLlmService();
      final svc = MemoryProfileService(db, llm);

      // 不写任何内容直接创建版本 → snapshot 全空
      final v = await svc.createMemoryProfileVersion(_charId);
      // 推进画像
      await svc.patchMemoryProfile(
        _charId,
        MemoryProfilePatch(relationshipState: '朋友'),
      );

      // rollback 到空 snapshot：应返回 getOrCreate 结果（不抛错）
      final rolled = await svc.rollbackMemoryProfile(_charId, v.id);
      expect(rolled.characterId, _charId);
      // 因 snapshot 空内容，rollback 直接返回 getOrCreate，当前画像已是「朋友」
      // （getOrCreate 不覆盖已有内容）
      expect(rolled.relationshipState, '朋友');

      llm.dispose();
    });

    test('rollback 不存在的 version 抛错', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final llm = _FakeLlmService();
      final svc = MemoryProfileService(db, llm);

      await expectLater(
        svc.rollbackMemoryProfile(_charId, 99999),
        throwsA(isA<Exception>()),
      );

      llm.dispose();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 7. enqueueMemoryProfileUpdate / enqueueMemoryProfilePatchExtraction
  // ═══════════════════════════════════════════════════════════════
  group('7. enqueueMemoryProfileUpdate / enqueueMemoryProfilePatchExtraction', () {
    test('enqueueMemoryProfileUpdate 写入 pending 行 + patch_json 序列化正确', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final llm = _FakeLlmService();
      final svc = MemoryProfileService(db, llm);

      final patch = MemoryProfilePatch(
        relationshipState: '朋友',
        openThreads: ['话题'],
      );
      final task = await svc.enqueueMemoryProfileUpdate(
        _charId,
        patch,
        reason: 'manual',
      );

      expect(task.characterId, _charId);
      expect(task.reason, 'manual');
      expect(task.status, 'pending');
      expect(task.retryCount, 0);
      expect(task.patch.relationshipState, '朋友');
      expect(task.patch.openThreads, ['话题']);
      expect(task.sourceText, isEmpty); // 非 extraction 任务

      // patch_json 应为序列化后的 JSON 字符串
      final row = await (db.select(db.characterMemoryProfileUpdateTasks)
            ..where((t) => t.id.equals(task.id)))
          .getSingle();
      expect(row.patchJson, jsonEncode(patch.toJson()));

      llm.dispose();
    });

    test('enqueueMemoryProfilePatchExtraction 写入 pending 行 + source_text 解析', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final llm = _FakeLlmService();
      final svc = MemoryProfileService(db, llm);

      const sourceText = '用户提到明天要去看电影';
      final task = await svc.enqueueMemoryProfilePatchExtraction(
        _charId,
        sourceText,
        reason: 'extraction',
      );

      expect(task.characterId, _charId);
      expect(task.reason, 'extraction');
      expect(task.status, 'pending');
      expect(task.sourceText, sourceText);
      // extraction 任务的 patch 字段应为空（待 LLM 生成）
      expect(hasPatchChanges(task.patch), isFalse);

      // patch_json 应为 {"source_text":"..."} 形式
      final row = await (db.select(db.characterMemoryProfileUpdateTasks)
            ..where((t) => t.id.equals(task.id)))
          .getSingle();
      expect(jsonDecode(row.patchJson), {'source_text': sourceText});

      llm.dispose();
    });

    test('默认 reason 为 memory_extraction', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final llm = _FakeLlmService();
      final svc = MemoryProfileService(db, llm);

      final task = await svc.enqueueMemoryProfileUpdate(
        _charId,
        MemoryProfilePatch(relationshipState: 'x'),
      );
      expect(task.reason, 'memory_extraction');

      final task2 = await svc.enqueueMemoryProfilePatchExtraction(
        _charId,
        'source',
      );
      expect(task2.reason, 'memory_extraction');

      llm.dispose();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 8. getMemoryProfileUpdateTasks / getMemoryProfileTaskSummaries
  // ═══════════════════════════════════════════════════════════════
  group('8. getMemoryProfileUpdateTasks / getMemoryProfileTaskSummaries', () {
    test('getMemoryProfileUpdateTasks 返回解析后的 patch + sourceText', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final llm = _FakeLlmService();
      final svc = MemoryProfileService(db, llm);

      await svc.enqueueMemoryProfileUpdate(
        _charId,
        MemoryProfilePatch(relationshipState: '朋友'),
      );
      await svc.enqueueMemoryProfilePatchExtraction(_charId, '新信号');

      final tasks = await svc.getMemoryProfileUpdateTasks(_charId);
      expect(tasks.length, 2);
      // 按 id ASC 排序：第一个是 patch 任务，第二个是 extraction 任务
      expect(tasks[0].patch.relationshipState, '朋友');
      expect(tasks[0].sourceText, isEmpty);
      expect(tasks[1].sourceText, '新信号');
      expect(hasPatchChanges(tasks[1].patch), isFalse);

      llm.dispose();
    });

    test('getMemoryProfileTaskSummaries 不含 patch_json/claim_token/lease', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final llm = _FakeLlmService();
      final svc = MemoryProfileService(db, llm);

      await svc.enqueueMemoryProfileUpdate(
        _charId,
        MemoryProfilePatch(relationshipState: '朋友'),
      );

      final summaries = await svc.getMemoryProfileTaskSummaries(_charId);
      expect(summaries.length, 1);
      final s = summaries.first;
      expect(s.characterId, _charId);
      expect(s.reason, 'memory_extraction');
      expect(s.status, 'pending');
      expect(s.retryCount, 0);
      expect(s.errorMessage, isNull);
      // MemoryProfileTaskSummary 类不包含 patch/claimToken/leaseExpiresAt 字段
      // （编译期保证，无需运行时断言）

      llm.dispose();
    });

    test('按 id ASC 排序', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final llm = _FakeLlmService();
      final svc = MemoryProfileService(db, llm);

      for (var i = 0; i < 3; i++) {
        await svc.enqueueMemoryProfilePatchExtraction(_charId, '信号$i');
      }

      final tasks = await svc.getMemoryProfileUpdateTasks(_charId);
      expect(tasks.length, 3);
      expect(tasks[0].id < tasks[1].id, isTrue);
      expect(tasks[1].id < tasks[2].id, isTrue);

      llm.dispose();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 9. claimMemoryProfileUpdateTasks
  // ═══════════════════════════════════════════════════════════════
  group('9. claimMemoryProfileUpdateTasks', () {
    test('claim pending 任务：翻 processing + 写 claim_token + lease', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final llm = _FakeLlmService();
      final svc = MemoryProfileService(db, llm);

      await _insertTaskRow(
        db,
        characterId: _charId,
        patchJson: jsonEncode({'source_text': 'x'}),
      );

      final claimed = await svc.claimMemoryProfileUpdateTasks(10, 300);
      expect(claimed.length, 1);
      expect(claimed.first.status, 'processing');
      expect(claimed.first.claimToken, isNotNull);
      expect(claimed.first.leaseExpiresAt, isNotNull);

      // DB 行确被翻 processing
      final row = await (db.select(db.characterMemoryProfileUpdateTasks)
            ..where((t) => t.id.equals(claimed.first.id)))
          .getSingle();
      expect(row.status, 'processing');
      expect(row.claimToken, claimed.first.claimToken);

      llm.dispose();
    });

    test('processing + lease 过期可重新 claim', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final llm = _FakeLlmService();
      final svc = MemoryProfileService(db, llm);

      // 插入一条 processing 且 lease 已过期（5 分钟前）的孤儿任务
      final expiredLease =
          DateTime.now().subtract(const Duration(minutes: 5)).millisecondsSinceEpoch;
      await _insertTaskRow(
        db,
        characterId: _charId,
        patchJson: jsonEncode({'source_text': 'x'}),
        status: 'processing',
        claimToken: 'old-token',
        leaseExpiresAt: expiredLease,
      );

      final claimed = await svc.claimMemoryProfileUpdateTasks(10, 300);
      expect(claimed.length, 1);
      // claim_token 应被新 token 覆盖
      expect(claimed.first.claimToken, isNot('old-token'));
      expect(claimed.first.status, 'processing');

      llm.dispose();
    });

    test('processing + lease 未过期不被 claim', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final llm = _FakeLlmService();
      final svc = MemoryProfileService(db, llm);

      // 插入一条 processing 且 lease 仍有效（5 分钟后到期）的任务
      final validLease =
          DateTime.now().add(const Duration(minutes: 5)).millisecondsSinceEpoch;
      await _insertTaskRow(
        db,
        characterId: _charId,
        patchJson: jsonEncode({'source_text': 'x'}),
        status: 'processing',
        claimToken: 'current-token',
        leaseExpiresAt: validLease,
      );

      final claimed = await svc.claimMemoryProfileUpdateTasks(10, 300);
      expect(claimed, isEmpty);

      llm.dispose();
    });

    test('characterId 过滤：只 claim 指定角色', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);
      await _seedCharacter(db, id: _charId2);

      final llm = _FakeLlmService();
      final svc = MemoryProfileService(db, llm);

      await _insertTaskRow(
        db,
        characterId: _charId,
        patchJson: jsonEncode({'source_text': 'x1'}),
      );
      await _insertTaskRow(
        db,
        characterId: _charId2,
        patchJson: jsonEncode({'source_text': 'x2'}),
      );

      final claimed = await svc.claimMemoryProfileUpdateTasks(
        10,
        300,
        characterId: _charId,
      );
      expect(claimed.length, 1);
      expect(claimed.first.characterId, _charId);

      llm.dispose();
    });

    test('taskId 过滤：只 claim 指定 id', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final llm = _FakeLlmService();
      final svc = MemoryProfileService(db, llm);

      final id1 = await _insertTaskRow(
        db,
        characterId: _charId,
        patchJson: jsonEncode({'source_text': 'x1'}),
      );
      final id2 = await _insertTaskRow(
        db,
        characterId: _charId,
        patchJson: jsonEncode({'source_text': 'x2'}),
      );

      final claimed = await svc.claimMemoryProfileUpdateTasks(
        10,
        300,
        taskId: id2,
      );
      expect(claimed.length, 1);
      expect(claimed.first.id, id2);
      expect(claimed.first.id, isNot(id1));

      llm.dispose();
    });

    test('throughTaskId 过滤：claim id <= throughTaskId 的任务', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final llm = _FakeLlmService();
      final svc = MemoryProfileService(db, llm);

      final id1 = await _insertTaskRow(
        db,
        characterId: _charId,
        patchJson: jsonEncode({'source_text': 'x1'}),
      );
      final id2 = await _insertTaskRow(
        db,
        characterId: _charId,
        patchJson: jsonEncode({'source_text': 'x2'}),
      );
      final id3 = await _insertTaskRow(
        db,
        characterId: _charId,
        patchJson: jsonEncode({'source_text': 'x3'}),
      );

      final claimed = await svc.claimMemoryProfileUpdateTasks(
        100,
        300,
        throughTaskId: id2,
      );
      // 应 claim id1 和 id2，不包括 id3
      expect(claimed.length, 2);
      expect(claimed.map((t) => t.id).toList()..sort(), [id1, id2]);

      // id3 仍为 pending
      final row3 = await (db.select(db.characterMemoryProfileUpdateTasks)
            ..where((t) => t.id.equals(id3)))
          .getSingle();
      expect(row3.status, 'pending');

      llm.dispose();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 10. recoverStaleMemoryProfileTasks
  // ═══════════════════════════════════════════════════════════════
  group('10. recoverStaleMemoryProfileTasks', () {
    test('把 processing 行翻回 pending + 清 claim_token/lease', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final llm = _FakeLlmService();
      final svc = MemoryProfileService(db, llm);

      final futureLease =
          DateTime.now().add(const Duration(minutes: 5)).millisecondsSinceEpoch;
      await _insertTaskRow(
        db,
        characterId: _charId,
        patchJson: jsonEncode({'source_text': 'x'}),
        status: 'processing',
        claimToken: 'tok-1',
        leaseExpiresAt: futureLease,
      );
      await _insertTaskRow(
        db,
        characterId: _charId,
        patchJson: jsonEncode({'source_text': 'y'}),
        status: 'processing',
        claimToken: 'tok-2',
        leaseExpiresAt: futureLease,
      );

      final changed = await svc.recoverStaleMemoryProfileTasks();
      expect(changed, 2);

      final rows = await db.select(db.characterMemoryProfileUpdateTasks).get();
      expect(rows.every((r) => r.status == 'pending'), isTrue);
      expect(rows.every((r) => r.claimToken == null), isTrue);
      expect(rows.every((r) => r.leaseExpiresAt == null), isTrue);

      llm.dispose();
    });

    test('已 done/failed 的行不受影响', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final llm = _FakeLlmService();
      final svc = MemoryProfileService(db, llm);

      await _insertTaskRow(
        db,
        characterId: _charId,
        patchJson: jsonEncode({'source_text': 'x'}),
        status: 'done',
      );
      await _insertTaskRow(
        db,
        characterId: _charId,
        patchJson: jsonEncode({'source_text': 'y'}),
        status: 'failed',
        retryCount: 2,
        errorMessage: 'prev error',
      );

      final changed = await svc.recoverStaleMemoryProfileTasks();
      expect(changed, 0);

      final rows = await db.select(db.characterMemoryProfileUpdateTasks).get();
      final doneRow = rows.firstWhere((r) => r.status == 'done');
      final failedRow = rows.firstWhere((r) => r.status == 'failed');
      expect(doneRow.status, 'done');
      expect(failedRow.status, 'failed');
      expect(failedRow.retryCount, 2);
      expect(failedRow.errorMessage, 'prev error');

      llm.dispose();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 11. processMemoryProfileUpdateTasks
  // ═══════════════════════════════════════════════════════════════
  group('11. processMemoryProfileUpdateTasks', () {
    test('generatePatch 返回有效 patch → 应用 + 创建版本 + 翻 done', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final llm = _FakeLlmService();
      final svc = MemoryProfileService(db, llm);

      await svc.enqueueMemoryProfilePatchExtraction(_charId, '新信号');

      final result = await svc.processMemoryProfileUpdateTasks(
        limit: 10,
        leaseSeconds: 300,
        generatePatch: (task, profile) async {
          return MemoryProfilePatch(relationshipState: '朋友');
        },
      );

      expect(result.claimed, 1);
      expect(result.processed, 1);
      expect(result.skipped, 0);
      expect(result.failed, 0);
      expect(result.profiles.length, 1);
      expect(result.profiles.first.relationshipState, '朋友');

      // 画像已更新
      final profile = await svc.readMemoryProfile(_charId);
      expect(profile!.relationshipState, '朋友');

      // 版本已创建
      final versions = await svc.getMemoryProfileVersions(_charId);
      expect(versions.length, 1);
      expect(versions.first.snapshot.relationshipState, '朋友');

      // 任务翻 done
      final tasks = await svc.getMemoryProfileUpdateTasks(_charId);
      expect(tasks.first.status, 'done');
      expect(tasks.first.claimToken, isNull);
      expect(tasks.first.leaseExpiresAt, isNull);

      llm.dispose();
    });

    test('generatePatch 返回空 patch → skipped + error_message=empty profile patch skipped', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final llm = _FakeLlmService();
      final svc = MemoryProfileService(db, llm);

      await svc.enqueueMemoryProfilePatchExtraction(_charId, '无价值信号');

      final result = await svc.processMemoryProfileUpdateTasks(
        limit: 10,
        leaseSeconds: 300,
        generatePatch: (task, profile) async {
          return MemoryProfilePatch(); // 空 patch
        },
      );

      expect(result.claimed, 1);
      expect(result.skipped, 1);
      expect(result.processed, 0);
      expect(result.failed, 0);

      final tasks = await svc.getMemoryProfileUpdateTasks(_charId);
      expect(tasks.first.status, 'done');
      expect(tasks.first.errorMessage, 'empty profile patch skipped');

      // 没有版本创建
      final versions = await svc.getMemoryProfileVersions(_charId);
      expect(versions, isEmpty);

      llm.dispose();
    });

    test('generatePatch 抛异常 → 翻 failed + retry_count++', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final llm = _FakeLlmService();
      final svc = MemoryProfileService(db, llm);

      await svc.enqueueMemoryProfilePatchExtraction(_charId, '坏信号');

      final result = await svc.processMemoryProfileUpdateTasks(
        limit: 10,
        leaseSeconds: 300,
        generatePatch: (task, profile) async {
          throw Exception('LLM 失败');
        },
      );

      expect(result.claimed, 1);
      expect(result.failed, 1);
      expect(result.processed, 0);

      final tasks = await svc.getMemoryProfileUpdateTasks(_charId);
      expect(tasks.first.status, 'failed');
      expect(tasks.first.retryCount, 1);
      expect(tasks.first.errorMessage, contains('LLM 失败'));
      expect(tasks.first.claimToken, isNull);
      expect(tasks.first.leaseExpiresAt, isNull);

      llm.dispose();
    });

    test('claim_token 抢占：generatePatch 期间被改写 → confirmTaskClaimForWrite 失败 → skipped', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final llm = _FakeLlmService();
      final svc = MemoryProfileService(db, llm);

      await svc.enqueueMemoryProfilePatchExtraction(_charId, '新信号');

      final result = await svc.processMemoryProfileUpdateTasks(
        limit: 10,
        leaseSeconds: 300,
        generatePatch: (task, profile) async {
          // 模拟另一个 worker 在 generatePatch 期间抢占了任务：
          // 把 claim_token 改写成别的值，让原 holder 的 confirmTaskClaimForWrite 失败
          await (db.update(db.characterMemoryProfileUpdateTasks)
                ..where((t) => t.id.equals(task.id)))
              .write(const CharacterMemoryProfileUpdateTasksCompanion(
                claimToken: Value('stolen-by-other'),
              ));
          return MemoryProfilePatch(relationshipState: '应被丢弃');
        },
      );

      // confirm 失败 → skipped 路径，patch 未应用
      expect(result.skipped, 1);
      expect(result.processed, 0);

      // 画像未被改写
      final profile = await svc.readMemoryProfile(_charId);
      expect(profile!.relationshipState, '');

      // 任务保持 processing 状态（被 stolen token 持有，未翻 done）
      final rows = await db.select(db.characterMemoryProfileUpdateTasks).get();
      expect(rows.first.status, 'processing');
      expect(rows.first.claimToken, 'stolen-by-other');

      llm.dispose();
    });

    test('已含 patch 任务（非 extraction）：直接应用 task.patch 不调 generator', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final llm = _FakeLlmService();
      final svc = MemoryProfileService(db, llm);

      // 入队一个已含 patch 的任务（非 extraction）
      await svc.enqueueMemoryProfileUpdate(
        _charId,
        MemoryProfilePatch(relationshipState: '直接 patch'),
      );

      var generatorCalled = false;
      final result = await svc.processMemoryProfileUpdateTasks(
        limit: 10,
        leaseSeconds: 300,
        generatePatch: (task, profile) async {
          generatorCalled = true;
          return MemoryProfilePatch();
        },
      );

      // 已含 patch 任务不调 generator（sourceText 为空走 task.patch 分支）
      expect(generatorCalled, isFalse);
      expect(result.processed, 1);
      expect(result.profiles.first.relationshipState, '直接 patch');

      llm.dispose();
    });

    test('无 pending 任务时返回 noPendingTasks=true', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final llm = _FakeLlmService();
      final svc = MemoryProfileService(db, llm);

      final result = await svc.processMemoryProfileUpdateTasks(
        limit: 10,
        leaseSeconds: 300,
        generatePatch: (task, profile) async => MemoryProfilePatch(),
      );

      expect(result.claimed, 0);
      expect(result.noPendingTasks, isTrue);
      expect(result.hasPendingTasks, isFalse);
      expect(result.message, 'no pending tasks');

      llm.dispose();
    });

    test('generatePatch 与 config 同时缺失 → 抛 "LLM provider is not configured"', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final llm = _FakeLlmService();
      final svc = MemoryProfileService(db, llm);

      await expectLater(
        svc.processMemoryProfileUpdateTasks(),
        throwsA(isA<Exception>().having(
          (e) => e.toString(),
          'message',
          contains('LLM provider is not configured'),
        )),
      );

      llm.dispose();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 12. parseMemoryProfilePatchResponse
  // ═══════════════════════════════════════════════════════════════
  group('12. parseMemoryProfilePatchResponse', () {
    test('纯 JSON 对象（patch 包装形式）', () {
      final patch = parseMemoryProfilePatchResponse(
        '{"patch":{"relationship_state":"朋友","open_threads":["a","b"]}}',
      );
      expect(patch.relationshipState, '朋友');
      expect(patch.openThreads, ['a', 'b']);
    });

    test('纯 JSON 对象（裸对象形式，无 patch 包装）', () {
      final patch = parseMemoryProfilePatchResponse(
        '{"relationship_state":"朋友"}',
      );
      expect(patch.relationshipState, '朋友');
    });

    test('```json 代码块包裹', () {
      final patch = parseMemoryProfilePatchResponse(
        '```json\n{"patch":{"relationship_state":"朋友"}}\n```',
      );
      expect(patch.relationshipState, '朋友');
    });

    test('``` 代码块（无 lang 标识）', () {
      final patch = parseMemoryProfilePatchResponse(
        '```\n{"patch":{"emotional_baseline":"安心"}}\n```',
      );
      expect(patch.emotionalBaseline, '安心');
    });

    test('带前后噪音文本 + 平衡 JSON 提取', () {
      final patch = parseMemoryProfilePatchResponse(
        '好的，这是 patch：\n{"patch":{"recent_story_state":"旅行中"}}\n完成。',
      );
      expect(patch.recentStoryState, '旅行中');
    });

    test('不含 JSON 对象 → 抛错', () {
      expect(
        () => parseMemoryProfilePatchResponse('没有 JSON 在这里'),
        throwsA(isA<Exception>().having(
          (e) => e.toString(),
          'message',
          contains('memory profile patch parsing failed'),
        )),
      );
    });

    test('root 为非对象（数组）→ 抛错', () {
      expect(
        () => parseMemoryProfilePatchResponse('[1,2,3]'),
        throwsA(isA<Exception>()),
      );
    });

    test('patch 字段为非对象 → 抛错', () {
      expect(
        () => parseMemoryProfilePatchResponse('{"patch":"not an object"}'),
        throwsA(isA<Exception>()),
      );
    });

    test('空 patch {"patch":{}} 返回无变更 patch', () {
      final patch = parseMemoryProfilePatchResponse('{"patch":{}}');
      expect(hasPatchChanges(patch), isFalse);
    });

    test('open_threads 含非字符串项被过滤', () {
      final patch = parseMemoryProfilePatchResponse(
        '{"patch":{"open_threads":["有效", 123, null, ""]}}',
      );
      // 仅 "有效" 通过 trim + 非空过滤；123/null/"" 被丢弃
      expect(patch.openThreads, ['有效']);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 13. renderMemoryProfile
  // ═══════════════════════════════════════════════════════════════
  group('13. renderMemoryProfile', () {
    test('全字段渲染', () {
      final profile = MemoryProfile(
        characterId: 'c',
        relationshipState: '朋友',
        recentStoryState: '旅行中',
        emotionalBaseline: '安心',
        openThreads: const ['话题A', '话题B'],
        userProfileSummary: '主人喜欢咖啡',
        pinnedSummary: '重要事件',
        updatedAt: DateTime(2026, 1, 1),
      );
      final rendered = renderMemoryProfile(profile);
      expect(rendered, contains('记忆画像：'));
      expect(rendered, contains('关系状态：朋友'));
      expect(rendered, contains('近期故事状态：旅行中'));
      expect(rendered, contains('情绪基线：安心'));
      expect(rendered, contains('进行中的话题：话题A；话题B'));
      expect(rendered, contains('主人画像：主人喜欢咖啡'));
      expect(rendered, contains('置顶摘要：重要事件'));
    });

    test('部分字段为空：只渲染非空字段', () {
      final profile = MemoryProfile(
        characterId: 'c',
        relationshipState: '朋友',
        recentStoryState: '',
        emotionalBaseline: '  ', // 空白
        openThreads: const [],
        userProfileSummary: '',
        pinnedSummary: '',
        updatedAt: DateTime(2026, 1, 1),
      );
      final rendered = renderMemoryProfile(profile);
      expect(rendered, contains('关系状态：朋友'));
      // 空字段不应出现
      expect(rendered, isNot(contains('近期故事状态')));
      expect(rendered, isNot(contains('情绪基线')));
      expect(rendered, isNot(contains('进行中的话题')));
      expect(rendered, isNot(contains('主人画像')));
      expect(rendered, isNot(contains('置顶摘要')));
    });

    test('全空返回空字符串', () {
      final profile = MemoryProfile(
        characterId: 'c',
        updatedAt: DateTime(2026, 1, 1),
      );
      expect(renderMemoryProfile(profile), '');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 14. buildMemoryProfilePatchPrompt
  // ═══════════════════════════════════════════════════════════════
  group('14. buildMemoryProfilePatchPrompt', () {
    test('含 characterInfo / task.reason / sourceText / 当前画像 JSON', () {
      final task = MemoryProfileUpdateTask(
        id: 1,
        characterId: 'c1',
        reason: 'memory_extraction',
        patch: MemoryProfilePatch(),
        sourceText: '用户提到明天要考试',
        status: 'pending',
        claimToken: null,
        leaseExpiresAt: null,
        retryCount: 0,
        errorMessage: null,
        createdAt: DateTime(2026, 1, 1),
        updatedAt: DateTime(2026, 1, 1),
      );
      final currentProfile = MemoryProfile(
        characterId: 'c1',
        relationshipState: '朋友',
        updatedAt: DateTime(2026, 1, 1),
      );
      const characterInfo = '角色名称：艾莉丝\n基本信息：猫娘';

      final prompt = buildMemoryProfilePatchPrompt(
        task,
        currentProfile,
        '用户提到明天要考试',
        characterInfo,
      );

      expect(prompt, contains('角色名称：艾莉丝'));
      expect(prompt, contains('基本信息：猫娘'));
      expect(prompt, contains('任务原因：memory_extraction'));
      expect(prompt, contains('新信号：用户提到明天要考试'));
      // 当前画像 JSON 应含 relationship_state
      expect(prompt, contains('"relationship_state":"朋友"'));
      // 输出格式提示
      expect(prompt, contains('输出格式：{"patch"'));
    });

    test('characterInfo 为空时 prompt 仍可构造', () {
      final task = MemoryProfileUpdateTask(
        id: 1,
        characterId: 'c1',
        reason: 'manual',
        patch: MemoryProfilePatch(),
        sourceText: '信号',
        status: 'pending',
        claimToken: null,
        leaseExpiresAt: null,
        retryCount: 0,
        errorMessage: null,
        createdAt: DateTime(2026, 1, 1),
        updatedAt: DateTime(2026, 1, 1),
      );
      final currentProfile = MemoryProfile(
        characterId: 'c1',
        updatedAt: DateTime(2026, 1, 1),
      );

      final prompt = buildMemoryProfilePatchPrompt(
        task,
        currentProfile,
        '信号',
        '',
      );

      expect(prompt, contains('任务原因：manual'));
      expect(prompt, contains('新信号：信号'));
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 15. _generateMemoryProfilePatchWithLlm (via processMemoryProfileUpdateTasks)
  // ═══════════════════════════════════════════════════════════════
  group('15. _generateMemoryProfilePatchWithLlm (via processMemoryProfileUpdateTasks)', () {
    test('LLM 返回有效 patch JSON → profile 更新 + version 创建', () async {
      final server = await _serveJson(_chatCompletionBody(
        '{"patch":{"relationship_state":"朋友","recent_story_state":"相遇"}}',
      ));
      addTearDown(() => server.close(force: true));

      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db, name: '艾莉丝', basicInfo: '猫娘', personality: '温柔');

      final llm = LlmService(dio: Dio());
      addTearDown(() => llm.dispose());
      final svc = MemoryProfileService(db, llm);
      await svc.enqueueMemoryProfilePatchExtraction(_charId, '新信号');

      final result = await svc.processMemoryProfileUpdateTasks(
        limit: 1,
        config: MemoryProfilePatchConfig(
          apiBase: 'http://127.0.0.1:${server.port}',
          apiKey: 'test-key',
          model: 'test-model',
          maxTokens: 4096,
        ),
      );

      expect(result.claimed, 1);
      expect(result.processed, 1);
      expect(result.failed, 0);

      final profile = await svc.readMemoryProfile(_charId);
      expect(profile!.relationshipState, '朋友');
      expect(profile.recentStoryState, '相遇');

      final versions = await svc.getMemoryProfileVersions(_charId);
      expect(versions.length, 1);
      expect(versions.first.snapshot.relationshipState, '朋友');

      final tasks = await svc.getMemoryProfileUpdateTasks(_charId);
      expect(tasks.first.status, 'done');
    });

    test('LLM 返回空 patch {"patch":{}} → skipped 路径', () async {
      final server = await _serveJson(_chatCompletionBody('{"patch":{}}'));
      addTearDown(() => server.close(force: true));

      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final llm = LlmService(dio: Dio());
      addTearDown(() => llm.dispose());
      final svc = MemoryProfileService(db, llm);
      await svc.enqueueMemoryProfilePatchExtraction(_charId, '无价值信号');

      final result = await svc.processMemoryProfileUpdateTasks(
        limit: 1,
        config: MemoryProfilePatchConfig(
          apiBase: 'http://127.0.0.1:${server.port}',
          apiKey: 'test-key',
          model: 'test-model',
          maxTokens: 4096,
        ),
      );

      expect(result.claimed, 1);
      expect(result.skipped, 1);
      expect(result.processed, 0);

      final tasks = await svc.getMemoryProfileUpdateTasks(_charId);
      expect(tasks.first.status, 'done');
      expect(tasks.first.errorMessage, 'empty profile patch skipped');

      // 没有版本创建
      final versions = await svc.getMemoryProfileVersions(_charId);
      expect(versions, isEmpty);
    });

    test('apiBase 缺失 → 抛 "LLM provider is not configured"，任务翻 failed', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final llm = LlmService(dio: Dio());
      addTearDown(() => llm.dispose());
      final svc = MemoryProfileService(db, llm);
      await svc.enqueueMemoryProfilePatchExtraction(_charId, '新信号');

      final result = await svc.processMemoryProfileUpdateTasks(
        limit: 1,
        config: const MemoryProfilePatchConfig(
          apiBase: '',
          apiKey: '',
          model: '',
          maxTokens: 4096,
        ),
      );

      expect(result.claimed, 1);
      expect(result.failed, 1);
      final tasks = await svc.getMemoryProfileUpdateTasks(_charId);
      expect(tasks.first.status, 'failed');
      expect(tasks.first.retryCount, 1);
      expect(tasks.first.errorMessage, contains('LLM provider is not configured'));
    });

    test('model 缺失 → 抛 "LLM provider is not configured"，任务翻 failed', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final llm = LlmService(dio: Dio());
      addTearDown(() => llm.dispose());
      final svc = MemoryProfileService(db, llm);
      await svc.enqueueMemoryProfilePatchExtraction(_charId, '新信号');

      final result = await svc.processMemoryProfileUpdateTasks(
        limit: 1,
        config: const MemoryProfilePatchConfig(
          apiBase: 'http://127.0.0.1:9999',
          apiKey: 'k',
          model: '',
          maxTokens: 4096,
        ),
      );

      expect(result.failed, 1);
      final tasks = await svc.getMemoryProfileUpdateTasks(_charId);
      expect(tasks.first.errorMessage, contains('LLM provider is not configured'));
    });
  });
}
