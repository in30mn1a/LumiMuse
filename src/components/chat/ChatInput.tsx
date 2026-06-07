'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from '@/lib/i18n-context';
import { formatTemplate } from '@/lib/i18n';
import { parseJsonResponse } from '@/lib/http';
import { prepareAttachmentPayload } from '@/lib/attachment-payload';
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

// 带稳定 id 的附件项：仅本组件内部使用，避免渲染列表用数组下标当 key。
// 提交 onSend 时再剥掉 id，保持对外 AttachmentItem 接口不变。
type LocalAttachment = AttachmentItem & { id: string };

function genAttachmentId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export default function ChatInput({ onSend, onStop, disabled, isGenerating, currentModel, onModelChange, modelList: externalModelList }: Props) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<LocalAttachment[]>([]);
  const [attachError, setAttachError] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [fetchedModels, setFetchedModels] = useState<string[]>([]);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelError, setModelError] = useState('');
  const modelPickerRef = useRef<HTMLDivElement>(null);
  // 选项 DOM 引用数组，用于方向键移动焦点
  const optionRefs = useRef<Array<HTMLDivElement | null>>([]);
  // 触发按钮引用，关闭后把焦点还回去，保持键盘用户操作连续
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
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

  // 下拉打开后把焦点移到当前选中项（或首项），方便键盘用户立即用方向键导航
  useEffect(() => {
    if (!modelPickerOpen || modelList.length === 0) return;
    const raf = requestAnimationFrame(() => {
      const selectedIdx = modelList.findIndex((m) => m === currentModel);
      const targetIdx = selectedIdx >= 0 ? selectedIdx : 0;
      optionRefs.current[targetIdx]?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [modelPickerOpen, modelList, currentModel]);

  const handleOpenModelPicker = async () => {
    if (modelPickerOpen) {
      setModelPickerOpen(false);
      return;
    }
    setModelPickerOpen(true);
    setModelError('');
    if (fetchedModels.length === 0 && !modelLoading && (!externalModelList || externalModelList.length === 0)) {
      setModelLoading(true);
      try {
        const data = await parseJsonResponse<{ models?: string[] }>(await fetch('/api/models'));
        if (data.models && data.models.length > 0) {
          setFetchedModels(data.models);
        }
      } catch {
        setModelError(t('input.modelLoadFail'));
      } finally {
        setModelLoading(false);
      }
    }
  };

  const handleSelectModel = (model: string) => {
    onModelChange?.(model);
    setModelPickerOpen(false);
    // 关闭下拉后焦点回到触发按钮，符合 listbox 模式的可访问性建议
    modelTriggerRef.current?.focus();
  };

  // listbox 选项键盘导航：方向键移动焦点、Enter 选中、Esc 关闭
  const handleOptionKeyDown = (e: React.KeyboardEvent<HTMLDivElement>, index: number, model: string) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = Math.min(index + 1, modelList.length - 1);
      optionRefs.current[next]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = Math.max(index - 1, 0);
      optionRefs.current[prev]?.focus();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleSelectModel(model);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setModelPickerOpen(false);
      modelTriggerRef.current?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      optionRefs.current[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      optionRefs.current[modelList.length - 1]?.focus();
    }
  };

  const handleSubmit = () => {
    const trimmed = text.trim();
    if ((!trimmed && attachments.length === 0) || disabled) return;
    // 图片 data 仅用于预览；发送时由服务端通过本地 url 读取，避免重复传输 base64。
    const payload = prepareAttachmentPayload(attachments);
    onSend(trimmed || ' ', payload);
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
    const newAttachments: LocalAttachment[] = [];

    for (const file of files) {
      if (file.size > MAX_FILE_SIZE) {
        setAttachError(formatTemplate(t('input.attachExceedSize'), { name: file.name }));
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
          setAttachError(data.error || formatTemplate(t('input.attachUploadFail'), { name: file.name }));
          continue;
        }
        newAttachments.push({ id: genAttachmentId(), type: 'image', name: file.name, data: dataUrl, url: data.url, mimeType: file.type });
      } else if (isText) {
        if (file.size > MAX_TEXT_SIZE) {
          setAttachError(formatTemplate(t('input.attachTextWarn'), { name: file.name }));
        }
        const text = await file.text();
        newAttachments.push({ id: genAttachmentId(), type: 'text', name: file.name, data: text, mimeType: file.type || 'text/plain' });
      } else {
        setAttachError(formatTemplate(t('input.attachUnsupported'), { name: file.name }));
      }
    }

    if (newAttachments.length > 0) {
      setAttachments(prev => [...prev, ...newAttachments]);
    }
  };

  const removeAttachment = (id: string) => {
    setAttachments(prev => prev.filter(att => att.id !== id));
  };

  const canSend = (text.trim().length > 0 || attachments.length > 0) && !disabled;

  return (
    <div className="border-t border-border-light bg-[rgba(248,244,255,0.82)] px-4 pb-0 pt-2 md:py-4 backdrop-blur-xl dark:bg-[rgba(25,20,37,0.82)]">
      <div className="mx-auto max-w-6xl">
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {attachments.map(att => (
              <div
                key={att.id}
                className="group relative flex items-center gap-2 rounded-xl border border-border-light bg-white/80 px-3 py-1.5 text-xs text-text-secondary shadow-sm dark:bg-white/10"
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
                  onClick={() => removeAttachment(att.id)}
                  className="ml-1 rounded-full p-0.5 text-text-muted hover:bg-red-50 hover:text-red-500"
                  aria-label={formatTemplate(t('message.removeAttachmentShort'), { name: att.name })}
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

        <div className="flex items-center gap-2 rounded-[1.25rem] border border-border-light bg-white/70 px-3 py-2 shadow-[0_8px_22px_rgba(92,74,139,0.04)] dark:bg-white/5">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled}
            className="shrink-0 self-end mb-1.5 rounded-xl p-2 text-text-muted transition-colors hover:bg-accent/8 hover:text-accent-dark disabled:cursor-not-allowed disabled:opacity-40"
            title={t('input.attachFileTitle')}
            aria-label={t('input.attachFileLabel')}
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
            ref={modelTriggerRef}
            onClick={handleOpenModelPicker}
            className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-text-muted transition-colors hover:bg-accent/8 hover:text-accent-dark"
            aria-haspopup="listbox"
            aria-expanded={modelPickerOpen}
          >
            <span className="max-w-[12rem] truncate">{currentModel || t('settings.modelPlaceholder')}</span>
            <ChevronDownIcon className="h-3 w-3" />
          </button>

          {modelPickerOpen && (
            <div
              role="listbox"
              tabIndex={-1}
              aria-label={t('input.modelSelect')}
              aria-activedescendant={currentModel ? `model-option-${currentModel}` : undefined}
              className="absolute bottom-full left-0 z-50 mb-1 max-h-60 w-72 overflow-y-auto rounded-xl border border-border-light bg-white/95 py-1 shadow-lg backdrop-blur-xl dark:bg-[rgba(25,20,37,0.95)]"
            >
              <div className="border-b border-border-light px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-text-muted">
                {modelLoading ? t('common.loading') : t('input.modelSelect')}
              </div>
              {modelList.length === 0 && !modelLoading && (
                <div className="px-3 py-2 text-xs text-text-muted">{modelError || t('input.noModels')}</div>
              )}
              {modelList.map((model, index) => {
                const isSelected = model === currentModel;
                return (
                  // role="option" + aria-selected：屏幕阅读器会朗读"选项 X，已选中"
                  // tabIndex=0 让方向键导航时能 focus 到具体选项
                  <div
                    key={model}
                    id={`model-option-${model}`}
                    ref={(el) => {
                      optionRefs.current[index] = el;
                    }}
                    role="option"
                    aria-selected={isSelected}
                    tabIndex={0}
                    onClick={() => handleSelectModel(model)}
                    onKeyDown={(e) => handleOptionKeyDown(e, index, model)}
                    className={`w-full cursor-pointer px-3 py-1.5 text-left text-xs transition-colors outline-none focus:bg-accent/10 ${
                      isSelected
                        ? 'bg-accent/10 text-accent-dark font-medium'
                        : 'text-text-secondary hover:bg-accent/5'
                    }`}
                  >
                    <span className="block truncate">{model}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
