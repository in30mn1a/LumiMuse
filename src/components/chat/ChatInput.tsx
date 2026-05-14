'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from '@/lib/i18n-context';
import { SparkIcon, StopIcon } from '@/components/ui/icons';
import type { AttachmentItem } from '@/lib/chat-engine';

// 支持的文件类型
const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png'];
const ACCEPTED_TEXT_TYPES = ['text/plain', 'text/markdown', 'text/csv', 'application/json', 'application/xml', 'text/xml', 'text/html'];
const ACCEPTED_TEXT_EXTS = new Set(['txt', 'md', 'markdown', 'csv', 'json', 'xml', 'html', 'htm', 'log', 'yaml', 'yml', 'toml', 'ini', 'env']);
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_TEXT_SIZE = 200 * 1024; // 文本文件最大 200KB（避免 token 爆炸）

interface Props {
  onSend: (content: string, attachments?: AttachmentItem[]) => void;
  onStop?: () => void;
  disabled: boolean;
  isGenerating?: boolean;
}

// 附件图标
function PaperclipIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

function XIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={className} aria-hidden="true">
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}

export default function ChatInput({ onSend, onStop, disabled, isGenerating }: Props) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<AttachmentItem[]>([]);
  const [attachError, setAttachError] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { t } = useTranslation();

  useEffect(() => {
    if (!textareaRef.current) return;
    textareaRef.current.style.height = '0px';
    textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 180)}px`;
  }, [text]);

  const handleSubmit = () => {
    const trimmed = text.trim();
    if ((!trimmed && attachments.length === 0) || disabled) return;
    onSend(trimmed || ' ', attachments.length > 0 ? attachments : undefined);
    setText('');
    setAttachments([]);
    setAttachError('');
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSubmit();
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    e.target.value = ''; // 允许重复选同一文件

    setAttachError('');
    const newAttachments: AttachmentItem[] = [];

    for (const file of files) {
      if (file.size > MAX_FILE_SIZE) {
        setAttachError(`${file.name} 超过 10MB 限制`);
        continue;
      }

      const ext = (file.name.split('.').pop() || '').toLowerCase();
      const isImage = ACCEPTED_IMAGE_TYPES.includes(file.type);
      const isText = ACCEPTED_TEXT_TYPES.some(t => file.type.startsWith(t)) || ACCEPTED_TEXT_EXTS.has(ext);

      if (isImage) {
        // 图片转 base64 data URL
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        const formData = new FormData();
        formData.append('avatar', file);
        formData.append('purpose', 'attachment');
        const uploadResponse = await fetch('/api/upload', { method: 'POST', body: formData });
        const data = await uploadResponse.json() as { url?: string; error?: string };
        if (!uploadResponse.ok || !data.url) {
          setAttachError(data.error || `${file.name} 上传失败`);
          continue;
        }
        newAttachments.push({ type: 'image', name: file.name, data: dataUrl, url: data.url, mimeType: file.type });
      } else if (isText) {
        if (file.size > MAX_TEXT_SIZE) {
          setAttachError(`${file.name} 文本文件超过 200KB，可能导致 token 过多`);
          // 警告但继续上传
        }
        const text = await file.text();
        newAttachments.push({ type: 'text', name: file.name, data: text, mimeType: file.type || 'text/plain' });
      } else {
        setAttachError(`${file.name} 不支持的格式（支持 JPG、PNG、TXT、MD、JSON 等文本文件）`);
      }
    }

    if (newAttachments.length > 0) {
      setAttachments(prev => [...prev, ...newAttachments]);
    }
  };

  const removeAttachment = (index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  };

  const canSend = (text.trim().length > 0 || attachments.length > 0) && !disabled;

  return (
    <div className="chat-input-safe border-t border-border-light bg-[rgba(248,244,255,0.82)] px-4 py-2 md:py-4 backdrop-blur-xl dark:bg-[rgba(25,20,37,0.82)]">
      <div className="mx-auto max-w-6xl">
        {/* 附件预览区 */}
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {attachments.map((att, i) => (
              <div
                key={i}
                className="group relative flex items-center gap-2 rounded-xl border border-border-light bg-white/80 px-3 py-1.5 text-xs text-text-secondary shadow-sm"
              >
                {att.type === 'image' ? (
                  <img src={att.url || att.data} alt={att.name} className="h-8 w-8 rounded-lg object-cover" loading="lazy" />
                ) : (
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent-dark text-[10px] font-medium">
                    {att.name.split('.').pop()?.toUpperCase().slice(0, 4)}
                  </span>
                )}
                <span className="max-w-[8rem] truncate">{att.name}</span>
                <button
                  onClick={() => removeAttachment(i)}
                  className="ml-1 rounded-full p-0.5 text-text-muted hover:bg-red-50 hover:text-red-500"
                  aria-label={`移除 ${att.name}`}
                >
                  <XIcon className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* 错误提示 */}
        {attachError && (
          <p className="mb-2 text-xs text-red-500">{attachError}</p>
        )}

        <div className="flex items-center gap-2 rounded-[1.25rem] border border-border-light bg-white/70 px-3 py-2 shadow-[0_8px_22px_rgba(92,74,139,0.04)]">
          {/* 附件按钮 */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled}
            className="shrink-0 self-end mb-1.5 rounded-xl p-2 text-text-muted transition-colors hover:bg-accent/8 hover:text-accent-dark disabled:cursor-not-allowed disabled:opacity-40"
            title="附加文件（图片 JPG/PNG，文本 TXT/MD/JSON 等）"
            aria-label="附加文件"
          >
            <PaperclipIcon className="h-4 w-4" />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".jpg,.jpeg,.png,.txt,.md,.markdown,.csv,.json,.xml,.html,.htm,.log,.yaml,.yml,.toml,.ini,.env"
            onChange={handleFileChange}
            className="hidden"
          />

          <div className="min-w-0 flex-1">
            <textarea
              ref={textareaRef}
              value={text}
              onChange={e => setText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t('input.placeholder')}
              rows={1}
              className="textarea-rich min-h-[3.1rem] max-h-44 resize-none border-none bg-transparent px-1 py-1 shadow-none focus:ring-0"
              disabled={disabled}
            />
          </div>

          {isGenerating ? (
            <button
              onClick={onStop}
              className="soft-button soft-button-secondary shrink-0 self-end mb-1 border-accent/20 px-3 text-accent-dark hover:border-accent/40 hover:bg-accent/8 md:min-w-[6.6rem] md:px-4"
            >
              <StopIcon className="h-4 w-4" />
              <span className="hidden md:inline">{t('input.stop')}</span>
            </button>
          ) : (
            <button
              onClick={handleSubmit}
              disabled={!canSend}
              className="soft-button soft-button-primary shrink-0 self-end mb-1 px-3 md:min-w-[6.6rem] md:px-4"
            >
              <SparkIcon className="h-4 w-4" />
              <span className="hidden md:inline">{t('input.send')}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
