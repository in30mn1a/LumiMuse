// 文件作用：LumiMuse Flutter 图标契约（与主项目 src/components/ui/icons.tsx 1:1 对齐）
//
// 来源任务：flutter-parity-gaps-fill / 任务 2.1
// 落实需求：R4.1、R4.2、R4.6、R4.7、R6.2
// 落实回归契约：RC-5（scripts/regression-check-flutter-parity.js）
//
// ─────────────────────────────────────────────────────────────────────────
// 命名风格说明（实施期一次性确认）
// ─────────────────────────────────────────────────────────────────────────
// 字段命名采用 lowerCamelCase（如 menuIcon、moreVerticalIcon），与
// `AppTheme`、`AppColors` 等同目录其它静态契约保持一致，并满足 Dart 内置
// `constant_identifier_names` 规则。
//
// RC-5 当前实现位于 `scripts/regression-check-flutter-parity.js`，对每个主
// 项目导出名 `<Name>Icon` 仅做 `\b<Name>Icon\b` 整词匹配；下方「映射决策表」
// 注释中已逐项列出 25 个 PascalCase 名（`MenuIcon` / `MoreVerticalIcon`
// 等），整词匹配会命中本文件，因此 lowerCamelCase 字段命名与 RC-5 不冲突。
//
// 若将来 RC-5 改为「严格 PascalCase 字段名比对」（例如要求声明
// `static const IconData MenuIcon = ...`），仅需将下方字段重命名为
// PascalCase 即可，不影响调用方语义。
//
// ─────────────────────────────────────────────────────────────────────────
// 与主项目 src/components/ui/icons.tsx 的映射决策表（视觉最近原则）
// ─────────────────────────────────────────────────────────────────────────
//
// | 主项目导出名     | Dart 字段          | Material Icons 候选        | 视觉差异说明                     |
// | ---------------- | ------------------ | -------------------------- | -------------------------------- |
// | MenuIcon         | menuIcon           | Icons.menu                 | 完全等价（三横线）               |
// | MoreVerticalIcon | moreVerticalIcon   | Icons.more_vert            | 完全等价（三点竖排）             |
// | SparkIcon        | sparkIcon          | Icons.auto_awesome         | 主项目为大星 + 小星双层；候选为   |
// |                  |                    |                            | 三星簇，强调感一致               |
// | PlusIcon         | plusIcon           | Icons.add                  | 完全等价                         |
// | ChevronDownIcon  | chevronDownIcon    | Icons.expand_more          | 完全等价                         |
// | ArrowLeftIcon    | arrowLeftIcon      | Icons.arrow_back           | 完全等价                         |
// | ChatIcon         | chatIcon           | Icons.chat_bubble_outline  | 完全等价（描边气泡）             |
// | MemoryIcon       | memoryIcon         | Icons.psychology_outlined  | 主项目为双圆 + 中线，候选为大脑； |
// |                  |                    |                            | 语义一致（记忆 / 思考），略异     |
// | SettingsIcon     | settingsIcon       | Icons.settings_outlined    | 完全等价（齿轮）                 |
// | PencilIcon       | pencilIcon         | Icons.edit_outlined        | 完全等价                         |
// | TrashIcon        | trashIcon          | Icons.delete_outline       | 完全等价                         |
// | ClockIcon        | clockIcon          | Icons.access_time          | 完全等价                         |
// | SearchIcon       | searchIcon         | Icons.search               | 完全等价                         |
// | CameraIcon       | cameraIcon         | Icons.camera_alt_outlined  | 完全等价                         |
// | LinkIcon         | linkIcon           | Icons.link                 | 完全等价（链条）                 |
// | CopyIcon         | copyIcon           | Icons.content_copy_outlined| 完全等价（双叠框）               |
// | RefreshIcon      | refreshIcon        | Icons.refresh              | 完全等价                         |
// | ReplyIcon        | replyIcon          | Icons.reply_outlined       | 完全等价                         |
// | StopIcon         | stopIcon           | Icons.stop_outlined        | 完全等价（描边方块）             |
// | CheckIcon        | checkIcon          | Icons.check                | 完全等价                         |
// | SummaryIcon      | summaryIcon        | Icons.summarize_outlined   | 完全等价（带横线文档）           |
// | DuplicateIcon    | duplicateIcon      | Icons.copy_all_outlined    | 完全等价                         |
// | ListIcon         | listIcon           | Icons.format_list_bulleted | 完全等价                         |
// | ImageIcon        | imageIcon          | Icons.image_outlined       | 完全等价                         |
// | WandIcon         | wandIcon           | Icons.auto_fix_high        | 完全等价（魔法棒 + 火花）        |
//
// ─────────────────────────────────────────────────────────────────────────
// 修改约定
// ─────────────────────────────────────────────────────────────────────────
// 1. 修改本文件前，请先同步更新主项目 `src/components/ui/icons.tsx`；
//    主项目是图标契约的真实来源，Flutter 端跟随主项目。
// 2. 新增图标键必须同时在主项目和本文件登记，并补全文件头映射决策表。
// 3. 不引入第三方图标包（如 lucide_icons / cupertino_icons 之外的扩展包），
//    全部使用 Flutter SDK 自带的 Material Icons（落实 R4.6 / R6.2）。
//
// 当前阶段说明：
//   本文件不主动替换 widget 内现有 `Icons.xxx` 调用（避免扩大改动面，
//   落实 R4.5）；widget 替换由各子 spec 自行推进。本任务仅保证
//   `class AppIcons` 存在且 25 个 `static const IconData` 字段全部命中
//   有效 Material Icons。

import 'package:flutter/material.dart';

/// LumiMuse 图标契约命名空间。
///
/// 25 个键的命名严格对齐主项目 `src/components/ui/icons.tsx` 导出函数名
/// （首字母小写化为 lowerCamelCase）。各字段类型为 [IconData]；调用方通常
/// 以 `Icon(AppIcons.menuIcon, size: 20)` 形式使用。
class AppIcons {
  AppIcons._();

  // ── 导航与操作 ──
  static const IconData menuIcon = Icons.menu;
  static const IconData moreVerticalIcon = Icons.more_vert;
  static const IconData plusIcon = Icons.add;
  static const IconData chevronDownIcon = Icons.expand_more;
  static const IconData arrowLeftIcon = Icons.arrow_back;

  // ── 主功能区 ──
  static const IconData chatIcon = Icons.chat_bubble_outline;
  static const IconData memoryIcon = Icons.psychology_outlined;
  static const IconData settingsIcon = Icons.settings_outlined;
  static const IconData searchIcon = Icons.search;

  // ── 编辑与状态 ──
  static const IconData pencilIcon = Icons.edit_outlined;
  static const IconData trashIcon = Icons.delete_outline;
  static const IconData clockIcon = Icons.access_time;
  static const IconData checkIcon = Icons.check;
  static const IconData stopIcon = Icons.stop_outlined;
  static const IconData refreshIcon = Icons.refresh;

  // ── 内容与多媒体 ──
  static const IconData cameraIcon = Icons.camera_alt_outlined;
  static const IconData linkIcon = Icons.link;
  static const IconData copyIcon = Icons.content_copy_outlined;
  static const IconData duplicateIcon = Icons.copy_all_outlined;
  static const IconData replyIcon = Icons.reply_outlined;
  static const IconData summaryIcon = Icons.summarize_outlined;
  static const IconData listIcon = Icons.format_list_bulleted;
  static const IconData imageIcon = Icons.image_outlined;

  // ── 装饰与魔法 ──
  static const IconData sparkIcon = Icons.auto_awesome;
  static const IconData wandIcon = Icons.auto_fix_high;
}
