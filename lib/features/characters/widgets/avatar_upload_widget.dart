import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:image_cropper/image_cropper.dart';
import 'package:image_picker/image_picker.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

import '../../../core/utils/image_utils.dart';
import '../../../theme/app_theme.dart';

/// 角色头像上传组件 — 严格 1:1 对照 src/app/characters/[id]/page.tsx
/// 「身份信息」分组中头像方块（TSX 第 372~395 行）。
///
/// 视觉契约（每处都对应 TSX 中的 className）：
/// - 容器：`relative h-24 w-24 shrink-0 overflow-hidden rounded-3xl`（96×96 圆角 24）
///   `bg-gradient-to-br from-accent/15 to-accent-light/25 shadow-inner`
/// - 已有图片：`h-full w-full object-cover`
/// - 无图占位：`flex h-full w-full items-center justify-center text-3xl`
///   `font-semibold text-accent-dark` + `character.name[0]`
/// - hover 蒙版（`absolute inset-0 ... bg-black/20 text-white opacity-0`
///   `transition hover:opacity-100`）+ 居中 CameraIcon h-6 w-6
///
/// 内部图片选择/裁剪/缩放保存逻辑严格保留：圆形裁剪、512×512 PNG、
/// 应用存储目录命名 `avatar_<timestamp>.png`；不影响主项目兼容。
class AvatarUploadWidget extends StatefulWidget {
  /// 当前头像文件路径（null 表示无自定义头像）
  final String? currentAvatarPath;

  /// 角色名称，用于生成默认头像首字符
  final String characterName;

  /// 头像变更回调，返回新头像的本地文件路径
  final ValueChanged<String> onAvatarChanged;

  const AvatarUploadWidget({
    super.key,
    this.currentAvatarPath,
    required this.characterName,
    required this.onAvatarChanged,
  });

  @override
  State<AvatarUploadWidget> createState() => AvatarUploadWidgetState();
}

/// 公开 State 以便测试访问内部方法
class AvatarUploadWidgetState extends State<AvatarUploadWidget> {
  final ImagePicker _picker = ImagePicker();
  bool _isProcessing = false;
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;

    return MouseRegion(
      cursor: _isProcessing
          ? SystemMouseCursors.basic
          : SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: GestureDetector(
        onTap: _isProcessing ? null : _showSourcePicker,
        child: SizedBox(
          width: 96,
          height: 96,
          child: Stack(
            children: [
              // h-24 w-24 rounded-3xl 渐变方块 + shadow-inner
              Positioned.fill(
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(24),
                  child: _buildAvatar(isDark),
                ),
              ),
              // hover 蒙版（bg-black/20 + 居中相机图标）
              Positioned.fill(
                child: AnimatedOpacity(
                  duration: const Duration(milliseconds: 180),
                  opacity: _hover ? 1 : 0,
                  child: Container(
                    decoration: BoxDecoration(
                      color: Colors.black.withValues(alpha: 0.20),
                      borderRadius: BorderRadius.circular(24),
                    ),
                    child: const Center(
                      child: Icon(
                        Icons.camera_alt_outlined, // CameraIcon
                        size: 24, // h-6 w-6
                        color: Colors.white,
                      ),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// 构建头像内容（图片 / 渐变占位 + 首字符）
  Widget _buildAvatar(bool isDark) {
    final avatarPath = widget.currentAvatarPath;

    // 渐变背景 + shadow-inner（用 BoxDecoration 模拟）
    final gradient = LinearGradient(
      begin: Alignment.topLeft,
      end: Alignment.bottomRight,
      colors: isDark
          ? [
              AppTheme.darkAccent.withValues(alpha: 0.15),
              AppTheme.darkAccent.withValues(alpha: 0.25),
            ]
          : [
              // from-accent/15 to-accent-light/25
              AppTheme.accent.withValues(alpha: 0.15),
              AppTheme.accentLight.withValues(alpha: 0.25),
            ],
    );

    // 有自定义头像时显示图片
    if (avatarPath != null && avatarPath.isNotEmpty) {
      final file = File(avatarPath);
      return Container(
        decoration: BoxDecoration(gradient: gradient),
        child: Image.file(
          file,
          width: 96,
          height: 96,
          fit: BoxFit.cover,
          errorBuilder: (_, __, ___) => _buildDefaultAvatar(isDark, gradient),
        ),
      );
    }

    return _buildDefaultAvatar(isDark, gradient);
  }

  /// 默认占位（渐变 + 首字符 / 人物图标）
  Widget _buildDefaultAvatar(bool isDark, Gradient gradient) {
    final firstChar = extractFirstCharacter(widget.characterName);
    return Container(
      decoration: BoxDecoration(gradient: gradient),
      child: Center(
        child: firstChar != null
            ? Text(
                firstChar,
                style: TextStyle(
                  fontSize: 30, // text-3xl
                  fontWeight: FontWeight.w600,
                  color: isDark
                      ? AppTheme.darkAccentDark
                      : AppTheme.accentDark,
                ),
              )
            : Icon(
                Icons.person_rounded,
                size: 36,
                color: isDark
                    ? AppTheme.darkAccentDark
                    : AppTheme.accentDark,
              ),
      ),
    );
  }

  /// 弹出图片来源选择
  void _showSourcePicker() {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final isMobile = _isMobilePlatform();

    showModalBottomSheet(
      context: context,
      backgroundColor: isDark ? AppTheme.darkSurfaceRaised : Colors.white,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              // 标题
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: Text(
                  '选择头像来源',
                  style: TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w600,
                    color: isDark
                        ? AppTheme.darkTextPrimary
                        : AppTheme.textPrimary,
                  ),
                ),
              ),
              // 相册
              _buildSourceOption(
                ctx,
                icon: Icons.photo_library_rounded,
                label: '从相册选择',
                isDark: isDark,
                onTap: () {
                  Navigator.pop(ctx);
                  _pickImage(ImageSource.gallery);
                },
              ),
              // 相机（仅移动端）
              if (isMobile)
                _buildSourceOption(
                  ctx,
                  icon: Icons.camera_alt_rounded,
                  label: '拍照',
                  isDark: isDark,
                  onTap: () {
                    Navigator.pop(ctx);
                    _pickImage(ImageSource.camera);
                  },
                ),
              // 文件选择 — 桌面端直接打开 FilePicker，移动端复用相册
              _buildSourceOption(
                ctx,
                icon: Icons.folder_rounded,
                label: '从文件选择',
                isDark: isDark,
                onTap: () {
                  Navigator.pop(ctx);
                  _pickImageFromFile();
                },
              ),
              const SizedBox(height: 8),
              // 取消按钮
              _buildSourceOption(
                ctx,
                icon: Icons.close_rounded,
                label: '取消',
                isDark: isDark,
                isCancel: true,
                onTap: () => Navigator.pop(ctx),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// 构建来源选项行
  Widget _buildSourceOption(
    BuildContext ctx, {
    required IconData icon,
    required String label,
    required bool isDark,
    bool isCancel = false,
    required VoidCallback onTap,
  }) {
    return ListTile(
      leading: Icon(
        icon,
        color: isCancel
            ? (isDark ? AppTheme.darkTextMuted : AppTheme.textMuted)
            : (isDark ? AppTheme.darkAccent : AppTheme.accent),
        size: 22,
      ),
      title: Text(
        label,
        style: TextStyle(
          fontSize: 15,
          color: isCancel
              ? (isDark ? AppTheme.darkTextMuted : AppTheme.textMuted)
              : (isDark ? AppTheme.darkTextPrimary : AppTheme.textPrimary),
        ),
      ),
      onTap: onTap,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
    );
  }

  /// P1-4：从文件系统选择图片
  ///
  /// - 桌面端（Windows/Linux/macOS）/Web 使用 FilePicker，体验更原生
  /// - 移动端 image_picker 的 gallery 入口已经覆盖文件选择，复用即可
  Future<void> _pickImageFromFile() async {
    if (_isMobilePlatform()) {
      await _pickImage(ImageSource.gallery);
      return;
    }
    try {
      final result = await FilePicker.platform.pickFiles(
        type: FileType.image,
        allowMultiple: false,
      );
      if (result == null || result.files.isEmpty) return;
      final filePath = result.files.single.path;
      if (filePath == null) return;

      final fileSize = await File(filePath).length();
      final validationError = ImageUtils.validateFile(filePath, fileSize);
      if (validationError != null) {
        _showError(validationError);
        return;
      }

      // 桌面端 image_cropper 无原生实现，跳过裁剪直接缩放保存
      if (!kIsWeb && (Platform.isWindows || Platform.isLinux)) {
        await _processAndSave(filePath);
        return;
      }

      // macOS 进入裁剪流程
      await _cropImage(filePath);
    } catch (e) {
      _showError('选择图片失败: $e');
    }
  }

  /// 选择图片
  Future<void> _pickImage(ImageSource source) async {
    try {
      final XFile? pickedFile = await _picker.pickImage(source: source);
      if (pickedFile == null) return; // 用户取消，保留当前头像

      // 验证文件格式和大小
      final filePath = pickedFile.path;
      final fileSize = await File(filePath).length();

      final validationError = ImageUtils.validateFile(filePath, fileSize);
      if (validationError != null) {
        _showError(validationError);
        return;
      }

      // Windows 桌面端 image_cropper 无原生实现，跳过裁剪直接缩放保存
      if (!kIsWeb && (Platform.isWindows || Platform.isLinux)) {
        await _processAndSave(filePath);
        return;
      }

      // 移动端 / macOS 进入裁剪流程
      await _cropImage(filePath);
    } catch (e) {
      _showError('选择图片失败: $e');
    }
  }

  /// 裁剪图片 — 圆形裁剪框，最小 100×100
  Future<void> _cropImage(String sourcePath) async {
    try {
      final isDark = Theme.of(context).brightness == Brightness.dark;

      final croppedFile = await ImageCropper().cropImage(
        sourcePath: sourcePath,
        aspectRatio: const CropAspectRatio(ratioX: 1, ratioY: 1),
        compressQuality: 95,
        maxWidth: 1024,
        maxHeight: 1024,
        uiSettings: [
          AndroidUiSettings(
            toolbarTitle: '裁剪头像',
            toolbarColor: isDark ? AppTheme.darkSurface : Colors.white,
            toolbarWidgetColor: isDark
                ? AppTheme.darkTextPrimary
                : AppTheme.textPrimary,
            backgroundColor: isDark ? AppTheme.darkWarm50 : AppTheme.warm50,
            activeControlsWidgetColor: AppTheme.accent,
            cropGridColor: AppTheme.accent.withValues(alpha: 0.3),
            cropFrameColor: AppTheme.accent,
            cropStyle: CropStyle.circle,
            initAspectRatio: CropAspectRatioPreset.square,
            lockAspectRatio: true,
            hideBottomControls: false,
            showCropGrid: true,
          ),
          IOSUiSettings(
            title: '裁剪头像',
            cancelButtonTitle: '取消',
            doneButtonTitle: '确认',
            cropStyle: CropStyle.circle,
            aspectRatioLockEnabled: true,
            resetAspectRatioEnabled: false,
            aspectRatioPickerButtonHidden: true,
            rotateButtonsHidden: true,
            minimumAspectRatio: 1.0,
          ),
        ],
      );

      if (croppedFile == null) return; // 用户取消裁剪，保留当前头像

      // 缩放并保存
      await _processAndSave(croppedFile.path);
    } catch (e) {
      _showError('裁剪图片失败: $e');
    }
  }

  /// 缩放为 512×512 PNG 并保存到应用存储目录
  Future<void> _processAndSave(String croppedPath) async {
    if (!mounted) return;
    setState(() => _isProcessing = true);

    try {
      // 获取应用存储目录
      final appDir = await getApplicationDocumentsDirectory();
      final avatarsDir = Directory(p.join(appDir.path, 'avatars'));
      if (!await avatarsDir.exists()) {
        await avatarsDir.create(recursive: true);
      }

      // 生成唯一文件名
      final timestamp = DateTime.now().millisecondsSinceEpoch;
      final outputPath = p.join(avatarsDir.path, 'avatar_$timestamp.png');

      // 缩放为 512×512 PNG
      await ImageUtils.resizeToAvatarPng(croppedPath, outputPath);

      // 通知外部头像已更新
      widget.onAvatarChanged(outputPath);
    } catch (e) {
      _showError('保存头像失败: $e');
    } finally {
      if (mounted) {
        setState(() => _isProcessing = false);
      }
    }
  }

  /// 显示错误提示
  void _showError(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(message),
        backgroundColor: Colors.red.shade400,
        behavior: SnackBarBehavior.floating,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),
    );
  }

  /// 判断是否为移动端平台
  bool _isMobilePlatform() {
    if (kIsWeb) return false;
    return Platform.isAndroid || Platform.isIOS;
  }

  /// 从名称中提取第一个字符（支持 CJK 多字节字符）
  ///
  /// 返回 null 表示名称为空，应显示人物图标。
  /// 正确处理 Unicode 字符（包括 CJK、emoji 等多字节字符）。
  static String? extractFirstCharacter(String name) {
    final trimmed = name.trim();
    if (trimmed.isEmpty) return null;

    // 使用 Characters 类正确处理 Unicode 字符簇
    // （包括 CJK 表意文字、emoji 组合字符等）
    final characters = trimmed.characters;
    return characters.first;
  }
}
