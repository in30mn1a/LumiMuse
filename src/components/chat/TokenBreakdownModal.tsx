'use client';

import { useMemo } from 'react';
import Modal from '@/components/ui/Modal';
import { useTranslation } from '@/lib/i18n-context';
import { formatTemplate } from '@/lib/i18n';

/**
 * Token 拆分弹窗
 *
 * 展示当前会话发给 LLM 的上下文中各组成部分的 token 估算与占比。
 *
 * 设计要点：
 * - 角色定义按字段细分（系统提示词 / 基本信息 / 性格 / 场景 / 其他 / 示例对话），
 *   方便用户定位"哪段角色卡占用最多 token"。
 * - 记忆按"条目数 + 总 token"汇总；若条目过多再细分会让弹窗过长，反而难看。
 * - 上下文消息复用已有的 messageTokens（已考虑最后一次 summary 之后的部分）。
 * - 占比基于 total = 各项之和，避免 "≈" 造成的轻微误差导致总和飘忽。
 * - 底部展示「上次真实统计」：模型返回的 usage.prompt_tokens / completion_tokens，
 *   与上方估算值对比，让用户直观看到估算偏差。
 */
export interface TokenBreakdownItem {
  /** 翻译键，例如 'token.systemPrompt' */
  labelKey: string;
  /** 该项 token 数（estimateTokens 估算值） */
  tokens: number;
  /** 可选副标题，例如记忆条目数 "12 条" */
  detail?: string;
}

/** 模型返回的真实 usage（OpenAI 兼容协议字段） */
export interface RealUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** 上一轮记忆注入统计（来自 assistant 消息 metadata.last_memory_injection） */
export interface MemoryInjectionInfo {
  /** 注入条数 */
  count: number;
  /** 实际 token 数（fallback 路径为 0 表示未知） */
  tokens: number;
  /** 检索模式：local/hybrid/vector/legacy-fallback/failed */
  mode?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  items: TokenBreakdownItem[];
  /** 上次模型返回的真实 usage；无则不展示真实统计区 */
  lastRealUsage?: RealUsage | null;
  /** 上一轮记忆注入统计；无则不展示注入信息 */
  lastMemoryInjection?: MemoryInjectionInfo | null;
}

export default function TokenBreakdownModal({ open, onClose, items, lastRealUsage, lastMemoryInjection }: Props) {
  const { t } = useTranslation();

  const estimatedTotal = useMemo(() => items.reduce((sum, item) => sum + item.tokens, 0), [items]);
  // 合计优先用真实 prompt_tokens（不带 ≈），无真实值时 fallback 到估算（带 ≈）
  const useRealTotal = !!lastRealUsage;
  const displayTotal = useRealTotal ? lastRealUsage!.prompt_tokens : estimatedTotal;

  // 有真实 usage 时，把各项估算按比例缩放到真实 prompt_tokens。
  // 这样各项加起来 = 真实合计，占比不再失真（否则 cl100k_base 估算对中文高估 1.7-2 倍，
  // 各项加起来会远大于真实合计，出现 164% 这种离谱占比）。
  // 注：缩放假设各项偏差比例一致（实际中文消息高估多、英文系统提示高估少，有轻微偏差，但远好于不缩放）
  const scaleFactor = useRealTotal && estimatedTotal > 0 ? displayTotal / estimatedTotal : 1;
  const scaledItems = useMemo(
    () => items.map(item => ({ ...item, tokens: Math.round(item.tokens * scaleFactor) })),
    [items, scaleFactor],
  );

  return (
    <Modal open={open} onClose={onClose} title={t('token.breakdownTitle')} maxWidth="max-w-md">
      <div className="space-y-3">
        <p className="text-xs text-text-muted">{t('token.breakdownHint')}</p>

        <ul className="space-y-2">
          {scaledItems.map((item) => {
            const percent = displayTotal > 0 ? (item.tokens / displayTotal) * 100 : 0;
            return (
              <li key={item.labelKey} className="flex flex-col gap-1">
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="text-text-primary">
                    {t(item.labelKey)}
                    {item.detail && (
                      <span className="ml-1.5 text-[11px] text-text-muted">({item.detail})</span>
                    )}
                  </span>
                  <span className="shrink-0 tabular-nums text-text-secondary">
                    {/* 有真实值时各项已按比例缩放到真实合计，不带 ≈；无真实值时是纯估算，带 ≈ */}
                    {useRealTotal ? '' : '≈'}{item.tokens} <span className="text-[11px] text-text-muted">{t('status.tokens')}</span>
                    <span className="ml-2 text-[11px] text-text-muted tabular-nums">{percent.toFixed(1)}%</span>
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/5 dark:bg-white/10">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-accent to-accent-dark"
                    style={{ width: `${percent}%` }}
                  />
                </div>
                {/* 记忆条目行：展示上一轮实际注入的条数和 token 数 */}
                {item.labelKey === 'token.memories' && lastMemoryInjection && (
                  <div className="pl-2 text-[11px] text-text-muted">
                    {formatTemplate(t('token.lastInjection'), {
                      count: lastMemoryInjection.count,
                      tokens: lastMemoryInjection.tokens > 0 ? lastMemoryInjection.tokens : '—',
                    })}
                    {lastMemoryInjection.mode && lastMemoryInjection.mode !== 'failed' && (
                      <span className="ml-1.5">· {t(`token.mode.${lastMemoryInjection.mode}`)}</span>
                    )}
                    {lastMemoryInjection.mode === 'failed' && (
                      <span
                        role="status"
                        className="ml-1.5 inline-flex rounded-full border border-red-200 bg-red-50 px-1.5 py-0.5 font-medium text-red-600 dark:border-red-900/70 dark:bg-red-950/40 dark:text-red-300"
                      >
                        {t('token.mode.failed')}
                      </span>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        <div className="flex items-baseline justify-between border-t border-border-light pt-3 text-sm">
          <span className="font-medium text-text-primary">{t('token.total')}</span>
          <span className="tabular-nums text-text-primary">
            {useRealTotal ? '' : '≈'}{displayTotal} <span className="text-[11px] text-text-muted">{t('status.tokens')}</span>
          </span>
        </div>

        {/* 真实统计区：展示模型返回的完整 usage（输入/输出/总计） */}
        {lastRealUsage && (
          <div className="rounded-lg border border-border-light bg-black/[0.02] p-3 dark:bg-white/[0.03]">
            <div className="mb-1.5 text-xs font-medium text-text-primary">{t('token.realUsageTitle')}</div>
            <p className="mb-2 text-[11px] text-text-muted">{t('token.realUsageHint')}</p>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div>
                <div className="text-[11px] text-text-muted">{t('token.realUsageInput')}</div>
                <div className="tabular-nums text-sm font-medium text-text-primary">{lastRealUsage.prompt_tokens}</div>
              </div>
              <div>
                <div className="text-[11px] text-text-muted">{t('token.realUsageOutput')}</div>
                <div className="tabular-nums text-sm font-medium text-text-primary">{lastRealUsage.completion_tokens}</div>
              </div>
              <div>
                <div className="text-[11px] text-text-muted">{t('token.realUsageTotal')}</div>
                <div className="tabular-nums text-sm font-medium text-text-primary">{lastRealUsage.total_tokens}</div>
              </div>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
