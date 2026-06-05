// Feature: flutter-pixel-perfect-parity, Task 7 聚合入口
// Validates: Requirements A1.1, A1.2, B3.3, B3.4, B3.5, B4.1, B4.2,
//            B7.1, C1.1, C1.2, C1.3, C1.4
//
// 设计说明
// ────────
// Flutter 桌面端 integration_test 在批量运行 5 个独立 dart 入口时，每个
// 文件都会启动一次 Windows 桌面应用；前一次进程还未完全释放就启动下一
// 次，会出现 `The log reader stopped unexpectedly` 错误。把 5 个场景汇
// 总到一个聚合入口里，仅启动一次桌面应用即可顺序执行所有 group。
//
// 每个被聚合的测试文件保留独立可运行性（`flutter test -d windows
// integration_test/scenario_*.dart` 仍可单独跑），本文件仅作为「一键全跑」
// 的总入口，与单独运行不冲突。

import 'scenario_a1_palette_smoke_test.dart' as scenario_a1;
import 'scenario_b3_concurrent_streams_test.dart' as scenario_b3;
import 'scenario_b4_version_archive_test.dart' as scenario_b4;
import 'scenario_b7_memory_triggers_test.dart' as scenario_b7;
import 'scenario_c1_scroll_policy_test.dart' as scenario_c1;

void main() {
  // 顺序调用各场景的 main()；group / test 注册顺序与文件名顺序一致，
  // 失败时报错信息会带上各自 group 名称便于定位。
  scenario_a1.main();
  scenario_b3.main();
  scenario_b4.main();
  scenario_b7.main();
  scenario_c1.main();
}
