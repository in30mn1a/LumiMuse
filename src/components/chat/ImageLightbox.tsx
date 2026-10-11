'use client';

import { useRef, useState } from 'react';
import type React from 'react';
import { useTranslation } from '@/lib/i18n-context';
import { formatTemplate } from '@/lib/i18n';
import { CheckIcon, TrashIcon } from '@/components/ui/icons';
import Modal from '@/components/ui/Modal';
import ReservedChatImage from '@/components/chat/ReservedChatImage';

export interface ImageLightboxProps {
  images: Array<{ url: string; prompt: string; id: string }>;
  initialIndex: number;
  onClose: () => void;
  onConfirm?: (index: number) => void;
  onDelete?: (index: number) => void;
}

/** 大图查看弹窗：顶部切换、确认使用、关闭 */
export function ImageLightbox({
  images,
  initialIndex,
  onClose,
  onConfirm,
  onDelete,
}: ImageLightboxProps) {
  const { t } = useTranslation();
  const [idx, setIdx] = useState(initialIndex);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const didSwipeRef = useRef(false);
  const total = images.length;
  const img = images[idx];
  const goPrev = () => setIdx(i => Math.max(0, i - 1));
  const goNext = () => setIdx(i => Math.min(total - 1, i + 1));

  const handleImageClick = (e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (didSwipeRef.current) {
      didSwipeRef.current = false;
      return;
    }
    if (total <= 1) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    if (clickX < rect.width / 2) {
      goPrev();
    } else {
      goNext();
    }
  };

  const handleImagePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    touchStartRef.current = { x: e.clientX, y: e.clientY };
  };

  const handleImagePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const start = touchStartRef.current;
    touchStartRef.current = null;
    if (!start || total <= 1) return;

    const deltaX = e.clientX - start.x;
    const deltaY = e.clientY - start.y;
    if (Math.abs(deltaX) < 45 || Math.abs(deltaX) < Math.abs(deltaY) * 1.2) return;

    didSwipeRef.current = true;
    if (deltaX < 0) {
      goNext();
    } else {
      goPrev();
    }
  };

  const lightboxButton = 'flex h-10 w-10 items-center justify-center touch-manipulation rounded-xl bg-white/10 text-white/80 backdrop-blur-sm transition-colors hover:bg-white/20 hover:text-white disabled:opacity-30 disabled:hover:bg-white/10 disabled:hover:text-white/80';
  const lightboxAccentButton = 'flex h-10 w-10 items-center justify-center touch-manipulation rounded-xl bg-accent/85 text-white backdrop-blur-sm transition-colors hover:bg-accent';
  const safeAreaToolbarStyle: React.CSSProperties = {
    top: 'max(1rem, calc(env(safe-area-inset-top, 0px) + 0.75rem))',
    left: 'calc(env(safe-area-inset-left, 0px) + 1rem)',
    right: 'calc(env(safe-area-inset-right, 0px) + 1rem)',
  };

  const content = (
    <>
      {/* 顶部工具栏：在 portal body 下不再被 surface-panel 的 backdrop-filter 困住，absolute 即可 */}
      <div
        className="pointer-events-none absolute z-[120] flex justify-end"
        style={safeAreaToolbarStyle}
      >
        <div
          className="pointer-events-auto flex max-w-full flex-wrap justify-end gap-2"
          onClick={e => e.stopPropagation()}
          onPointerDown={e => e.stopPropagation()}
          onTouchStart={e => e.stopPropagation()}
        >
        {total > 1 && (
          <>
            <button
              onClick={goPrev}
              disabled={idx === 0}
              className={lightboxButton}
              title={t('message.imagePrevTitle')}
              aria-label={t('message.imagePrevTitle')}
            >
              ‹
            </button>
            <span className="flex h-10 min-w-14 items-center justify-center rounded-xl bg-black/30 px-3 text-sm text-white/75 backdrop-blur-sm">
              {idx + 1} / {total}
            </span>
            <button
              onClick={goNext}
              disabled={idx === total - 1}
              className={lightboxButton}
              title={t('message.imageNextTitle')}
              aria-label={t('message.imageNextTitle')}
            >
              ›
            </button>
          </>
        )}

        {onConfirm && (
          <button
            onClick={() => { onConfirm(idx); onClose(); }}
            className={lightboxAccentButton}
            title={t('message.imageUseTitle')}
            aria-label={t('message.imageUseTitle')}
          >
            <CheckIcon className="h-4 w-4" />
          </button>
        )}
        {onDelete && (
          <button
            onClick={() => { onDelete(idx); onClose(); }}
            className={lightboxButton}
            title={t('message.imageDeleteTitle')}
            aria-label={t('message.imageDeleteTitle')}
          >
            <TrashIcon className="h-4 w-4" />
          </button>
        )}
        <button
          onClick={onClose}
          className={lightboxButton}
          title={t('message.imageCloseTitle')}
          aria-label={t('message.imageCloseTitle')}
        >
          ✕
        </button>
        </div>
      </div>

      {/* 图片：移动端点左半边上一张，点右半边下一张；左右滑动也可切换 */}
      <div
        className="relative max-h-[85vh] max-w-[90vw] touch-pan-y select-none"
        onClick={handleImageClick}
        onPointerDown={handleImagePointerDown}
        onPointerUp={handleImagePointerUp}
      >
        <ReservedChatImage
          src={img.url}
          alt={formatTemplate(t('message.imagePreviewAlt'), { current: idx + 1, total })}
          maxWidthClassName="max-w-[90vw]"
          maxWidth="90vw"
          maxHeight="85vh"
          className="rounded-xl shadow-2xl"
        />
      </div>
    </>
  );

  return (
    <Modal
      open
      onClose={onClose}
      ariaLabel={t('message.imagePreviewTitle')}
      padded={false}
      overlayClassName="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-black/80 backdrop-blur-sm"
      dialogClassName="relative flex h-full w-full flex-col items-center justify-center bg-transparent outline-none"
    >
      {content}
    </Modal>
  );
}

export default ImageLightbox;
