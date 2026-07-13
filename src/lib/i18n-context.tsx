'use client';

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { Lang, t } from './i18n';
import { DEFAULT_SETTINGS } from '@/types';
import { notifySettingsBootstrapFailed } from '@/lib/settings-bootstrap-events';

interface I18nContextValue {
  lang: Lang;
  t: (key: string) => string;
  setLang: (lang: Lang) => void;
}

const I18nContext = createContext<I18nContextValue>({
  lang: DEFAULT_SETTINGS.language,
  t: (key: string) => key,
  setLang: () => {},
});

const SETTINGS_BOOTSTRAP_MAX_ATTEMPTS = 2;

async function fetchLanguageSetting(signal?: AbortSignal): Promise<Lang | null> {
  const response = await fetch('/api/settings', { signal });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const settings = await response.json() as { language?: unknown };
  if (settings.language === 'zh' || settings.language === 'en') {
    return settings.language;
  }
  return null;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(DEFAULT_SETTINGS.language);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    void (async () => {
      let lastError: unknown;
      for (let attempt = 1; attempt <= SETTINGS_BOOTSTRAP_MAX_ATTEMPTS; attempt += 1) {
        if (cancelled) return;
        try {
          const language = await fetchLanguageSetting(controller.signal);
          if (cancelled) return;
          if (language) setLangState(language);
          return;
        } catch (error) {
          if (controller.signal.aborted || cancelled) return;
          lastError = error;
          if (attempt < SETTINGS_BOOTSTRAP_MAX_ATTEMPTS) continue;
        }
      }
      console.warn('[i18n] failed to load language from /api/settings; using default', lastError);
      notifySettingsBootstrapFailed('i18n');
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  const setLang = useCallback((newLang: Lang) => {
    setLangState(newLang);
  }, []);

  const translate = useCallback((key: string) => t(key, lang), [lang]);

  return (
    <I18nContext.Provider value={{ lang, t: translate, setLang }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useTranslation() {
  return useContext(I18nContext);
}
