'use client';

import type { AgentSession } from '@/lib/agent/store';
import { useTranslation } from '@/lib/i18n-context';
import { PlusIcon, TrashIcon } from '@/components/ui/icons';

interface Props {
  sessions: AgentSession[];
  activeId: string | null;
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (session: AgentSession) => void;
  onLoadMore: () => void;
  onRetry: () => void;
}

function formatUpdatedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString([], { month: 'numeric', day: 'numeric' });
}

/** 会话列表：桌面是左栏，手机放在抽屉里。 */
export default function AgentSessionList({
  sessions,
  activeId,
  loading,
  error,
  hasMore,
  loadingMore,
  onSelect,
  onNew,
  onDelete,
  onLoadMore,
  onRetry,
}: Props) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="p-3">
        <button
          type="button"
          onClick={onNew}
          className="flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-accent/30 px-3 text-sm font-medium text-accent-dark transition-colors hover:bg-accent/10"
        >
          <PlusIcon className="h-4 w-4" />
          {t('agent.newSession')}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3">
        {loading && <p className="px-3 py-2 text-xs text-text-muted">{t('common.loading')}</p>}
        {!loading && error && (
          <div className="px-3 py-2 text-xs text-danger" role="alert">
            <p className="[overflow-wrap:anywhere]">{`${t('common.loadFailed')}: ${error}`}</p>
            <button type="button" onClick={onRetry} className="mt-1 font-medium text-accent-dark underline">{t('common.retry')}</button>
          </div>
        )}
        {!loading && !error && sessions.length === 0 && (
          <p className="px-3 py-2 text-xs text-text-muted">{t('agent.sessionsEmpty')}</p>
        )}
        <ul className="grid grid-cols-1 gap-0.5">
          {sessions.map(session => {
            const active = session.id === activeId;
            return (
              <li key={session.id} className="group relative">
                <button
                  type="button"
                  onClick={() => onSelect(session.id)}
                  aria-current={active ? 'true' : undefined}
                  className={`flex min-h-11 w-full min-w-0 flex-col justify-center rounded-xl py-1.5 pl-3 pr-11 text-left transition-colors ${
                    active ? 'bg-accent/10 text-text-primary' : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary'
                  }`}
                >
                  <span className="block w-full truncate text-sm">{session.title || t('agent.untitled')}</span>
                  <span className="block text-[0.7rem] text-text-muted">{formatUpdatedAt(session.updated_at)}</span>
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(session)}
                  className="absolute right-1 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-surface-3 hover:text-danger lg:opacity-0 lg:focus-visible:opacity-100 lg:group-hover:opacity-100"
                  aria-label={`${t('agent.deleteSession')}: ${session.title || t('agent.untitled')}`}
                >
                  <TrashIcon className="h-4 w-4" />
                </button>
              </li>
            );
          })}
        </ul>
        {hasMore && (
          <button
            type="button"
            onClick={onLoadMore}
            disabled={loadingMore}
            className="mt-1 w-full rounded-xl px-3 py-2 text-center text-xs font-medium text-accent-dark hover:bg-accent/5 disabled:text-text-muted"
          >
            {loadingMore ? t('common.loading') : t('agent.loadMore')}
          </button>
        )}
      </div>
    </div>
  );
}
