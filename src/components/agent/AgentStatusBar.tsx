'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from '@/lib/i18n-context';
import { formatTemplate } from '@/lib/i18n';
import { getErrorMessage, parseJsonResponse } from '@/lib/http';

interface AgentStatus {
  failed_tasks: { extraction: number; profile: number; embedding: number };
  repairable_candidates: number;
  recent_errors: number;
  recent_error_window_hours: number;
  dismissal_snapshot: Array<{ kind: CountKey; id: number; version: string }>;
  /** 接口还返回 provider_name / model；模型改在输入框里显示和切换，这里只看是否可用 */
  agent: { configured: boolean };
}

interface Props {
  /** 变化时重新读取（每轮结束后） */
  refreshKey: number;
}

const CHIP = 'inline-flex min-h-7 shrink-0 items-center rounded-full border px-2.5 text-xs';
const CHIP_OK = `${CHIP} border-border-light text-text-muted`;
const CHIP_WARN = `${CHIP} border-danger/30 bg-danger/5 text-danger`;

type CountKey = 'extraction' | 'profile' | 'embedding' | 'repairable' | 'errors';

/** 顶部状态条：读取活跃问题并保存忽略状态，不调用模型。 */
export default function AgentStatusBar({ refreshKey }: Props) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState(false);
  const [dismissError, setDismissError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const dismissingRef = useRef(false);
  const refreshAfterDismissRef = useRef(false);

  const load = useCallback(async () => {
    if (dismissingRef.current) {
      refreshAfterDismissRef.current = true;
      return;
    }
    const request = ++requestRef.current;
    try {
      const next = await parseJsonResponse<AgentStatus>(await fetch('/api/agent/status'));
      if (request !== requestRef.current) return;
      setStatus(next);
      setError(null);
    } catch (err) {
      if (request === requestRef.current) setError(getErrorMessage(err));
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

  const counts: Array<{ key: CountKey; label: string; count: number }> = [
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

  const isWarn = (item: { count: number }) => item.count > 0;
  const hasWarn = counts.some(isWarn);
  const dismissAll = async () => {
    if (dismissingRef.current) return;
    dismissingRef.current = true;
    setDismissing(true);
    setDismissError(null);
    // 忽略开始前发出的 GET 不能再恢复旧提醒；期间的刷新留到写入后读取。
    ++requestRef.current;
    try {
      const next = await parseJsonResponse<AgentStatus>(await fetch('/api/agent/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dismissal_snapshot: status.dismissal_snapshot }),
      }));
      setStatus(next);
      setError(null);
    } catch (err) {
      setDismissError(getErrorMessage(err));
    } finally {
      dismissingRef.current = false;
      setDismissing(false);
      if (refreshAfterDismissRef.current) {
        refreshAfterDismissRef.current = false;
        void load();
      }
    }
  };

  return (
    <div className="border-b border-border-light px-3 py-2 lg:px-6" aria-label={t('agent.status.title')} role="region">
      {/* 手机上单行横向滑动，避免状态条占掉三四行高度 */}
      <div className="flex items-center gap-1.5 overflow-x-auto [scrollbar-width:none] lg:flex-wrap lg:overflow-visible">
        {counts.map(item => (
          <span key={item.key} className={isWarn(item) ? CHIP_WARN : CHIP_OK} data-status={item.key}>
            {item.label}
            <span className="ml-1 font-semibold tabular-nums">{item.count}</span>
          </span>
        ))}
        {hasWarn && (
          <button
            type="button"
            onClick={() => void dismissAll()}
            disabled={dismissing}
            aria-busy={dismissing}
            title={t('agent.status.dismissHint')}
            className={`${CHIP} border-border-light text-text-secondary transition-colors hover:border-accent/40 hover:text-accent-dark`}
          >
            {t('agent.status.dismiss')}
          </button>
        )}
        {!status.agent.configured && (
          <span className={`${CHIP_WARN} min-w-0 max-w-full`} data-status="not-configured">
            <span className="truncate">{t('agent.status.notConfigured')}</span>
          </span>
        )}
      </div>
      {dismissError && (
        <p className="mt-1 text-xs text-danger [overflow-wrap:anywhere]" role="alert">
          {`${t('agent.status.dismissFailed')}: ${dismissError}`}
        </p>
      )}
    </div>
  );
}
