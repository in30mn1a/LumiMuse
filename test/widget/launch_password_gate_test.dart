// Feature: flutter-parity-completion, Task 16.7: 闸门 5 次失败 → 锁定 → 倒计时
// **Validates: Requirements 13.3, 13.4**
//
// 通过 fake `LaunchPasswordService` 让 `verifyPassword(p)` 总是返回 false，
// 模拟连续 5 次错误密码触发 30 秒锁定。为了让测试在合理时间内完成，
// 闸门通过 `lockDurationOverride` 注入了一个极短的锁定时长（100ms），
// 这是仅供 widget 测试使用的钩子，与生产代码 30 秒锁定路径完全一致。
//
// 测试覆盖：
//   - 输入 5 次错误密码后进入锁定状态：倒计时文案出现，提交按钮禁用
//   - 锁定期间继续点击「解锁」不会再触发 `verifyPassword`
//   - 倒计时结束后允许下一次尝试：可以再次输入并触发 `verifyPassword`

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/services/launch_password_service.dart';
import 'package:lumimuse/features/auth/launch_password_gate.dart';

/// 永远拒绝的假启动密码服务 — 用于覆盖
/// [launchPasswordServiceProvider]，强制走「失败」路径。
///
/// 复用真实 [LaunchPasswordService] 类型而非额外引入接口，方便 Provider
/// override。继承时不再调用真实数据库逻辑：所有方法在子类中独立实现。
class _AlwaysFailLaunchPasswordService implements LaunchPasswordService {
  /// `verifyPassword` 被调用的次数，便于断言锁定期间不再继续校验。
  int verifyCallCount = 0;

  @override
  Future<bool> isEnabled() async => true;

  @override
  Future<bool> verifyPassword(String plain) async {
    verifyCallCount++;
    return false;
  }

  @override
  Future<void> setPassword(String plain) async {
    throw UnimplementedError('fake service: setPassword');
  }

  @override
  Future<void> disable(String currentPlain) async {
    throw UnimplementedError('fake service: disable');
  }
}

/// 构造挂载了闸门的测试 App
Widget _buildGateApp({
  required _AlwaysFailLaunchPasswordService service,
  required Duration lockDuration,
}) {
  return ProviderScope(
    overrides: [
      launchPasswordServiceProvider.overrideWithValue(service),
    ],
    child: MaterialApp(
      home: LaunchPasswordGate(
        lockDurationOverride: lockDuration,
        child: const Scaffold(body: Text('main-content')),
      ),
    ),
  );
}

/// 在密码框输入文本后点击「解锁」按钮
Future<void> _submitPassword(WidgetTester tester, String text) async {
  // 失败一次后控制器会被清空，所以每次都重新输入
  await tester.enterText(find.byType(TextField), text);
  // 通过文案找到主按钮 — `_PrimaryButton` 的 GestureDetector 包裹了 Container
  await tester.tap(find.text('解锁'));
  await tester.pumpAndSettle();
}

void main() {
  group('Widget · 启动密码闸门 5 次失败锁定状态机', () {
    testWidgets(
      '5 次错误密码 → 锁定文案出现 / 按钮禁用 / 倒计时结束允许下一次尝试',
      (tester) async {
        final service = _AlwaysFailLaunchPasswordService();
        // 100ms 锁定时长足够覆盖锁定 → 解锁的迁移，又不至于让测试耗时过长。
        await tester.pumpWidget(
          _buildGateApp(
            service: service,
            lockDuration: const Duration(milliseconds: 100),
          ),
        );
        // isEnabled 是异步的，需要 settle 一次让闸门完成 _checkEnabled。
        await tester.pumpAndSettle();

        // 闸门已展示密码输入界面，主体内容仍被拦截。
        expect(find.text('请输入启动密码'), findsOneWidget);
        expect(find.text('main-content'), findsNothing);

        // 1) 连续 5 次错误密码 → 触发 30 秒锁定（这里测试用 100ms）
        for (var i = 1; i <= 5; i++) {
          await _submitPassword(tester, 'wrong-$i');
        }
        expect(service.verifyCallCount, 5,
            reason: '前 5 次错误密码都应触发 verifyPassword');

        // 2) 锁定文案出现，倒计时 N 秒
        expect(
          find.textContaining('请在'),
          findsOneWidget,
          reason: '锁定后应出现「请在 N 秒后再试」倒计时文案',
        );
        expect(
          find.textContaining('秒后再试'),
          findsOneWidget,
        );

        // 3) 锁定期间继续点击「解锁」不会再触发 verifyPassword
        //    （TextField 在锁定期被禁用，按钮也被禁用 → 点击无效）
        await tester.tap(find.text('解锁'));
        await tester.pump();
        expect(service.verifyCallCount, 5,
            reason: '锁定期间提交按钮应禁用，不再触发 verifyPassword');

        // 4) 让真实时钟越过 lockDurationOverride 边界 — 锁定到期
        await tester.runAsync(() async {
          await Future<void>.delayed(const Duration(milliseconds: 250));
        });
        // 推动 fake 时钟让周期 ticker 触发一次：cancel + setState(_lockUntil=null)
        await tester.pump(const Duration(seconds: 1));

        // 5) 倒计时文案应已消失，TextField / 提交按钮重新可用
        expect(
          find.textContaining('请在'),
          findsNothing,
          reason: '倒计时结束后锁定文案应消失',
        );

        // 6) 允许下一次尝试：再次输入密码 → verifyPassword 第 6 次被调用
        await _submitPassword(tester, 'after-unlock');
        expect(
          service.verifyCallCount,
          6,
          reason: '倒计时结束后允许下一次提交，verifyPassword 应被再次调用',
        );

        // 失败次数从 0 重新累计 → 此时只算第 1 次失败，不应立刻触发新一轮锁定
        expect(
          find.textContaining('请在'),
          findsNothing,
          reason: '解锁后第 1 次失败不应立即重新锁定',
        );
        expect(
          find.textContaining('1 / 5'),
          findsOneWidget,
          reason: '解锁后失败次数应从 0 重新累加，提示「1 / 5」',
        );
      },
    );
  });
}
