'use client';

import { useCallback, useEffect, useState } from 'react';
import type { AgentSession } from '@/lib/agent/store';
import { expectOkResponse, getErrorMessage, parseJsonResponse } from '@/lib/http';

const PAGE_SIZE = 50;

interface SessionPage {
  sessions: AgentSession[];
  has_more: boolean;
}

/** Agent 会话列表：按最近更新排序，分页加载，新建和删除。 */
export function useAgentSessions() {
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const page = await parseJsonResponse<SessionPage>(await fetch(`/api/agent/sessions?limit=${PAGE_SIZE}`));
      setSessions(page.sessions);
      setHasMore(page.has_more);
      setError(null);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    try {
      const page = await parseJsonResponse<SessionPage>(
        await fetch(`/api/agent/sessions?limit=${PAGE_SIZE}&offset=${sessions.length}`),
      );
      setSessions(prev => {
        const seen = new Set(prev.map(session => session.id));
        return [...prev, ...page.sessions.filter(session => !seen.has(session.id))];
      });
      setHasMore(page.has_more);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoadingMore(false);
    }
  }, [sessions.length]);

  /** 新建会话；带 `conversation_id` 时服务端会同时关联该对话的角色。 */
  const create = useCallback(async (input: { conversation_id?: string } = {}) => {
    const session = await parseJsonResponse<AgentSession>(await fetch('/api/agent/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }));
    setSessions(prev => [session, ...prev.filter(item => item.id !== session.id)]);
    return session;
  }, []);

  const remove = useCallback(async (id: string) => {
    await expectOkResponse(await fetch(`/api/agent/sessions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
    }));
    setSessions(prev => prev.filter(session => session.id !== id));
  }, []);

  useEffect(() => {
    // 状态写入都在请求返回之后
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  return { sessions, hasMore, loading, loadingMore, error, refresh, loadMore, create, remove };
}
