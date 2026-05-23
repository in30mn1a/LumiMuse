// _io_stub.dart — Web 平台下的 dart:io 占位
//
// app_widgets.dart 通过条件导入引入：
//   import 'dart:io' if (dart.library.html) '_io_stub.dart';
//
// 在 Web 平台编译时，dart:io 不可用；此 stub 仅提供 app_widgets.dart 中实际
// 用到的 API（仅 `File`），保证编译通过。运行时 app_widgets.dart 会通过
// `kIsWeb` 守卫，避免真正走到 File 分支。
class File {
  final String path;
  File(this.path);

  Future<bool> exists() async => false;
  bool existsSync() => false;
}
