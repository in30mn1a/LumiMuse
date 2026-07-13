'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getErrorMessage, parseJsonResponse } from '@/lib/http';

export interface MessageSearchResult {
  messageId: string;
  snippet: string;
  role: string;
  createdAt: string;
  conversationId: string;
  conversationTitle: string;
  characterId: string;
  characterName: string;
  avatarUrl: string | null;
}

interface UseMessageSearchOptions {
  limit?: number;
  debounceMs?: number;
}

interface MessageSearchResponse {
  results: MessageSearchResult[];
  hasMore: boolean;
}

const isAbortError = (error: unknown) =>
  (error instanceof DOMException || error instanceof Error) && error.name === 'AbortError';

function parseSearchPayload(data: unknown): MessageSearchResponse {
  if (Array.isArray(data)) {
    return { results: data as MessageSearchResult[], hasMore: false };
  }
  if (
    data
    && typeof data === 'object'
    && Array.isArray((data as MessageSearchResponse).results)
  ) {
    const payload = data as MessageSearchResponse;
    return {
      results: payload.results,
      hasMore: Boolean(payload.hasMore),
    };
  }
  throw new Error('Invalid search response');
}

export function useMessageSearch(query: string, options: UseMessageSearchOptions = {}) {
  const { limit = 15, debounceMs = 220 } = options;
  const [results, setResults] = useState<MessageSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const resultsRef = useRef<MessageSearchResult[]>([]);

  const runSearch = useCallback(async (trimmed: string, reset: boolean) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    if (reset) {
      setLoading(true);
      setLoadingMore(false);
      setError(null);
    } else {
      // loadMore 重试时先清旧错误，避免 loading 期间错误条残留
      setLoadingMore(true);
      setError(null);
    }

    try {
      const params = new URLSearchParams({
        q: trimmed,
        limit: String(limit),
        offset: String(reset ? 0 : resultsRef.current.length),
      });
      const response = await fetch(`/api/messages/search?${params}`, { signal: controller.signal });
      const data = await parseJsonResponse<unknown>(response);
      const { results: nextResults, hasMore: nextHasMore } = parseSearchPayload(data);
      if (!controller.signal.aborted) {
        setResults(prev => {
          const merged = reset ? nextResults : [...prev, ...nextResults];
          resultsRef.current = merged;
          return merged;
        });
        setHasMore(nextHasMore);
        setError(null);
      }
    } catch (err) {
      if (isAbortError(err)) return;
      if (!controller.signal.aborted) {
        if (reset) {
          resultsRef.current = [];
          setResults([]);
          setHasMore(false);
        }
        setError(getErrorMessage(err));
      }
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
        setLoadingMore(false);
        abortRef.current = null;
      }
    }
  }, [limit]);

  const clearSearch = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    resultsRef.current = [];
    setResults([]);
    setLoading(false);
    setLoadingMore(false);
    setHasMore(false);
    setError(null);
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      abortRef.current?.abort();
      abortRef.current = null;
      resultsRef.current = [];
      const timer = setTimeout(() => {
        setResults([]);
        setLoading(false);
        setLoadingMore(false);
        setHasMore(false);
        setError(null);
      }, 0);
      return () => clearTimeout(timer);
    }

    resultsRef.current = [];

    const timer = setTimeout(() => {
      setHasMore(false);
      void runSearch(trimmed, true);
    }, debounceMs);

    return () => {
      clearTimeout(timer);
    };
  }, [clearSearch, debounceMs, query, runSearch]);

  const loadMore = useCallback(() => {
    const trimmed = query.trim();
    if (!trimmed || loading || loadingMore || !hasMore) return;
    void runSearch(trimmed, false);
  }, [hasMore, loading, loadingMore, query, runSearch]);

  useEffect(() => () => abortRef.current?.abort(), []);

  return { results, loading, loadingMore, hasMore, error, loadMore, clearSearch };
}
