// Feature: flutter-parity-completion, Property 24: getDatabaseStats 行数与实际计数一致
//
// 任务来源：tasks.md 17.3
// **Validates: Requirements 14.1, 14.2, 14.3**
//
// 性质：对任意一段 INSERT / UPDATE / DELETE 操作序列，`getDatabaseStats().tables[t]`
// 必须等于 `SELECT COUNT(*) FROM t` 的实际结果（对每张被覆盖的表）；`totalBytes`
// 必须等于 `lumimuse.db` + `lumimuse.db-wal` + `lumimuse.db-shm` 三个文件实际大小
// 之和（任一文件不存在按 0 计入）。
//
// 注：内存 Drift 数据库本身不写入磁盘文件，path_provider 在测试中被 mock 到
// 系统临时目录，预期目录下不会存在 `LumiMuse/lumimuse.db`，因此 `totalBytes` 在
// 这个场景下应当为 0（与 design.md「P2 / R14」的「文件读取失败回退 0」分支一致）。
//
// 同时验证：Flutter 端 Drift schema 暂未建立 `glossary` 表，所以返回的
// `tables` Map 不应包含 `glossary` 键 —— 与 design.md「缺省该键」语义一致。

import 'dart:io';
import 'dart:math' as math;

import 'package:drift/drift.dart';
import 'package:drift/native.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, test, group, setUpAll, tearDownAll;
import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/core/services/maintenance_service.dart';
import 'package:path/path.dart' as p;

/// 创建用于测试的内存 Drift 数据库 —— 与项目现有测试约定一致。
AppDatabase _createTestDb() {
  driftRuntimeOptions.dontWarnAboutMultipleDatabases = true;
  return AppDatabase.forTesting(NativeDatabase.memory());
}

/// 候选表名：与 `MaintenanceService._statsTableNames` 对齐，但去除 `glossary`
/// 这张 Flutter 端尚未建立的表（Drift schema 中没有 `glossary` 表）。
const List<String> _expectedTables = <String>[
  'characters',
  'conversations',
  'messages',
  'memories',
  'memory_tasks',
  'settings',
  'model_cache',
];

/// 直接对单张表执行 `SELECT COUNT(*)`，作为属性断言的「实际计数」基准。
Future<int> _countRows(AppDatabase db, String table) async {
  final row = await db
      .customSelect('SELECT COUNT(*) AS cnt FROM $table')
      .getSingle();
  return row.read<int>('cnt');
}

/// 计算预期 `totalBytes`：与 `MaintenanceService.getDatabaseStats` 内部公式
/// 完全等价（基础路径 + `-wal` + `-shm`），用于让属性断言不依赖测试环境是否
/// 真的写入了文件。
Future<int> _expectedTotalBytes() async {
  try {
    // 这里直接复用与生产代码相同的路径解析逻辑，依赖 path_provider mock
    // 把基目录指向系统临时目录。
    final base = await _resolveDbBasePath();
    int sum = 0;
    for (final path in <String>[base, '$base-wal', '$base-shm']) {
      final file = File(path);
      if (await file.exists()) {
        sum += await file.length();
      }
    }
    return sum;
  } catch (_) {
    return 0;
  }
}

/// 在测试中复刻 `MaintenanceService` 内部使用的数据库文件路径解析过程。
///
/// 与生产实现一致：`{ApplicationDocumentsDirectory}/LumiMuse/lumimuse.db`。
Future<String> _resolveDbBasePath() async {
  // 直接读 Mock 在 setUpAll 中设定的临时目录，不再走 path_provider 包装。
  return p.join(Directory.systemTemp.path, 'LumiMuse', 'lumimuse.db');
}

/// 按种子驱动一段「INSERT / UPDATE / DELETE 操作序列」，覆盖所有候选表。
///
/// - `size` 控制每张表最多生成的行数上限。
/// - `seed` 决定具体每张表的实际行数与删除/更新模式。
///
/// 这样设计的好处：用两个简单参数就能让 glados 探索很多状态组合，
/// 同时操作链对外部仍然是确定性的（同 seed 同 size → 同最终状态）。
Future<void> _runRandomOps(AppDatabase db, int seed, int size) async {
  final rng = math.Random(seed);

  // 1. 插入 characters
  final charCount = rng.nextInt(size + 1);
  final charIds = <String>[];
  for (int i = 0; i < charCount; i++) {
    final id = 'c-$seed-$i';
    charIds.add(id);
    await db.customInsert(
      'INSERT INTO characters (id, name) VALUES (?, ?)',
      variables: [
        Variable.withString(id),
        Variable.withString('角色$i'),
      ],
    );
  }

  // 2. 插入 conversations（必须依附于已有 character）
  final convCount = charIds.isEmpty ? 0 : rng.nextInt(size + 1);
  final convIds = <String>[];
  for (int i = 0; i < convCount; i++) {
    final id = 'cv-$seed-$i';
    final charId = charIds[rng.nextInt(charIds.length)];
    convIds.add(id);
    await db.customInsert(
      'INSERT INTO conversations (id, character_id, title, ignore_memory) '
      'VALUES (?, ?, ?, ?)',
      variables: [
        Variable.withString(id),
        Variable.withString(charId),
        Variable.withString('对话$i'),
        Variable.withInt(rng.nextBool() ? 1 : 0),
      ],
    );
  }

  // 3. 插入 messages（必须依附于已有 conversation）
  final msgCount = convIds.isEmpty ? 0 : rng.nextInt(size + 1);
  for (int i = 0; i < msgCount; i++) {
    final convId = convIds[rng.nextInt(convIds.length)];
    await db.customInsert(
      'INSERT INTO messages (id, conversation_id, role, content) '
      'VALUES (?, ?, ?, ?)',
      variables: [
        Variable.withString('m-$seed-$i'),
        Variable.withString(convId),
        Variable.withString(rng.nextBool() ? 'user' : 'assistant'),
        Variable.withString('消息$i'),
      ],
    );
  }

  // 4. 插入 memories（必须依附于已有 character）
  final memCount = charIds.isEmpty ? 0 : rng.nextInt(size + 1);
  for (int i = 0; i < memCount; i++) {
    final charId = charIds[rng.nextInt(charIds.length)];
    await db.customInsert(
      'INSERT INTO memories (id, character_id, category, content) '
      'VALUES (?, ?, ?, ?)',
      variables: [
        Variable.withString('mem-$seed-$i'),
        Variable.withString(charId),
        Variable.withString('preference'),
        Variable.withString('记忆$i'),
      ],
    );
  }

  // 5. 插入 memory_tasks
  final taskCount = convIds.isEmpty ? 0 : rng.nextInt(size + 1);
  for (int i = 0; i < taskCount; i++) {
    final convId = convIds[rng.nextInt(convIds.length)];
    final charId = charIds[rng.nextInt(charIds.length)];
    await db.customInsert(
      'INSERT INTO memory_tasks '
      '(character_id, conversation_id, status) VALUES (?, ?, ?)',
      variables: [
        Variable.withString(charId),
        Variable.withString(convId),
        Variable.withString('done'),
      ],
    );
  }

  // 6. 插入 settings KV（无外键依赖）
  final settingsCount = rng.nextInt(size + 1);
  for (int i = 0; i < settingsCount; i++) {
    await db.customInsert(
      'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
      variables: [
        Variable.withString('k-$seed-$i'),
        Variable.withString('v-$i'),
      ],
    );
  }

  // 7. 插入 model_cache（主键为 api_base，无外键依赖）
  final modelCount = rng.nextInt(size + 1);
  for (int i = 0; i < modelCount; i++) {
    await db.customInsert(
      'INSERT OR REPLACE INTO model_cache (api_base, models) VALUES (?, ?)',
      variables: [
        Variable.withString('https://api-$seed-$i.example.com'),
        Variable.withString('["gpt-4"]'),
      ],
    );
  }

  // 8. 随机 UPDATE：把部分 conversations 的 ignore_memory 翻转，
  //    不影响行数但模拟「序列中间出现 UPDATE」。
  if (convIds.isNotEmpty && rng.nextBool()) {
    final pickId = convIds[rng.nextInt(convIds.length)];
    await db.customStatement(
      'UPDATE conversations SET ignore_memory = 1 - ignore_memory WHERE id = ?',
      [pickId],
    );
  }

  // 9. 随机 DELETE：每张表以 1/2 概率删除一条行，覆盖删除路径。
  if (charIds.isNotEmpty && rng.nextBool()) {
    final id = charIds[rng.nextInt(charIds.length)];
    // 先清掉该角色相关的子表（避免外键悬挂；当前 schema 未启用 FK，
    // 这里只是为了让计数下降的语义更直观）。
    await db.customStatement(
      'DELETE FROM memories WHERE character_id = ?',
      [id],
    );
    await db.customStatement(
      'DELETE FROM conversations WHERE character_id = ?',
      [id],
    );
    await db.customStatement('DELETE FROM characters WHERE id = ?', [id]);
  }
  if (rng.nextBool()) {
    await db.customStatement(
      "DELETE FROM messages WHERE id LIKE 'm-$seed-0%'",
    );
  }
  if (rng.nextBool()) {
    await db.customStatement(
      "DELETE FROM settings WHERE key LIKE 'k-$seed-0%'",
    );
  }
  if (rng.nextBool()) {
    await db.customStatement(
      "DELETE FROM model_cache WHERE api_base LIKE 'https://api-$seed-0%'",
    );
  }
}

void main() {
  // 让 path_provider 在测试环境下不报 MissingPluginException —— 把
  // ApplicationDocumentsDirectory 重定向到系统临时目录，使
  // `MaintenanceService.getDatabaseStats` 内部能拼出一个稳定路径。
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      (MethodCall methodCall) async {
        if (methodCall.method == 'getApplicationDocumentsDirectory' ||
            methodCall.method == 'getApplicationSupportDirectory' ||
            methodCall.method == 'getTemporaryDirectory') {
          return Directory.systemTemp.path;
        }
        return null;
      },
    );
  });

  tearDownAll(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      null,
    );
  });

  group('Property 24: getDatabaseStats 行数与实际计数一致', () {
    Glados2<int, int>(
      any.intInRange(0, 1 << 30), // 操作序列种子
      any.intInRange(0, 5),        // 每张表行数上限
      // 默认 100 次迭代，与 tasks.md 17.3 保持一致
    ).test(
      '任意 INSERT/UPDATE/DELETE 序列后 tables[t] == COUNT(*) FROM t',
      (seed, size) async {
        final db = _createTestDb();
        addTearDown(() => db.close());

        await _runRandomOps(db, seed, size);

        final service = MaintenanceService(db);
        final stats = await service.getDatabaseStats();

        // 1. 每张候选表的行数必须等于直接 COUNT(*) 的结果
        for (final table in _expectedTables) {
          final actual = await _countRows(db, table);
          expect(
            stats.tables[table],
            equals(actual),
            reason: '表 $table 的统计行数应等于 SELECT COUNT(*)，'
                'seed=$seed size=$size',
          );
        }

        // 2. Flutter 端 Drift schema 未建立 `glossary` 表 —— 缺省该键
        expect(
          stats.tables.containsKey('glossary'),
          isFalse,
          reason: 'glossary 表在 Drift 中并不存在，按设计应缺省该键',
        );

        // 3. tables Map 中不应出现额外的非候选键
        for (final key in stats.tables.keys) {
          expect(
            _expectedTables.contains(key),
            isTrue,
            reason: '非预期表键 $key 出现在 stats.tables 中',
          );
        }
      },
    );

    Glados2<int, int>(
      any.intInRange(0, 1 << 30),
      any.intInRange(0, 5),
    ).test(
      'totalBytes 等于实际三个文件大小之和（内存 Drift 场景下应为 0）',
      (seed, size) async {
        final db = _createTestDb();
        addTearDown(() => db.close());

        await _runRandomOps(db, seed, size);

        final service = MaintenanceService(db);
        final stats = await service.getDatabaseStats();

        // 与 MaintenanceService 内部相同的路径解析公式，避免依赖测试环境
        // 是否实际写过文件 —— 内存 Drift 场景下三个文件都不存在，预期 0。
        final expected = await _expectedTotalBytes();

        expect(
          stats.totalBytes,
          equals(expected),
          reason: 'totalBytes 应等于 lumimuse.db + -wal + -shm 三个文件实际大小'
              '之和；内存 Drift 不会写文件，预期为 0',
        );
        expect(
          stats.totalBytes,
          equals(0),
          reason: '内存 Drift 数据库无对应文件，totalBytes 必须为 0',
        );
      },
    );
  });
}
