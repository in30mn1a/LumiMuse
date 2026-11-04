'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { AgentDocument, AgentDocumentKey, AgentDocumentVersion } from '@/lib/agent/documents';
import { useTranslation } from '@/lib/i18n-context';
import { formatTemplate } from '@/lib/i18n';
import { getErrorMessage, parseJsonResponse } from '@/lib/http';
import { useToast } from '@/components/ui/Toast';

interface DocumentPage {
  document: AgentDocument;
  versions: AgentDocumentVersion[];
  has_more: boolean;
}

export interface AgentDocumentState {
  document: AgentDocument | null;
  draft: string | undefined;
  versions: AgentDocumentVersion[];
  hasMore: boolean;
}

interface Props {
  docKey: AgentDocumentKey;
  /** 已保存内容与草稿一起由抽屉保管，卸载期间完成的保存仍能同步。 */
  state: AgentDocumentState;
  onStateChange: Dispatch<SetStateAction<AgentDocumentState>>;
  /** 与草稿一起由抽屉持有，保存和恢复共用同一把同步锁。 */
  pendingWrite: 'save' | number | null;
  onWriteStart: (operation: 'save' | number) => boolean;
  onWriteEnd: () => void;
}

function documentUrl(key: AgentDocumentKey, versionsOffset = 0): string {
  const base = `/api/agent/documents/${key}`;
  return versionsOffset > 0 ? `${base}?versions_offset=${versionsOffset}` : base;
}

function formatVersionTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
}

/** `Agents.md` / `memory.md` 编辑器。每次保存都留一个版本，旧版本可以恢复（恢复也算一次新保存）。 */
export default function AgentDocumentEditor({ docKey, state, onStateChange, pendingWrite, onWriteStart, onWriteEnd }: Props) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { document: doc, draft, versions, hasMore } = state;
  const stateRef = useRef(state);
  useLayoutEffect(() => { stateRef.current = state; }, [state]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async (documentAtLoad = stateRef.current.document) => {
    setLoadError(null);
    try {
      const page = await parseJsonResponse<DocumentPage>(await fetch(documentUrl(docKey)));
      // 读取期间若已保存或刷新过文档，不让迟到的旧页面覆盖较新的基准和版本列表。
      onStateChange(current => current.document !== documentAtLoad ? current : {
        ...current,
        document: page.document,
        versions: page.versions,
        hasMore: page.has_more,
      });
    } catch (error) {
      setLoadError(getErrorMessage(error));
    }
  }, [docKey, onStateChange]);

  useEffect(() => {
    // 状态写入都在请求返回之后
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  if (loadError && !doc) {
    return (
      <div className="px-5 py-6 text-sm text-danger" role="alert">
        <p className="[overflow-wrap:anywhere]">{`${t('common.loadFailed')}: ${loadError}`}</p>
        <button type="button" onClick={() => void load()} className="mt-2 font-medium text-accent-dark underline">
          {t('common.retry')}
        </button>
      </div>
    );
  }
  if (!doc) {
    return <p className="px-5 py-6 text-sm text-text-muted" aria-busy="true">{t('common.loading')}</p>;
  }

  const text = draft ?? doc.content;
  const dirty = draft !== undefined && draft !== doc.content;
  const hint = docKey === 'agents' ? t('agent.settings.agentsHint') : t('agent.settings.memoryHint');
  const label = docKey === 'agents' ? 'Agents.md' : 'memory.md';

  const write = async (body: { content: string } | { restore_version_id: number }, successKey: string) => {
    const response = await fetch(documentUrl(docKey), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(docKey === 'memory' ? { ...body, expected_content: doc.content } : body),
    });
    const result = await parseJsonResponse<{ document: AgentDocument }>(response);
    // 同时更新已保存基准与草稿，旧实例完成保存后，重开的编辑器也能显示正确内容。
    onStateChange(current => ({
      ...current,
      document: result.document,
      draft: current.draft === draft || current.draft === result.document.content ? undefined : current.draft,
    }));
    showToast(t(successKey), 'success');
    // 版本列表重新从第一页读，新版本排在最前面
    await load(result.document);
  };

  const save = async () => {
    if (!dirty || !onWriteStart('save')) return;
    try {
      await write({ content: text }, 'agent.settings.saved');
    } catch (error) {
      showToast(`${t('common.operationFailed')}: ${getErrorMessage(error)}`, 'error');
    } finally {
      onWriteEnd();
    }
  };

  const restore = async (version: AgentDocumentVersion) => {
    if (!onWriteStart(version.id)) return;
    try {
      await write({ restore_version_id: version.id }, 'agent.settings.restored');
    } catch (error) {
      showToast(`${t('common.operationFailed')}: ${getErrorMessage(error)}`, 'error');
    } finally {
      onWriteEnd();
    }
  };

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const page = await parseJsonResponse<DocumentPage>(await fetch(documentUrl(docKey, versions.length)));
      onStateChange(current => {
        if (current.document !== doc) return current;
        const seen = new Set(current.versions.map(version => version.id));
        return {
          ...current,
          versions: [...current.versions, ...page.versions.filter(version => !seen.has(version.id))],
          hasMore: page.has_more,
        };
      });
    } catch (error) {
      showToast(`${t('common.loadFailed')}: ${getErrorMessage(error)}`, 'error');
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="space-y-5 px-5 py-5">
      <div>
        <label htmlFor={`agent-doc-${docKey}`} className="mb-1.5 block font-mono text-sm font-medium text-text-secondary">
          {label}
        </label>
        <p className="mb-2 text-xs leading-relaxed text-text-muted">{hint}</p>
        <textarea
          id={`agent-doc-${docKey}`}
          value={text}
          onChange={event => {
            const content = event.target.value;
            onStateChange(current => ({ ...current, draft: content }));
          }}
          rows={12}
          spellCheck={false}
          className="textarea-rich min-h-48 w-full resize-y font-mono text-sm leading-relaxed"
        />
        <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
          {dirty && (
            <button
              type="button"
              onClick={() => onStateChange(current => ({ ...current, draft: undefined }))}
              disabled={pendingWrite !== null}
              className="soft-button soft-button-ghost min-h-10 px-4 disabled:opacity-50"
            >
              {t('agent.settings.discard')}
            </button>
          )}
          <button
            type="button"
            onClick={() => void save()}
            disabled={!dirty || pendingWrite !== null}
            className="soft-button soft-button-primary min-h-10 px-5 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pendingWrite === 'save' ? t('common.loading') : t('common.save')}
          </button>
        </div>
      </div>

      <section aria-labelledby={`agent-doc-${docKey}-versions`}>
        <h3 id={`agent-doc-${docKey}-versions`} className="mb-2 text-sm font-medium text-text-secondary">
          {t('agent.settings.versions')}
        </h3>
        {dirty && versions.length > 0 && (
          <p className="mb-2 text-xs text-text-muted">{t('agent.settings.restoreBlocked')}</p>
        )}
        {versions.length === 0 ? (
          <p className="text-xs text-text-muted">{t('agent.settings.versionsEmpty')}</p>
        ) : (
          <ul className="grid grid-cols-1 gap-2">
            {versions.map(version => {
              const current = version.content === doc.content;
              return (
                <li key={version.id}>
                  <details className="group rounded-xl border border-border-light bg-surface-2/40" data-agent-version={version.id}>
                    <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs [&::-webkit-details-marker]:hidden">
                      <span className="shrink-0 tabular-nums text-text-secondary">{formatVersionTime(version.created_at)}</span>
                      <span className="shrink-0 rounded-full bg-surface-3 px-2 py-0.5 text-text-muted">
                        {version.source === 'agent' ? 'Agent' : t('agent.settings.sourceUser')}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-text-muted">
                        {formatTemplate(t('agent.settings.chars'), { count: version.content.length })}
                      </span>
                      {current && <span className="shrink-0 font-medium text-accent-dark">{t('agent.settings.current')}</span>}
                    </summary>
                    <div className="border-t border-border-light px-3 py-2">
                      <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-xs leading-relaxed text-text-primary [overflow-wrap:anywhere]">
                        {version.content || ' '}
                      </pre>
                      {!current && (
                        <div className="mt-2 flex justify-end">
                          <button
                            type="button"
                            onClick={() => void restore(version)}
                            disabled={dirty || pendingWrite !== null}
                            className="soft-button soft-button-secondary min-h-9 px-3 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {pendingWrite === version.id ? t('common.loading') : t('agent.settings.restore')}
                          </button>
                        </div>
                      )}
                    </div>
                  </details>
                </li>
              );
            })}
          </ul>
        )}
        {hasMore && (
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="mt-2 w-full rounded-xl px-3 py-2 text-center text-xs font-medium text-accent-dark hover:bg-accent/5 disabled:text-text-muted"
          >
            {loadingMore ? t('common.loading') : t('agent.loadMore')}
          </button>
        )}
      </section>
    </div>
  );
}
