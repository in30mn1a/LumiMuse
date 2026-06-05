'use client';

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { Lang, t } from './i18n';
import { DEFAULT_SETTINGS } from '@/types';

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

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(DEFAULT_SETTINGS.language);

  useEffect(() => {
    fetch('/api/settings').then(r => r.json()).then(s => {
      if (s.language === 'zh' || s.language === 'en') setLangState(s.language);
    }).catch(() => {});
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
