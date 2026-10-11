'use client';

import { useState } from 'react';
import { useTranslation } from '@/lib/i18n-context';
import type { GeneratedImage, GeneratedImageVersion } from '@/lib/generated-image-assets';
import { PencilIcon, RefreshIcon, TrashIcon } from '@/components/ui/icons';
import ReservedChatImage from '@/components/chat/ReservedChatImage';
import ImageLightbox from '@/components/chat/ImageLightbox';

export interface ImageGenCardProps {
  img: GeneratedImage;
  allImages: Array<GeneratedImageVersion>;
  initialIndex: number;
  messageId: string;
  onRegenerate?: (id: string, prompt?: string, replaceImageId?: string) => void;
  isGenerating?: boolean;
  onDelete?: (messageId: string, imgId: string, versionId?: string) => void;
  onEditPrompt?: (messageId: string, imgId: string, newPrompt: string) => void;
  onSetPrimary?: (versionId: string) => void;
}

/** 单张生成图片卡片 */
export function ImageGenCard({
  img,
  allImages,
  initialIndex,
  messageId,
  onRegenerate,
  isGenerating,
  onDelete,
  onEditPrompt,
  onSetPrimary,
}: ImageGenCardProps) {
  const { t } = useTranslation();
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [promptValue, setPromptValue] = useState(img.prompt);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [showImgActions, setShowImgActions] = useState(false);
  const handleSavePrompt = () => {
    onEditPrompt?.(messageId, img.id, promptValue);
    setEditingPrompt(false);
  };

  // 编辑模式：图片消失，显示 prompt 编辑框
  if (editingPrompt) {
    return (
      <div className="editor-surface-wide rounded-xl border border-border-light bg-white/90 p-3 shadow-sm dark:bg-[rgba(30,25,45,0.9)]">
        <div className="mb-2 text-xs font-medium text-text-secondary">{t('message.promptEditTitle')}</div>
        <textarea
          value={promptValue}
          onChange={e => setPromptValue(e.target.value)}
          rows={4}
          className="w-full resize-none rounded-lg border border-border-light bg-white/70 px-3 py-2 text-xs leading-relaxed text-text-primary focus:outline-none focus:ring-1 focus:ring-accent/30 dark:bg-white/5"
        />
        <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
          <button onClick={() => setEditingPrompt(false)} className="rounded-lg px-3 py-1.5 text-xs text-text-muted hover:bg-black/5 dark:hover:bg-white/10">{t('message.promptEditCancel')}</button>
          <button onClick={handleSavePrompt} className="rounded-lg bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent-dark hover:bg-accent/20">{t('message.promptEditSave')}</button>
          <button disabled={isGenerating} aria-busy={isGenerating} onClick={() => { handleSavePrompt(); onRegenerate?.(messageId, promptValue, img.id); }} className="rounded-lg bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent-dark hover:bg-accent/20 disabled:cursor-wait disabled:opacity-50">{t('message.promptEditSaveRegen')}</button>
        </div>
      </div>
    );
  }

  const isPending = img.status === 'pending_prompt' || img.status === 'pending_image';
  const isFailed = img.status === 'failed';
  const hasFallbackUrl = isFailed && !!img.url;
  const handleRetry = () => onRegenerate?.(messageId, img.prompt || undefined, img.id);

  if ((isPending || (isFailed && !hasFallbackUrl)) && !img.url) {
    return (
      <div className="generated-image-card group/img relative w-full max-w-[20rem] rounded-xl border border-border-light bg-white/82 p-3 shadow-sm backdrop-blur-sm dark:bg-white/8">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium text-text-secondary">
              {isFailed ? t('message.imageGenFailed') : img.status === 'pending_prompt' ? t('message.imageGenPromptPending') : t('message.imageGenPending')}
            </div>
            {isPending && (
              <div className="mt-2 flex items-center gap-1.5 py-1">
                <span className="typing-dot" style={{ animationDelay: '0ms' }} />
                <span className="typing-dot" style={{ animationDelay: '160ms' }} />
                <span className="typing-dot" style={{ animationDelay: '320ms' }} />
              </div>
            )}
            {img.prompt && <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-text-muted">{img.prompt}</p>}
            {isFailed && <p className="mt-2 text-xs leading-relaxed text-red-500">{img.error || t('message.imageUpstreamFail')}</p>}
          </div>
          <div className="flex shrink-0 gap-1">
            <button
              onClick={() => { setPromptValue(img.prompt); setEditingPrompt(true); }}
              className="rounded-lg bg-black/5 p-1.5 text-text-muted transition-colors hover:bg-black/10 hover:text-text-primary dark:bg-white/10 dark:hover:bg-white/15"
              title={t('message.promptEditTitle')}
              aria-label={t('message.promptEditTitle')}
            >
              <PencilIcon className="h-3.5 w-3.5" />
            </button>
            {isFailed && (
              <button
                onClick={handleRetry}
                disabled={isGenerating}
                aria-busy={isGenerating}
                className="rounded-lg bg-accent/10 p-1.5 text-accent-dark transition-colors hover:bg-accent/20 disabled:cursor-wait disabled:opacity-50"
                title={t('message.imageRetryTitle')}
                aria-label={t('message.imageRetryTitle')}
              >
                <RefreshIcon className="h-3.5 w-3.5" />
              </button>
            )}
            <button
              onClick={() => onDelete?.(messageId, img.id)}
              className="rounded-lg bg-red-500/10 p-1.5 text-red-500 transition-colors hover:bg-red-500/20"
              title={t('message.imageDeletePlaceholderTitle')}
              aria-label={t('message.imageDeletePlaceholderTitle')}
            >
              <TrashIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  const myIndex = initialIndex >= 0 && initialIndex < allImages.length ? initialIndex : 0;
  const openLightbox = () => setLightboxIndex(myIndex >= 0 ? myIndex : 0);

  return (
    <>
      <div className="generated-image-card group/img relative block w-full max-w-[20rem] overflow-hidden rounded-xl border border-border-light shadow-sm">
        {hasFallbackUrl && (
          <div className="flex items-center gap-2 rounded-t-xl border-b border-red-200/60 bg-red-50/90 px-3 py-1.5 text-xs text-red-600 backdrop-blur-sm">
            <span className="min-w-0 flex-1 truncate">{img.error || t('message.imageRegenFailed')}</span>
            <button
              onClick={handleRetry}
              disabled={isGenerating}
              aria-busy={isGenerating}
              className="shrink-0 font-medium text-red-500 transition-colors hover:text-red-700 disabled:cursor-wait disabled:opacity-50"
            >
              {t('message.imageRetry')}
            </button>
          </div>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            openLightbox();
          }}
          className="block w-full rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          aria-label={t('message.imageOpenTitle') || t('message.imageCloseTitle')}
        >
          <ReservedChatImage
            src={img.url}
            alt=""
            maxWidthClassName="max-w-full"
            className="cursor-pointer rounded-xl"
          />
        </button>
        {/* 操作按钮：PC hover 显示，移动端点击切换 */}
        <div
          className={`absolute right-2 top-2 flex gap-1 transition-opacity ${showImgActions ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0 group-hover/img:pointer-events-auto group-hover/img:opacity-100 group-focus-within/img:pointer-events-auto group-focus-within/img:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100'}`}
          onClick={e => e.stopPropagation()}
        >
          <button
            onClick={() => { setPromptValue(img.prompt); setEditingPrompt(true); setShowImgActions(false); }}
            className="rounded-lg bg-black/50 p-1.5 text-white/80 backdrop-blur-sm transition-colors hover:bg-black/70 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            title={t('message.editPromptTitle')}
          >
            <PencilIcon className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => { onRegenerate?.(messageId, img.prompt, img.id); setShowImgActions(false); }}
            disabled={isGenerating}
            aria-busy={isGenerating}
            className="rounded-lg bg-black/50 p-1.5 text-white/80 backdrop-blur-sm transition-colors hover:bg-black/70 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:cursor-wait disabled:opacity-50"
            title={t('message.regenerateTitle')}
          >
            <RefreshIcon className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => { onDelete?.(messageId, img.id); setShowImgActions(false); }}
            className="rounded-lg bg-black/50 p-1.5 text-white/80 backdrop-blur-sm transition-colors hover:bg-red-600/80 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            title={t('message.imageDeleteTitle')}
          >
            <TrashIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {lightboxIndex !== null && (
        <ImageLightbox
          images={allImages}
          initialIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onConfirm={onSetPrimary ? (idx) => onSetPrimary(allImages[idx].id) : undefined}
          onDelete={onDelete ? (idxToDelete) => onDelete(messageId, img.id, allImages[idxToDelete].id) : undefined}
        />
      )}
    </>
  );
}

export default ImageGenCard;
