'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Character } from '@/types';
import { ImageIcon, TrashIcon } from '@/components/ui/icons';
import { useTranslation } from '@/lib/i18n-context';
import { formatTemplate } from '@/lib/i18n';

const PAGE_SIZE = 12;

interface CharacterImage {
  messageId: string;
  conversationId: string;
  conversationTitle: string;
  createdAt: string;
  imageId: string;
  versionId: string;
  url: string;
}

interface Props {
  open: boolean;
  character: Character | null;
  onClose: () => void;
  /** 删除完成后通知父组件刷新主消息列表的 metadata */
  onAfterBatchDelete?: () => void | Promise<void>;
  /** 显示 toast，由父组件提供（沿用原有提示机制） */
  showToast: (message: string, type?: 'error' | 'info') => void;
}

/**
 * 角色图库管理弹窗。
 * 外层负责开关控制：未打开时直接返回 null，避免在 effect 中重置 state。
 * 内层组件每次打开时重新挂载，state 通过 useState 初始化自然重置。
 */
export default function ImageManagerModal(props: Props) {
  if (!props.open) return null;
  return <ImageManagerModalInner {...props} />;
}

type InnerProps = Omit<Props, 'open'>;

/**
 * 角色图库管理弹窗内层。
 * 内部完全自管：加载、分页、选中、批量删除、Lightbox 预览。
 */
function ImageManagerModalInner({ character, onClose, onAfterBatchDelete, showToast }: InnerProps) {
  const { t } = useTranslation();
  const [images, setImages] = useState<CharacterImage[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [page, setPage] = useState(0);

  const reload = useCallback(async () => {
    if (!character) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/characters/${character.id}/images`);
      const data = await res.json();
      setImages(data);
    } catch {
      showToast(t('chat.imageLoadFail'));
    } finally {
      setLoading(false);
    }
  }, [character, showToast, t]);

  // 挂载时加载一次（外层保证只有 open=true 才会挂载）
  // reload() 内部会 setLoading(true) 启动加载态，是合法的"组件挂载时同步外部数据"模式
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);

  const close = () => {
    setPreviewIndex(null);
    setSelected(new Set());
    setPage(0);
    onClose();
  };

  const handleBatchDelete = async () => {
    if (selected.size === 0 || !character) return;
    const items = [...selected].map(key => {
      const [messageId, imageId, versionId] = key.split('::');
      return { messageId, imageId, versionId };
    });
    try {
      const res = await fetch(`/api/characters/${character.id}/images`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      });
      const data = await res.json() as { ok: boolean; deletedUrls?: string[] };
      if (!data.ok) throw new Error(t('chat.imageDeleteFail'));
      // 同步删除磁盘文件
      for (const url of data.deletedUrls || []) {
        fetch('/api/image-gen/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
        }).catch(() => {});
      }
      setSelected(new Set());
      setPreviewIndex(null);
      await reload();
      // 通知父组件刷新主消息列表（图片已从 metadata 中剥离）
      if (onAfterBatchDelete) await onAfterBatchDelete();
      showToast(formatTemplate(t('chat.imageBatchDeleted'), { count: items.length }), 'info');
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('chat.imageDeleteFail'));
    }
  };

  const totalPages = Math.max(1, Math.ceil(images.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages - 1);
  const pageImages = images.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const previewImage = previewIndex !== null ? images[previewIndex] : null;
  const canPrev = previewIndex !== null && previewIndex > 0;
  const canNext = previewIndex !== null && previewIndex < images.length - 1;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={close}>
      <div
        className="surface-panel flex w-full max-w-3xl flex-col overflow-hidden"
        style={{ maxHeight: '90dvh' }}
        onClick={e => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex shrink-0 items-center justify-between border-b border-border-light px-5 py-4">
          <div className="flex items-center gap-3">
            <h3 className="section-title text-lg">图片管理</h3>
            <span className="chip text-xs">{images.length} 张</span>
          </div>
          <div className="flex items-center gap-2">
            {selected.size > 0 && (
              <button
                onClick={() => void handleBatchDelete()}
                className="soft-button soft-button-danger px-3 py-1.5 text-sm"
              >
                <TrashIcon className="h-3.5 w-3.5" />
                <span>删除选中 ({selected.size})</span>
              </button>
            )}
            {images.length > 0 && (
              <button
                onClick={() => {
                  if (selected.size === images.length) {
                    setSelected(new Set());
                  } else {
                    setSelected(new Set(images.map(img => `${img.messageId}::${img.imageId}::${img.versionId}`)));
                  }
                }}
                className="soft-button soft-button-secondary px-3 py-1.5 text-sm"
              >
                {selected.size === images.length ? '取消全选' : '全选'}
              </button>
            )}
            <button onClick={close} className="rounded-xl p-2 text-text-muted hover:bg-warm-100" aria-label="关闭">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="h-4 w-4" aria-hidden="true">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* 图片网格 */}
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="flex h-40 items-center justify-center text-sm text-text-muted">加载中...</div>
          ) : images.length === 0 ? (
            <div className="flex h-40 flex-col items-center justify-center gap-2 text-sm text-text-muted">
              <ImageIcon className="h-8 w-8 opacity-30" />
              <span>还没有生成过图片</span>
            </div>
          ) : (
            <div className="grid grid-cols-4 gap-3">
              {pageImages.map((img, indexInPage) => {
                const globalIndex = currentPage * PAGE_SIZE + indexInPage;
                const key = `${img.messageId}::${img.imageId}::${img.versionId}`;
                const isSelected = selected.has(key);
                return (
                  <div key={key} className="group relative aspect-square overflow-hidden rounded-xl">
                    <button
                      className="block h-full w-full"
                      onClick={() => setPreviewIndex(globalIndex)}
                      aria-label="查看大图"
                    >
                      {/* 展示来自 /api/files/... 的生成/上传图片，路径动态、非静态资源，next/image 无法优化 */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={img.url}
                        alt=""
                        className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
                        loading="lazy"
                      />
                    </button>
                    <button
                      className={`absolute left-2 top-2 flex h-5 w-5 items-center justify-center rounded-full border-2 transition-all ${
                        isSelected
                          ? 'border-accent bg-accent opacity-100'
                          : 'border-white/80 bg-black/25 opacity-0 group-hover:opacity-100'
                      }`}
                      onClick={e => {
                        e.stopPropagation();
                        setSelected(prev => {
                          const next = new Set(prev);
                          if (next.has(key)) next.delete(key);
                          else next.add(key);
                          return next;
                        });
                      }}
                      aria-label={isSelected ? '取消选中' : '选中'}
                    >
                      {isSelected && (
                        <svg viewBox="0 0 10 8" fill="none" className="h-2.5 w-2.5" aria-hidden="true">
                          <path d="M1 4l3 3 5-6" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </button>
                    {isSelected && (
                      <div className="pointer-events-none absolute inset-0 rounded-xl ring-2 ring-accent ring-offset-1" />
                    )}
                    <div className="pointer-events-none absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent px-2 pb-1.5 pt-4 opacity-0 transition-opacity group-hover:opacity-100">
                      <p className="truncate text-[10px] text-white/90">{img.conversationTitle}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 翻页栏 */}
        {!loading && images.length > PAGE_SIZE && (
          <div className="flex shrink-0 items-center justify-between border-t border-border-light px-5 py-3">
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={currentPage === 0}
              className="soft-button soft-button-secondary px-3 py-1.5 text-sm disabled:opacity-40"
            >
              ‹ 上一页
            </button>
            <span className="text-sm text-text-muted">
              第 {currentPage + 1} / {totalPages} 页
            </span>
            <button
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
              disabled={currentPage >= totalPages - 1}
              className="soft-button soft-button-secondary px-3 py-1.5 text-sm disabled:opacity-40"
            >
              下一页 ›
            </button>
          </div>
        )}
      </div>

      {/* 大图预览 Lightbox */}
      {previewImage && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80"
          onClick={e => { e.stopPropagation(); setPreviewIndex(null); }}
        >
          <div className="relative flex max-h-[90dvh] max-w-[90vw] items-center justify-center" onClick={e => e.stopPropagation()}>
            {canPrev && (
              <button
                onClick={() => setPreviewIndex(i => i !== null ? i - 1 : i)}
                className="absolute left-3 top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/40 p-3 text-white/90 backdrop-blur-sm hover:bg-black/60"
                aria-label="上一张"
              >
                <span className="block text-xl leading-none">‹</span>
              </button>
            )}
            {/* 展示来自 /api/files/... 的生成/上传图片，路径动态、非静态资源，next/image 无法优化 */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={previewImage.url}
              alt=""
              className="max-h-[90dvh] max-w-[90vw] rounded-2xl shadow-2xl"
            />
            {canNext && (
              <button
                onClick={() => setPreviewIndex(i => i !== null ? i + 1 : i)}
                className="absolute right-3 top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/40 p-3 text-white/90 backdrop-blur-sm hover:bg-black/60"
                aria-label="下一张"
              >
                <span className="block text-xl leading-none">›</span>
              </button>
            )}
            <div className="absolute right-3 top-3 flex items-center gap-2">
              <span className="rounded-full bg-black/40 px-3 py-1 text-xs text-white/85 backdrop-blur-sm">
                {previewIndex! + 1} / {images.length}
              </span>
              <button
                onClick={() => setPreviewIndex(null)}
                className="rounded-full bg-black/40 p-2 text-white/90 backdrop-blur-sm hover:bg-black/60"
                aria-label="关闭预览"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4" aria-hidden="true">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/40 px-3 py-1 text-xs text-white/85 backdrop-blur-sm">
              {previewImage.conversationTitle}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
