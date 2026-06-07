import type { ReactNode } from 'react';
import type { ApiProvider, MemoryEngineSettings, Settings } from '@/types';

type MemoryModePreset = 'local' | 'balanced' | 'continuity';

type SettingsWithMemoryEngine = Settings & {
  memory_engine: MemoryEngineSettings;
};

interface MemoryEngineSectionProps {
  settings: SettingsWithMemoryEngine;
  providers: ApiProvider[];
  bgModelList: string[];
  bgModelLoading: boolean;
  bgModelError: string | null;
  embeddingModelList: string[];
  embeddingModelLoading: boolean;
  embeddingModelError: string | null;
  rerankerModelList: string[];
  rerankerModelLoading: boolean;
  rerankerModelError: string | null;
  memoryModePreset: MemoryModePreset;
  update: <K extends keyof SettingsWithMemoryEngine>(key: K, value: SettingsWithMemoryEngine[K]) => void;
  updateMemoryEngine: <K extends keyof MemoryEngineSettings>(key: K, value: MemoryEngineSettings[K]) => void;
  onMemoryModeChange: (mode: MemoryModePreset) => void;
  onFetchBgModels: () => void;
  onFetchEmbeddingModels: () => void;
  onFetchRerankerModels: () => void;
  onClearBgModelList: () => void;
  onClearEmbeddingModelList: () => void;
  onClearRerankerModelList: () => void;
  parseNumber: (value: string) => number;
  t: (key: string) => string;
  children: ReactNode;
}

export function MemoryEngineSection({
  settings,
  providers,
  bgModelList,
  bgModelLoading,
  bgModelError,
  embeddingModelList,
  embeddingModelLoading,
  embeddingModelError,
  rerankerModelList,
  rerankerModelLoading,
  rerankerModelError,
  memoryModePreset,
  update,
  updateMemoryEngine,
  onMemoryModeChange,
  onFetchBgModels,
  onFetchEmbeddingModels,
  onFetchRerankerModels,
  onClearBgModelList,
  onClearEmbeddingModelList,
  onClearRerankerModelList,
  parseNumber,
  t,
  children,
}: MemoryEngineSectionProps) {
  const memoryEngineEnabled = settings.memory_engine.enabled;

  return (
    <section className="surface-panel p-5">
      <div className="mb-4">
        <h2 className="section-title text-lg">{t('settings.memoryEngine')}</h2>
      </div>

      <div className="space-y-3">
        <label className="flex items-center gap-3 rounded-2xl border border-border-light bg-white/70 px-4 py-3 text-sm text-text-secondary">
          <input
            type="checkbox"
            checked={settings.memory_engine.enabled}
            onChange={e => updateMemoryEngine('enabled', e.target.checked)}
          />
          {t('settings.memoryEngineEnabled')}
        </label>

        {!memoryEngineEnabled && (
          <p className="rounded-2xl border border-border-light bg-white/70 px-4 py-3 text-xs leading-relaxed text-text-muted">
            {t('settings.memoryEngineDisabledHint')}
          </p>
        )}

        {memoryEngineEnabled && (
          <div className="rounded-2xl border border-border-light bg-white/70 px-4 py-4">
            <label className="mb-2 block text-sm font-medium text-text-secondary">{t('settings.memoryRetrievalMode')}</label>
            <select
              value={memoryModePreset}
              onChange={e => onMemoryModeChange(e.target.value as MemoryModePreset)}
              className="select-rich"
            >
              <option value="local">{t('settings.memoryRetrievalModeLocal')}</option>
              <option value="balanced">{t('settings.memoryRetrievalModeBalanced')}</option>
              <option value="continuity">{t('settings.memoryRetrievalModeContinuity')}</option>
            </select>
          </div>
        )}

        <div className="space-y-4 rounded-2xl border border-border-light bg-white/70 px-4 py-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.memoryBackgroundProvider')}</label>
            <select
              value={settings.memory_background_provider_id}
              onChange={e => {
                update('memory_background_provider_id', e.target.value);
                onClearBgModelList();
                const provider = providers.find(p => p.id === e.target.value);
                if (provider) {
                  update('memory_background_model', provider.model);
                } else {
                  update('memory_background_model', '');
                }
              }}
              className="select-rich"
            >
              <option value="">{t('settings.memoryBackgroundProviderNone')}</option>
              {providers.map(p => (
                <option key={p.id} value={p.id}>{p.name} ({p.model || t('settings.modelPlaceholder')})</option>
              ))}
            </select>
            <p className="mt-1.5 text-xs leading-relaxed text-text-muted">{t('settings.memoryBackgroundProviderHint')}</p>
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.memoryBackgroundModel')}</label>
            <div className="flex flex-col gap-2 lg:flex-row">
              {bgModelList.length > 0 ? (
                <select
                  value={settings.memory_background_model}
                  onChange={e => update('memory_background_model', e.target.value)}
                  className="select-rich flex-1"
                >
                  <option value="">{t('settings.modelSelectPlaceholder')}</option>
                  {bgModelList.map(model => (
                    <option key={model} value={model}>{model}</option>
                  ))}
                </select>
              ) : (
                <input
                  value={settings.memory_background_model}
                  onChange={e => update('memory_background_model', e.target.value)}
                  className="input-rich flex-1"
                  placeholder={t('settings.modelPlaceholder')}
                />
              )}
              <button
                type="button"
                onClick={onFetchBgModels}
                disabled={bgModelLoading}
                className="soft-button soft-button-secondary shrink-0 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {bgModelLoading ? t('common.loading') : t('settings.fetchModels')}
              </button>
            </div>
            {bgModelError && <p className="mt-2 text-xs text-red-500">{bgModelError}</p>}
            <p className="mt-1.5 text-xs leading-relaxed text-text-muted">{t('settings.memoryBackgroundModelHint')}</p>
          </div>
          <label className="flex items-start gap-3 rounded-2xl border border-border-light bg-white/70 px-4 py-3 text-sm text-text-secondary">
            <input
              type="checkbox"
              checked={settings.disable_deepseek_thinking_for_background}
              onChange={e => update('disable_deepseek_thinking_for_background', e.target.checked)}
              className="mt-1"
            />
            <span>
              <span className="block font-medium text-text-primary">{t('settings.disableDeepseekThinkingForBackground')}</span>
              <span className="mt-1 block text-xs leading-relaxed text-text-muted">{t('settings.disableDeepseekThinkingForBackgroundHint')}</span>
            </span>
          </label>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.memoryPackageTokenBudget')}</label>
            <input
              type="number"
              min="1000"
              max="32000"
              step="500"
              value={settings.memory_engine.memory_package_token_budget}
              onChange={e => updateMemoryEngine('memory_package_token_budget', parseNumber(e.target.value))}
              onBlur={e => updateMemoryEngine('memory_package_token_budget', Math.min(32000, Math.max(1000, Math.round(parseNumber(e.target.value) || 12000))))}
              className="input-rich"
            />
            <p className="mt-1.5 text-xs leading-relaxed text-text-muted">{t('settings.memoryPackageTokenBudgetHint')}</p>
          </div>
        </div>

        <div className="space-y-3 rounded-2xl border border-border-light bg-white/70 px-4 py-4">
          <h3 className="text-sm font-medium text-text-primary">{t('settings.memoryEmbedding')}</h3>
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.memoryEmbeddingApiBase')}</label>
              <input
                value={settings.memory_engine.embedding_api_base}
                onChange={e => { updateMemoryEngine('embedding_api_base', e.target.value); onClearEmbeddingModelList(); }}
                className="input-rich"
                placeholder={t('settings.apiBasePlaceholder')}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.memoryEmbeddingApiKey')}</label>
              <input
                type="password"
                value={settings.memory_engine.embedding_api_key}
                onChange={e => { updateMemoryEngine('embedding_api_key', e.target.value); onClearEmbeddingModelList(); }}
                className="input-rich"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.memoryEmbeddingModel')}</label>
              <div className="flex gap-2">
                {embeddingModelList.length > 0 ? (
                  <select
                    value={settings.memory_engine.embedding_model}
                    onChange={e => updateMemoryEngine('embedding_model', e.target.value)}
                    className="select-rich flex-1"
                  >
                    <option value="">{t('settings.modelSelectPlaceholder')}</option>
                    {embeddingModelList.map(model => (
                      <option key={model} value={model}>{model}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={settings.memory_engine.embedding_model}
                    onChange={e => updateMemoryEngine('embedding_model', e.target.value)}
                    className="input-rich flex-1"
                    placeholder={t('settings.modelPlaceholder')}
                  />
                )}
                <button
                  type="button"
                  onClick={onFetchEmbeddingModels}
                  disabled={embeddingModelLoading}
                  className="soft-button soft-button-secondary shrink-0 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {embeddingModelLoading ? t('common.loading') : t('settings.fetchModels')}
                </button>
              </div>
              {embeddingModelError && <p className="mt-1 text-xs text-red-500">{embeddingModelError}</p>}
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.memoryEmbeddingDimension')}</label>
              <input
                type="number"
                min="0"
                value={settings.memory_engine.embedding_dimension || ''}
                onChange={e => updateMemoryEngine('embedding_dimension', parseNumber(e.target.value))}
                className="input-rich"
                placeholder="0"
              />
              <p className="mt-1 text-xs text-text-muted">{t('settings.memoryEmbeddingDimensionHint')}</p>
            </div>
          </div>
        </div>

        <div className="space-y-3 rounded-2xl border border-border-light bg-white/70 px-4 py-4">
          <h3 className="text-sm font-medium text-text-primary">{t('settings.memoryReranker')}</h3>
          <label className="flex items-center gap-3 text-sm text-text-secondary">
            <input
              type="checkbox"
              checked={settings.memory_engine.reranker_enabled}
              onChange={e => updateMemoryEngine('reranker_enabled', e.target.checked)}
            />
            {t('settings.memoryRerankerEnabled')}
          </label>
          {settings.memory_engine.reranker_enabled && (
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.memoryRerankerApiBase')}</label>
                <input
                  value={settings.memory_engine.reranker_api_base}
                  onChange={e => { updateMemoryEngine('reranker_api_base', e.target.value); onClearRerankerModelList(); }}
                  className="input-rich"
                  placeholder={t('settings.apiBasePlaceholder')}
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.memoryRerankerApiKey')}</label>
                <input
                  type="password"
                  value={settings.memory_engine.reranker_api_key}
                  onChange={e => { updateMemoryEngine('reranker_api_key', e.target.value); onClearRerankerModelList(); }}
                  className="input-rich"
                />
              </div>
              <div className="md:col-span-2">
                <label className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.memoryRerankerModel')}</label>
                <div className="flex gap-2">
                  {rerankerModelList.length > 0 ? (
                    <select
                      value={settings.memory_engine.reranker_model}
                      onChange={e => updateMemoryEngine('reranker_model', e.target.value)}
                      className="select-rich flex-1"
                    >
                      <option value="">{t('settings.modelSelectPlaceholder')}</option>
                      {rerankerModelList.map(model => (
                        <option key={model} value={model}>{model}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      value={settings.memory_engine.reranker_model}
                      onChange={e => updateMemoryEngine('reranker_model', e.target.value)}
                      className="input-rich flex-1"
                      placeholder={t('settings.modelPlaceholder')}
                    />
                  )}
                  <button
                    type="button"
                    onClick={onFetchRerankerModels}
                    disabled={rerankerModelLoading}
                    className="soft-button soft-button-secondary shrink-0 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {rerankerModelLoading ? t('common.loading') : t('settings.fetchModels')}
                  </button>
                </div>
                {rerankerModelError && <p className="mt-1 text-xs text-red-500">{rerankerModelError}</p>}
              </div>
            </div>
          )}
        </div>

        {memoryEngineEnabled && (
          <>
            <div className="space-y-3 rounded-2xl border border-border-light bg-white/70 px-4 py-4">
              <h3 className="text-sm font-medium text-text-primary">{t('settings.memoryPrivacy')}</h3>
              <label className="flex items-center gap-3 text-sm text-text-secondary">
                <input
                  type="checkbox"
                  checked={settings.memory_engine.allow_memory_context_in_chat}
                  onChange={e => updateMemoryEngine('allow_memory_context_in_chat', e.target.checked)}
                />
                {t('settings.memoryAllowChatContext')}
              </label>
              <label className="flex items-center gap-3 text-sm text-text-secondary">
                <input
                  type="checkbox"
                  checked={settings.memory_engine.allow_external_memory_payloads}
                  onChange={e => updateMemoryEngine('allow_external_memory_payloads', e.target.checked)}
                />
                {t('settings.memoryAllowExternalPayloads')}
              </label>
            </div>
            {children}
          </>
        )}

        <div className="border-t border-border-light pt-3" />

        <label className="flex items-center gap-3 rounded-2xl border border-border-light bg-white/70 px-4 py-3 text-sm text-text-secondary">
          <input
            type="checkbox"
            checked={settings.memory_trigger_interval_enabled}
            onChange={e => update('memory_trigger_interval_enabled', e.target.checked)}
          />
          {t('settings.triggerInterval')}
        </label>

        {settings.memory_trigger_interval_enabled && (
          <div className="rounded-2xl border border-border-light bg-white/70 px-4 py-4">
            <label className="mb-2 block text-sm font-medium text-text-secondary">{t('settings.extractionInterval')}</label>
            <input
              type="number"
              min="1"
              max="50"
              value={settings.memory_interval}
              onChange={e => update('memory_interval', parseNumber(e.target.value))}
              className="input-rich"
            />
          </div>
        )}

        <label className="flex items-center gap-3 rounded-2xl border border-border-light bg-white/70 px-4 py-3 text-sm text-text-secondary">
          <input
            type="checkbox"
            checked={settings.memory_trigger_time_enabled}
            onChange={e => update('memory_trigger_time_enabled', e.target.checked)}
          />
          {t('settings.triggerTime')}
        </label>

        {settings.memory_trigger_time_enabled && (
          <div className="rounded-2xl border border-border-light bg-white/70 px-4 py-4">
            <label className="mb-2 block text-sm font-medium text-text-secondary">{t('settings.triggerTimeMinutes')}</label>
            <input
              type="number"
              min="1"
              max="72"
              value={settings.memory_trigger_time_hours}
              onChange={e => update('memory_trigger_time_hours', parseNumber(e.target.value))}
              className="input-rich"
            />
          </div>
        )}

        <label className="flex items-center gap-3 rounded-2xl border border-border-light bg-white/70 px-4 py-3 text-sm text-text-secondary">
          <input
            type="checkbox"
            checked={settings.memory_trigger_keyword_enabled}
            onChange={e => update('memory_trigger_keyword_enabled', e.target.checked)}
          />
          {t('settings.triggerKeyword')}
        </label>

        {settings.memory_trigger_keyword_enabled && (
          <div className="rounded-2xl border border-border-light bg-white/70 px-4 py-4">
            <label className="mb-2 block text-sm font-medium text-text-secondary">{t('settings.triggerKeywords')}</label>
            <p className="mb-2 text-xs leading-relaxed text-text-muted">{t('settings.triggerKeywordsHint')}</p>
            <input
              type="text"
              value={settings.memory_trigger_keywords}
              onChange={e => update('memory_trigger_keywords', e.target.value)}
              placeholder={t('settings.triggerKeywordsPlaceholder')}
              className="input-rich"
            />
          </div>
        )}

        <label className="flex items-center gap-3 rounded-2xl border border-border-light bg-white/70 px-4 py-3 text-sm text-text-secondary">
          <input
            type="checkbox"
            checked={settings.memory_inject}
            onChange={e => update('memory_inject', e.target.checked)}
          />
          {t('settings.memoryInject')}
        </label>

        <label className="flex items-center gap-3 rounded-2xl border border-border-light bg-white/70 px-4 py-3 text-sm text-text-secondary">
          <input
            type="checkbox"
            checked={settings.limit_inject}
            onChange={e => update('limit_inject', e.target.checked)}
          />
          {t('settings.limitInject')}
        </label>

        {settings.limit_inject && (
          <div className="rounded-2xl border border-border-light bg-white/70 px-4 py-4">
            <label className="mb-2 block text-sm font-medium text-text-secondary">{t('settings.maxMemoriesInject')}</label>
            <p className="mb-3 text-xs leading-relaxed text-text-muted">{t('settings.limitInjectHint')}</p>
            <input
              type="number"
              min="5"
              max="100"
              value={settings.memory_max_inject}
              onChange={e => update('memory_max_inject', parseNumber(e.target.value))}
              className="input-rich"
            />
          </div>
        )}
      </div>
    </section>
  );
}
