'use client';

import { memo, useEffect, useRef, useState } from 'react';
import type React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Message } from '@/types';
import { useTranslation } from '@/lib/i18n-context';
import { formatTemplate } from '@/lib/i18n';
import { sanitizeGeneratedImages, type GeneratedImage, type GeneratedImageVersion } from '@/lib/generated-image-assets';
import { CheckIcon, ClockIcon, CopyIcon, PencilIcon, RefreshIcon, TrashIcon, ReplyIcon, SummaryIcon, ImageIcon } from '@/components/ui/icons';
import Modal from '@/components/ui/Modal';

interface VersionInfo {
  total: number;
  active: number;
}

interface Props {
  isStreaming?: boolean;
  isLoading?: boolean;
  showTimestamps?: boolean;
  message: Message;
  characterName: string;
  avatarUrl: string | null;
  versionInfo?: VersionInfo;
  onEdit?: (id: string, content: string, attachments?: Array<{ type: string; name: string; data?: string; url?: string; mimeType: string }>) => void;
  onDelete?: (id: string) => void;
  onRegenerate?: (id: string) => void;
  onRegenerateFromHere?: (id: string) => void;
  onSwitchVersion?: (id: string, versionIndex: number) => void;
  onGenerateImage?: (id: string, existingPrompt?: string, replaceImageId?: string) => void;
  onDeleteImage?: (messageId: string, imgId: string, versionId?: string) => void;
  onEditImagePrompt?: (messageId: string, imgId: string, newPrompt: string) => void;
  onSetPrimaryImage?: (messageId: string, imgId: string, versionId: string) => void;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function getImageVersions(img: GeneratedImage): Array<GeneratedImageVersion> {
  if (img.versions && img.versions.length > 0) return img.versions;
  return img.url ? [{ id: img.id, url: img.url, prompt: img.prompt }] : [];
}

function getActiveImageIndex(img: GeneratedImage): number {
  const versions = getImageVersions(img);
  if (versions.length === 0) return 0;

  if (typeof img.activeVersion === 'number' && img.activeVersion >= 0 && img.activeVersion < versions.length) {
    return img.activeVersion;
  }

  const currentIndex = versions.findIndex(version => version.url === img.url && version.prompt === img.prompt);
  return currentIndex >= 0 ? currentIndex : Math.max(versions.length - 1, 0);
}

/** 根据气泡颜色（用户/助手）返回对应的 markdown 组件样式映射（模块级缓存，只有两种） */
const MD_COMPONENTS_USER = buildMarkdownComponents(true);
const MD_COMPONENTS_ASSISTANT = buildMarkdownComponents(false);

function buildMarkdownComponents(isUser: boolean): React.ComponentProps<typeof ReactMarkdown>['components'] {
  const text = isUser ? 'text-white' : 'text-text-primary';
  const muted = isUser ? 'text-white/70' : 'text-text-muted';
  const border = isUser ? 'border-white/30' : 'border-border-light';
  const codeBg = isUser ? 'bg-white/15 text-white' : 'bg-[var(--code-inline-bg)] text-text-primary';
  const blockBg = isUser ? 'bg-white/10 border-white/25' : 'bg-[var(--code-block-bg)] border-accent/20';
  const linkColor = isUser ? 'text-white underline decoration-white/50' : 'text-accent-dark underline decoration-accent/40';

  return {
    p: ({ children }) => <p className={`leading-relaxed ${text}`}>{children}</p>,
    h1: ({ children }) => <h1 className={`mb-2 mt-3 text-base font-semibold first:mt-0 ${text}`}>{children}</h1>,
    h2: ({ children }) => <h2 className={`mb-1.5 mt-3 text-sm font-semibold first:mt-0 ${text}`}>{children}</h2>,
    h3: ({ children }) => <h3 className={`mb-1 mt-2 text-sm font-medium first:mt-0 ${text}`}>{children}</h3>,
    ul: ({ children }) => <ul className={`mb-2 ml-4 list-disc space-y-0.5 last:mb-0 ${text}`}>{children}</ul>,
    ol: ({ children }) => <ol className={`mb-2 ml-4 list-decimal space-y-0.5 last:mb-0 ${text}`}>{children}</ol>,
    li: ({ children }) => <li className="leading-relaxed">{children}</li>,
    code: ({ children, className }) => {
      const isBlock = className?.startsWith('language-');
      if (isBlock) {
        return <code className={`block overflow-x-auto rounded-xl px-3 py-2.5 font-mono text-xs leading-relaxed ${codeBg}`}>{children}</code>;
      }
      return <code className={`rounded px-1 py-0.5 font-mono text-[0.8em] ${codeBg}`}>{children}</code>;
    },
    pre: ({ children }) => (
      <pre className={`mb-2 overflow-x-auto rounded-xl border px-3 py-2.5 last:mb-0 ${blockBg}`}>{children}</pre>
    ),
    blockquote: ({ children }) => (
      <blockquote className={`mb-2 border-l-2 pl-3 last:mb-0 ${border} ${muted}`}>{children}</blockquote>
    ),
    hr: () => <hr className={`my-2 border-t ${border}`} />,
    a: ({ href, children }) => (
      <a href={href} target="_blank" rel="noopener noreferrer" className={linkColor}>{children}</a>
    ),
    strong: ({ children }) => <strong className={`font-semibold ${text}`}>{children}</strong>,
    em: ({ children }) => <em className={`italic ${text}`}>{children}</em>,
    del: ({ children }) => <del className={`line-through ${muted}`}>{children}</del>,
    table: ({ children }) => (
      <div className="mb-2 overflow-x-auto last:mb-0">
        <table className={`w-full border-collapse text-xs ${text}`}>{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead className={`border-b ${border}`}>{children}</thead>,
    tbody: ({ children }) => <tbody>{children}</tbody>,
    tr: ({ children }) => <tr className={`border-b last:border-0 ${border}`}>{children}</tr>,
    th: ({ children }) => <th className={`px-2 py-1 text-left font-semibold ${text}`}>{children}</th>,
    td: ({ children }) => <td className={`px-2 py-1 ${text}`}>{children}</td>,
  };
}

function SummaryCard({
  message,
  showTimestamps,
  onEdit,
  onDelete,
}: {
  message: Message;
  showTimestamps?: boolean;
  onEdit?: (id: string, content: string) => void;
  onDelete?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState(message.content);

  const handleSave = () => {
    onEdit?.(message.id, editContent);
    setEditing(false);
  };

  const handleCancel = () => {
    setEditContent(message.content);
    setEditing(false);
  };

  return (
    <div className="my-6 flex flex-col gap-0">
      {/* 分隔线 + 标签 + 操作按钮 */}
      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-gradient-to-r from-transparent via-accent/30 to-transparent" />
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 rounded-full border border-accent/20 bg-accent/6 px-3 py-1 text-[11px] font-medium text-accent-dark">
            <SummaryIcon className="h-3.5 w-3.5" />
            {t('chat.summaryLabel')}
          </div>
          {!editing && (
            <div className="flex items-center gap-1">
              <button
                onClick={() => setEditing(true)}
                className="rounded-lg p-1 text-text-muted/50 transition-colors hover:bg-accent/10 hover:text-accent-dark"
                title={t('memory.edit')}
              >
                <PencilIcon className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => onDelete?.(message.id)}
                className="rounded-lg p-1 text-text-muted/50 transition-colors hover:bg-red-50 hover:text-red-400"
                title={t('memory.delete')}
              >
                <TrashIcon className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>
        <div className="h-px flex-1 bg-gradient-to-r from-transparent via-accent/30 to-transparent" />
      </div>

      {/* 总结内容卡片 */}
      <div className="mt-3 rounded-2xl border border-accent/15 bg-gradient-to-br from-accent/5 to-accent-light/8 px-5 py-4">
        <p className="mb-3 text-[11px] text-text-muted">{t('chat.summaryHint')}</p>
        {editing ? (
          <div className="flex flex-col gap-2">
            <textarea
              value={editContent}
              onChange={e => setEditContent(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleSave();
                if (e.key === 'Escape') handleCancel();
              }}
              rows={8}
              className="textarea-rich text-sm"
              autoFocus
            />
            <div className="flex items-center gap-2 text-[11px] text-text-muted">
              <span>{t('message.editKeyHint')}</span>
            </div>
            <div className="flex gap-2">
              <button onClick={handleSave} className="soft-button soft-button-primary px-3 py-1.5 text-xs">
                {t('memory.save')}
              </button>
              <button onClick={handleCancel} className="soft-button soft-button-secondary px-3 py-1.5 text-xs">
                {t('common.cancel')}
              </button>
            </div>
          </div>
        ) : (
          <div
            className="prose-bubble prose-bubble-assistant text-sm"
            onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleSave(); if (e.key === 'Escape') handleCancel(); }}
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS_ASSISTANT}>
              {message.content}
            </ReactMarkdown>
          </div>
        )}
        {showTimestamps && message.created_at && !editing && (
          <div className="mt-3 flex items-center gap-1 text-[11px] text-text-muted">
            <ClockIcon className="h-3 w-3" />
            {formatTime(message.created_at)}
          </div>
        )}
      </div>
    </div>
  );
}

function MessageBubbleInner({
  message,
  characterName,
  avatarUrl,
  isStreaming,
  isLoading,
  showTimestamps,
  versionInfo,
  onEdit,
  onDelete,
  onRegenerate,
  onRegenerateFromHere,
  onSwitchVersion,
  onGenerateImage,
  onDeleteImage,
  onEditImagePrompt,
  onSetPrimaryImage,
}: Props) {
  const { t } = useTranslation();
  const isUser = message.role === 'user';
  const roleLabel = isUser ? t('message.you') : characterName;
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [editAttachments, setEditAttachments] = useState<Array<{ type: string; name: string; data?: string; url?: string; mimeType: string }>>([]);
  const [copied, setCopied] = useState(false);
  const [showActions, setShowActions] = useState(false);
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);

  const hasVersions = versionInfo && versionInfo.total > 1;

  // 编辑框高度自适应内容：长消息进入编辑时不再被压成固定 3 行的小框，而是撑到原内容高度（与 ChatInput 同款 auto-grow），超长封顶 60vh 内部滚动
  useEffect(() => {
    const el = editTextareaRef.current;
    if (!editing || !el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.6))}px`;
  }, [editing, editContent]);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleEditStart = () => {
    setEditContent(message.content);
    // 初始化编辑时的附件列表（从 metadata 读取）
    const meta = message.metadata as Record<string, unknown> || {};
    const atts = meta.attachments as Array<{ type: string; name: string; data?: string; url?: string; mimeType: string }> | undefined;
    setEditAttachments(atts ? [...atts] : []);
    setEditing(true);
  };

  const handleEditSave = () => {
    if (editContent.trim() || editAttachments.length > 0) {
      // 始终传 editAttachments（即使是空数组），让 API 能清除旧附件
      onEdit?.(message.id, editContent.trim(), editAttachments);
    }
    setEditing(false);
  };

  const handleEditKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleEditSave();
    }
    if (e.key === 'Escape') {
      setEditing(false);
    }
  };

  /* 操作按钮样式 */
  const btnBase = 'rounded-lg p-1.5 transition-all duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2';
  const btnUser = `${btnBase} text-white/60 hover:bg-white/20 hover:text-white`;
  const btnAssistant = `${btnBase} text-text-muted/50 hover:bg-black/5 hover:text-text-secondary dark:hover:bg-white/10`;

  // ── 总结消息：特殊卡片样式（通过 metadata.isSummary 识别）──
  const msgMeta = (message.metadata || {}) as Record<string, unknown>;
  if (msgMeta.isSummary) {
    return <SummaryCard
      message={message}
      showTimestamps={showTimestamps}
      onEdit={onEdit}
      onDelete={onDelete}
    />;
  }

  return (
    <div className={`message-appear ${isUser ? 'flex justify-end' : 'flex flex-col items-start'}`}>
      {/* 头像 + 气泡 行 */}
      <div className={`flex w-full gap-3 ${isUser ? 'flex-row-reverse' : ''}`}>
        {/* 角色头像 */}
        {!isUser && (
          <div className="mt-1 h-10 w-10 shrink-0 overflow-hidden rounded-2xl bg-gradient-to-br from-accent/18 to-accent-light/28 ring-1 ring-accent/10">
            {avatarUrl ? (
              <img src={avatarUrl} alt={characterName} className="h-full w-full object-cover" loading="lazy" />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-sm font-semibold text-accent-dark">
                {characterName[0]}
              </div>
            )}
          </div>
        )}

      <div className={`message-card group ${editing ? 'message-card-editing' : ''} ${isUser ? 'message-user' : 'message-assistant'}`}
        onClick={() => {
          // 触屏设备：点击气泡切换操作按钮显示
          if ('ontouchstart' in window && !editing) {
            setShowActions(prev => !prev);
          }
        }}
      >

        {/* ── 顶部 meta 行：角色名 + 时间 + 操作按钮 ── */}
        <div className={`message-meta flex items-center gap-2 whitespace-nowrap ${isUser ? 'text-white/75' : 'text-text-muted'}`}>
          <span className="font-medium">{roleLabel}</span>
          {showTimestamps && message.created_at && (
            <span className="inline-flex items-center gap-1">
              <ClockIcon className="h-3 w-3" />
              {formatTime(message.created_at)}
            </span>
          )}

          {/* 操作按钮：PC hover 淡入，移动端点击切换 */}
          {!isStreaming && !isLoading && !editing && (
            <div
              className={`ml-auto flex items-center gap-0.5 transition-opacity duration-150 ${isUser ? 'flex-row-reverse' : ''} ${showActions ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100'}`}
              onClick={e => e.stopPropagation()}
            >
              {/* 复制：已复制时显示 ✓ */}
              <button
                onClick={handleCopy}
                className={isUser ? btnUser : btnAssistant}
                title={copied ? t('message.copied') : t('message.copy')}
                aria-label={copied ? t('message.copied') : t('message.copy')}
              >
                {copied
                  ? <CheckIcon className="h-3.5 w-3.5" />
                  : <CopyIcon className="h-3.5 w-3.5" />
                }
              </button>

              {/* 编辑 */}
              <button
                onClick={handleEditStart}
                className={isUser ? btnUser : btnAssistant}
                title={t('message.edit')}
                aria-label={t('message.edit')}
              >
                <PencilIcon className="h-3.5 w-3.5" />
              </button>

              {/* 删除 */}
              <button
                onClick={() => onDelete?.(message.id)}
                className={isUser ? btnUser : btnAssistant}
                title={t('message.delete')}
                aria-label={t('message.delete')}
              >
                <TrashIcon className="h-3.5 w-3.5" />
              </button>

              {/* 用户消息：重新回答 */}
              {isUser && (
                <button
                  onClick={() => onRegenerateFromHere?.(message.id)}
                  className={btnUser}
                  title={t('message.regenerateFromHere')}
                  aria-label={t('message.regenerateFromHere')}
                >
                  <ReplyIcon className="h-3.5 w-3.5" />
                </button>
              )}

              {/* AI 消息：重新生成 */}
              {!isUser && (
                <button
                  onClick={() => onRegenerate?.(message.id)}
                  className={btnAssistant}
                  title={t('message.regenerate')}
                  aria-label={t('message.regenerate')}
                >
                  <RefreshIcon className="h-3.5 w-3.5" />
                </button>
              )}

              {/* AI 消息：生图 */}
              {!isUser && onGenerateImage && (
                <button
                  onClick={() => onGenerateImage(message.id)}
                  className={btnAssistant}
                  title={t('imageGen.button')}
                  aria-label={t('imageGen.button')}
                >
                  <ImageIcon className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          )}
        </div>

        {/* ── 消息正文 / 编辑框 / loading ── */}
        {editing ? (
          <div className="editor-surface-wide mt-1 w-full">
            {/* 编辑时的附件列表（仅用户消息） */}
            {isUser && editAttachments.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-2">
                {editAttachments.map((att, i) => (
                  <div key={i} className="flex items-center gap-2 rounded-xl bg-white/20 px-2.5 py-1.5 text-xs text-white/90">
                    {att.type === 'image' ? (
                      <img src={att.url || att.data} alt={att.name} className="h-6 w-6 rounded-lg object-cover" loading="lazy" />
                    ) : (
                      <span className="font-medium opacity-70">{att.name.split('.').pop()?.toUpperCase()}</span>
                    )}
                    <span className="max-w-[8rem] truncate opacity-80">{att.name}</span>
                    <button
                      onClick={() => setEditAttachments(prev => prev.filter((_, j) => j !== i))}
                      className="ml-0.5 rounded-full p-0.5 text-white/50 hover:bg-white/20 hover:text-white"
                      aria-label={formatTemplate(t('message.removeAttachment'), { name: att.name })}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-3 w-3" aria-hidden="true">
                        <path d="M18 6L6 18M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            )}
            <textarea
              ref={editTextareaRef}
              value={editContent}
              onChange={e => setEditContent(e.target.value)}
              onKeyDown={handleEditKeyDown}
              className={`max-h-[60vh] min-h-[3.25rem] w-full resize-none overflow-y-auto rounded-xl border p-2 text-sm outline-none ${
                isUser
                  ? 'border-white/30 bg-white/20 text-white placeholder-white/50 focus:border-white/60'
                  : 'border-border-light bg-white/90 text-text-primary focus:border-accent/40 dark:bg-white/10'
              }`}
              rows={3}
              autoFocus
            />
            <div className="mt-2 flex items-center justify-end gap-2">
              <span className={`text-[10px] ${isUser ? 'text-white/40' : 'text-text-muted/60'}`}>
                {t('message.editKeyHint')}
              </span>
              <button
                onClick={() => setEditing(false)}
                className={`rounded-lg px-3 py-1 text-xs transition-colors ${
                  isUser ? 'text-white/70 hover:bg-white/20' : 'text-text-muted hover:bg-white/60 dark:hover:bg-white/10'
                }`}
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleEditSave}
                className={`rounded-lg px-3 py-1 text-xs transition-colors ${
                  isUser ? 'bg-white/25 text-white hover:bg-white/35' : 'bg-accent text-white hover:bg-accent-dark'
                }`}
              >
                {t('common.save')}
              </button>
            </div>
          </div>
        ) : isLoading ? (
          /* 三点跳动：等待 API 响应阶段 */
          <div className="flex items-center gap-1.5 py-1">
            <span className="typing-dot" style={{ animationDelay: '0ms' }} />
            <span className="typing-dot" style={{ animationDelay: '160ms' }} />
            <span className="typing-dot" style={{ animationDelay: '320ms' }} />
          </div>
        ) : (
          <>
            {/* 附件预览（仅用户消息） */}
            {isUser && (() => {
              const meta = message.metadata as Record<string, unknown> || {};
              const atts = meta.attachments as Array<{ type: string; name: string; data?: string; url?: string }> | undefined;
              if (!atts || atts.length === 0) return null;
              return (
                <div className="mb-2 flex flex-wrap gap-2">
                  {atts.map((att, i) => (
                    att.type === 'image' ? (
                      <img
                        key={i}
                        src={att.url || att.data}
                        alt={att.name}
                        className="max-h-48 max-w-[16rem] rounded-xl object-cover ring-1 ring-white/30"
                        loading="lazy"
                      />
                    ) : (
                      <div key={i} className="flex items-center gap-2 rounded-xl bg-white/20 px-3 py-2 text-xs text-white/90">
                        <span className="font-medium">{att.name.split('.').pop()?.toUpperCase()}</span>
                        <span className="max-w-[10rem] truncate opacity-80">{att.name}</span>
                      </div>
                    )
                  ))}
                </div>
              );
            })()}
            <div className={`leading-relaxed ${isUser ? 'text-white' : 'text-text-primary'}`}
              style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowWrap: 'anywhere' }}
            >
              {isStreaming ? message.content + '▍' : message.content}
            </div>
          </>
        )}

        {/* ── 版本导航 ── */}
        {hasVersions && !isStreaming && !editing && (
          <div className={`mt-2 flex items-center gap-1 text-xs ${isUser ? 'justify-end text-white/60' : 'justify-start text-text-muted'}`}>
            <button
              onClick={() => onSwitchVersion?.(message.id, versionInfo.active - 1)}
              disabled={versionInfo.active <= 0}
              className="rounded px-1.5 py-0.5 transition-colors hover:bg-white/30 disabled:opacity-30"
              aria-label={t('message.prevVersion')}
            >
              ‹
            </button>
            <span aria-label={t('message.versionStatus').replace('{active}', String(versionInfo.active + 1)).replace('{total}', String(versionInfo.total))}>
              {versionInfo.active + 1}/{versionInfo.total}
            </span>
            <button
              onClick={() => onSwitchVersion?.(message.id, versionInfo.active + 1)}
              disabled={versionInfo.active >= versionInfo.total - 1}
              className="rounded px-1.5 py-0.5 transition-colors hover:bg-white/30 disabled:opacity-30"
              aria-label={t('message.nextVersion')}
            >
              ›
            </button>
          </div>
        )}

      </div>
      </div>
      {/* ── 生成的图片（气泡正下方，缩进对齐气泡） ── */}
      {!isUser && (() => {
        const meta = (message.metadata || {}) as Record<string, unknown>;
        const images = sanitizeGeneratedImages(meta.generatedImages);
        if (images.length === 0) return null;
        return (
          <div className="generated-image-list ml-13 mt-2 flex flex-col items-start gap-2">
            {images.map((img) => (
              <ImageGenCard
                key={img.id}
                img={img}
                allImages={getImageVersions(img)}
                initialIndex={getActiveImageIndex(img)}
                messageId={message.id}
                onRegenerate={onGenerateImage}
                onDelete={onDeleteImage}
                onEditPrompt={onEditImagePrompt}
                onSetPrimary={(versionId) => onSetPrimaryImage?.(message.id, img.id, versionId)}
              />
            ))}
          </div>
        );
      })()}
    </div>
  );
}

/** 大图查看弹窗：顶部切换、确认使用、关闭 */
function ImageLightbox({
  images,
  initialIndex,
  onClose,
  onConfirm,
  onDelete,
}: {
  images: Array<{ url: string; prompt: string; id: string }>;
  initialIndex: number;
  onClose: () => void;
  onConfirm?: (index: number) => void;
  onDelete?: (index: number) => void;
}) {
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
        <img
          src={img.url}
          alt=""
          className="max-h-[85vh] max-w-[90vw] rounded-xl shadow-2xl"
          draggable={false}
        />
      </div>
    </>
  );

  return (
    <Modal
      open
      onClose={onClose}
      ariaLabel={t('message.imageCloseTitle')}
      padded={false}
      overlayClassName="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-black/80 backdrop-blur-sm"
      dialogClassName="relative flex h-full w-full flex-col items-center justify-center bg-transparent outline-none"
    >
      {content}
    </Modal>
  );
}

/** 单张生成图片卡片 */
function ImageGenCard({ img, allImages, initialIndex, messageId, onRegenerate, onDelete, onEditPrompt, onSetPrimary }: {
  img: GeneratedImage;
  allImages: Array<GeneratedImageVersion>;
  initialIndex: number;
  messageId: string;
  onRegenerate?: (id: string, prompt?: string, replaceImageId?: string) => void;
  onDelete?: (messageId: string, imgId: string, versionId?: string) => void;
  onEditPrompt?: (messageId: string, imgId: string, newPrompt: string) => void;
  onSetPrimary?: (versionId: string) => void;
}) {
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
          <button onClick={() => { handleSavePrompt(); onRegenerate?.(messageId, promptValue, img.id); }} className="rounded-lg bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent-dark hover:bg-accent/20">{t('message.promptEditSaveRegen')}</button>
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
                className="rounded-lg bg-accent/10 p-1.5 text-accent-dark transition-colors hover:bg-accent/20"
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
      <div className="generated-image-card group/img relative inline-block overflow-hidden rounded-xl border border-border-light shadow-sm">
        {hasFallbackUrl && (
          <div className="flex items-center gap-2 rounded-t-xl border-b border-red-200/60 bg-red-50/90 px-3 py-1.5 text-xs text-red-600 backdrop-blur-sm">
            <span className="min-w-0 flex-1 truncate">{img.error || t('message.imageRegenFailed')}</span>
            <button
              onClick={handleRetry}
              className="shrink-0 font-medium text-red-500 transition-colors hover:text-red-700"
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
          className="block rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          aria-label={t('message.imageOpenTitle') || t('message.imageCloseTitle')}
        >
          <img
            src={img.url}
            alt=""
            className="max-w-[20rem] cursor-pointer rounded-xl"
            loading="lazy"
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
            className="rounded-lg bg-black/50 p-1.5 text-white/80 backdrop-blur-sm transition-colors hover:bg-black/70 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
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

const MessageBubble = memo(MessageBubbleInner);
export default MessageBubble;
