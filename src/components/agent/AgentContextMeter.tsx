'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { AgentContextStatus } from '@/lib/agent/context';
import { useTranslation } from '@/lib/i18n-context';
import { formatTemplate } from '@/lib/i18n';

/** 12345 → 12.3k；界面上的 token 数只需要量级 */
export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(Math.round(tokens));
  const k = tokens / 1000;
  return `${k >= 100 ? Math.round(k) : Number(k.toFixed(1))}k`;
}

const RING_RADIUS = 6;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

/**
 * 输入框工具行里的上下文占用：圆环加百分比，点开看明细。
 * 数值与服务端判断是否自动压缩用的是同一个，接近阈值时变成强调色。
 */
export default function AgentContextMeter({ context, onCompact, compactDisabled = false, compacting = false }: {
  context: AgentContextStatus;
  onCompact?: () => void;
  compactDisabled?: boolean;
  compacting?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const handlePointer = (event: MouseEvent | TouchEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      triggerRef.current?.focus();
      // 还焦点会触发 onFocus，最后关闭，避免详情立即重新打开。
      setOpen(false);
    };
    document.addEventListener('mousedown', handlePointer);
    document.addEventListener('touchstart', handlePointer);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handlePointer);
      document.removeEventListener('touchstart', handlePointer);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  const fraction = context.window > 0 ? context.used / context.window : 0;
  const percent = Math.round(fraction * 100);
  const thresholdPercent = Math.round((context.threshold / context.window) * 100);
  const near = context.used >= context.threshold * 0.9;
  const usage = context.last_usage;

  return (
    <div className="relative ml-auto shrink-0" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={formatTemplate(t('agent.context.label'), { percent })}
        className={`flex min-h-6 cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-xs tabular-nums transition-colors hover:bg-accent/8 hover:text-accent-dark ${
          near ? 'text-accent-dark' : 'text-text-muted'
        }`}
      >
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 -rotate-90" aria-hidden="true">
          <circle cx="8" cy="8" r={RING_RADIUS} fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
          <circle
            cx="8"
            cy="8"
            r={RING_RADIUS}
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={`${Math.min(1, fraction) * RING_LENGTH} ${RING_LENGTH}`}
          />
        </svg>
        <span>{percent}%</span>
      </button>

      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label={t('agent.context.title')}
          className="absolute bottom-full right-0 z-50 mb-1 w-64 max-w-[calc(100vw-2rem)] rounded-xl border border-border-light bg-surface/95 p-3 text-xs text-text-secondary shadow-lg backdrop-blur-xl dark:bg-[rgba(25,20,37,0.95)]"
        >
          <p className="mb-2 font-medium text-text-primary">{t('agent.context.title')}</p>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5">
            <dt className="text-text-muted">{t('agent.context.used')}</dt>
            <dd className="text-right tabular-nums">
              {formatTemplate(t('agent.context.usedValue'), {
                used: formatTokenCount(context.used),
                window: formatTokenCount(context.window),
                percent,
              })}
            </dd>
            <dt className="text-text-muted">{t('agent.context.threshold')}</dt>
            <dd className="text-right tabular-nums">
              {formatTemplate(t('agent.context.thresholdValue'), {
                tokens: formatTokenCount(context.threshold),
                percent: thresholdPercent,
              })}
            </dd>
            {usage && (
              <>
                <dt className="text-text-muted">{t('agent.context.lastUsage')}</dt>
                <dd className="text-right tabular-nums">
                  {formatTemplate(t('agent.context.lastUsageValue'), {
                    prompt: formatTokenCount(usage.prompt_tokens),
                    completion: formatTokenCount(usage.completion_tokens),
                  })}
                  {usage.cached_tokens !== undefined && (
                    <span className="block text-text-muted">
                      {formatTemplate(t('agent.context.cached'), { cached: formatTokenCount(usage.cached_tokens) })}
                    </span>
                  )}
                </dd>
              </>
            )}
          </dl>
          <p className="mt-2 leading-relaxed text-text-muted">{t('agent.context.hint')}</p>
          {onCompact && (
            <button
              type="button"
              onClick={onCompact}
              disabled={compactDisabled}
              aria-busy={compacting}
              className="soft-button soft-button-secondary mt-3 min-h-11 w-full disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t(compacting ? 'agent.context.compacting' : 'agent.context.compact')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
