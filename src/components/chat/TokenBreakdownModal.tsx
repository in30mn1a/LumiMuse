'use client';

import { useMemo } from 'react';
import Modal from '@/components/ui/Modal';
import { useTranslation } from '@/lib/i18n-context';

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
 */
export interface TokenBreakdownItem {
  /** 翻译键，例如 'token.systemPrompt' */
  labelKey: string;
  /** 该项 token 数（estimateTokens 估算值） */
  tokens: number;
  /** 可选副标题，例如记忆条目数 "12 条" */
  detail?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  items: TokenBreakdownItem[];
}

export default function TokenBreakdownModal({ open, onClose, items }: Props) {
  const { t } = useTranslation();

  const total = useMemo(() => items.reduce((sum, item) => sum + item.tokens, 0), [items]);

  return (
    <Modal open={open} onClose={onClose} title={t('token.breakdownTitle')} maxWidth="max-w-md">
      <div className="space-y-3">
        <p className="text-xs text-text-muted">{t('token.breakdownHint')}</p>

        <ul className="space-y-2">
          {items.map((item) => {
            const percent = total > 0 ? (item.tokens / total) * 100 : 0;
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
                    ≈{item.tokens} <span className="text-[11px] text-text-muted">{t('status.tokens')}</span>
                    <span className="ml-2 text-[11px] text-text-muted tabular-nums">{percent.toFixed(1)}%</span>
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/5 dark:bg-white/10">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-accent to-accent-dark"
                    style={{ width: `${percent}%` }}
                  />
                </div>
              </li>
            );
          })}
        </ul>

        <div className="flex items-baseline justify-between border-t border-border-light pt-3 text-sm">
          <span className="font-medium text-text-primary">{t('token.total')}</span>
          <span className="tabular-nums text-text-primary">
            ≈{total} <span className="text-[11px] text-text-muted">{t('status.tokens')}</span>
          </span>
        </div>
      </div>
    </Modal>
  );
}
