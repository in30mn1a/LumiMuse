import 'dart:convert';
import 'dart:io';

import 'package:drift/drift.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:uuid/uuid.dart';
import '../database/database.dart';
import '../models/message_metadata.dart';
import '../utils/local_asset_utils.dart';
import 'character_images_actions.dart';
import 'database_provider.dart';

/// 角色列表 Provider — 按 sort_order 排序
final characterListProvider = StreamProvider<List<Character>>((ref) {
  final db = ref.watch(databaseProvider);
  return (db.select(db.characters)
        ..orderBy([
          (t) => OrderingTerm(expression: t.sortOrder, mode: OrderingMode.asc),
          (t) => OrderingTerm(expression: t.updatedAt, mode: OrderingMode.desc),
        ]))
      .watch();
});

/// 单个角色 Provider
final characterProvider = StreamProvider.family<Character?, String>((ref, id) {
  final db = ref.watch(databaseProvider);
  return (db.select(db.characters)..where((t) => t.id.equals(id)))
      .watchSingleOrNull();
});

/// 角色操作 Notifier
final characterActionsProvider = Provider<CharacterActions>((ref) {
  return CharacterActions(
    ref.read(databaseProvider),
    ref.read(characterImagesActionsProvider),
  );
});

/// 角色写入操作集合，封装创建、更新、删除、复制和排序等数据库操作。
class CharacterActions {
  final AppDatabase _db;
  final CharacterImagesActions _imagesActions;
  static const _uuid = Uuid();

  // FIX(Major-1)：原本 `_pendingNewFiles` 是实例字段，多次并发 duplicate
  // 调用会写到同一个 List 上，互相串扰（A 调用复制的新文件可能被 B 调用的
  // 异常分支当成自己的中间产物清理掉）。现已收敛为 [duplicate] 方法的局部
  // List<String>，并通过参数显式传给 [_safeDeletePendingFiles]。
  // pathMapping / newAvatarUrl 一直是 [duplicate] 的局部变量，无需调整。

  CharacterActions(this._db, this._imagesActions);

  /// 创建角色
  Future<String> create({
    String name = '新角色',
    String personality = '',
    String scenario = '',
    String greeting = '',
    String exampleDialogue = '',
    String systemPrompt = '',
    String imageTags = '',
  }) async {
    // 使用完整 UUID（之前 substring(0, 8) 在大数据量下存在碰撞风险）
    final id = _uuid.v4();
    final now = DateTime.now();

    // 新角色排到最前面
    final minSort = await (_db.selectOnly(db.characters)
          ..addColumns([db.characters.sortOrder.min()]))
        .getSingleOrNull();
    final currentMin = minSort?.read(db.characters.sortOrder.min()) ?? 0;
    final nextSort = currentMin - 1;

    await _db.into(_db.characters).insert(CharactersCompanion.insert(
      id: id,
      name: Value(name),
      personality: Value(personality),
      scenario: Value(scenario),
      greeting: Value(greeting),
      exampleDialogue: Value(exampleDialogue),
      systemPrompt: Value(systemPrompt),
      imageTags: Value(imageTags),
      sortOrder: Value(nextSort),
      createdAt: Value(now),
      updatedAt: Value(now),
    ));

    return id;
  }

  /// 更新角色
  Future<void> update(String id, {
    String? name,
    String? avatarUrl,
    String? personality,
    String? scenario,
    String? greeting,
    String? exampleDialogue,
    String? systemPrompt,
    String? imageTags,
    String? basicInfo,
    String? otherInfo,
  }) async {
    await (_db.update(_db.characters)..where((t) => t.id.equals(id))).write(
      CharactersCompanion(
        name: name != null ? Value(name) : const Value.absent(),
        avatarUrl: avatarUrl != null ? Value(avatarUrl) : const Value.absent(),
        personality: personality != null ? Value(personality) : const Value.absent(),
        scenario: scenario != null ? Value(scenario) : const Value.absent(),
        greeting: greeting != null ? Value(greeting) : const Value.absent(),
        exampleDialogue: exampleDialogue != null ? Value(exampleDialogue) : const Value.absent(),
        systemPrompt: systemPrompt != null ? Value(systemPrompt) : const Value.absent(),
        imageTags: imageTags != null ? Value(imageTags) : const Value.absent(),
        basicInfo: basicInfo != null ? Value(basicInfo) : const Value.absent(),
        otherInfo: otherInfo != null ? Value(otherInfo) : const Value.absent(),
        updatedAt: Value(DateTime.now()),
      ),
    );
  }

  /// 删除角色（级联删除对话、消息、记忆，并清理本地资产文件）
  ///
  /// P0-1 修复：之前仅删数据库，会留下孤儿头像 / 消息附件 / 生图文件。
  /// 现在的策略：
  /// 1. 事务前扫描该角色头像 + 该角色所有对话下的消息 metadata，收集本地路径；
  /// 2. 在事务内级联删除数据库行（与原行为一致）；
  /// 3. 事务提交后调用 [CharacterImagesActions.scanAndDeleteOrphanFiles]，
  ///    扫描全库其他消息与角色 avatar 后，仅对「不再被任何引用」的路径真正删文件，
  ///    避免误删被其它角色 / 消息共享的资产。
  Future<void> delete(String id) async {
    // 1. 事务前收集本角色相关的本地资产路径
    final pendingDelete = <String>{};

    final character = await (_db.select(_db.characters)
          ..where((t) => t.id.equals(id)))
        .getSingleOrNull();
    if (character != null && isLocalAssetPath(character.avatarUrl)) {
      pendingDelete.add(character.avatarUrl!);
    }

    final conversations = await (_db.select(_db.conversations)
          ..where((t) => t.characterId.equals(id)))
        .get();
    for (final conv in conversations) {
      final msgs = await (_db.select(_db.messages)
            ..where((t) => t.conversationId.equals(conv.id)))
          .get();
      for (final msg in msgs) {
        try {
          final meta = MessageMetadata.fromJsonString(msg.metadata);
          pendingDelete.addAll(extractLocalPaths(meta.toJson()));
        } catch (_) {
          // 单条 metadata 解析失败不阻塞删除
        }
        if (msg.content.isNotEmpty) {
          pendingDelete.addAll(collectLocalAssetUrlsFromContent(msg.content));
        }
      }
    }

    // 2. 事务内级联删除数据库行
    await _db.transaction(() async {
      for (final conv in conversations) {
        await (_db.delete(_db.messages)
              ..where((t) => t.conversationId.equals(conv.id)))
            .go();
        await (_db.delete(_db.memoryTasks)
              ..where((t) => t.conversationId.equals(conv.id)))
            .go();
      }
      await (_db.delete(_db.conversations)
            ..where((t) => t.characterId.equals(id)))
          .go();
      await (_db.delete(_db.memories)
            ..where((t) => t.characterId.equals(id)))
          .go();
      await (_db.delete(_db.characters)..where((t) => t.id.equals(id))).go();
    });

    // 3. 事务成功后做引用扫描 + 安全删除孤儿文件（best-effort，IO 异常仅记录日志）
    try {
      await _imagesActions.scanAndDeleteOrphanFiles(pendingDelete);
    } catch (e) {
      // ignore: avoid_print
      debugPrint('[CharacterActions.delete] 清理孤儿文件失败: $e');
    }
  }

  /// 复制角色 — 任务 11.1（文件复制）+ 11.2（事务级联写入）+ 11.3（失败回滚清理）
  ///
  /// 对应 design.md「P1 / R10」一节：fs 复制必须发生在 Drift 事务**之外**，
  /// 这样任一文件 IO 失败都不会让 SQLite 长时间持锁；事务内只做纯数据库写入。
  ///
  /// 当前覆盖：
  /// - 11.1：先扫描原角色全部资产路径，头像与消息 metadata 中的本地路径每个旧路径
  ///         只复制一次新文件，得到 `pathMapping` 与 `newAvatarUrl`；
  /// - 11.2：在单个 [AppDatabase.transaction] 内按「角色 → 对话 → 消息 → 记忆」
  ///         的顺序级联写入，所有 ID 重新生成，metadata 用 `pathMapping` 重写，
  ///         记忆 `source_msg_ids` 按「旧 msgId → 新 msgId」映射重写。
  /// - 11.3：用 try / catch / finally 包住事务调用——事务抛错时调用
  ///         [_safeDeletePendingFiles] 删除已复制出的新文件兜底清理，避免孤儿；
  ///         finally 中无论成功失败都清空 [_pendingNewFiles]，保证下一次调用从空列表开始。
  ///         所有清理时的 IO 异常仅记录日志，不再次抛出，避免遮蔽原始事务异常。
  Future<String> duplicate(String id) async {
    // FIX(Major-1)：把原实例字段 `_pendingNewFiles` 收敛为方法内局部变量，
    // 避免并发 duplicate 调用互相串扰。所有读写都在本方法栈内完成；
    // 兜底清理通过参数显式传给 [_safeDeletePendingFiles]。
    final pendingNewFiles = <String>[];

    final original = await (_db.select(_db.characters)
          ..where((t) => t.id.equals(id)))
        .getSingle();

    // 该角色全部对话（11.2 事务内会再读一次以保证一致性，这里仅为扫描资产路径）
    final conversations = await (_db.select(_db.conversations)
          ..where((t) => t.characterId.equals(id)))
        .get();

    // 该角色全部消息：分批读取，避免单次 IN 子句过大
    final allMessages = <Message>[];
    for (final conv in conversations) {
      final msgs = await (_db.select(_db.messages)
            ..where((t) => t.conversationId.equals(conv.id))
            ..orderBy([(t) => OrderingTerm.asc(t.seq)]))
          .get();
      allMessages.addAll(msgs);
    }

    // 1) 头像：本地路径 → 复制；远程 URL / 空 → 沿用原值
    String? newAvatarUrl = original.avatarUrl;
    if (isLocalAssetPath(original.avatarUrl)) {
      final copied = await copyLocalAsset(original.avatarUrl!);
      pendingNewFiles.add(copied); // FIX(Major-1)：写入局部列表
      newAvatarUrl = copied;
    }

    // 2) 收集所有消息 metadata 中的本地资产路径（去重）
    final assetSet = <String>{};
    for (final msg in allMessages) {
      final meta = MessageMetadata.fromJsonString(msg.metadata);
      assetSet.addAll(extractLocalPaths(meta.toJson()));
    }

    // 3) 每个旧路径只复制一次，构造「旧路径 → 新路径」映射；
    //    任一复制失败时立即清理已成功的新文件，避免 11.2 / 11.3 之外的孤儿
    final pathMapping = <String, String>{};
    try {
      for (final oldPath in assetSet) {
        final newPath = await copyLocalAsset(oldPath);
        pendingNewFiles.add(newPath); // FIX(Major-1)：写入局部列表
        pathMapping[oldPath] = newPath;
      }
    } catch (_) {
      // 11.3 之外的兜底：复制阶段自身失败即清理，不留下孤儿
      // FIX(Major-1)：把局部列表显式传入清理函数
      await _safeDeletePendingFiles(pendingNewFiles);
      rethrow;
    }

    // ── 任务 11.2：事务内级联写入新角色 / 对话 / 消息 / 记忆 ──
    //
    // 关键约束（与 design.md「P1 / R10」伪代码一致）：
    // - 所有 ID 在事务内重新生成，不复用旧 ID，避免与原角色冲突；
    // - 消息 metadata 中的本地资产路径用 [pathMapping] 重写，保证新副本独立持有；
    // - 记忆的 `source_msg_ids` JSON 数组按「旧 msgId → 新 msgId」映射重写，
    //   未命中映射的元素保留原值（防御 metadata 中混入对外部消息的引用）；
    // - name 去重不在本任务范围，仅按「{原 name}（副本）」直写，由
    //   `flutter-data-management` 统一去重，避免重叠。
    final newCharId = _uuid.v4();
    final now = DateTime.now();
    final msgIdMap = <String, String>{};

    // ── 任务 11.3：try / catch / finally 包住事务调用 ──
    //
    // - 事务抛错：调用 [_safeDeletePendingFiles] 删除已复制出的新文件兜底清理，再 rethrow
    //   把原始异常透传给上层；清理过程内部的 IO 异常仅记录日志，不再次抛出。
    // - 事务成功：finally 同样会清空 [_pendingNewFiles]，无需额外删除文件。
    // - finally 统一清空暂存列表，保证下一次 [duplicate] 调用从空列表开始，避免跨调用污染。
    try {
      await _db.transaction(() async {
      // a. 新角色 sort_order：与 create() 一致，排到最前
      final minSort = await (_db.selectOnly(_db.characters)
            ..addColumns([_db.characters.sortOrder.min()]))
          .getSingleOrNull();
      final currentMin = minSort?.read(_db.characters.sortOrder.min()) ?? 0;
      final nextSort = currentMin - 1;

      // b. 插入新角色：复制全部字段，name 追加「（副本）」，avatar_url 用 11.1 的新值
      //    若原名已含「（副本）」则不重复追加
      final newName = original.name.endsWith('（副本）')
          ? original.name
          : '${original.name}（副本）';
      await _db.into(_db.characters).insert(CharactersCompanion.insert(
        id: newCharId,
        name: Value(newName),
        avatarUrl: Value(newAvatarUrl),
        personality: Value(original.personality),
        scenario: Value(original.scenario),
        greeting: Value(original.greeting),
        exampleDialogue: Value(original.exampleDialogue),
        systemPrompt: Value(original.systemPrompt),
        basicInfo: Value(original.basicInfo),
        otherInfo: Value(original.otherInfo),
        imageTags: Value(original.imageTags),
        sortOrder: Value(nextSort),
        createdAt: Value(now),
        updatedAt: Value(now),
      ));

      // c. 事务内重新读取该角色对话快照（一致性优先于步骤 11.1 的扫描结果）
      final convsInTxn = await (_db.select(_db.conversations)
            ..where((t) => t.characterId.equals(id))
            ..orderBy([(t) => OrderingTerm.asc(t.createdAt)]))
          .get();

      for (final conv in convsInTxn) {
        final newConvId = _uuid.v4();
        await _db.into(_db.conversations).insert(ConversationsCompanion.insert(
          id: newConvId,
          characterId: newCharId,
          title: Value(conv.title),
          ignoreMemory: Value(conv.ignoreMemory),
          // 保留原始时间，确保副本里的对话顺序与原角色一致
          createdAt: Value(conv.createdAt),
          updatedAt: Value(conv.updatedAt),
        ));

        // d. 拷贝该对话所有消息，按 seq 升序保证顺序稳定
        final msgs = await (_db.select(_db.messages)
              ..where((t) => t.conversationId.equals(conv.id))
              ..orderBy([(t) => OrderingTerm.asc(t.seq)]))
            .get();

        for (final msg in msgs) {
          final newMsgId = _uuid.v4();
          msgIdMap[msg.id] = newMsgId;

          final meta = MessageMetadata.fromJsonString(msg.metadata);
          final remapped = remapLocalPaths(meta.toJson(), pathMapping);

          await _db.into(_db.messages).insert(MessagesCompanion.insert(
            id: newMsgId,
            conversationId: newConvId,
            role: msg.role,
            content: Value(msg.content),
            tokenCount: Value(msg.tokenCount),
            seq: Value(msg.seq),
            createdAt: Value(msg.createdAt),
            metadata: Value(jsonEncode(remapped)),
          ));
        }
      }

      // e. 拷贝记忆，并按 msgIdMap 重写 source_msg_ids
      //    映射未命中的元素保留原值（不强行清洗，便于后续排查）
      final memories = await (_db.select(_db.memories)
            ..where((t) => t.characterId.equals(id)))
          .get();

      for (final mem in memories) {
        final newMemId = _uuid.v4();
        String newSourceMsgIds = mem.sourceMsgIds;
        try {
          final decoded = jsonDecode(mem.sourceMsgIds);
          if (decoded is List) {
            final mapped = decoded.map((e) {
              if (e is String) return msgIdMap[e] ?? e;
              return e;
            }).toList();
            newSourceMsgIds = jsonEncode(mapped);
          }
        } catch (_) {
          // 解析失败保留原值，避免破坏后续展示
        }

        await _db.into(_db.memories).insert(MemoriesCompanion.insert(
          id: newMemId,
          characterId: newCharId,
          category: mem.category,
          content: mem.content,
          confidence: Value(mem.confidence),
          tags: Value(mem.tags),
          sourceMsgIds: Value(newSourceMsgIds),
          createdAt: Value(mem.createdAt),
          updatedAt: Value(mem.updatedAt),
        ));
      }
    });

    // 11.3：事务成功路径走到这里。
    // FIX(Major-1)：原来依赖 finally 清空实例字段，现在已收敛为局部变量，
    // 函数返回后自动随栈帧释放，不需要手动 clear。
    return newCharId;
    } catch (_) {
      // 11.3：事务抛错时兜底清理已复制出的新文件，避免孤儿；清理本身的 IO 异常仅在
      // [_safeDeletePendingFiles] 内部记录日志，不再次抛出，避免遮蔽原始事务异常。
      // FIX(Major-1)：传入局部 pendingNewFiles
      await _safeDeletePendingFiles(pendingNewFiles);
      rethrow;
    }
  }

  /// 兜底：删除已复制出的新文件（IO 异常仅吞掉不再次抛出）
  ///
  /// FIX(Major-1)：参数化为 `pendingFiles`，避免依赖实例字段，从而不再被
  /// 并发 duplicate 调用串扰。事务回滚或复制阶段失败时由调用方传入相应的
  /// 局部列表。所有 IO 异常仅打日志，避免遮蔽原始异常。
  Future<void> _safeDeletePendingFiles(List<String> pendingFiles) async {
    for (final path in pendingFiles) {
      try {
        final f = File(path);
        if (await f.exists()) {
          await f.delete();
        }
      } catch (_) {
        // 仅记录日志，避免遮蔽原异常
        // ignore: avoid_print
        print('[CharacterActions.duplicate] 清理新文件失败: $path');
      }
    }
  }

  /// 更新排序
  Future<void> reorder(List<String> orderedIds) async {
    await _db.batch((batch) {
      for (int i = 0; i < orderedIds.length; i++) {
        batch.update(
          _db.characters,
          CharactersCompanion(sortOrder: Value(i)),
          where: (t) => t.id.equals(orderedIds[i]),
        );
      }
    });
  }

  // 便捷访问 db（用于 minSort 查询）
  AppDatabase get db => _db;
}
