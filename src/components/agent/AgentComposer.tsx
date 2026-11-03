'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from '@/lib/i18n-context';
import { StopIcon } from '@/components/ui/icons';

interface Props {
  /** 本页正有一条流在进行（可能属于别的会话），此时不能再发送 */
  busy: boolean;
  /** 当前会话的这条流可以停止 */
  canStop: boolean;
  /** 返回 false 表示没发出去，输入框恢复原文 */
  onSend: (content: string) => Promise<boolean>;
  onStop: () => void;
}

/** Agent 输入框。桌面 Enter 发送、Shift+Enter 换行；触屏上回车只换行，发送走按钮。 */
export default function AgentComposer({ busy, canStop, onSend, onStop }: Props) {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  const [enterInsertsNewline, setEnterInsertsNewline] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = '0px';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
  }, [value]);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(hover: none) and (pointer: coarse)');
    const sync = () => setEnterInsertsNewline(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  const submit = async () => {
    const content = value.trim();
    if (!content || busy) return;
    setValue('');
    const sent = await onSend(content);
    if (!sent) setValue(prev => prev || content);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (enterInsertsNewline || composingRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <div className="border-t border-border-light bg-surface px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 lg:px-6">
      <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-2xl border border-border-light bg-surface-2/40 px-3 py-1.5 focus-within:border-accent/50">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={event => setValue(event.target.value)}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
          onKeyDown={handleKeyDown}
          rows={1}
          placeholder={t('agent.inputPlaceholder')}
          aria-label={t('agent.inputLabel')}
          className="textarea-rich block min-h-[2.75rem] max-h-[min(11rem,30dvh)] min-w-0 flex-1 resize-none border-none bg-transparent px-1 py-2 shadow-none focus:ring-0"
        />
        {canStop ? (
          <button
            type="button"
            onClick={onStop}
            className="soft-button soft-button-secondary mb-1 min-h-10 shrink-0 px-3"
            aria-label={t('agent.stop')}
          >
            <StopIcon className="h-4 w-4" />
            <span className="hidden sm:inline">{t('agent.stop')}</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || !value.trim()}
            className="soft-button soft-button-primary mb-1 min-h-10 shrink-0 px-4 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('agent.send')}
          </button>
        )}
      </div>
    </div>
  );
}
