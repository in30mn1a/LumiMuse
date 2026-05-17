'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from '@/lib/i18n-context';
import { SparkIcon, StopIcon } from '@/components/ui/icons';
import type { AttachmentItem } from '@/lib/chat-engine';

const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png'];
const ACCEPTED_TEXT_TYPES = ['text/plain', 'text/markdown', 'text/csv', 'application/json', 'application/xml', 'text/xml', 'text/html'];
const ACCEPTED_TEXT_EXTS = new Set(['txt', 'md', 'markdown', 'csv', 'json', 'xml', 'html', 'htm', 'log', 'yaml', 'yml', 'toml', 'ini', 'env']);
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_TEXT_SIZE = 200 * 1024;

interface Props {
  onSend: (content: string, attachments?: AttachmentItem[]) => void;
  onStop?: () => void;
  disabled: boolean;
  isGenerating?: boolean;
  currentModel?: string;
  onModelChange?: (model: string) => void;
  modelList?: string[];
}

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

function ChevronDownIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

export default function ChatInput({ onSend, onStop, disabled, isGenerating, currentModel, onModelChange, modelList: externalModelList }: Props) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<AttachmentItem[]>([]);
  const [attachError, setAttachError] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [fetchedModels, setFetchedModels] = useState<string[]>([]);
  const [modelLoading, setModelLoading] = useState(false);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();

  const modelList = externalModelList && externalModelList.length > 0 ? externalModelList : fetchedModels;

  useEffect(() => {
    if (!textareaRef.current) return;
    textareaRef.current.style.height = '0px';
    textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 180)}px`;
  }, [text]);

  useEffect(() => {
    if (!modelPickerOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (modelPickerRef.current && !modelPickerRef.current.contains(e.target as Node)) {
        setModelPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [modelPickerOpen]);

  const handleOpenModelPicker = async () => {
    if (modelPickerOpen) {
      setModelPickerOpen(false);
      return;
    }
    setModelPickerOpen(true);
    if (fetchedModels.length === 0 && !modelLoading && (!externalModelList || externalModelList.length === 0)) {
      setModelLoading(true);
      try {
        const res = await fetch('/api/models');
        const data = await res.json();
        if (data.models && data.models.length > 0) {
          setFetchedModels(data.models);
        }
      } catch {
        // 静默失败
      } finally {
        setModelLoading(false);
      }
    }
  };

  const handleSelectModel = (model: string) => {
    onModelChange?.(model);
    setModelPickerOpen(false);
  };

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
    e.target.value = '';

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
    <div className="chat-input-safe border-t border-border-light bg-[rgba(248,244,255,0.82)] px-4 pb-1.5 pt-2 md:py-4 backdrop-blur-xl dark:bg-[rgba(25,20,37,0.82)]">
      <div className="mx-auto max-w-6xl">
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

        {attachError && (
          <p className="mb-2 text-xs text-red-500">{attachError}</p>
        )}

        <div className="flex items-center gap-2 rounded-[1.25rem] border border-border-light bg-white/70 px-3 py-2 shadow-[0_8px_22px_rgba(92,74,139,0.04)]">
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

        {/* 模型切换栏 */}
        <div className="relative mt-1 flex items-center justify-between px-1" ref={modelPickerRef}>
          <button
            onClick={handleOpenModelPicker}
            className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-text-muted transition-colors hover:bg-accent/8 hover:text-accent-dark"
          >
            <span className="max-w-[12rem] truncate">{currentModel || t('settings.modelPlaceholder')}</span>
            <ChevronDownIcon className="h-3 w-3" />
          </button>

          {modelPickerOpen && (
            <div className="absolute bottom-full left-0 z-50 mb-1 max-h-60 w-72 overflow-y-auto rounded-xl border border-border-light bg-white/95 py-1 shadow-lg backdrop-blur-xl dark:bg-[rgba(25,20,37,0.95)]">
              <div className="border-b border-border-light px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-text-muted">
                {modelLoading ? t('common.loading') : t('input.modelSelect')}
              </div>
              {modelList.length === 0 && !modelLoading && (
                <div className="px-3 py-2 text-xs text-text-muted">{t('input.noModels')}</div>
              )}
              {modelList.map(model => (
                <button
                  key={model}
                  onClick={() => handleSelectModel(model)}
                  className={`w-full px-3 py-1.5 text-left text-xs transition-colors ${
                    model === currentModel
                      ? 'bg-accent/10 text-accent-dark font-medium'
                      : 'text-text-secondary hover:bg-accent/5'
                  }`}
                >
                  <span className="block truncate">{model}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
