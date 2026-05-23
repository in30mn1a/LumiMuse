import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../database/database.dart';

/// 全局数据库实例 Provider
final databaseProvider = Provider<AppDatabase>((ref) {
  final db = AppDatabase();
  ref.onDispose(() => db.close());
  return db;
});
