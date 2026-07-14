import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { Character, Message, Settings } from '@/types';
import { sanitizeGeneratedImages, type GeneratedImage } from '@/lib/generated-image-assets';
import { expectOkResponse, getErrorMessage, parseJsonResponse } from '@/lib/http';

type UpdateMessagesForConversation = (
  conversationIdToUpdate: string,
  updater: (messages: Message[]) => Message[],
) => void;

type UseChatImageGenerationOptions = {
  activeConvId: string | null;
  activeConvIdRef: MutableRefObject<string | null>;
  characterRef: MutableRefObject<Character | null>;
  messagesRef: MutableRefObject<Message[]>;
  updateMessagesForConversation: UpdateMessagesForConversation;
  markSkipNextScroll: () => void;
  showToast: (message: string, type?: 'info' | 'error') => void;
  t: (key: string) => string;
};

type ImageEntry = GeneratedImage;

type GenerateImageFn = (
  messageId: string,
  existingPrompt?: string,
  replaceImageId?: string,
  conversationIdOverride?: string,
  /** 流刚结束后 messagesRef 可能尚未同步；自动出图传入服务端快照避免找不到消息 */
  messageSnapshot?: Message,
) => Promise<boolean>;

const isAbortError = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

export function useChatImageGeneration({
  activeConvId,
  activeConvIdRef,
  characterRef: _characterRef,
  messagesRef,
  updateMessagesForConversation,
  markSkipNextScroll,
  showToast,
  t,
}: UseChatImageGenerationOptions) {
  // characterRef 仍由 ChatView 传入以保持 hook 签名稳定；生图链路不依赖角色对象
  void _characterRef;
  const generateImageRef = useRef<GenerateImageFn | null>(null);
  const autoImagedMsgIdsRef = useRef<Set<string>>(new Set());
  const imageRequestSeqRef = useRef(0);
  const activeImageRequestsRef = useRef<Map<number, { controller: AbortController; conversationId: string }>>(new Map());
  const inFlightMessageIdsRef = useRef<Set<string>>(new Set());
  const [generatingImageMessageIds, setGeneratingImageMessageIds] = useState<Set<string>>(() => new Set());

  const abortImageRequests = useCallback((conversationId?: string | null) => {
    for (const [requestId, request] of activeImageRequestsRef.current.entries()) {
      if (conversationId && request.conversationId !== conversationId) continue;
      if (!request.controller.signal.aborted) request.controller.abort();
      activeImageRequestsRef.current.delete(requestId);
    }
  }, []);

  useEffect(() => {
    return () => {
      abortImageRequests(activeConvId);
    };
  }, [abortImageRequests, activeConvId]);

  const isCurrentImageRequest = useCallback((
    requestId: number,
    conversationId: string,
    controller: AbortController,
  ) => {
    const request = activeImageRequestsRef.current.get(requestId);
    return request?.controller === controller
      && request.conversationId === conversationId
      && activeConvIdRef.current === conversationId
      && !controller.signal.aborted;
  }, [activeConvIdRef]);

  const handleGenerateImage = useCallback<GenerateImageFn>(async (
    messageId,
    existingPrompt,
    replaceImageId,
    conversationIdOverride,
    messageSnapshot,
  ) => {
    const targetConversationId = conversationIdOverride || activeConvIdRef.current;
    if (!targetConversationId) return false;

    const currentMessages = messagesRef.current;
    const targetFromList = currentMessages.find(m => m.id === messageId);
    const targetMsg = targetFromList
      ?? (messageSnapshot?.id === messageId ? messageSnapshot : undefined);
    if (!targetMsg) return false;

    if (inFlightMessageIdsRef.current.has(messageId)) return false;
    inFlightMessageIdsRef.current.add(messageId);
    setGeneratingImageMessageIds(current => {
      const next = new Set(current);
      next.add(messageId);
      return next;
    });
    showToast(t('chat.imageGenStart'), 'info');

    let workingMeta = { ...(targetMsg.metadata as Record<string, unknown> || {}) };
    const placeholderId = replaceImageId || Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const requestId = ++imageRequestSeqRef.current;
    const controller = new AbortController();
    activeImageRequestsRef.current.set(requestId, { controller, conversationId: targetConversationId });

    const canWriteImageRequest = (allowCompletedRequest = false) => {
      if (allowCompletedRequest) {
        return !controller.signal.aborted;
      }
      return isCurrentImageRequest(requestId, targetConversationId, controller);
    };

    const persistImages = async (
      updater: (images: ImageEntry[]) => ImageEntry[],
      options?: { allowCompletedRequest?: boolean },
    ) => {
      if (!canWriteImageRequest(options?.allowCompletedRequest)) return workingMeta;
      const currentImages = sanitizeGeneratedImages(workingMeta.generatedImages);
      const nextMeta = { ...workingMeta, generatedImages: updater(currentImages) };

      await expectOkResponse(await fetch(`/api/messages/${messageId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metadata: nextMeta }),
        signal: controller.signal,
      }));
      if (!canWriteImageRequest(options?.allowCompletedRequest)) return workingMeta;

      workingMeta = nextMeta;
      markSkipNextScroll();
      updateMessagesForConversation(targetConversationId, messages => {
        let found = false;
        const next = messages.map(m => {
          if (m.id !== messageId) return m;
          found = true;
          return { ...m, metadata: nextMeta };
        });
        // messagesRef 尚未同步新消息时，用快照补一条，否则 pending 气泡永远不出现
        if (!found && messageSnapshot?.id === messageId) {
          return [...next, { ...messageSnapshot, metadata: nextMeta }];
        }
        return next;
      });
      return nextMeta;
    };

    const upsertPlaceholder = async (patch: Partial<ImageEntry>) => {
      await persistImages(images => {
        const existingIndex = images.findIndex(img => img.id === placeholderId);
        if (existingIndex >= 0) {
          return images.map(img => img.id === placeholderId ? { ...img, ...patch, id: placeholderId } : img);
        }
        return [...images, { id: placeholderId, prompt: '', ...patch }];
      });
    };

    const inlineImagePrompt = typeof (targetMsg.metadata as Record<string, unknown> | undefined)?.inlineImagePrompt === 'string'
      ? (targetMsg.metadata as Record<string, unknown>).inlineImagePrompt as string
      : '';
    let generatedPrompt = existingPrompt || inlineImagePrompt || '';

    try {
      await upsertPlaceholder({
        prompt: generatedPrompt,
        status: generatedPrompt ? 'pending_image' : 'pending_prompt',
        error: undefined,
      });

      if (!generatedPrompt) {
        const promptRes = await fetch('/api/image-gen/prompt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversation_id: targetConversationId, message_id: messageId }),
          signal: controller.signal,
        });
        const promptData = await parseJsonResponse<{ prompt?: string; error?: string }>(promptRes);
        if (!isCurrentImageRequest(requestId, targetConversationId, controller)) return true;
        if (promptData.error) throw new Error(promptData.error);
        generatedPrompt = promptData.prompt || '';
        if (!generatedPrompt) throw new Error(t('chat.imageGenPromptFail'));

        await upsertPlaceholder({
          prompt: generatedPrompt,
          status: 'pending_image',
          error: undefined,
        });
      }

      const imgRes = await fetch('/api/image-gen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: generatedPrompt }),
        signal: controller.signal,
      });
      const imgData = await parseJsonResponse<{ url?: string; error?: string }>(imgRes);
      if (!isCurrentImageRequest(requestId, targetConversationId, controller)) return true;
      if (imgData.error) throw new Error(imgData.error);
      if (!imgData.url) throw new Error(t('chat.imageGenNoUrl'));

      const newImage = { url: imgData.url, prompt: generatedPrompt, id: placeholderId, status: 'ready' as const };
      await persistImages(images => {
        if (replaceImageId && images.some(img => img.id === replaceImageId && img.url)) {
          return images.map(img => {
            if (img.id !== replaceImageId) return img;
            const existingVersions = img.versions && img.versions.length > 0 ? img.versions : img.url ? [{ id: img.id, url: img.url, prompt: img.prompt }] : [];
            return {
              ...img,
              url: newImage.url,
              prompt: newImage.prompt,
              status: 'ready',
              error: undefined,
              versions: [...existingVersions, { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), url: newImage.url, prompt: newImage.prompt }],
              activeVersion: existingVersions.length,
            };
          });
        }

        return images.map(img => img.id === placeholderId ? newImage : img);
      });
      return true;
    } catch (err) {
      // 已占坑：无论成败都返回 true，避免 auto 路径反复重试同一条消息
      if (isAbortError(err) || !isCurrentImageRequest(requestId, targetConversationId, controller)) return true;
      const message = err instanceof Error ? err.message : t('chat.imageGenGeneric');
      try {
        await upsertPlaceholder({
          prompt: generatedPrompt,
          status: 'failed',
          error: message,
        });
      } catch (persistErr) {
        console.warn('[image-gen] 写入失败状态失败：', persistErr);
        showToast(`${t('chat.autoImageGenFailed')}: ${message}`, 'error');
      }
      showToast(message, 'error');

      if (replaceImageId) {
        setTimeout(async () => {
          try {
            const currentMsg = messagesRef.current.find(m => m.id === messageId);
            const currentMeta = currentMsg
              ? { ...(currentMsg.metadata as Record<string, unknown> || {}) }
              : { ...workingMeta };
            const currentImages = sanitizeGeneratedImages(currentMeta.generatedImages);
            const targetImg = currentImages.find((img: ImageEntry) => img.id === replaceImageId);
            if (targetImg && targetImg.status === 'failed' && targetImg.error === message) {
              await persistImages(
                images => images.map(img =>
                  img.id === replaceImageId
                    ? { ...img, status: 'ready' as const, error: undefined }
                    : img
                ),
                { allowCompletedRequest: true },
              );
            }
          } catch (restoreErr) {
            console.warn('[image-gen] 恢复旧图片状态失败：', restoreErr);
          }
        }, 5000);
      }
      return true;
    } finally {
      const request = activeImageRequestsRef.current.get(requestId);
      if (request?.controller === controller) {
        activeImageRequestsRef.current.delete(requestId);
      }
      inFlightMessageIdsRef.current.delete(messageId);
      setGeneratingImageMessageIds(current => {
        const next = new Set(current);
        next.delete(messageId);
        return next;
      });
    }
  }, [activeConvIdRef, isCurrentImageRequest, markSkipNextScroll, messagesRef, showToast, t, updateMessagesForConversation]);

  useEffect(() => {
    generateImageRef.current = handleGenerateImage;
  }, [handleGenerateImage]);

  const maybeAutoGenerateImageFromMessages = useCallback(async (
    cid: string,
    freshMessages: Message[],
    options?: { assistantMessageId?: string; retry?: boolean },
  ) => {
    try {
      const settingsRes = await fetch('/api/settings');
      const s = await parseJsonResponse<Partial<Settings>>(settingsRes);
      const imgCfg = s.image_gen;
      if (!imgCfg?.enabled) return;

      const targetAssistant = options?.assistantMessageId
        ? freshMessages.find(m => m.id === options.assistantMessageId && m.role === 'assistant')
        : [...freshMessages].reverse().find(m => m.role === 'assistant');
      if (!targetAssistant) return;

      if (options?.retry) {
        autoImagedMsgIdsRef.current.delete(targetAssistant.id);
      }
      if (autoImagedMsgIdsRef.current.has(targetAssistant.id)) return;
      if (inFlightMessageIdsRef.current.has(targetAssistant.id)) return;
      const existingImgs = sanitizeGeneratedImages((targetAssistant.metadata as Record<string, unknown> | undefined)?.generatedImages);
      // 重新生成（retry）时保留旧图，仍可为新版本追加 pending/新图
      if (!options?.retry && existingImgs.length > 0) return;

      const inlinePrompt = (targetAssistant.metadata as Record<string, unknown> | undefined)?.inlineImagePrompt;
      let triggerPrompt: string | undefined;
      if (imgCfg.inline_prompt && typeof inlinePrompt === 'string' && inlinePrompt.trim()) {
        triggerPrompt = inlinePrompt.trim();
      } else if (imgCfg.auto_generate) {
        const targetIdx = freshMessages.findIndex(m => m.id === targetAssistant.id);
        const context = targetIdx >= 0 ? freshMessages.slice(0, targetIdx + 1) : freshMessages;
        const lastUser = [...context].reverse().find(m => m.role === 'user');
        const keywords = (imgCfg.auto_generate_keywords || '').split(',').map((k: string) => k.trim()).filter(Boolean);
        if (!lastUser || keywords.length === 0 || !keywords.some((kw: string) => lastUser.content.includes(kw))) return;
        triggerPrompt = undefined;
      } else {
        return;
      }

      const started = await generateImageRef.current?.(
        targetAssistant.id,
        triggerPrompt,
        undefined,
        cid,
        targetAssistant,
      );
      if (started) {
        autoImagedMsgIdsRef.current.add(targetAssistant.id);
      }
    } catch (err) {
      showToast(`${t('chat.autoImageGenFailed')}: ${getErrorMessage(err)}`, 'error');
    }
  }, [showToast, t]);

  const handleDeleteImage = useCallback(async (messageId: string, imgId: string, versionId?: string) => {
    try {
      const targetMsg = messagesRef.current.find(m => m.id === messageId);
      if (!targetMsg) return;
      const meta = { ...(targetMsg.metadata as Record<string, unknown> || {}) };
      const existingImages = sanitizeGeneratedImages(meta.generatedImages);

      meta.generatedImages = existingImages.flatMap(img => {
        if (img.id !== imgId) return [img];

        const versions = img.versions && img.versions.length > 0 ? img.versions : img.url ? [{ id: img.id, url: img.url, prompt: img.prompt }] : [];
        const activeVersion = versionId
          ? versions.findIndex(version => version.id === versionId)
          : typeof img.activeVersion === 'number' && img.activeVersion >= 0 && img.activeVersion < versions.length
          ? img.activeVersion
          : Math.max(versions.findIndex(version => version.url === img.url && version.prompt === img.prompt), 0);
        if (activeVersion < 0) return [img];

        const remainingVersions = versions.filter((_, index) => index !== activeVersion);
        if (remainingVersions.length === 0) return [];

        const nextActiveVersion = Math.min(activeVersion, remainingVersions.length - 1);
        const nextVersion = remainingVersions[nextActiveVersion];

        return [{
          ...img,
          url: nextVersion.url,
          prompt: nextVersion.prompt,
          versions: remainingVersions,
          activeVersion: nextActiveVersion,
        }];
      });

      await expectOkResponse(await fetch(`/api/messages/${messageId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metadata: meta }),
      }));

      markSkipNextScroll();
      updateMessagesForConversation(targetMsg.conversation_id, messages => (
        messages.map(m => m.id === messageId ? { ...m, metadata: meta } : m)
      ));
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('message.deleteFailed'), 'error');
    }
  }, [markSkipNextScroll, messagesRef, showToast, t, updateMessagesForConversation]);

  const handleEditImagePrompt = useCallback(async (messageId: string, imgId: string, newPrompt: string) => {
    try {
      const targetMsg = messagesRef.current.find(m => m.id === messageId);
      if (!targetMsg) return;
      const meta = { ...(targetMsg.metadata as Record<string, unknown> || {}) };
      const existingImages = sanitizeGeneratedImages(meta.generatedImages);
      meta.generatedImages = existingImages.map(img => {
        if (img.id !== imgId) return img;

        const versions = img.versions && img.versions.length > 0 ? [...img.versions] : [{ id: img.id, url: img.url, prompt: img.prompt }];
        const activeVersion = typeof img.activeVersion === 'number' && img.activeVersion >= 0 && img.activeVersion < versions.length
          ? img.activeVersion
          : Math.max(versions.findIndex(version => version.url === img.url && version.prompt === img.prompt), 0);
        versions[activeVersion] = { ...versions[activeVersion], prompt: newPrompt };

        return {
          ...img,
          prompt: newPrompt,
          versions,
          activeVersion,
        };
      });

      await expectOkResponse(await fetch(`/api/messages/${messageId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metadata: meta }),
      }));
      markSkipNextScroll();
      updateMessagesForConversation(targetMsg.conversation_id, messages => (
        messages.map(m => m.id === messageId ? { ...m, metadata: meta } : m)
      ));
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('common.operationFailed'), 'error');
    }
  }, [markSkipNextScroll, messagesRef, showToast, t, updateMessagesForConversation]);

  const handleSetPrimaryImage = useCallback(async (messageId: string, imgId: string, versionId: string) => {
    try {
      const targetMsg = messagesRef.current.find(m => m.id === messageId);
      if (!targetMsg) return;
      const meta = { ...(targetMsg.metadata as Record<string, unknown> || {}) };
      const existingImages = sanitizeGeneratedImages(meta.generatedImages);
      meta.generatedImages = existingImages.map(img => {
        if (img.id !== imgId) return img;

        const versions = img.versions && img.versions.length > 0 ? img.versions : img.url ? [{ id: img.id, url: img.url, prompt: img.prompt }] : [];
        const versionIndex = versions.findIndex(version => version.id === versionId);
        if (versionIndex < 0) return img;
        const selected = versions[versionIndex];

        return {
          ...img,
          url: selected.url,
          prompt: selected.prompt,
          versions,
          activeVersion: versionIndex,
        };
      });

      await expectOkResponse(await fetch(`/api/messages/${messageId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metadata: meta }),
      }));

      markSkipNextScroll();
      updateMessagesForConversation(targetMsg.conversation_id, messages => (
        messages.map(m => m.id === messageId ? { ...m, metadata: meta } : m)
      ));
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('common.operationFailed'), 'error');
    }
  }, [markSkipNextScroll, messagesRef, showToast, t, updateMessagesForConversation]);

  return {
    handleGenerateImage,
    generatingImageMessageIds,
    maybeAutoGenerateImageFromMessages,
    handleDeleteImage,
    handleEditImagePrompt,
    handleSetPrimaryImage,
  };
}

export type UseChatImageGenerationResult = ReturnType<typeof useChatImageGeneration>;
