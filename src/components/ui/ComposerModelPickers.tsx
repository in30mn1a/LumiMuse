'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '@/lib/i18n-context';
import { formatTemplate } from '@/lib/i18n';
import { parseJsonResponse } from '@/lib/http';
import { PinIcon } from '@/components/ui/icons';
import { sortModelsByPinned } from '@/lib/pinned-models';
import type { ReasoningEffort } from '@/types';

const REASONING_EFFORT_OPTIONS: ReasoningEffort[] = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];

/** 模型 / 思考强度触发按钮：轻量文字按钮，不抢输入区的视觉重量 */
const PICKER_TRIGGER = 'flex max-w-full cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-xs text-text-muted transition-colors hover:bg-accent/8 hover:text-accent-dark';

function ChevronDownIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

/** 默认读取当前主接口的模型列表 */
async function fetchMainModels(): Promise<string[]> {
  const data = await parseJsonResponse<{ models?: string[] }>(await fetch('/api/models'));
  return data.models ?? [];
}

interface ModelPickerProps {
  currentModel?: string;
  onModelChange?: (model: string) => void;
  /** 调用方已有的列表；为空时第一次打开下拉再去拉取 */
  modelList?: string[];
  /** 拉取模型列表，默认读取当前主接口 */
  loadModels?: () => Promise<string[]>;
  pinnedModels?: string[];
  onTogglePinnedModel?: (model: string) => void;
}

/** 输入框里的模型下拉（聊天页与 Agent 页共用）。 */
export function ModelPicker({
  currentModel,
  onModelChange,
  modelList: externalModelList,
  loadModels = fetchMainModels,
  pinnedModels = [],
  onTogglePinnedModel,
}: ModelPickerProps) {
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [fetchedModels, setFetchedModels] = useState<string[]>([]);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelError, setModelError] = useState('');
  const modelPickerRef = useRef<HTMLDivElement>(null);
  // 选项 DOM 引用数组，用于方向键移动焦点
  const optionRefs = useRef<Array<HTMLDivElement | null>>([]);
  // 触发按钮引用，关闭后把焦点还回去，保持键盘用户操作连续
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  // 触屏没有悬停：第一次点星标位置只把它显示出来，再点一次才切换置顶，避免点模型名时误触
  const [revealedPinModel, setRevealedPinModel] = useState<string | null>(null);
  const pinPointerTypeRef = useRef('');
  const { t } = useTranslation();

  const modelList = externalModelList && externalModelList.length > 0 ? externalModelList : fetchedModels;
  const displayModels = sortModelsByPinned(modelList, pinnedModels);

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

  // 下拉打开后把焦点移到当前选中项（或首项），方便键盘用户立即用方向键导航。
  // 按渲染后的 DOM 找选中项，不依赖置顶列表：切换置顶只重排，不能把焦点从星标上抢走
  useEffect(() => {
    if (!modelPickerOpen || modelList.length === 0) return;
    const raf = requestAnimationFrame(() => {
      const options = optionRefs.current;
      (options.find((option) => option?.getAttribute('aria-selected') === 'true') ?? options[0])?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [modelPickerOpen, modelList, currentModel]);

  const handleOpenModelPicker = async () => {
    if (modelPickerOpen) {
      setModelPickerOpen(false);
      return;
    }
    setModelPickerOpen(true);
    setRevealedPinModel(null);
    setModelError('');
    if (fetchedModels.length === 0 && !modelLoading && (!externalModelList || externalModelList.length === 0)) {
      setModelLoading(true);
      try {
        const models = await loadModels();
        if (models.length > 0) {
          setFetchedModels(models);
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

  const handlePinClick = (e: React.MouseEvent<HTMLButtonElement>, model: string, pinned: boolean) => {
    e.stopPropagation();
    const pointerType = pinPointerTypeRef.current;
    pinPointerTypeRef.current = '';
    if (!pinned && pointerType === 'touch' && revealedPinModel !== model) {
      setRevealedPinModel(model);
      return;
    }
    setRevealedPinModel(null);
    onTogglePinnedModel?.(model);
    // 置顶会重排选项，被移动的节点可能丢焦点；键盘用户继续停在这颗星标上
    if (e.currentTarget === document.activeElement) {
      const star = e.currentTarget;
      requestAnimationFrame(() => star.focus());
    }
  };

  // listbox 选项键盘导航：方向键移动焦点、Enter 选中、Esc 关闭
  const handleOptionKeyDown = (e: React.KeyboardEvent<HTMLDivElement>, index: number, model: string) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = Math.min(index + 1, displayModels.length - 1);
      optionRefs.current[next]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = Math.max(index - 1, 0);
      optionRefs.current[prev]?.focus();
    } else if (e.key === 'Enter' || e.key === ' ') {
      // 星标按钮上的回车/空格交给按钮自己切换置顶，不当成选中模型
      if (e.target !== e.currentTarget) return;
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
      optionRefs.current[displayModels.length - 1]?.focus();
    }
  };

  return (
    <div className="relative min-w-0" ref={modelPickerRef}>
      <button
        ref={modelTriggerRef}
        onClick={handleOpenModelPicker}
        className={PICKER_TRIGGER}
        aria-haspopup="listbox"
        aria-expanded={modelPickerOpen}
      >
        <span className="min-w-0 max-w-[12rem] truncate">{currentModel || t('settings.modelPlaceholder')}</span>
        <ChevronDownIcon className="h-3 w-3 shrink-0" />
      </button>

      {modelPickerOpen && (
        <div
          role="listbox"
          tabIndex={-1}
          aria-label={t('input.modelSelect')}
          aria-activedescendant={currentModel ? `model-option-${currentModel}` : undefined}
          className="absolute bottom-full left-0 z-50 mb-1 w-72 max-h-[40dvh] overflow-y-auto rounded-xl border border-border-light bg-surface/95 py-1 shadow-lg backdrop-blur-xl md:max-h-60 dark:bg-[rgba(25,20,37,0.95)]"
        >
          <div className="border-b border-border-light px-3 py-1.5 text-xs font-medium uppercase tracking-wider text-text-muted">
            {modelLoading ? t('common.loading') : t('input.modelSelect')}
          </div>
          {modelList.length === 0 && !modelLoading && (
            <div className="px-3 py-2 text-xs text-text-muted">{modelError || t('input.noModels')}</div>
          )}
          {displayModels.map((model, index) => {
            const isSelected = model === currentModel;
            const isPinned = pinnedModels.includes(model);
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
                className={`group flex w-full cursor-pointer items-center gap-1 px-3 py-1.5 text-left text-xs transition-colors outline-none focus:bg-accent/10 ${
                  isSelected
                    ? 'bg-accent/10 text-accent-dark font-medium'
                    : 'text-text-secondary hover:bg-accent/5'
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{model}</span>
                {onTogglePinnedModel && (
                  <button
                    type="button"
                    onPointerDown={(e) => { pinPointerTypeRef.current = e.pointerType; }}
                    onClick={(e) => handlePinClick(e, model, isPinned)}
                    aria-pressed={isPinned}
                    aria-label={formatTemplate(t(isPinned ? 'input.unpinModel' : 'input.pinModel'), { model })}
                    title={formatTemplate(t(isPinned ? 'input.unpinModel' : 'input.pinModel'), { model })}
                    className={`-my-1.5 -mr-2 flex h-7 w-8 shrink-0 items-center justify-center rounded-md outline-none transition-opacity focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-accent/50 ${
                      isPinned
                        ? 'text-accent-dark'
                        : `text-text-muted hover:text-accent-dark ${revealedPinModel === model ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`
                    }`}
                  >
                    <PinIcon className={`h-3.5 w-3.5 ${isPinned ? 'fill-current' : ''}`} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface ReasoningEffortPickerProps {
  reasoningEffort?: ReasoningEffort;
  onReasoningEffortChange?: (effort: ReasoningEffort) => void;
}

/** 输入框里的思考强度下拉（聊天页与 Agent 页共用）。default 表示不发送 reasoning_effort 字段。 */
export function ReasoningEffortPicker({ reasoningEffort = 'default', onReasoningEffortChange }: ReasoningEffortPickerProps) {
  const [effortPickerOpen, setEffortPickerOpen] = useState(false);
  const effortPickerRef = useRef<HTMLDivElement>(null);
  const effortTriggerRef = useRef<HTMLButtonElement>(null);
  const effortOptionRefs = useRef<Array<HTMLDivElement | null>>([]);
  const { t } = useTranslation();

  useEffect(() => {
    if (!effortPickerOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (effortPickerRef.current && !effortPickerRef.current.contains(e.target as Node)) {
        setEffortPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [effortPickerOpen]);

  // 下拉打开后把焦点移到当前选中项，方便键盘用户立即用方向键导航
  useEffect(() => {
    if (!effortPickerOpen) return;
    const raf = requestAnimationFrame(() => {
      const selectedIdx = REASONING_EFFORT_OPTIONS.indexOf(reasoningEffort);
      effortOptionRefs.current[selectedIdx >= 0 ? selectedIdx : 0]?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [effortPickerOpen, reasoningEffort]);

  const handleSelectEffort = (effort: ReasoningEffort) => {
    onReasoningEffortChange?.(effort);
    setEffortPickerOpen(false);
    effortTriggerRef.current?.focus();
  };

  // 思考强度选项键盘导航：方向键移动焦点、Enter 选中、Esc 关闭
  const handleEffortOptionKeyDown = (e: React.KeyboardEvent<HTMLDivElement>, index: number, effort: ReasoningEffort) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      effortOptionRefs.current[Math.min(index + 1, REASONING_EFFORT_OPTIONS.length - 1)]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      effortOptionRefs.current[Math.max(index - 1, 0)]?.focus();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleSelectEffort(effort);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setEffortPickerOpen(false);
      effortTriggerRef.current?.focus();
    }
  };

  return (
    <div className="relative shrink-0" ref={effortPickerRef}>
      <button
        ref={effortTriggerRef}
        onClick={() => setEffortPickerOpen(open => !open)}
        className={PICKER_TRIGGER}
        title={t('input.reasoningEffortHint')}
        aria-haspopup="listbox"
        aria-expanded={effortPickerOpen}
      >
        <span className="truncate">
          {t('input.reasoningEffort')}: {reasoningEffort === 'default' ? t('input.reasoningEffortDefault') : reasoningEffort}
        </span>
        <ChevronDownIcon className="h-3 w-3 shrink-0" />
      </button>

      {effortPickerOpen && (
        <div
          role="listbox"
          tabIndex={-1}
          aria-label={t('input.reasoningEffort')}
          aria-activedescendant={`effort-option-${reasoningEffort}`}
          className="absolute bottom-full right-0 z-50 mb-1 w-44 max-h-[40dvh] overflow-y-auto rounded-xl border border-border-light bg-surface/95 py-1 shadow-lg backdrop-blur-xl md:left-0 md:right-auto dark:bg-[rgba(25,20,37,0.95)]"
        >
          <div className="border-b border-border-light px-3 py-1.5 text-xs font-medium uppercase tracking-wider text-text-muted">
            {t('input.reasoningEffort')}
          </div>
          {REASONING_EFFORT_OPTIONS.map((effort, index) => {
            const isSelected = effort === reasoningEffort;
            return (
              <div
                key={effort}
                id={`effort-option-${effort}`}
                ref={(el) => {
                  effortOptionRefs.current[index] = el;
                }}
                role="option"
                aria-selected={isSelected}
                tabIndex={0}
                onClick={() => handleSelectEffort(effort)}
                onKeyDown={(e) => handleEffortOptionKeyDown(e, index, effort)}
                className={`w-full cursor-pointer px-3 py-1.5 text-left text-xs transition-colors outline-none focus:bg-accent/10 ${
                  isSelected
                    ? 'bg-accent/10 text-accent-dark font-medium'
                    : 'text-text-secondary hover:bg-accent/5'
                }`}
              >
                {effort === 'default' ? t('input.reasoningEffortDefault') : effort}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
