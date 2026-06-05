import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../database/database.dart';
import '../services/memory_extraction_service.dart';

/// 全局数据库实例 Provider
final databaseProvider = Provider<AppDatabase>((ref) {
  final db = AppDatabase();
  ref.onDispose(() => db.close());

  // 启动恢复：把上一次运行残留的 pending/processing memory_tasks 翻成 failed，
  // 避免被系统杀进程 / 网络异常导致的孤儿行让记忆提取按钮永久卡在「提取中」、
  // 后续手动触发被去重 guard 静默吞掉。详见
  // [MemoryExtractionService.recoverStaleTasksOnStartup] 的注释说明。
  // 火-忘形（fire-and-forget）：不阻塞 provider 构建，失败也不影响 App 启动。
  // ignore: discarded_futures
  MemoryExtractionService.recoverStaleTasksOnStartup(db).catchError((_) => 0);

  return db;
});
