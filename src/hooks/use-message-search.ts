'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

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

export function useMessageSearch(query: string, options: UseMessageSearchOptions = {}) {
  const { limit = 15, debounceMs = 220 } = options;
  const [results, setResults] = useState<MessageSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const resultsRef = useRef<MessageSearchResult[]>([]);

  const runSearch = useCallback(async (trimmed: string, reset: boolean) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    if (reset) {
      setLoading(true);
      setLoadingMore(false);
    } else {
      setLoadingMore(true);
    }

    try {
      const params = new URLSearchParams({
        q: trimmed,
        limit: String(limit),
        offset: String(reset ? 0 : resultsRef.current.length),
      });
      const response = await fetch(`/api/messages/search?${params}`, { signal: controller.signal });
      const data = await response.json() as MessageSearchResponse | MessageSearchResult[];
      const nextResults = Array.isArray(data) ? data : data.results;
      const nextHasMore = Array.isArray(data) ? false : data.hasMore;
      if (!controller.signal.aborted) {
        setResults(prev => {
          const merged = reset ? nextResults : [...prev, ...nextResults];
          resultsRef.current = merged;
          return merged;
        });
        setHasMore(nextHasMore);
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        if (reset) {
          resultsRef.current = [];
          setResults([]);
          setHasMore(false);
        }
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

  return { results, loading, loadingMore, hasMore, loadMore, clearSearch };
}
