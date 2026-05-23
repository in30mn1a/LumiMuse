// 主题层 —— 槽位抽象（PageRegion / PageSlot / SlotAnchor）
//
// 该文件落实「UI 布局唯一基准原则」的工程契约：核心五页（HomePage / ChatView /
// CharacterEditPage / MemoryListPage / SettingsPage）以及弹层（ExportDialog /
// ImportDialog / 对话内大图 Lightbox 工具组）的根 widget，必须以 [PageRegion]
// 列表声明结构。槽位的 order / anchor / id 一旦确定，便是 Flutter 端相对主项目
// 源码（src/）+ assets/ 五张参考截图的最小可机器校验单位。
//
// 关键约定（与 design.md §UI 布局基准在工程上的强制方式 一致）：
//   1. 子 spec（flutter-core-features / flutter-data-management /
//      flutter-parity-completion / flutter-platform-polish /
//      flutter-visual-polish）修改某个 widget 的内部细节时，**不得**改变
//      [PageSlot.order]、[PageSlot.anchor]、[PageSlot.id] 三者中的任意一项；
//      仅允许调整 [PageSlot.build] 闭包返回的子树的内部细节。
//   2. 任何「把按钮从工具栏挪到底栏 / 调换分组顺序 / 新增主项目没有的 FAB」之类
//      调整都会破坏 order 与 anchor 的不变量，回归脚本（RC-11）会立即扫出。
//   3. 同一 [PageRegion] 内的 slots 必须严格递增、无重复 order；构造时通过
//      `assert` 立即校验，避免运行期才暴露顺序冲突。
//
// 该抽象只在核心五页 + 弹层骨架使用，不强制套用到所有 widget；具体 widget
// 内部仍由子 spec 按现有约定自由实现。

import 'package:flutter/widgets.dart';

/// 槽位锚点 —— 决定一个 [PageSlot] 在 [PageRegion] 内的对齐方位。
///
/// - [start]：靠起始侧（水平 Row 中等价于「左侧」，遵循当前文本方向）。
/// - [center]：居中。
/// - [end]：靠结束侧（水平 Row 中等价于「右侧」，遵循当前文本方向）。
enum SlotAnchor { start, center, end }

/// 单个槽位的契约。
///
/// 一个 [PageSlot] 描述「在某个 [PageRegion] 中的第 [order] 个、对齐到
/// [anchor] 方位、可选语义 id 为 [id] 的子项，由 [build] 闭包按需构造其
/// widget 子树」。
///
/// [order] 在所属 [PageRegion] 内必须严格递增、无重复（由 [PageRegion] 构造
/// 时的 `assert` 校验）。[id] 用于在测试与回归脚本中按语义定位某一槽位
/// （例如 `btnAiGenerate` / `btnSave`）。
@immutable
class PageSlot {
  const PageSlot({
    required this.order,
    required this.anchor,
    required this.build,
    this.id,
  });

  /// 在所属 Region 内的相对顺序（1-based 推荐，但允许从 0 开始）。
  final int order;

  /// 对齐锚点。
  final SlotAnchor anchor;

  /// 可选语义 id，用于断言与回归扫描定位（例如 `btnSave`）。
  final String? id;

  /// 该槽位的 widget 构造闭包。
  ///
  /// 子 spec 实施过程中允许调整本闭包返回的子树的内部细节，但不得改变
  /// 所属 [PageSlot] 的 [order] / [anchor] / [id]。
  final Widget Function(BuildContext context) build;
}

/// 页面 / 弹层的某一区域（Region）。
///
/// 一个页面通常由若干 [PageRegion] 组成（例如对话视图分为「顶部 hero
/// 工具栏」「中部消息区 surface-panel」「底部 ChatInput」三段），每段内部由
/// 若干 [PageSlot] 组成。槽位顺序与锚点是 Flutter 端 UI 布局相对主项目源码
/// 的对齐基准。
///
/// 构造时通过 `assert` 校验 [slots] 中的 [PageSlot.order] 严格递增、无重复；
/// 一旦违反，开发期会立即抛出，避免运行期 UI 漂移。
@immutable
class PageRegion {
  PageRegion({
    required this.name,
    required this.slots,
  }) : assert(
          _isStrictlyAscending(slots),
          'PageRegion "$name" 的 slots.order 必须严格递增且无重复；'
          '请检查是否有子 spec 擅自改变了槽位顺序或重复声明了 order。',
        );

  /// Region 的语义名称（例如 `headerActions` / `toolbarMain`）。
  final String name;

  /// 该 Region 包含的槽位列表，order 严格递增、无重复。
  final List<PageSlot> slots;

  /// 校验 [slots] 中的 order 是否严格递增（同时蕴含「无重复」）。
  static bool _isStrictlyAscending(List<PageSlot> slots) {
    for (var i = 1; i < slots.length; i++) {
      if (slots[i].order <= slots[i - 1].order) return false;
    }
    return true;
  }
}

/// 按 [PageRegion.slots] 渲染出一行（[Row]）布局。
///
/// 实现规则：
///   1. 先按 [PageSlot.order] 升序对所有槽位排序（与构造期 assert 互为冗余，
///      确保即便外部传入未排序的列表也能稳定渲染）。
///   2. 按 [PageSlot.anchor] 分组：[SlotAnchor.start] 在左、
///      [SlotAnchor.center] 居中、[SlotAnchor.end] 在右。
///   3. 仅存在单一 anchor 类型时，使用对应的 [MainAxisAlignment]
///      （`start` / `center` / `end`）；存在多种 anchor 混合时，使用
///      `[...start, Spacer, ...center, Spacer, ...end]` 的标准三段式，
///      让 start 段靠左、center 段居中、end 段靠右同时成立。
///
/// 该方法只负责水平方向的槽位编排；垂直方向的多 Region 组合由调用方
/// （核心五页根 widget）通过 [Column] 或 [CustomScrollView] 自行排布。
Widget renderRegion(PageRegion region) {
  return Builder(
    builder: (context) {
      final sorted = [...region.slots]..sort((a, b) => a.order.compareTo(b.order));
      final startWidgets = <Widget>[];
      final centerWidgets = <Widget>[];
      final endWidgets = <Widget>[];
      for (final slot in sorted) {
        final child = slot.build(context);
        switch (slot.anchor) {
          case SlotAnchor.start:
            startWidgets.add(child);
            break;
          case SlotAnchor.center:
            centerWidgets.add(child);
            break;
          case SlotAnchor.end:
            endWidgets.add(child);
            break;
        }
      }

      final hasStart = startWidgets.isNotEmpty;
      final hasCenter = centerWidgets.isNotEmpty;
      final hasEnd = endWidgets.isNotEmpty;

      // 单一 anchor：直接映射到对应的 MainAxisAlignment。
      if (hasStart && !hasCenter && !hasEnd) {
        return Row(
          mainAxisAlignment: MainAxisAlignment.start,
          children: startWidgets,
        );
      }
      if (!hasStart && hasCenter && !hasEnd) {
        return Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: centerWidgets,
        );
      }
      if (!hasStart && !hasCenter && hasEnd) {
        return Row(
          mainAxisAlignment: MainAxisAlignment.end,
          children: endWidgets,
        );
      }
      if (!hasStart && !hasCenter && !hasEnd) {
        // 空 Region 也是合法形态（例如某弹层尚未注入任何槽位）。
        return const SizedBox.shrink();
      }

      // 混合 anchor：用两段 Spacer 包夹 center 段，让三组对齐同时成立。
      final children = <Widget>[
        ...startWidgets,
        if (hasCenter || hasEnd) const Spacer(),
        ...centerWidgets,
        if (hasCenter && hasEnd) const Spacer(),
        ...endWidgets,
      ];
      return Row(children: children);
    },
  );
}
