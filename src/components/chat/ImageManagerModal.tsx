'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Character } from '@/types';
import { ImageIcon, TrashIcon } from '@/components/ui/icons';
import { useTranslation } from '@/lib/i18n-context';
import { formatTemplate } from '@/lib/i18n';
import Modal from '@/components/ui/Modal';
import JSZip from 'jszip';

const PAGE_SIZE = 12;
const DOWNLOAD_CONCURRENCY = 5;

interface CharacterImage {
  messageId: string;
  conversationId: string;
  conversationTitle: string;
  createdAt: string;
  imageId: string;
  versionId: string;
  url: string;
  referenceCount: number;
  references: Array<{
    messageId: string;
    conversationId: string;
    conversationTitle: string;
    createdAt: string;
    imageId: string;
    versionId: string;
  }>;
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

async function fetchImagesWithConcurrency(images: CharacterImage[]): Promise<Array<{ blob: Blob; url: string }>> {
  const results: Array<{ blob: Blob; url: string }> = [];

  for (let i = 0; i < images.length; i += DOWNLOAD_CONCURRENCY) {
    const batch = images.slice(i, i + DOWNLOAD_CONCURRENCY);
    const blobs = await Promise.all(
      batch.map(async img => {
        const res = await fetch(img.url);
        if (!res.ok) throw new Error(`Failed to load ${img.url}`);
        return { blob: await res.blob(), url: img.url };
      }),
    );
    results.push(...blobs);
  }

  return results;
}

/**
 * 角色图库管理弹窗。
 * 外层负责开关控制：未打开时直接返回 null，避免在 effect 中重置 state。
 * 内层组件每次打开时重新挂载，state 通过 useState 初始化自然重置。
 *
 * 视觉外壳统一使用通用 <Modal> 组件，复用焦点陷阱 / ESC / Portal / aria-modal。
 * 因为图库需要"标题栏 + 滚动网格 + 翻页栏"的三栏布局，
 * 我们用 Modal 的 padded={false} + dialogClassName 自管 padding 与 max-height。
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
  const [downloading, setDownloading] = useState(false);

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
    const items = [...selected].map(url => ({ url }));
    try {
      const res = await fetch(`/api/characters/${character.id}/images`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      });
      const data = await res.json() as { ok: boolean };
      if (!data.ok) throw new Error(t('chat.imageDeleteFail'));
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

  const handleDownload = async () => {
    if (selected.size === 0) return;
    setDownloading(true);
    try {
      const zip = new JSZip();
      // 选中态以 img.url 为 key（与单选/全选/删除一致），这里必须同样用 url 过滤，
      // 否则匹配不到任何图片，会导致打出空压缩包。
      const selectedImages = images.filter(img => selected.has(img.url));
      const blobs = await fetchImagesWithConcurrency(selectedImages);
      for (const { blob, url } of blobs) {
        const ext = url.split('.').pop()?.split('?')[0] ?? 'png';
        const name = url.split('/').pop()?.split('?')[0] ?? `image.${ext}`;
        zip.file(name, blob);
      }
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const downloadUrl = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      const now = new Date();
      const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const timeStr = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
      a.download = `lumimuse-${character?.name ?? 'images'}-${dateStr}-${timeStr}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(downloadUrl);
      showToast(formatTemplate(t('chat.imageDownloaded'), { count: blobs.length }), 'info');
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('chat.imageDownloadFail'));
    } finally {
      setDownloading(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil(images.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages - 1);
  const pageImages = images.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const previewImage = previewIndex !== null ? images[previewIndex] : null;
  const canPrev = previewIndex !== null && previewIndex > 0;
  const canNext = previewIndex !== null && previewIndex < images.length - 1;

  return (
    <>
      <Modal
        open
        onClose={close}
        padded={false}
        dialogClassName="surface-panel flex w-full max-w-3xl flex-col overflow-hidden outline-none"
      >
        <div style={{ maxHeight: '90dvh' }} className="flex flex-col">
          {/* 标题栏 */}
          <div className="flex shrink-0 items-center justify-between border-b border-border-light px-5 py-4">
            <div className="flex items-center gap-3">
              <h3 className="section-title text-lg">{t('chat.imageManagerTitle')}</h3>
              <span className="chip text-xs">{formatTemplate(t('chat.imageCount'), { count: images.length })}</span>
            </div>
            <div className="flex items-center gap-2">
              {selected.size > 0 && (
                <>
                  <button
                    onClick={() => void handleDownload()}
                    disabled={downloading}
                    className="soft-button soft-button-secondary px-3 py-1.5 text-sm"
                  >
                    <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5" aria-hidden="true">
                      <path d="M10.75 2.75a.75.75 0 00-1.5 0v8.614L6.295 8.235a.75.75 0 10-1.09 1.03l4.25 4.5a.75.75 0 001.09 0l4.25-4.5a.75.75 0 00-1.09-1.03l-2.955 3.129V2.75z" />
                      <path d="M3.5 12.75a.75.75 0 00-1.5 0v2.5A2.75 2.75 0 004.75 18h10.5A2.75 2.75 0 0018 15.25v-2.5a.75.75 0 00-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5z" />
                    </svg>
                    <span>{downloading ? t('chat.imageDownloading') : formatTemplate(t('chat.imageDownloadSelected'), { count: selected.size })}</span>
                  </button>
                  <button
                    onClick={() => void handleBatchDelete()}
                    className="soft-button soft-button-danger px-3 py-1.5 text-sm"
                  >
                    <TrashIcon className="h-3.5 w-3.5" />
                    <span>{formatTemplate(t('chat.imageDeleteSelected'), { count: selected.size })}</span>
                  </button>
                </>
              )}
              {images.length > 0 && (
                <button
                  onClick={() => {
                    if (selected.size === images.length) {
                      setSelected(new Set());
                    } else {
                      setSelected(new Set(images.map(img => img.url)));
                    }
                  }}
                  className="soft-button soft-button-secondary px-3 py-1.5 text-sm"
                >
                  {selected.size === images.length ? t('chat.imageUnselectAll') : t('chat.imageSelectAll')}
                </button>
              )}
              <button onClick={close} className="rounded-xl p-2 text-text-muted hover:bg-warm-100" aria-label={t('common.close')}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="h-4 w-4" aria-hidden="true">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          {/* 图片网格 */}
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {loading ? (
              <div className="flex h-40 items-center justify-center text-sm text-text-muted">{t('common.loading')}</div>
            ) : images.length === 0 ? (
              <div className="flex h-40 flex-col items-center justify-center gap-2 text-sm text-text-muted">
                <ImageIcon className="h-8 w-8 opacity-30" />
                <span>{t('chat.imageEmpty')}</span>
              </div>
            ) : (
              <div className="grid grid-cols-4 gap-3">
                {pageImages.map((img, indexInPage) => {
                  const globalIndex = currentPage * PAGE_SIZE + indexInPage;
                  const key = img.url;
                  const isSelected = selected.has(key);
                  return (
                    <div key={key} className="group relative aspect-square overflow-hidden rounded-xl">
                      <button
                        className="block h-full w-full"
                        onClick={() => setPreviewIndex(globalIndex)}
                        aria-label={t('chat.imageViewLarge')}
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
                        aria-label={isSelected ? t('chat.imageUnselect') : t('chat.imageSelect')}
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
                        <p className="truncate text-[10px] text-white/90">
                          {img.conversationTitle}{img.referenceCount > 1 ? ` ×${img.referenceCount}` : ''}
                        </p>
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
                {t('chat.imagePrevPage')}
              </button>
              <span className="text-sm text-text-muted">
                {formatTemplate(t('chat.imagePageStatus'), { current: currentPage + 1, total: totalPages })}
              </span>
              <button
                onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                disabled={currentPage >= totalPages - 1}
                className="soft-button soft-button-secondary px-3 py-1.5 text-sm disabled:opacity-40"
              >
                {t('chat.imageNextPage')}
              </button>
            </div>
          )}
        </div>
      </Modal>

      {/* 大图预览 Lightbox：单独走一层 Modal，叠在图库之上 */}
      {previewImage && (
        <Modal
          open
          onClose={() => setPreviewIndex(null)}
          padded={false}
          dialogClassName="relative flex max-h-[90dvh] max-w-[90vw] items-center justify-center bg-transparent outline-none"
        >
          {canPrev && (
            <button
              onClick={() => setPreviewIndex(i => i !== null ? i - 1 : i)}
              className="absolute left-3 top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/40 p-3 text-white/90 backdrop-blur-sm hover:bg-black/60"
              aria-label={t('chat.imagePreviewPrev')}
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
              aria-label={t('chat.imagePreviewNext')}
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
              aria-label={t('chat.imagePreviewClose')}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4" aria-hidden="true">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/40 px-3 py-1 text-xs text-white/85 backdrop-blur-sm">
            {previewImage.conversationTitle}
          </div>
        </Modal>
      )}
    </>
  );
}
