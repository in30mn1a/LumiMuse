import 'dart:convert';
import 'dart:math';

import 'package:cryptography/cryptography.dart';
import 'package:flutter/foundation.dart';

import '../database/database.dart';

/// 启动密码服务 — 使用 PBKDF2(HMAC-SHA256) 派生哈希
///
/// 设计要点（详见 design.md「P2 / R13」）：
/// - 复用 `Settings` KV 表，写入三键：
///   - `launch_password_hash`   ：base64 编码的派生哈希（256 bits / 32 字节）
///   - `launch_password_salt`   ：base64 编码的 16 字节随机 salt
///   - `launch_password_iterations`：PBKDF2 迭代次数
///     （新写入用 [_kDefaultIterations] = 600000，OWASP 2023+ 推荐；
///     旧库已写入的 200000 仍按其值验证以保留向后兼容）
/// - 不升级 Drift schemaVersion，应用层完全用 KV 承载。
/// - 哈希计算失败回退「启动密码功能暂不可用」：`verifyPassword` 仅返回 false，不抛异常。
/// - 存储读取失败视为未启用：`isEnabled` 仅返回 false，不抛异常。
class LaunchPasswordService {
  /// PBKDF2 派生哈希位数（256 bits = 32 字节）
  static const int _kHashBits = 256;

  /// PBKDF2 默认迭代次数
  ///
  /// FIX(Major-5): 由 200000 提升至 600000，对齐 OWASP 2023+ 对
  /// PBKDF2-HMAC-SHA256 的最小推荐值（≥ 600,000）。
  ///
  /// 向后兼容：
  /// - 旧版本写入的密码三键中包含 `launch_password_iterations`（KV 表，
  ///   见 [_kIterationsKey]），verifyPassword 始终读取该键作为迭代次数；
  /// - 因此已存的 200K 哈希仍能用 200K 验证，不会失效；
  /// - 仅在 [setPassword] 路径会用本常量重新写入新值（用户自愿改密
  ///   或恢复出厂时），实现"渐进式迁移"。
  ///
  /// 注意：[forTesting] 构造器仍允许显式传入 1000 次等小值，本常量
  /// 升级不会让属性测试 / 状态机测试更慢。
  static const int _kDefaultIterations = 600000;

  /// 随机 salt 字节长度
  static const int _kSaltLength = 16;

  /// Settings KV 键名 — 与 backup 导入逻辑兼容
  static const String _kHashKey = 'launch_password_hash';
  static const String _kSaltKey = 'launch_password_salt';
  static const String _kIterationsKey = 'launch_password_iterations';

  final AppDatabase _db;

  /// PBKDF2 实际使用的迭代次数 — 默认走 [_kDefaultIterations]，
  /// 测试通过 [LaunchPasswordService.forTesting] 注入更小的值（例如 100）
  /// 以避免每次属性运行都跑完整 600000 次轮次。
  final int _iterations;

  LaunchPasswordService(this._db) : _iterations = _kDefaultIterations;

  /// 测试专用构造器 — 允许覆盖 PBKDF2 迭代次数，便于属性测试快速跑完。
  ///
  /// 仅在 `test/` 目录下使用；线上代码必须使用默认构造器以保留
  /// 600000 次迭代的安全强度。
  @visibleForTesting
  LaunchPasswordService.forTesting(this._db, {int iterations = 1000})
      : _iterations = iterations;

  /// 是否已启用启动密码（hash + salt 同时存在且非空时视为启用）
  Future<bool> isEnabled() async {
    try {
      final hashB64 = await _readSetting(_kHashKey);
      final saltB64 = await _readSetting(_kSaltKey);
      return hashB64 != null &&
          hashB64.isNotEmpty &&
          saltB64 != null &&
          saltB64.isNotEmpty;
    } catch (_) {
      // 存储读取失败视为未启用，避免阻塞启动流程
      return false;
    }
  }

  /// 设置启动密码（覆盖式写入），内部生成 16 字节随机 salt
  ///
  /// 调用方应在 UI 层先校验密码长度（≥ 4），本方法不再二次校验，
  /// 以便本服务可被独立的密码迁移 / 导入流程复用。
  Future<void> setPassword(String plain) async {
    final salt = _generateSalt();
    final iterations = _iterations;
    final hashBytes = await _derive(plain, salt, iterations);

    // 三键一并写入；any 单键失败将抛出异常由调用方处理
    await _writeSetting(_kSaltKey, base64Encode(salt));
    await _writeSetting(_kHashKey, base64Encode(hashBytes));
    await _writeSetting(_kIterationsKey, iterations.toString());
  }

  /// 校验密码 — 失败仅返回 false，不抛异常
  ///
  /// 任何分支的异常（存储读取失败、base64 解码失败、PBKDF2 计算失败）
  /// 都会被吞掉并返回 false，对应「启动密码功能暂不可用」语义。
  Future<bool> verifyPassword(String plain) async {
    try {
      final hashB64 = await _readSetting(_kHashKey);
      final saltB64 = await _readSetting(_kSaltKey);
      if (hashB64 == null ||
          hashB64.isEmpty ||
          saltB64 == null ||
          saltB64.isEmpty) {
        return false;
      }
      final iterStr = await _readSetting(_kIterationsKey);
      final iterations = int.tryParse(iterStr ?? '') ?? _kDefaultIterations;

      final expected = base64Decode(hashB64);
      final salt = base64Decode(saltB64);
      final actual = await _derive(plain, salt, iterations);
      return _constantTimeEquals(expected, actual);
    } catch (_) {
      // 哈希计算 / 存储读取失败：保守返回 false
      return false;
    }
  }

  /// 禁用启动密码 — 验证当前密码通过后清空三键，验证失败抛 [StateError]
  Future<void> disable(String currentPlain) async {
    final ok = await verifyPassword(currentPlain);
    if (!ok) {
      throw StateError('launch_password_verify_failed');
    }
    await _deleteSetting(_kHashKey);
    await _deleteSetting(_kSaltKey);
    await _deleteSetting(_kIterationsKey);
  }

  // ─────────────────────────────────────────────────────────────
  // 内部工具
  // ─────────────────────────────────────────────────────────────

  /// 调用 PBKDF2(HMAC-SHA256) 派生 32 字节哈希
  Future<List<int>> _derive(
    String plain,
    List<int> salt,
    int iterations,
  ) async {
    final pbkdf2 = Pbkdf2(
      macAlgorithm: Hmac.sha256(),
      iterations: iterations,
      bits: _kHashBits,
    );
    final derived = await pbkdf2.deriveKey(
      secretKey: SecretKey(utf8.encode(plain)),
      nonce: salt,
    );
    return derived.extractBytes();
  }

  /// 生成 16 字节加密安全随机 salt
  List<int> _generateSalt() {
    final rng = Random.secure();
    return List<int>.generate(_kSaltLength, (_) => rng.nextInt(256));
  }

  /// 常量时间字节比较，避免侧信道泄露密码长度信息
  bool _constantTimeEquals(List<int> a, List<int> b) {
    if (a.length != b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) {
      diff |= a[i] ^ b[i];
    }
    return diff == 0;
  }

  Future<String?> _readSetting(String key) async {
    final row = await (_db.select(_db.settings)
          ..where((t) => t.key.equals(key)))
        .getSingleOrNull();
    return row?.value;
  }

  Future<void> _writeSetting(String key, String value) async {
    await _db.into(_db.settings).insertOnConflictUpdate(
          SettingsCompanion.insert(key: key, value: value),
        );
  }

  Future<void> _deleteSetting(String key) async {
    await (_db.delete(_db.settings)..where((t) => t.key.equals(key))).go();
  }
}
