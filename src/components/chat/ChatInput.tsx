'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from '@/lib/i18n-context';
import { formatTemplate } from '@/lib/i18n';
import { prepareAttachmentPayload } from '@/lib/attachment-payload';
import { SendIcon, StopIcon } from '@/components/ui/icons';
import { ModelPicker, ReasoningEffortPicker } from '@/components/ui/ComposerModelPickers';
import type { AttachmentItem } from '@/lib/chat-engine';
import type { ReasoningEffort } from '@/types';

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
  pinnedModels?: string[];
  onTogglePinnedModel?: (model: string) => void;
  reasoningEffort?: ReasoningEffort;
  onReasoningEffortChange?: (effort: ReasoningEffort) => void;
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

// 带稳定 id 的附件项：仅本组件内部使用，避免渲染列表用数组下标当 key。
// 提交 onSend 时再剥掉 id，保持对外 AttachmentItem 接口不变。
type LocalAttachment = AttachmentItem & { id: string };

function genAttachmentId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export default function ChatInput({ onSend, onStop, disabled, isGenerating, currentModel, onModelChange, modelList: externalModelList, pinnedModels = [], onTogglePinnedModel, reasoningEffort = 'default', onReasoningEffortChange }: Props) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<LocalAttachment[]>([]);
  const [attachError, setAttachError] = useState('');
  const composingRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 触屏设备（手机/平板）上回车键当换行用，发送只走发送按钮
  const [enterInsertsNewline, setEnterInsertsNewline] = useState(false);
  const { t } = useTranslation();

  useEffect(() => {
    if (!textareaRef.current) return;
    textareaRef.current.style.height = '0px';
    textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 180)}px`;
  }, [text]);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(hover: none) and (pointer: coarse)');
    const sync = () => setEnterInsertsNewline(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

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
    // 触屏设备保留浏览器默认行为（换行），避免软键盘回车误发送
    if (enterInsertsNewline || composingRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
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

      // 读取 / 上传 / 解析响应都可能抛错（断网、响应不是 JSON 等）：按文件兜住，
      // 只提示这一个文件失败，之前已处理好的附件照常加入
      try {
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
      } catch {
        setAttachError(formatTemplate(t('input.attachUploadFail'), { name: file.name }));
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
    // 手机底边只让出 home indicator 本身（安全区减 1rem，无安全区保底 0.5rem）；上方与消息的间距由最后一条消息的 mb-4 提供
    <div className="px-2.5 pb-[max(0.5rem,calc(env(safe-area-inset-bottom)_-_1rem))] md:px-5 md:pb-4 md:pt-1 lg:px-6">
      <div className="mx-auto max-w-[50rem]">
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {attachments.map(att => (
              <div
                key={att.id}
                className="group relative flex items-center gap-2 rounded-xl border border-border-light bg-surface/80 px-3 py-1.5 text-xs text-text-secondary shadow-sm dark:bg-white/10"
              >
                {att.type === 'image' ? (
                  <img src={att.url || att.data} alt={att.name} className="h-8 w-8 rounded-lg object-cover" loading="lazy" />
                ) : (
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent-dark text-xs font-medium">
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

        <div className="grid grid-cols-[2.75rem_minmax(0,1fr)_2.75rem] items-end gap-x-1 gap-y-0 rounded-3xl border border-border-light bg-surface p-1.5 shadow-[var(--shadow-soft)] focus-within:border-accent/40 md:grid-cols-[2.75rem_minmax(0,1fr)_auto] md:gap-y-1">
          <div className="col-start-2 row-start-1 min-w-0 md:col-span-3 md:col-start-1 md:px-2 md:pt-1">
            <textarea
              ref={textareaRef}
              value={text}
              onChange={e => setText(e.target.value)}
              onCompositionStart={() => { composingRef.current = true; }}
              onCompositionEnd={() => { composingRef.current = false; }}
              onKeyDown={handleKeyDown}
              rows={1}
              className="textarea-rich block min-h-[2.75rem] max-h-[min(11rem,30dvh)] resize-none border-none bg-transparent px-1 py-2 shadow-none focus:ring-0"
              disabled={disabled}
            />
          </div>

          {/* 手机首行保留输入和发送，模型工具在下一行；桌面维持独立工具行。 */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled}
            className="col-start-1 row-start-1 flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full p-2 text-text-muted transition-colors hover:bg-accent/8 hover:text-accent-dark disabled:cursor-not-allowed disabled:opacity-40 md:row-start-2 md:rounded-xl"
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

          <div className="col-span-3 col-start-1 row-start-2 flex min-w-0 items-center gap-1 px-1 md:col-span-1 md:col-start-2 md:px-0">
            <ModelPicker
              currentModel={currentModel}
              onModelChange={onModelChange}
              modelList={externalModelList}
              pinnedModels={pinnedModels}
              onTogglePinnedModel={onTogglePinnedModel}
            />

            {/* 思考强度选择：default 不发送 reasoning_effort 字段 */}
            <ReasoningEffortPicker reasoningEffort={reasoningEffort} onReasoningEffortChange={onReasoningEffortChange} />
          </div>
          {isGenerating ? (
            <>
              <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{t('status.streaming')}</span>
              <button
                onClick={onStop}
                aria-label={t('input.stop')}
                className="soft-button soft-button-secondary col-start-3 row-start-1 h-11 w-11 shrink-0 rounded-full border-accent/20 p-0 text-accent-dark hover:border-accent/40 hover:bg-accent/8 md:row-start-2 md:h-auto md:w-auto md:min-w-[6.6rem] md:rounded-xl md:px-4 md:py-2.5"
              >
                <StopIcon className="h-4 w-4" />
                <span className="hidden md:inline">{t('input.stop')}</span>
              </button>
            </>
          ) : (
            <button
              onClick={handleSubmit}
              aria-label={t('input.send')}
              disabled={!canSend}
              className="soft-button soft-button-primary col-start-3 row-start-1 h-11 w-11 shrink-0 rounded-full p-0 md:row-start-2 md:h-auto md:w-auto md:min-w-[6.6rem] md:rounded-xl md:px-4 md:py-2.5"
            >
              <SendIcon className="h-5 w-5 md:h-4 md:w-4" />
              <span className="hidden md:inline">{t('input.send')}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
