'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { WORK_TYPES, type WorkEntry, type WorkType } from '@/types';
import type { WorkSources, WorkWithSources } from '@/app/api/works/works-route-helpers';
import { useTranslation } from '@/lib/i18n-context';
import { formatTemplate } from '@/lib/i18n';
import { getErrorMessage, HttpResponseError, parseJsonArrayResponse, parseJsonResponse } from '@/lib/http';
import { ChevronDownIcon, ListIcon, PencilIcon, PlusIcon, SearchIcon, SparkIcon, XIcon } from '@/components/ui/icons';
import ContentState from '@/components/ui/ContentState';
import WorksEntryEditor, { changedWorkFields, workStatusLabelKey, type WorkEditorValues } from './WorksEntryEditor';

interface Props {
  characterId: string;
  /** 只用于「让 Agent 从记忆整理」的草稿文案 */
  characterName: string;
}

interface ListState {
  characterId: string;
  /** null = 还没成功读到过 */
  works: WorkEntry[] | null;
  error: string;
  loading: boolean;
}

/**
 * 接口 409 带回的 code（work_exists：撞上未移除条目 / work_dismissed：撞上已移除条目）和撞上的条目名称，
 * 提示里点名是哪一条：撞上的往往是别名，光说「已经有了」主人找不到是哪条。
 */
function conflictOf(error: unknown): { code: string; title: string } | null {
  if (!(error instanceof HttpResponseError) || error.status !== 409) return null;
  const data = error.data as { code?: unknown; work?: { title?: unknown } | null } | null;
  const code = data?.code;
  const title = data?.work?.title;
  return typeof code === 'string' && typeof title === 'string' ? { code, title } : null;
}

/** 接口校验字段名 → 编辑器里的字段名称 */
const FIELD_LABEL_KEYS = new Map<string, string>([
  ['work_type', 'works.field.type'],
  ['title', 'works.field.title'],
  ['aliases', 'works.field.aliases'],
  ['status', 'works.field.status'],
  ['rating', 'works.field.rating'],
  ['progress', 'works.field.progress'],
  ['note', 'works.field.note'],
]);

/** 400 带回的 fieldErrors 里认得出的字段（按编辑器里的叫法）；没有可认的字段时返回空数组。 */
function invalidFieldLabelKeys(error: unknown): string[] {
  if (!(error instanceof HttpResponseError) || error.status !== 400) return [];
  const fieldErrors = (error.data as { fieldErrors?: unknown } | null)?.fieldErrors;
  if (!fieldErrors || typeof fieldErrors !== 'object') return [];
  return Object.keys(fieldErrors).flatMap(field => {
    const labelKey = FIELD_LABEL_KEYS.get(field);
    return labelKey ? [labelKey] : [];
  });
}

function worksUrl(characterId: string): string {
  return `/api/works?character_id=${encodeURIComponent(characterId)}&include_dismissed=1`;
}

function workUrl(id: string, characterId: string, query = ''): string {
  return `/api/works/${encodeURIComponent(id)}?character_id=${encodeURIComponent(characterId)}${query}`;
}

async function putWork(id: string, characterId: string, body: Record<string, unknown>): Promise<WorkEntry> {
  const response = await fetch(workUrl(id, characterId), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return parseJsonResponse<WorkEntry>(response);
}

type SourcesState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; sources: WorkSources };

/** 依据：展开时才请求，列出来源记忆正文和来源消息开头；都没有时写明「无依据」。 */
function WorkSourcesView({ workId, characterId }: { workId: string; characterId: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<SourcesState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(workUrl(workId, characterId, '&include_sources=1'), { signal: controller.signal });
        const data = await parseJsonResponse<WorkWithSources>(response);
        if (!controller.signal.aborted) setState({ status: 'ready', sources: data.sources });
      } catch (error) {
        if (!controller.signal.aborted) setState({ status: 'error', message: getErrorMessage(error) });
      }
    })();
    return () => controller.abort();
  }, [workId, characterId, attempt]);

  if (state.status === 'loading') {
    return <p role="status" aria-label={t('common.loading')} className="mt-1 text-xs text-text-muted">{t('common.loading')}</p>;
  }
  if (state.status === 'error') {
    return (
      <div role="alert" className="mt-1 flex flex-wrap items-center gap-2 text-xs text-danger">
        <span className="[overflow-wrap:anywhere]">{t('works.sourcesFailed')}: {state.message}</span>
        <button
          type="button"
          onClick={() => {
            setState({ status: 'loading' });
            setAttempt(value => value + 1);
          }}
          className="soft-button soft-button-secondary min-h-9 px-3 py-1 text-xs"
        >
          {t('common.retry')}
        </button>
      </div>
    );
  }

  const { memories, messages } = state.sources;
  if (memories.length === 0 && messages.length === 0) {
    return <p className="mt-1 text-xs text-text-muted">{t('works.noEvidence')}</p>;
  }
  return (
    <div className="mt-1 space-y-2 rounded-xl bg-surface-2 px-3 py-2 text-xs">
      {memories.length > 0 && (
        <div>
          <p className="mb-1 font-medium text-text-secondary">{t('works.sourceMemories')}</p>
          <ul className="space-y-1">
            {memories.map(memory => (
              <li key={memory.id} className="leading-relaxed text-text-primary [overflow-wrap:anywhere]">
                {memory.status !== 'active' && (
                  <span className="chip mr-1.5 min-h-0 px-2 py-0.5 text-[0.7rem]">{t(`memory.status.${memory.status}`)}</span>
                )}
                {memory.content}
              </li>
            ))}
          </ul>
        </div>
      )}
      {messages.length > 0 && (
        <div>
          <p className="mb-1 font-medium text-text-secondary">{t('works.sourceMessages')}</p>
          <ul className="space-y-1">
            {messages.map(message => (
              <li key={message.id} className="leading-relaxed text-text-primary [overflow-wrap:anywhere]">
                <span className="text-text-muted">
                  {message.role === 'user' ? t('works.roleUser') : message.role === 'assistant' ? t('works.roleAssistant') : t('works.roleSystem')}
                  {t('works.roleSeparator')}
                </span>
                {message.excerpt}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

interface RowProps {
  entry: WorkEntry;
  characterId: string;
  onEdit?: () => void;
  onRestore?: () => void;
  restoring?: boolean;
}

function WorkRow({ entry, characterId, onEdit, onRestore, restoring = false }: RowProps) {
  const { t } = useTranslation();
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const dismissed = entry.dismissed_at !== null;

  const summary = (
    <>
      <span className="flex flex-wrap items-center gap-2">
        <span className={`chip text-xs ${dismissed ? '' : 'chip-active'}`}>{t(workStatusLabelKey(entry.work_type, entry.status))}</span>
        <span className="min-w-0 text-sm font-medium text-text-primary [overflow-wrap:anywhere]">《{entry.title}》</span>
        {entry.rating && <span className="chip text-xs">{formatTemplate(t('works.rating'), { rating: entry.rating })}</span>}
        {entry.progress && (
          <span className="chip text-xs [overflow-wrap:anywhere]">{formatTemplate(t('works.progress'), { progress: entry.progress })}</span>
        )}
      </span>
      {entry.aliases.length > 0 && (
        <span className="mt-1 block text-xs text-text-muted [overflow-wrap:anywhere]">
          {formatTemplate(t('works.aliases'), { aliases: entry.aliases.join(' / ') })}
        </span>
      )}
      {entry.note && <span className="mt-1 block text-sm leading-relaxed text-text-secondary [overflow-wrap:anywhere]">{entry.note}</span>}
    </>
  );

  return (
    <li className="border-b border-border-light px-4 py-3 last:border-b-0">
      <div className="flex items-start gap-3">
        {dismissed ? (
          <div className="min-w-0 flex-1 opacity-75">{summary}</div>
        ) : (
          // 整行内容就是编辑入口；依据按钮放在外面，避免按钮套按钮
          // 名称只写作品名：不写的话整行文字（状态、评分、印象…）都会被读成按钮名
          <button
            type="button"
            onClick={onEdit}
            aria-label={formatTemplate(t('works.editTitle'), { title: entry.title })}
            className="group -m-1 flex min-w-0 flex-1 items-start gap-3 rounded-xl p-1 text-left transition-colors hover:bg-surface-2"
          >
            <span className="min-w-0 flex-1">{summary}</span>
            <PencilIcon className="mt-1.5 h-3.5 w-3.5 shrink-0 text-text-muted transition-colors group-hover:text-accent-dark" />
          </button>
        )}
        {dismissed && (
          <button
            type="button"
            onClick={onRestore}
            disabled={restoring}
            aria-label={formatTemplate(t('works.restoreTitle'), { title: entry.title })}
            className="soft-button soft-button-secondary h-11 min-h-11 shrink-0 px-3 py-0 text-xs disabled:cursor-not-allowed disabled:opacity-50"
          >
            {restoring ? t('works.restoring') : t('works.restore')}
          </button>
        )}
      </div>
      <button
        type="button"
        aria-expanded={sourcesOpen}
        aria-label={formatTemplate(t('works.sourcesTitle'), { title: entry.title })}
        onClick={() => setSourcesOpen(open => !open)}
        className="mt-1 inline-flex min-h-9 items-center gap-1 text-xs text-accent-dark/70 transition-colors hover:text-accent-dark"
      >
        {t('works.sources')}
        <ChevronDownIcon className={`h-3 w-3 transition-transform ${sourcesOpen ? 'rotate-180' : ''}`} />
      </button>
      {sourcesOpen && <WorkSourcesView workId={entry.id} characterId={characterId} />}
    </li>
  );
}

function parseSearchTerms(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

function matchesWorkTerms(entry: WorkEntry, terms: readonly string[], t: (key: string) => string): boolean {
  if (terms.length === 0) return true;
  const haystack = [
    `《${entry.title}》`,
    ...entry.aliases,
    entry.note,
    entry.progress,
    entry.rating,
    t(workStatusLabelKey(entry.work_type, entry.status)),
    t(`works.type.${entry.work_type}`),
  ].join('\n').toLowerCase();
  return terms.every(term => haystack.includes(term));
}

/** 记忆管理页的片单视图：按类型分组列出条目，可搜索、展开折叠、新增、编辑、移除、恢复，并能查看依据。 */
export default function WorksCatalogPanel({ characterId, characterName }: Props) {
  const { t } = useTranslation();
  const [list, setList] = useState<ListState>({ characterId, works: null, error: '', loading: true });
  const [reloadNonce, setReloadNonce] = useState(0);
  const [editor, setEditor] = useState<{ entry: WorkEntry | null; key: number } | null>(null);
  // 各大类默认折叠；有搜索词时命中的大类默认展开，仍允许用户在该搜索词下手动折起
  const [expandedTypes, setExpandedTypes] = useState<Partial<Record<WorkType, boolean>>>({});
  const [searchCollapsedTypes, setSearchCollapsedTypes] = useState<Partial<Record<WorkType, boolean>>>({});
  const [query, setQuery] = useState('');
  const [dismissedOpen, setDismissedOpen] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  // 带角色 id：切到别的角色后，上一个角色迟到的失败不显示在这里
  const [mutationError, setMutationError] = useState<{ characterId: string; message: string } | null>(null);

  if (list.characterId !== characterId) {
    setList({ characterId, works: null, error: '', loading: true });
    setEditor(null);
    setExpandedTypes({});
    setSearchCollapsedTypes({});
    setQuery('');
    setDismissedOpen(false);
  }

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const works = await parseJsonArrayResponse<WorkEntry>(await fetch(worksUrl(characterId), { signal: controller.signal }));
        if (!controller.signal.aborted) setList({ characterId, works, error: '', loading: false });
      } catch (error) {
        if (controller.signal.aborted) return;
        setList(prev => (prev.characterId === characterId ? { ...prev, error: getErrorMessage(error), loading: false } : prev));
      }
    })();
    return () => controller.abort();
  }, [characterId, reloadNonce]);

  const retry = () => {
    setList(prev => ({ ...prev, error: '', loading: true }));
    setReloadNonce(value => value + 1);
  };

  // 先就地替换，界面立刻反映修改；再重新拉一次，让分组内的顺序与服务端一致
  const applySaved = useCallback((saved: WorkEntry) => {
    setList(prev => {
      if (prev.characterId !== saved.character_id || !prev.works) return prev;
      const exists = prev.works.some(work => work.id === saved.id);
      return {
        ...prev,
        works: exists ? prev.works.map(work => (work.id === saved.id ? saved : work)) : [...prev.works, saved],
      };
    });
    setReloadNonce(value => value + 1);
  }, []);

  const ensureGroupOpen = useCallback((type: WorkType) => {
    setExpandedTypes(prev => (prev[type] ? prev : { ...prev, [type]: true }));
    setSearchCollapsedTypes(prev => (prev[type] ? { ...prev, [type]: false } : prev));
  }, []);

  const openEditor = (entry: WorkEntry | null) => {
    setMutationError(null);
    setEditor(prev => ({ entry, key: (prev?.key ?? 0) + 1 }));
  };

  const saveEntry = async (entry: WorkEntry | null, values: WorkEditorValues): Promise<string | null> => {
    try {
      let saved: WorkEntry;
      if (entry) {
        // 只发改过的字段（与打开弹窗时的条目比）：弹窗开着时自动更新或批准的提案写入的字段不被旧值覆盖
        saved = await putWork(entry.id, characterId, { ...changedWorkFields(entry, values) });
      } else {
        const response = await fetch('/api/works', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ character_id: characterId, ...values }),
        });
        saved = await parseJsonResponse<WorkEntry>(response);
      }
      applySaved(saved);
      if (saved.dismissed_at === null) ensureGroupOpen(saved.work_type);
      setEditor(null);
      return null;
    } catch (error) {
      const conflict = conflictOf(error);
      if (conflict?.code === 'work_exists') return formatTemplate(t('works.conflictExists'), { title: conflict.title });
      if (conflict?.code === 'work_dismissed') return formatTemplate(t('works.conflictDismissed'), { title: conflict.title });
      const invalidFields = invalidFieldLabelKeys(error);
      if (invalidFields.length > 0) {
        return formatTemplate(t('works.invalidFields'), {
          fields: invalidFields.map(key => t(key)).join(t('works.fieldSeparator')),
        });
      }
      return `${t('works.saveFailed')}: ${getErrorMessage(error)}`;
    }
  };

  const removeEntry = async (entry: WorkEntry): Promise<string | null> => {
    try {
      applySaved(await putWork(entry.id, characterId, { dismissed: true }));
      setEditor(null);
      return null;
    } catch (error) {
      return `${t('works.removeFailed')}: ${getErrorMessage(error)}`;
    }
  };

  const restoreEntry = async (entry: WorkEntry) => {
    if (restoringId) return;
    setRestoringId(entry.id);
    setMutationError(null);
    try {
      const saved = await putWork(entry.id, characterId, { dismissed: false });
      applySaved(saved);
      ensureGroupOpen(saved.work_type);
    } catch (error) {
      const conflict = conflictOf(error);
      setMutationError({
        characterId,
        message: conflict?.code === 'work_exists'
          ? formatTemplate(t('works.restoreConflict'), { title: conflict.title })
          : `${t('works.restoreFailed')}: ${getErrorMessage(error)}`,
      });
    } finally {
      setRestoringId(null);
    }
  };

  const works = list.works ?? [];
  const active = works.filter(work => work.dismissed_at === null);
  const dismissed = works.filter(work => work.dismissed_at !== null);
  const searchTerms = parseSearchTerms(query);
  const hasSearch = searchTerms.length > 0;
  const matchedActive = hasSearch ? active.filter(work => matchesWorkTerms(work, searchTerms, t)) : active;
  const matchedDismissed = hasSearch ? dismissed.filter(work => matchesWorkTerms(work, searchTerms, t)) : dismissed;
  const groups = WORK_TYPES
    .map(type => ({ type, entries: matchedActive.filter(work => work.work_type === type) }))
    .filter(group => group.entries.length > 0);
  const isGroupOpen = (type: WorkType) => (hasSearch ? !searchCollapsedTypes[type] : Boolean(expandedTypes[type]));
  const toggleGroup = (type: WorkType) => {
    if (hasSearch) {
      setSearchCollapsedTypes(prev => ({ ...prev, [type]: !prev[type] }));
    } else {
      setExpandedTypes(prev => ({ ...prev, [type]: !prev[type] }));
    }
  };
  const clearSearch = () => {
    setQuery('');
    setSearchCollapsedTypes({});
  };
  const agentDraft = formatTemplate(t('works.agentDraft'), { name: characterName, id: characterId });
  const visibleMutationError = mutationError?.characterId === characterId ? mutationError.message : '';
  const editingEntry = editor?.entry ?? null;

  const errorState = (
    <ContentState
      mode="error"
      title={t('works.loadFailed')}
      description={list.error}
      action={<button type="button" onClick={retry} className="soft-button soft-button-secondary">{t('common.retry')}</button>}
    />
  );

  return (
    <div className="space-y-4">
      <div className="surface-panel px-4 py-4 md:px-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0">
            <h2 className="text-sm font-medium text-text-primary">{t('works.title')}</h2>
            <p className="mt-1 text-xs leading-relaxed text-text-muted">{t('works.intro')}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {/* 只把草稿带到 Agent 输入框，不自动发送 */}
            <Link href={`/agent?draft=${encodeURIComponent(agentDraft)}`} className="soft-button soft-button-secondary">
              <SparkIcon className="h-4 w-4" />
              {t('works.agentOrganize')}
            </Link>
            <button type="button" onClick={() => openEditor(null)} className="soft-button soft-button-primary">
              <PlusIcon className="h-4 w-4" />
              {t('works.add')}
            </button>
          </div>
        </div>
        <div className="mt-3 flex min-h-10 items-center gap-2 rounded-full border border-transparent bg-surface-2 px-3.5 text-sm text-text-secondary transition-colors focus-within:border-accent/40">
          <SearchIcon className="h-3.5 w-3.5 shrink-0 text-text-muted" />
          <input
            type="text"
            value={query}
            onChange={event => {
              setQuery(event.target.value);
              setSearchCollapsedTypes({});
            }}
            onKeyDown={event => {
              if (event.key === 'Escape' && query) {
                event.preventDefault();
                clearSearch();
              }
            }}
            placeholder={t('works.searchPlaceholder')}
            aria-label={t('works.searchLabel')}
            className="w-full min-w-0 border-none bg-transparent py-1.5 text-sm text-text-primary outline-none placeholder:text-text-muted"
          />
          {query && (
            <button
              type="button"
              onClick={clearSearch}
              aria-label={t('works.clearSearch')}
              className="-mr-1.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-surface-3 hover:text-text-primary"
            >
              <XIcon className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {visibleMutationError && <p role="alert" className="mt-3 text-xs text-danger">{visibleMutationError}</p>}
      </div>

      <div className="surface-panel overflow-hidden" aria-busy={list.loading}>
        <div className="flex items-center justify-between border-b border-border-light px-4 py-3 text-xs text-text-muted">
          <span>{t('works.title')}</span>
          {list.works && (
            <span>
              {hasSearch
                ? formatTemplate(t('works.searchCount'), { matched: matchedActive.length, total: active.length })
                : formatTemplate(t('works.count'), { count: active.length })}
            </span>
          )}
        </div>

        {list.works === null ? (
          list.error ? errorState : <ContentState mode="loading" title={t('common.loading')} />
        ) : (
          <>
            {list.loading && (
              <p role="status" aria-label={t('common.loading')} className="px-4 py-3 text-sm text-text-muted">{t('common.loading')}</p>
            )}
            {list.error && errorState}
            {active.length === 0 ? (
              <ContentState
                mode="empty"
                title={t('works.empty')}
                description={t('works.emptyHint')}
                icon={<ListIcon className="h-5 w-5" />}
              />
            ) : groups.length === 0 ? (
              <ContentState
                mode="empty"
                title={t('works.searchEmpty')}
                description={t('works.searchEmptyHint')}
                icon={<SearchIcon className="h-5 w-5" />}
                action={(
                  <button type="button" onClick={clearSearch} className="soft-button soft-button-secondary">
                    {t('works.clearSearch')}
                  </button>
                )}
              />
            ) : groups.map(group => {
              const open = isGroupOpen(group.type);
              return (
                <section key={group.type} aria-label={t(`works.type.${group.type}`)} className="border-b border-border-light last:border-b-0">
                  <h3>
                    <button
                      type="button"
                      aria-expanded={open}
                      onClick={() => toggleGroup(group.type)}
                      className="flex min-h-11 w-full items-center justify-between gap-2 bg-surface-2/60 px-4 py-2.5 text-left text-xs font-medium text-text-secondary transition-colors hover:bg-surface-2"
                    >
                      <span>{t(`works.type.${group.type}`)} · {group.entries.length}</span>
                      <ChevronDownIcon className={`h-4 w-4 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
                    </button>
                  </h3>
                  {open && (
                    <ul className="border-t border-border-light">
                      {group.entries.map(entry => (
                        <WorkRow key={entry.id} entry={entry} characterId={characterId} onEdit={() => openEditor(entry)} />
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
          </>
        )}
      </div>

      {matchedDismissed.length > 0 && (
        <div className="surface-panel overflow-hidden">
          <button
            type="button"
            aria-expanded={dismissedOpen}
            onClick={() => setDismissedOpen(open => !open)}
            className="flex min-h-11 w-full items-center justify-between gap-2 px-4 py-3 text-left text-sm text-text-secondary transition-colors hover:bg-surface-2"
          >
            <span>{formatTemplate(t('works.dismissedSection'), { count: matchedDismissed.length })}</span>
            <ChevronDownIcon className={`h-4 w-4 shrink-0 transition-transform ${dismissedOpen ? 'rotate-180' : ''}`} />
          </button>
          {dismissedOpen && (
            <div className="border-t border-border-light">
              <p className="px-4 pt-3 text-xs leading-relaxed text-text-muted">{t('works.dismissedHint')}</p>
              <ul>
                {matchedDismissed.map(entry => (
                  <WorkRow
                    key={entry.id}
                    entry={entry}
                    characterId={characterId}
                    onRestore={() => void restoreEntry(entry)}
                    restoring={restoringId === entry.id}
                  />
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {editor && (
        <WorksEntryEditor
          key={editor.key}
          entry={editingEntry}
          onClose={() => setEditor(null)}
          onSave={values => saveEntry(editingEntry, values)}
          onRemove={editingEntry ? () => removeEntry(editingEntry) : undefined}
        />
      )}
    </div>
  );
}
