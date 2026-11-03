'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from '@/lib/i18n-context';
import { formatTemplate } from '@/lib/i18n';
import { getErrorMessage, parseJsonResponse } from '@/lib/http';

interface AgentStatus {
  failed_tasks: { extraction: number; profile: number; embedding: number };
  repairable_candidates: number;
  recent_errors: number;
  recent_error_window_hours: number;
  agent: { configured: boolean; provider_name: string | null; model: string };
}

interface Props {
  /** 变化时重新读取（每轮结束后） */
  refreshKey: number;
}

const CHIP = 'inline-flex min-h-7 shrink-0 items-center rounded-full border px-2.5 text-xs';
const CHIP_OK = `${CHIP} border-border-light text-text-muted`;
const CHIP_WARN = `${CHIP} border-danger/30 bg-danger/5 text-danger`;

/** 顶部状态条：只读数据库，不调用模型，上游故障时也能显示。 */
export default function AgentStatusBar({ refreshKey }: Props) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await parseJsonResponse<AgentStatus>(await fetch('/api/agent/status')));
      setError(null);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }, []);

  useEffect(() => {
    // 状态写入都在请求返回之后
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load, refreshKey]);

  if (error && !status) {
    return (
      <div className="flex items-center gap-2 border-b border-border-light px-4 py-2 text-xs text-danger" role="alert">
        <span className="min-w-0 truncate">{`${t('agent.status.loadFailed')}: ${error}`}</span>
        <button type="button" onClick={() => void load()} className="shrink-0 font-medium text-accent-dark underline">
          {t('common.retry')}
        </button>
      </div>
    );
  }
  if (!status) {
    return <div className="h-11 border-b border-border-light" aria-busy="true" aria-label={t('common.loading')} />;
  }

  const counts: Array<{ key: string; label: string; count: number }> = [
    { key: 'extraction', label: t('agent.status.extractionFailed'), count: status.failed_tasks.extraction },
    { key: 'profile', label: t('agent.status.profileFailed'), count: status.failed_tasks.profile },
    { key: 'embedding', label: t('agent.status.embeddingFailed'), count: status.failed_tasks.embedding },
    { key: 'repairable', label: t('agent.status.repairable'), count: status.repairable_candidates },
    {
      key: 'errors',
      label: formatTemplate(t('agent.status.recentErrors'), { hours: status.recent_error_window_hours }),
      count: status.recent_errors,
    },
  ];
  const modelLabel = status.agent.configured
    ? [status.agent.provider_name, status.agent.model].filter(Boolean).join(' · ')
    : t('agent.status.notConfigured');

  return (
    <div className="border-b border-border-light px-3 py-2 lg:px-6" aria-label={t('agent.status.title')} role="region">
      {/* 手机上单行横向滑动，避免状态条占掉三四行高度 */}
      <div className="flex items-center gap-1.5 overflow-x-auto [scrollbar-width:none] lg:flex-wrap lg:overflow-visible">
        {counts.map(item => (
          <span key={item.key} className={item.count > 0 ? CHIP_WARN : CHIP_OK} data-status={item.key}>
            {item.label}
            <span className="ml-1 font-semibold tabular-nums">{item.count}</span>
          </span>
        ))}
        <span
          className={`${status.agent.configured ? CHIP_OK : CHIP_WARN} min-w-0 max-w-full`}
          title={modelLabel}
        >
          <span className="truncate">{modelLabel}</span>
        </span>
      </div>
    </div>
  );
}
