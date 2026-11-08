'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ProposalView } from '@/lib/agent/proposals';
import { getErrorMessage, parseJsonResponse } from '@/lib/http';
import { useTranslation } from '@/lib/i18n-context';
import ContentState from '@/components/ui/ContentState';
import ProposalCard from './ProposalCard';

const PAGE_SIZE = 20;

interface CharacterOption {
  id: string;
  name: string;
}

interface HistoryPage {
  proposals: ProposalView[];
  has_more: boolean;
}

interface LoadedHistory {
  characterId: string;
  proposals: ProposalView[];
  hasMore: boolean;
}

interface Props {
  /** 当前会话关联的角色，默认选中它 */
  defaultCharacterId: string | null;
}

/** 修改历史：列出全部提案或按角色筛选，新的在前。已生效的项在这里也能撤销，包括已删除会话产生的。 */
export default function AgentProposalHistory({ defaultCharacterId }: Props) {
  const { t } = useTranslation();
  const [characters, setCharacters] = useState<CharacterOption[] | null>(null);
  const [charactersError, setCharactersError] = useState<string | null>(null);
  const [characterId, setCharacterId] = useState<string | null>(null);
  const [history, setHistory] = useState<LoadedHistory | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // 切换角色后，旧角色迟到的响应不再写入
  const requestRef = useRef(0);

  const loadCharacters = useCallback(async () => {
    setCharactersError(null);
    try {
      const list = await parseJsonResponse<CharacterOption[]>(await fetch('/api/characters'));
      setCharacters(list.map(({ id, name }) => ({ id, name })));
      setCharacterId(current => {
        if (current !== null && (current === '' || list.some(character => character.id === current))) return current;
        if (defaultCharacterId && list.some(character => character.id === defaultCharacterId)) return defaultCharacterId;
        return '';
      });
    } catch (error) {
      setCharactersError(getErrorMessage(error));
    }
  }, [defaultCharacterId]);

  const loadHistory = useCallback(async (id: string, offset: number) => {
    const request = ++requestRef.current;
    setHistoryError(null);
    setLoadingMore(offset > 0);
    try {
      const params = new URLSearchParams();
      if (id) params.set('character_id', id);
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(offset));
      const page = await parseJsonResponse<HistoryPage>(await fetch(`/api/agent/proposals?${params}`));
      if (request !== requestRef.current) return;
      setHistory(current => {
        if (offset === 0 || current?.characterId !== id) return { characterId: id, proposals: page.proposals, hasMore: page.has_more };
        // 翻页期间有新提案时偏移会错开一位，按 ID 去重
        const seen = new Set(current.proposals.map(proposal => proposal.id));
        return {
          characterId: id,
          proposals: [...current.proposals, ...page.proposals.filter(proposal => !seen.has(proposal.id))],
          hasMore: page.has_more,
        };
      });
    } catch (error) {
      if (request === requestRef.current) setHistoryError(getErrorMessage(error));
    } finally {
      if (request === requestRef.current) setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    // 状态写入都在请求返回之后
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadCharacters();
  }, [loadCharacters]);

  useEffect(() => {
    // 同步写入的只有清掉上一次的错误和翻页状态，列表在请求返回后才更新
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (characterId !== null) void loadHistory(characterId, 0);
  }, [characterId, loadHistory]);

  if (charactersError) {
    return (
      <ContentState
        mode="error"
        title={t('agent.history.loadFailed')}
        description={charactersError}
        action={<button type="button" onClick={() => void loadCharacters()} className="soft-button soft-button-secondary px-4 py-2">{t('common.retry')}</button>}
      />
    );
  }
  if (!characters) return <ContentState mode="loading" title={t('common.loading')} />;
  if (characterId === null) return <ContentState mode="loading" title={t('common.loading')} />;

  const current = history?.characterId === characterId ? history : null;
  let list: ReactNode;
  if (!current) {
    list = historyError
      ? (
        <ContentState
          mode="error"
          title={t('agent.history.loadFailed')}
          description={historyError}
          action={<button type="button" onClick={() => void loadHistory(characterId, 0)} className="soft-button soft-button-secondary px-4 py-2">{t('common.retry')}</button>}
        />
      )
      : <ContentState mode="loading" title={t('common.loading')} />;
  } else if (current.proposals.length === 0) {
    list = <ContentState mode="empty" title={t(characterId ? 'agent.history.empty' : 'agent.history.emptyAll')} />;
  } else {
    list = (
      <div className="space-y-3">
        {current.proposals.map(proposal => (
          <ProposalCard key={proposal.id} proposalId={proposal.id} initialView={proposal} decidable={false} />
        ))}
        {historyError && <p className="text-xs text-danger [overflow-wrap:anywhere]" role="alert">{historyError}</p>}
        {current.hasMore && (
          <button
            type="button"
            onClick={() => void loadHistory(characterId, current.proposals.length)}
            disabled={loadingMore}
            className="soft-button soft-button-secondary min-h-10 w-full px-4 text-sm"
          >
            {loadingMore ? t('common.loading') : t('agent.history.loadMore')}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4 px-5 py-5">
      <div>
        <label htmlFor="agent-history-character" className="mb-1.5 block text-sm font-medium text-text-secondary">
          {t('agent.history.character')}
        </label>
        <select
          id="agent-history-character"
          value={characterId}
          onChange={event => setCharacterId(event.target.value)}
          className="select-rich w-full"
        >
          <option value="">{t('agent.history.allCharacters')}</option>
          {characters.map(character => <option key={character.id} value={character.id}>{character.name}</option>)}
        </select>
        <p className="mt-2 text-xs leading-relaxed text-text-muted">{t('agent.history.hint')}</p>
      </div>
      {list}
    </div>
  );
}
