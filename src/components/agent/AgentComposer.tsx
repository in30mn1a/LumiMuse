'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from '@/lib/i18n-context';
import { SendIcon, StopIcon } from '@/components/ui/icons';
import { ModelPicker, ReasoningEffortPicker } from '@/components/ui/ComposerModelPickers';
import type { AgentModelControls } from '@/hooks/agent/useAgentModel';
import type { AgentContextStatus } from '@/lib/agent/context';
import AgentContextMeter from './AgentContextMeter';

interface Props {
  /** 本页正有一条流在进行（可能属于别的会话），此时不能再发送 */
  busy: boolean;
  /** 当前会话的这条流可以停止 */
  canStop: boolean;
  /** 返回 false 表示没发出去，输入框恢复原文 */
  onSend: (content: string) => Promise<boolean>;
  onStop: () => void;
  /** 输入框里的模型与思考强度 */
  model: AgentModelControls;
  /** 当前会话的上下文占用；没有会话或读不到时为 null，不显示 */
  context?: AgentContextStatus | null;
  onCompact?: () => void;
  compacting?: boolean;
  compactDisabled?: boolean;
  /** 任务计划还有没做完的步骤、会话空闲时提供：点一下等于发送「继续」 */
  onContinue?: () => void;
}

/** Agent 输入框，布局同聊天页。桌面 Enter 发送、Shift+Enter 换行；触屏上回车只换行，发送走按钮。 */
export default function AgentComposer({ busy, canStop, onSend, onStop, model, context = null, onCompact, compacting = false, compactDisabled = true, onContinue }: Props) {
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
    // 手机底边只让出 home indicator 本身（安全区减 1rem，无安全区保底 0.5rem）
    <div className="px-2.5 pb-[max(0.5rem,calc(env(safe-area-inset-bottom)_-_1rem))] md:px-5 md:pb-4 md:pt-1 lg:px-6">
      <div className="mx-auto max-w-3xl">
        {onContinue && !busy && !canStop && (
          <div className="mb-1.5 flex">
            <button type="button" onClick={onContinue} className="soft-button soft-button-secondary min-h-9 rounded-xl px-3 text-xs">
              {t('agent.continueRound')}
            </button>
          </div>
        )}
        <div className="grid grid-cols-[minmax(0,1fr)_2.75rem] items-end gap-x-1 gap-y-0 rounded-3xl border border-border-light bg-surface p-1.5 shadow-[var(--shadow-soft)] focus-within:border-accent/40 md:grid-cols-[minmax(0,1fr)_auto] md:gap-y-1">
          <div className="col-start-1 row-start-1 min-w-0 md:col-span-2 md:px-2 md:pt-1">
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
              className="textarea-rich block min-h-[2.75rem] max-h-[min(11rem,30dvh)] resize-none border-none bg-transparent px-1 py-2 shadow-none focus:ring-0"
            />
          </div>

          {/* 手机首行是输入和发送，模型工具在下一行；桌面工具行与发送按钮同一行。min-h 为选择器预留高度，读到设置后不跳动 */}
          <div className="col-span-2 col-start-1 row-start-2 flex min-h-6 min-w-0 items-center gap-1 px-1 md:col-span-1 md:px-0">
            {model.ready && (
              <>
                {/* 换接口后重新挂载，下拉里的模型列表随之重新读取 */}
                <ModelPicker
                  key={model.providerId}
                  currentModel={model.currentModel}
                  onModelChange={model.selectModel}
                  loadModels={model.loadModels}
                  pinnedModels={model.pinnedModels}
                  onTogglePinnedModel={model.togglePinnedModel}
                />
                <ReasoningEffortPicker reasoningEffort={model.reasoningEffort} onReasoningEffortChange={model.selectReasoningEffort} />
              </>
            )}
            {context && <AgentContextMeter context={context} onCompact={onCompact} compacting={compacting} compactDisabled={compactDisabled} />}
          </div>

          {canStop ? (
            <button
              type="button"
              onClick={onStop}
              aria-label={t('agent.stop')}
              className="soft-button soft-button-secondary col-start-2 row-start-1 h-11 w-11 shrink-0 rounded-full border-accent/20 p-0 text-accent-dark hover:border-accent/40 hover:bg-accent/8 md:row-start-2 md:h-auto md:w-auto md:min-w-[6.6rem] md:rounded-xl md:px-4 md:py-2.5"
            >
              <StopIcon className="h-4 w-4" />
              <span className="hidden md:inline">{t('agent.stop')}</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void submit()}
              disabled={busy || !value.trim()}
              aria-label={t('agent.send')}
              className="soft-button soft-button-primary col-start-2 row-start-1 h-11 w-11 shrink-0 rounded-full p-0 disabled:cursor-not-allowed disabled:opacity-50 md:row-start-2 md:h-auto md:w-auto md:min-w-[6.6rem] md:rounded-xl md:px-4 md:py-2.5"
            >
              <SendIcon className="h-5 w-5 md:h-4 md:w-4" />
              <span className="hidden md:inline">{t('agent.send')}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
