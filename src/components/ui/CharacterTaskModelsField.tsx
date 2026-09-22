'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from '@/lib/i18n-context';
import { parseJsonResponse } from '@/lib/http';
import {
  planModelReasoningSwitch,
  rememberReasoningEffortForModel,
  resolveReasoningEffortForModel,
} from '@/lib/reasoning-effort';
import type { ReasoningEffort } from '@/types';

const EFFORTS: ReasoningEffort[] = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];

interface TaskModelValue {
  background_model: string;
  image_prompt_model: string;
  background_reasoning_by_model: Record<string, ReasoningEffort>;
  image_prompt_reasoning_by_model: Record<string, ReasoningEffort>;
}

interface Props {
  value: TaskModelValue;
  onChange: (next: TaskModelValue) => void;
}

export default function CharacterTaskModelsField({ value, onChange }: Props) {
  const { t } = useTranslation();
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadModels = useCallback(async (refresh: boolean) => {
    const settings = await parseJsonResponse<{ memory_background_provider_id?: string }>(
      await fetch('/api/settings'),
    );
    const body: Record<string, unknown> = { refresh };
    const providerId = settings.memory_background_provider_id?.trim();
    if (providerId) body.provider_id = providerId;
    return parseJsonResponse<{ models?: string[]; error?: string }>(await fetch('/api/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await loadModels(false);
        if (cancelled) return;
        if (data.error) setError(data.error);
        setModels(Array.isArray(data.models) ? data.models : []);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadModels]);

  const refreshModels = () => {
    setLoading(true);
    setError('');
    void loadModels(true)
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
      <div className="grid gap-4 lg:grid-cols-2">
        <ModelEffortField
          idPrefix="character-background"
          label={t('editor.backgroundModel')}
          hint={t('editor.backgroundModelHint')}
          emptyLabel={t('editor.taskModelInheritSettings')}
          model={value.background_model}
          byModel={value.background_reasoning_by_model}
          models={models}
          onModelChange={(model, byModel) => onChange({
            ...value,
            background_model: model,
            background_reasoning_by_model: byModel,
          })}
          onEffortChange={byModel => onChange({ ...value, background_reasoning_by_model: byModel })}
        />
        <ModelEffortField
          idPrefix="character-image-prompt"
          label={t('editor.imagePromptModel')}
          hint={t('editor.imagePromptModelHint')}
          emptyLabel={t('editor.taskModelInheritBackground')}
          model={value.image_prompt_model}
          byModel={value.image_prompt_reasoning_by_model}
          models={models}
          onModelChange={(model, byModel) => onChange({
            ...value,
            image_prompt_model: model,
            image_prompt_reasoning_by_model: byModel,
          })}
          onEffortChange={byModel => onChange({ ...value, image_prompt_reasoning_by_model: byModel })}
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
  byModel,
  models,
  onModelChange,
  onEffortChange,
}: {
  idPrefix: string;
  label: string;
  hint: string;
  emptyLabel: string;
  model: string;
  byModel: Record<string, ReasoningEffort>;
  models: string[];
  onModelChange: (model: string, byModel: Record<string, ReasoningEffort>) => void;
  onEffortChange: (byModel: Record<string, ReasoningEffort>) => void;
}) {
  const { t } = useTranslation();
  const trimmed = model.trim();
  const effort = resolveReasoningEffortForModel(trimmed, byModel, 'default');
  const focusedModelRef = useRef(trimmed);
  const options = useMemo(() => {
    const next = new Set(models);
    if (trimmed) next.add(trimmed);
    return [...next];
  }, [models, trimmed]);

  const changeModel = (nextModel: string) => {
    const planned = planModelReasoningSwitch({
      previousModel: trimmed,
      previousEffort: effort,
      nextModel: nextModel.trim(),
      byModel,
    });
    onModelChange(nextModel.trim(), planned.byModel);
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
          onChange={event => onModelChange(event.target.value, byModel)}
          onBlur={event => {
            const nextModel = event.target.value.trim();
            const previousModel = focusedModelRef.current;
            const planned = planModelReasoningSwitch({
              previousModel,
              previousEffort: resolveReasoningEffortForModel(previousModel, byModel, 'default'),
              nextModel,
              byModel,
            });
            onModelChange(nextModel, planned.byModel);
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
        value={trimmed ? effort : 'default'}
        disabled={!trimmed}
        onChange={event => {
          onEffortChange(rememberReasoningEffortForModel(
            byModel,
            trimmed,
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
      <p className="mt-1.5 text-xs leading-relaxed text-text-muted">{hint}</p>
    </div>
  );
}
