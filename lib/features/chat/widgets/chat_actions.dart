import 'dart:convert';
import 'package:drift/drift.dart' show Value;
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:uuid/uuid.dart';
import '../../../core/database/database.dart';
import '../../../core/models/app_settings.dart';
import '../../../core/models/attachment_item.dart';
import '../../../core/models/message_metadata.dart';
import '../../../core/providers/character_images_actions.dart';
import '../../../core/providers/chat_provider.dart';
import '../../../core/providers/conversation_provider.dart';
import '../../../core/providers/database_provider.dart';
import '../../../core/providers/message_provider.dart';
import '../../../core/providers/selection_provider.dart';
import '../../../core/providers/settings_provider.dart';
import '../../../core/services/image_gen_service.dart';
import '../../../core/services/image_prompt_service.dart';
import '../../../core/services/summarize_service.dart';
import '../../../core/utils/i18n.dart';
import '../utils/image_delete_paths.dart' as img_del;
import 'chat_toast.dart';

class ChatActions {
  final WidgetRef ref;
  String? conversationId;
  final void Function(String message, {ChatToastType type}) showToast;
  final void Function() refreshMessages;
  final void Function() requestScrollToBottom;
  final bool Function() isMounted;
  final void Function() resetAnimationState;
  final void Function() resetMemoryTaskSeen;
  final void Function(String id) onConversationChanged;
  bool isGeneratingImage = false;

  ChatActions({
    required this.ref,
    this.conversationId,
    required this.showToast,
    required this.refreshMessages,
    required this.requestScrollToBottom,
    required this.isMounted,
    required this.resetAnimationState,
    required this.resetMemoryTaskSeen,
    required this.onConversationChanged,
  });

  String _i18n(String key, [Map<String, Object?>? args]) {
    final lang = ref.watch(localeProvider).languageCode;
    if (args == null) return I18n.t(key, lang: lang);
    return I18n.tArgs(key, args, lang: lang);
  }

  Future<void> sendMessage(String text, [List<AttachmentItem>? attachments]) async {
    final trimmedText = text.trim();
    if (trimmedText.isEmpty && (attachments == null || attachments.isEmpty)) return;

    final selection = ref.read(selectionProvider);
    if (selection.characterId == null) return;

    if (conversationId == null) {
      final convActions = ref.read(conversationActionsProvider);
      final id = await convActions.create(characterId: selection.characterId!);
      conversationId = id;
      onConversationChanged(id);
      ref.read(selectionProvider.notifier).setActiveConversation(id);
    }

    requestScrollToBottom();

    final controller =
        ref.read(chatControllerProvider(conversationId!).notifier);

    if (attachments != null && attachments.isNotEmpty) {
      await controller.sendMessageWithAttachments(trimmedText, attachments);
    } else {
      await controller.sendMessage(trimmedText);
    }
    requestScrollToBottom();
  }

  Future<void> sendFromInput(
    String text,
    List<AttachmentItem>? attachments,
  ) async {
    // 与 sendMessage 完全等价，仅作为 ChatInput 的回调适配点；
    // 直接委托避免分支重复逻辑（曾因独立维护导致空文本判断不一致）。
    await sendMessage(text, attachments);
  }

  void stopGeneration() {
    if (conversationId == null) return;
    ref
        .read(chatControllerProvider(conversationId!).notifier)
        .stop();
  }

  Future<void> regenerate(String messageId) async {
    if (conversationId == null) return;
    await ref
        .read(chatControllerProvider(conversationId!).notifier)
        .regenerate(messageId);
  }

  Future<void> regenerateFromHere(String userMessageId) async {
    final convId = conversationId;
    if (convId == null) return;
    final messagesAsync = ref.read(messageListProvider(convId));
    final msgs = messagesAsync.valueOrNull ?? const [];
    final idx = msgs.indexWhere((m) => m.id == userMessageId);
    if (idx == -1) {
      showToast('找不到目标用户消息');
      return;
    }
    final nextAssistant = msgs.skip(idx + 1).cast<Message?>().firstWhere(
          (m) => m?.role == 'assistant',
          orElse: () => null,
        );
    if (nextAssistant != null) {
      ref
          .read(chatControllerProvider(convId).notifier)
          .regenerate(nextAssistant.id);
    } else {
      final userContent = msgs[idx].content;
      await ref
          .read(chatControllerProvider(convId).notifier)
          .sendMessageSkipUserInsert(userContent);
    }
  }

  Future<void> generateImageForMessage(String messageId, {String? existingPrompt, String? replaceImageId}) async {
    final convId = conversationId;
    if (convId == null) return;
    if (isGeneratingImage) {
      showToast('正在生成图片，请稍候', type: ChatToastType.info);
      return;
    }
    isGeneratingImage = true;
    refreshMessages();
    showToast('正在生成图片...', type: ChatToastType.info);

    final db = ref.read(databaseProvider);

    // 对照主项目：replaceImageId 有值时复用该 ID（原位替换），
    // 否则使用 UUID v4 生成新 ID 避免碰撞（旧实现拼接 hashCode 仍存在
    // 同毫秒 + hashCode 低 12 位重合的风险）。
    final placeholderId = replaceImageId ?? const Uuid().v4();

    // upsert 占位条目：path 为空时 message_bubble 渲染"正在生图…"卡片
    Future<void> upsertPlaceholder({
      required String prompt,
    }) async {
      final msg = await (db.select(db.messages)
            ..where((t) => t.id.equals(messageId)))
          .getSingle();
      final meta = MessageMetadata.fromJsonString(msg.metadata);
      final existingIndex =
          meta.generatedImages.indexWhere((img) => img.id == placeholderId);
      final List<GeneratedImage> nextImages;
      if (existingIndex >= 0) {
        nextImages = [...meta.generatedImages];
        nextImages[existingIndex] = GeneratedImage(
          id: placeholderId,
          url: '',
          path: '',
          prompt: prompt,
          status: 'pending',
        );
      } else {
        nextImages = [
          ...meta.generatedImages,
          GeneratedImage(
            id: placeholderId,
            url: '',
            path: '',
            prompt: prompt,
            status: 'pending',
          ),
        ];
      }
      final newMeta = meta.copyWith(generatedImages: nextImages);
      await (db.update(db.messages)..where((t) => t.id.equals(messageId)))
          .write(MessagesCompanion(metadata: Value(newMeta.toJsonString())));
    }

    try {
      // 1) 占位处理
      if (replaceImageId != null) {
        // 原位替换：把现有图片状态改为 pending_image（保留原图显示直到新图生成完）
        final msg = await (db.select(db.messages)
              ..where((t) => t.id.equals(messageId)))
            .getSingle();
        final meta = MessageMetadata.fromJsonString(msg.metadata);
        final updatedForPending = meta.generatedImages.map((img) {
          if (img.id != replaceImageId) return img;
          return img.copyWith(status: 'pending_image');
        }).toList();
        final pendingMeta = meta.copyWith(generatedImages: updatedForPending);
        await (db.update(db.messages)..where((t) => t.id.equals(messageId)))
            .write(MessagesCompanion(metadata: Value(pendingMeta.toJsonString())));
      } else {
        // 新图片：写入空 prompt 占位
        await upsertPlaceholder(prompt: existingPrompt ?? '');
      }
      refreshMessages();
      requestScrollToBottom();

      final settings =
          ref.read(settingsProvider).valueOrNull ?? const AppSettings();

      // 2) 生成 prompt（如果已有 existingPrompt 则跳过 AI 生成）
      String positivePrompt;
      String negativePrompt = '';
      if (existingPrompt != null && existingPrompt.isNotEmpty) {
        positivePrompt = existingPrompt;
      } else {
        final promptService = ImagePromptService();
        final p = await promptService.generateImagePrompt(
          settings,
          convId,
          db,
          messageId: messageId,
        );
        promptService.dispose();
        positivePrompt = p.positive;
        negativePrompt = p.negative;
      }

      // 3) 把 prompt 写回占位（仅新图片时）
      if (replaceImageId == null) {
        await upsertPlaceholder(prompt: positivePrompt);
        refreshMessages();
      }

      // 4) 调用引擎生图
      final imageService = ImageGenService();
      final imagePath = await imageService.generate(
        prompt: positivePrompt,
        negativePrompt: negativePrompt,
        settings: settings.imageGen,
      );
      imageService.dispose();

      // 5) 用真实路径替换占位
      final msg = await (db.select(db.messages)
            ..where((t) => t.id.equals(messageId)))
          .getSingle();
      final meta = MessageMetadata.fromJsonString(msg.metadata);

      List<GeneratedImage> updatedImages;
      if (replaceImageId != null) {
        // 对照主项目：replaceImageId 有值时，把新图片追加为版本
        updatedImages = meta.generatedImages.map((img) {
          if (img.id != replaceImageId) return img;
          // 归一化 versions
          var versions = List<ImageVersion>.from(img.versions);
          if (versions.isEmpty && img.url.isNotEmpty) {
            versions.add(ImageVersion(
              id: img.id,
              url: img.url,
              path: img.path,
              prompt: img.prompt,
            ));
          }
          // 追加新版本
          final newVersionId = DateTime.now().millisecondsSinceEpoch.toRadixString(36);
          versions.add(ImageVersion(
            id: newVersionId,
            url: imagePath,
            path: imagePath,
            prompt: positivePrompt,
          ));
          return img.copyWith(
            url: imagePath,
            path: imagePath,
            prompt: positivePrompt,
            status: 'ready',
            versions: versions,
            activeVersion: versions.length - 1,
          );
        }).toList();
      } else {
        // 新图片：直接替换占位
        updatedImages = meta.generatedImages
            .map((img) => img.id == placeholderId
                ? GeneratedImage(
                    id: placeholderId,
                    url: imagePath,
                    path: imagePath,
                    prompt: positivePrompt,
                    status: 'ready',
                  )
                : img)
            .toList();
      }

      final newMeta = meta.copyWith(generatedImages: updatedImages);
      await (db.update(db.messages)..where((t) => t.id.equals(messageId)))
          .write(MessagesCompanion(metadata: Value(newMeta.toJsonString())));

      requestScrollToBottom();
      if (!isMounted()) return;
      showToast('图片生成完成', type: ChatToastType.info);
    } catch (e) {
      // 失败时将占位状态设为 failed，保留占位让用户可重试
      try {
        final msg = await (db.select(db.messages)
              ..where((t) => t.id.equals(messageId)))
            .getSingle();
        final meta = MessageMetadata.fromJsonString(msg.metadata);
        final updated = meta.copyWith(
          generatedImages: meta.generatedImages
              .map((img) => img.id == placeholderId
                  ? GeneratedImage(
                      id: placeholderId,
                      url: '',
                      path: '',
                      prompt: img.prompt,
                      status: 'failed',
                    )
                  : img)
              .toList(),
        );
        await (db.update(db.messages)..where((t) => t.id.equals(messageId)))
            .write(MessagesCompanion(metadata: Value(updated.toJsonString())));
      } catch (_) {
        // 更新失败保持原状，不影响主流程
      }
      if (!isMounted()) return;
      showToast('生图失败: $e');
    } finally {
      if (isMounted()) {
        isGeneratingImage = false;
        refreshMessages();
      }
    }
  }

  void copyMessage(String content) {
    Clipboard.setData(ClipboardData(text: content));
    showToast(_i18n('message.copied'), type: ChatToastType.info);
  }

  Future<void> deleteMessage(String messageId) async {
    final actions = ref.read(messageActionsProvider);
    await actions.delete(messageId);
  }

  Future<void> switchVersion(String messageId, int versionIndex) async {
    final actions = ref.read(messageActionsProvider);
    await actions.switchVersion(messageId, versionIndex);
  }

  Future<void> createNewConversation() async {
    final selection = ref.read(selectionProvider);
    if (selection.characterId == null) return;
    final convActions = ref.read(conversationActionsProvider);
    final id = await convActions.create(characterId: selection.characterId!);
    resetAnimationState();
    resetMemoryTaskSeen();
    conversationId = id;
    onConversationChanged(id);
    ref.read(selectionProvider.notifier).setActiveConversation(id);
  }

  Future<void> summarize() async {
    if (conversationId == null) return;
    showToast(_i18n('chat.summarizing'), type: ChatToastType.info);
    try {
      final db = ref.read(databaseProvider);
      final settings =
          ref.read(settingsProvider).valueOrNull ?? const AppSettings();
      final service = SummarizeService(db);
      await service.summarize(conversationId!, settings);
      service.dispose();
      if (!isMounted()) return;
      showToast(_i18n('chat.summarizeSuccess'), type: ChatToastType.info);
    } catch (e) {
      if (!isMounted()) return;
      showToast('${_i18n('chat.summarizeError')}: $e');
    }
  }

  Future<void> duplicateConversation() async {
    if (conversationId == null) return;
    try {
      final newId = await ref
          .read(conversationActionsProvider)
          .duplicate(conversationId!);
      conversationId = newId;
      onConversationChanged(newId);
      ref.read(selectionProvider.notifier).setActiveConversation(newId);
      if (!isMounted()) return;
      showToast(_i18n('chat.duplicateSuccess'), type: ChatToastType.info);
    } catch (e) {
      if (!isMounted()) return;
      showToast('${_i18n('chat.duplicateError')}: $e');
    }
  }

  Future<void> generateImage(String userHint) async {
    if (conversationId == null) return;
    isGeneratingImage = true;
    refreshMessages();
    String? placeholderId;
    try {
      final db = ref.read(databaseProvider);
      final settings =
          ref.read(settingsProvider).valueOrNull ?? const AppSettings();
      final promptService = ImagePromptService();
      final p = await promptService.generateImagePrompt(
        settings,
        conversationId!,
        db,
        userHint: userHint,
        messageId: null,
      );
      promptService.dispose();

      final messageActions = ref.read(messageActionsProvider);
      placeholderId = await messageActions.insertAssistantMessage(
        conversationId: conversationId!,
        content: '',
      );
      // 与 generateImageForMessage 一致：使用稳定非空 UUID 作为图片占位 ID，
      // 避免 GeneratedImage.id 为空导致的回调入参不可寻址。
      final imagePlaceholderId = const Uuid().v4();
      final placeholderMeta = MessageMetadata(
        generatedImages: [
          GeneratedImage(id: imagePlaceholderId, url: '', path: '', prompt: p.positive, status: 'pending'),
        ],
      );
      await (db.update(db.messages)..where((t) => t.id.equals(placeholderId!))).write(
        MessagesCompanion(metadata: Value(placeholderMeta.toJsonString())),
      );
      refreshMessages();
      requestScrollToBottom();

      final imageService = ImageGenService();
      final imagePath = await imageService.generate(
        prompt: p.positive,
        negativePrompt: p.negative,
        settings: settings.imageGen,
      );
      imageService.dispose();

      final doneMeta = MessageMetadata(
        generatedImages: [
          GeneratedImage(id: imagePlaceholderId, url: '', path: imagePath, prompt: p.positive, status: 'ready'),
        ],
      );
      await (db.update(db.messages)..where((t) => t.id.equals(placeholderId!))).write(
        MessagesCompanion(metadata: Value(doneMeta.toJsonString())),
      );

          requestScrollToBottom();
      if (!isMounted()) return;
      showToast('图片生成完成', type: ChatToastType.info);
    } catch (e) {
      // 失败时将占位状态设为 failed，保留消息让用户可重试
      if (placeholderId != null) {
        try {
          final db = ref.read(databaseProvider);
          final msg = await (db.select(db.messages)
                ..where((t) => t.id.equals(placeholderId!)))
              .getSingle();
          final meta = MessageMetadata.fromJsonString(msg.metadata);
          final updatedMeta = meta.copyWith(
            generatedImages: meta.generatedImages
                .map((img) => img.copyWith(status: 'failed'))
                .toList(),
          );
          await (db.update(db.messages)..where((t) => t.id.equals(placeholderId!))).write(
            MessagesCompanion(metadata: Value(updatedMeta.toJsonString())),
          );
        } catch (_) {}
      }
      if (!isMounted()) return;
      showToast('生图失败: $e');
    } finally {
      if (isMounted()) {
        isGeneratingImage = false;
        refreshMessages();
      }
    }
  }

  Future<void> regenerateImage(
    String messageId,
    String oldPath, {
    String? prompt,
  }) async {
    if (conversationId == null) return;
    isGeneratingImage = true;
    refreshMessages();
    try {
      final settings =
          ref.read(settingsProvider).valueOrNull ?? const AppSettings();

      await ref
          .read(chatControllerProvider(conversationId!).notifier)
          .regenerateImage(
            messageId: messageId,
            currentImagePath: oldPath,
            settings: settings,
            prompt: prompt,
          );

      if (!isMounted()) return;
      showToast('图片已重新生成', type: ChatToastType.info);
    } catch (e) {
      if (!isMounted()) return;
      showToast('重新生图失败: $e');
    } finally {
      if (isMounted()) {
        isGeneratingImage = false;
        refreshMessages();
      }
    }
  }

  bool _imageMatches(Map image, String imageId) =>
      img_del.imageMatches(image, imageId);

  Set<String> _collectImagePaths(Map<String, dynamic> image) =>
      img_del.collectImagePaths(image);

  Future<void> deleteGeneratedImage(
    String messageId,
    String imageId,
  ) async {
    final db = ref.read(databaseProvider);
    Set<String> removed = const <String>{};
    try {
      final msg = await (db.select(db.messages)
            ..where((t) => t.id.equals(messageId)))
          .getSingle();
      final meta = MessageMetadata.fromJsonString(msg.metadata);
      final metaMap = meta.toJson();

      final images = meta.generatedImages;
      Map<String, dynamic>? targetImage;
      for (final img in images) {
        if (_imageMatches(img.toJson(), imageId)) {
          targetImage = img.toJson();
          break;
        }
      }
      if (targetImage == null) {
        return;
      }
      removed = _collectImagePaths(targetImage);

      final newMetaMap = img_del.removeGeneratedImage(metaMap, imageId);
      await db.transaction(() async {
        await (db.update(db.messages)
              ..where((t) => t.id.equals(messageId)))
            .write(MessagesCompanion(metadata: Value(jsonEncode(newMetaMap))));
      });
    } catch (e) {
      if (isMounted()) {
        showToast('删除失败，请重试');
      }
      return;
    }

    if (removed.isEmpty) return;
    final imagesActions = ref.read(characterImagesActionsProvider);
    final cleanupService = ImageGenService();
    try {
      for (final p in removed) {
        await cleanupService.deleteImage(p, imagesActions: imagesActions);
      }
    } finally {
      cleanupService.dispose();
    }
  }

  Future<void> deleteGeneratedImageVersion(
    String messageId,
    String imageId,
    String versionLocalPath,
  ) async {
    if (versionLocalPath.isEmpty) return;
    final db = ref.read(databaseProvider);
    try {
      final msg = await (db.select(db.messages)
            ..where((t) => t.id.equals(messageId)))
          .getSingle();
      final meta = MessageMetadata.fromJsonString(msg.metadata);
      final metaMap = meta.toJson();

      final newMetaMap = img_del.removeGeneratedImageVersion(
        metaMap,
        imageId,
        versionLocalPath,
      );

      final beforeJson = jsonEncode(meta.generatedImages.map((e) => e.toJson()).toList());
      final afterJson = jsonEncode(newMetaMap['generatedImages'] ?? const []);
      if (beforeJson == afterJson) {
        return;
      }

      await db.transaction(() async {
        await (db.update(db.messages)
              ..where((t) => t.id.equals(messageId)))
            .write(MessagesCompanion(metadata: Value(jsonEncode(newMetaMap))));
      });
    } catch (e) {
      if (isMounted()) {
        showToast('删除失败，请重试');
      }
      return;
    }

    final imagesActions = ref.read(characterImagesActionsProvider);
    final cleanupService = ImageGenService();
    try {
      await cleanupService.deleteImage(
        versionLocalPath,
        imagesActions: imagesActions,
      );
    } finally {
      cleanupService.dispose();
    }
  }

  /// 编辑图片提示词 — 对照主项目 handleEditImagePrompt
  Future<void> editImagePrompt(
    String messageId,
    String imageId,
    String newPrompt,
  ) async {
    final db = ref.read(databaseProvider);
    final msg = await (db.select(db.messages)
          ..where((t) => t.id.equals(messageId)))
        .getSingle();
    final meta = MessageMetadata.fromJsonString(msg.metadata);

    final updatedImages = meta.generatedImages.map((img) {
      if (img.id != imageId) return img;
      // 对照主项目：更新 versions 中 activeVersion 对应条目的 prompt
      var versions = List<ImageVersion>.from(img.versions);
      if (versions.isNotEmpty) {
        final activeIdx = img.activeVersion.clamp(0, versions.length - 1);
        versions[activeIdx] = ImageVersion(
          id: versions[activeIdx].id,
          url: versions[activeIdx].url,
          path: versions[activeIdx].path,
          prompt: newPrompt,
          createdAt: versions[activeIdx].createdAt,
        );
      }
      return img.copyWith(prompt: newPrompt, versions: versions);
    }).toList();

    final newMeta = meta.copyWith(generatedImages: updatedImages);
    await (db.update(db.messages)..where((t) => t.id.equals(messageId)))
        .write(MessagesCompanion(metadata: Value(newMeta.toJsonString())));
    refreshMessages();
  }

  /// 设置图片激活版本 — 对照主项目 handleSetPrimaryImage
  Future<void> setPrimaryImage(
    String messageId,
    String imageId,
    int versionIndex,
  ) async {
    final db = ref.read(databaseProvider);
    final msg = await (db.select(db.messages)
          ..where((t) => t.id.equals(messageId)))
        .getSingle();
    final meta = MessageMetadata.fromJsonString(msg.metadata);

    final updatedImages = meta.generatedImages.map((img) {
      if (img.id != imageId) return img;
      final versions = img.versions;
      if (versions.isEmpty || versionIndex < 0 || versionIndex >= versions.length) {
        return img;
      }
      final selected = versions[versionIndex];
      return img.copyWith(
        url: selected.url,
        path: selected.path,
        prompt: selected.prompt,
        activeVersion: versionIndex,
      );
    }).toList();

    final newMeta = meta.copyWith(generatedImages: updatedImages);
    await (db.update(db.messages)..where((t) => t.id.equals(messageId)))
        .write(MessagesCompanion(metadata: Value(newMeta.toJsonString())));
    refreshMessages();
  }
}
