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
type Dismissed = Partial<Record<CountKey, number>>;

/** 已读忽略只是本机显示偏好，存浏览器即可；读写失败（隐私模式等）时退化为不忽略 */
const DISMISSED_STORAGE_KEY = 'lumimuse.agentStatusDismissed';

function readDismissed(): Dismissed {
  try {
    const raw = typeof window === 'undefined' ? null : window.localStorage.getItem(DISMISSED_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Dismissed) : {};
  } catch {
    return {};
  }
}

function writeDismissed(value: Dismissed) {
  try {
    window.localStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // 存不进去只影响刷新后是否还记得，不影响本次显示
  }
}

function countsOf(status: AgentStatus): Record<CountKey, number> {
  return {
    extraction: status.failed_tasks.extraction,
    profile: status.failed_tasks.profile,
    embedding: status.failed_tasks.embedding,
    repairable: status.repairable_candidates,
    errors: status.recent_errors,
  };
}

/**
 * 计数回落时同步压低已忽略的基线：否则从 7 降到 0 再涨到 3 时，
 * 新出现的 3 条会被旧基线 7 吞掉。
 */
function lowerDismissed(dismissed: Dismissed, counts: Record<CountKey, number>): Dismissed {
  const next: Dismissed = {};
  for (const key of Object.keys(counts) as CountKey[]) {
    const value = Math.min(dismissed[key] ?? 0, counts[key]);
    if (value > 0) next[key] = value;
  }
  return next;
}

/** 顶部状态条：只读数据库，不调用模型，上游故障时也能显示。 */
export default function AgentStatusBar({ refreshKey }: Props) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Dismissed>(readDismissed);

  const load = useCallback(async () => {
    try {
      const next = await parseJsonResponse<AgentStatus>(await fetch('/api/agent/status'));
      setStatus(next);
      setError(null);
      setDismissed(previous => {
        const lowered = lowerDismissed(previous, countsOf(next));
        if (JSON.stringify(lowered) !== JSON.stringify(previous)) writeDismissed(lowered);
        return lowered;
      });
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

  // 只有超出已忽略基线的部分才标红；数字照常显示
  const isWarn = (item: { key: CountKey; count: number }) => item.count > (dismissed[item.key] ?? 0);
  const hasWarn = counts.some(isWarn);
  const dismissAll = () => {
    const next = lowerDismissed(countsOf(status), countsOf(status));
    setDismissed(next);
    writeDismissed(next);
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
            onClick={dismissAll}
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
    </div>
  );
}
