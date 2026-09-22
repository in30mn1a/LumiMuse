'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from '@/lib/i18n-context';
import { parseJsonResponse } from '@/lib/http';
import {
  planBackgroundModelSwitch,
  rememberBackgroundSystemPromptForModel,
  resolveBackgroundSystemPromptForModel,
} from '@/lib/background-system-prompt';
import {
  planModelReasoningSwitch,
  rememberReasoningEffortForModel,
  resolveReasoningEffortForModel,
} from '@/lib/reasoning-effort';
import type { ReasoningEffort } from '@/types';

const EFFORTS: ReasoningEffort[] = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];

interface TaskModelValue {
  background_provider_id: string;
  background_model: string;
  image_prompt_model: string;
  background_reasoning_by_model: Record<string, ReasoningEffort>;
  image_prompt_reasoning_by_model: Record<string, ReasoningEffort>;
  background_system_prompt_by_model: Record<string, string>;
  image_prompt_system_prompt_by_model: Record<string, string>;
}

interface ProviderOption {
  id: string;
  name: string;
  model: string;
}

interface Props {
  value: TaskModelValue;
  onChange: (next: TaskModelValue) => void;
}

export default function CharacterTaskModelsField({ value, onChange }: Props) {
  const { t } = useTranslation();
  const [models, setModels] = useState<string[]>([]);
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [mainModel, setMainModel] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const providerId = value.background_provider_id.trim();

  const loadModels = useCallback(async (refresh: boolean, selectedProviderId: string) => {
    const body: Record<string, unknown> = { refresh };
    if (selectedProviderId) body.provider_id = selectedProviderId;
    return parseJsonResponse<{ models?: string[]; error?: string }>(await fetch('/api/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const settings = await parseJsonResponse<{ model?: string }>(await fetch('/api/settings'));
        const providerData = await parseJsonResponse<{ providers?: ProviderOption[] }>(await fetch('/api/providers'));
        if (cancelled) return;
        setMainModel((settings.model || '').trim());
        setProviders(Array.isArray(providerData.providers) ? providerData.providers : []);
      } catch {
        // 供应商列表失败时仍允许手填模型名。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadModels(false, providerId)
      .then(data => {
        if (cancelled) return;
        if (data.error) setError(data.error);
        setModels(Array.isArray(data.models) ? data.models : []);
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadModels, providerId]);

  const refreshModels = () => {
    setLoading(true);
    setError('');
    void loadModels(true, providerId)
      .then(data => {
        if (data.error) setError(data.error);
        setModels(Array.isArray(data.models) ? data.models : []);
      })
      .catch(err => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoading(false));
  };

  return (
    <div>
      <h2 className="mb-1 text-base font-semibold text-text-primary">{t('editor.taskModels')}</h2>
      <p className="mb-4 text-xs leading-relaxed text-text-muted">{t('editor.taskModelsHint')}</p>
      <div className="mb-4">
        <label htmlFor="character-task-provider" className="mb-1.5 block text-sm font-medium text-text-secondary">
          {t('editor.taskProvider')}
        </label>
        <select
          id="character-task-provider"
          value={providerId}
          onChange={event => {
            setLoading(true);
            setError('');
            onChange({ ...value, background_provider_id: event.target.value });
          }}
          className="select-rich w-full"
        >
          <option value="">{t('editor.taskProviderInheritMain')}</option>
          {providers.map(provider => (
            <option key={provider.id} value={provider.id}>
              {provider.name}{provider.model ? ` (${provider.model})` : ''}
            </option>
          ))}
        </select>
        <p className="mt-1.5 text-xs leading-relaxed text-text-muted">{t('editor.taskProviderHint')}</p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <ModelEffortField
          idPrefix="character-background"
          label={t('editor.backgroundModel')}
          hint={t('editor.backgroundModelHint')}
          emptyLabel={t('editor.taskModelInheritSettings')}
          model={value.background_model}
          inheritedModel={mainModel}
          byModel={value.background_reasoning_by_model}
          promptByModel={value.background_system_prompt_by_model}
          models={models}
          onModelChange={(model, byModel, promptByModel) => onChange({
            ...value,
            background_model: model,
            background_reasoning_by_model: byModel,
            background_system_prompt_by_model: promptByModel,
          })}
          onEffortChange={byModel => onChange({ ...value, background_reasoning_by_model: byModel })}
          onPromptChange={promptByModel => onChange({ ...value, background_system_prompt_by_model: promptByModel })}
        />
        <ModelEffortField
          idPrefix="character-image-prompt"
          label={t('editor.imagePromptModel')}
          hint={t('editor.imagePromptModelHint')}
          emptyLabel={t('editor.taskModelInheritBackground')}
          model={value.image_prompt_model}
          inheritedModel=""
          byModel={value.image_prompt_reasoning_by_model}
          promptByModel={value.image_prompt_system_prompt_by_model}
          models={models}
          onModelChange={(model, byModel, promptByModel) => onChange({
            ...value,
            image_prompt_model: model,
            image_prompt_reasoning_by_model: byModel,
            image_prompt_system_prompt_by_model: promptByModel,
          })}
          onEffortChange={byModel => onChange({ ...value, image_prompt_reasoning_by_model: byModel })}
          onPromptChange={promptByModel => onChange({ ...value, image_prompt_system_prompt_by_model: promptByModel })}
        />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={refreshModels}
          disabled={loading}
          className="soft-button soft-button-secondary disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? t('common.loading') : t('settings.fetchModels')}
        </button>
        {error && <p className="text-xs text-red-500">{error}</p>}
      </div>
    </div>
  );
}

function ModelEffortField({
  idPrefix,
  label,
  hint,
  emptyLabel,
  model,
  inheritedModel,
  byModel,
  promptByModel,
  models,
  onModelChange,
  onEffortChange,
  onPromptChange,
}: {
  idPrefix: string;
  label: string;
  hint: string;
  emptyLabel: string;
  model: string;
  inheritedModel: string;
  byModel: Record<string, ReasoningEffort>;
  promptByModel: Record<string, string>;
  models: string[];
  onModelChange: (
    model: string,
    byModel: Record<string, ReasoningEffort>,
    promptByModel: Record<string, string>,
  ) => void;
  onEffortChange: (byModel: Record<string, ReasoningEffort>) => void;
  onPromptChange: (promptByModel: Record<string, string>) => void;
}) {
  const { t } = useTranslation();
  const trimmed = model.trim();
  const boundModel = trimmed || inheritedModel.trim();
  const effort = resolveReasoningEffortForModel(boundModel, byModel, 'default');
  const prompt = boundModel
    ? resolveBackgroundSystemPromptForModel(boundModel, promptByModel, '')
    : '';
  const focusedModelRef = useRef(trimmed);
  const options = useMemo(() => {
    const next = new Set(models);
    if (trimmed) next.add(trimmed);
    return [...next];
  }, [models, trimmed]);

  const changeModel = (nextModel: string) => {
    const nextTrimmed = nextModel.trim();
    const plannedEffort = planModelReasoningSwitch({
      previousModel: trimmed,
      previousEffort: resolveReasoningEffortForModel(trimmed, byModel, 'default'),
      nextModel: nextTrimmed,
      byModel,
    });
    const plannedPrompt = planBackgroundModelSwitch({
      previousModel: trimmed,
      previousPrompt: trimmed ? resolveBackgroundSystemPromptForModel(trimmed, promptByModel, '') : '',
      nextModel: nextTrimmed,
      byModel: promptByModel,
    });
    onModelChange(nextTrimmed, plannedEffort.byModel, plannedPrompt.byModel);
  };

  return (
    <div className="rounded-2xl border border-border-light bg-white/70 px-4 py-4">
      <label htmlFor={`${idPrefix}-model`} className="mb-1.5 block text-sm font-medium text-text-secondary">
        {label}
      </label>
      {options.length > 0 ? (
        <select
          id={`${idPrefix}-model`}
          value={trimmed}
          onChange={event => changeModel(event.target.value)}
          className="select-rich w-full"
        >
          <option value="">{emptyLabel}</option>
          {options.map(item => (
            <option key={item} value={item}>{item}</option>
          ))}
        </select>
      ) : (
        <input
          id={`${idPrefix}-model`}
          value={model}
          onFocus={() => { focusedModelRef.current = trimmed; }}
          onChange={event => onModelChange(event.target.value, byModel, promptByModel)}
          onBlur={event => {
            const nextModel = event.target.value.trim();
            const previousModel = focusedModelRef.current;
            const plannedEffort = planModelReasoningSwitch({
              previousModel,
              previousEffort: resolveReasoningEffortForModel(previousModel, byModel, 'default'),
              nextModel,
              byModel,
            });
            const plannedPrompt = planBackgroundModelSwitch({
              previousModel,
              previousPrompt: previousModel
                ? resolveBackgroundSystemPromptForModel(previousModel, promptByModel, '')
                : '',
              nextModel,
              byModel: promptByModel,
            });
            onModelChange(nextModel, plannedEffort.byModel, plannedPrompt.byModel);
          }}
          className="input-rich w-full"
          placeholder={emptyLabel}
        />
      )}
      <label htmlFor={`${idPrefix}-effort`} className="mb-1.5 mt-3 block text-sm font-medium text-text-secondary">
        {t('input.reasoningEffort')}
      </label>
      <select
        id={`${idPrefix}-effort`}
        value={boundModel ? effort : 'default'}
        disabled={!boundModel}
        onChange={event => {
          onEffortChange(rememberReasoningEffortForModel(
            byModel,
            boundModel,
            event.target.value as ReasoningEffort,
          ));
        }}
        className="select-rich w-full disabled:cursor-not-allowed disabled:opacity-60"
      >
        {EFFORTS.map(item => (
          <option key={item} value={item}>
            {item === 'default' ? t('input.reasoningEffortDefault') : item}
          </option>
        ))}
      </select>
      <label htmlFor={`${idPrefix}-prompt`} className="mb-1.5 mt-3 block text-sm font-medium text-text-secondary">
        {t('editor.taskModelSystemPrompt')}
        {boundModel ? <span className="ml-1.5 font-normal text-text-muted">({boundModel})</span> : null}
      </label>
      <textarea
        id={`${idPrefix}-prompt`}
        rows={4}
        value={boundModel ? prompt : ''}
        disabled={!boundModel}
        onChange={event => {
          onPromptChange(rememberBackgroundSystemPromptForModel(
            promptByModel,
            boundModel,
            event.target.value,
          ));
        }}
        className="textarea-rich w-full resize-y font-mono text-sm disabled:cursor-not-allowed disabled:opacity-60"
        placeholder={t('editor.taskModelSystemPromptPlaceholder')}
      />
      <p className="mt-1.5 text-xs leading-relaxed text-text-muted">{t('editor.taskModelSystemPromptHint')}</p>
      <p className="mt-1.5 text-xs leading-relaxed text-text-muted">{hint}</p>
    </div>
  );
}
