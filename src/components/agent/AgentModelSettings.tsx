'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useTranslation } from '@/lib/i18n-context';
import { formatTemplate } from '@/lib/i18n';
import { getErrorMessage, parseJsonResponse } from '@/lib/http';
import { useToast } from '@/components/ui/Toast';
import type { ReasoningEffort } from '@/types';

const EFFORTS: ReasoningEffort[] = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];
const DEFAULT_CONTEXT_WINDOW = 272000;
/** 与服务端 settingsUpdateSchema 的上限一致 */
const MAX_CONTEXT_WINDOW = 100_000_000;

interface AgentModelValue {
  agent_provider_id: string;
  agent_model: string;
  agent_reasoning_effort: ReasoningEffort;
  /** 输入框原文；保存时转成正整数 */
  agent_context_window: string;
}

function parseContextWindow(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= 1 && value <= MAX_CONTEXT_WINDOW ? value : null;
}

export interface AgentModelState {
  saved: AgentModelValue | null;
  value: AgentModelValue | null;
}

interface ProviderOption {
  id: string;
  name: string;
  model: string;
}

interface Props {
  state: AgentModelState;
  onStateChange: Dispatch<SetStateAction<AgentModelState>>;
  /** 保存成功后调用（状态条据此刷新模型显示） */
  onSaved: () => void;
  saving: boolean;
  onSaveStart: () => boolean;
  onSaveEnd: () => void;
}

function sameValue(a: AgentModelValue, b: AgentModelValue): boolean {
  return a.agent_provider_id === b.agent_provider_id
    && a.agent_model === b.agent_model
    && a.agent_reasoning_effort === b.agent_reasoning_effort
    && a.agent_context_window.trim() === b.agent_context_window.trim();
}

/** Agent 用哪个接口和模型。留空时跟随主接口和主聊天模型。 */
export default function AgentModelSettings({ state, onStateChange, onSaved, saving, onSaveStart, onSaveEnd }: Props) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { saved, value } = state;
  const stateRef = useRef(state);
  useLayoutEffect(() => { stateRef.current = state; }, [state]);
  const setValue = (next: AgentModelValue) => onStateChange(prev => ({ ...prev, value: next }));
  const [mainModel, setMainModel] = useState('');
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState('');
  const modelRequestRef = useRef(0);

  const load = useCallback(async () => {
    const savedAtLoad = stateRef.current.saved;
    setLoadError(null);
    try {
      const settings = await parseJsonResponse<Omit<AgentModelValue, 'agent_context_window'> & {
        model?: string;
        agent_context_window?: number;
      }>(await fetch('/api/settings'));
      const current: AgentModelValue = {
        agent_provider_id: settings.agent_provider_id ?? '',
        agent_model: settings.agent_model ?? '',
        agent_reasoning_effort: settings.agent_reasoning_effort ?? 'default',
        agent_context_window: String(settings.agent_context_window ?? DEFAULT_CONTEXT_WINDOW),
      };
      onStateChange(prev => {
        // 读取期间完成的保存更晚，不让旧 GET 回包覆盖它或尚未保存的选择。
        if (prev.saved !== savedAtLoad) return prev;
        const edited = prev.value && prev.saved && !sameValue(prev.value, prev.saved);
        return { saved: current, value: edited ? prev.value : current };
      });
      setMainModel((settings.model ?? '').trim());
    } catch (error) {
      setLoadError(getErrorMessage(error));
      return;
    }
    try {
      const data = await parseJsonResponse<{ providers?: ProviderOption[] }>(await fetch('/api/providers'));
      setProviders(Array.isArray(data.providers) ? data.providers : []);
    } catch {
      // 接口列表读不到时仍可只改模型
    }
  }, [onStateChange]);

  useEffect(() => {
    // 状态写入都在请求返回之后
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const providerId = value?.agent_provider_id ?? null;
  useLayoutEffect(() => {
    // 接口变更及卸载立即使旧请求失效，包括它的错误和 loading 回写。
    modelRequestRef.current += 1;
    return () => { modelRequestRef.current += 1; };
  }, [providerId]);
  const loadModels = useCallback(async (refresh: boolean) => {
    if (providerId === null) return;
    const requestId = ++modelRequestRef.current;
    setModels([]);
    setModelsLoading(true);
    setModelsError('');
    try {
      const body: Record<string, unknown> = { refresh };
      if (providerId) body.provider_id = providerId;
      const data = await parseJsonResponse<{ models?: string[]; error?: string | null }>(await fetch('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }));
      if (requestId !== modelRequestRef.current) return;
      setModels(Array.isArray(data.models) ? data.models : []);
      if (data.error) setModelsError(data.error);
    } catch (error) {
      if (requestId !== modelRequestRef.current) return;
      setModels([]);
      setModelsError(getErrorMessage(error));
    } finally {
      if (requestId === modelRequestRef.current) setModelsLoading(false);
    }
  }, [providerId]);

  useEffect(() => {
    // 换接口后重新拉模型列表；状态写入都在请求返回之后
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadModels(false);
  }, [loadModels]);

  const modelOptions = useMemo(() => {
    const options = new Set(models);
    const current = value?.agent_model.trim();
    if (current) options.add(current);
    return [...options];
  }, [models, value?.agent_model]);

  if (loadError) {
    return (
      <div className="px-5 py-6 text-sm text-danger" role="alert">
        <p className="[overflow-wrap:anywhere]">{`${t('common.loadFailed')}: ${loadError}`}</p>
        <button type="button" onClick={() => void load()} className="mt-2 font-medium text-accent-dark underline">
          {t('common.retry')}
        </button>
      </div>
    );
  }
  if (!value || !saved) {
    return <p className="px-5 py-6 text-sm text-text-muted" aria-busy="true">{t('common.loading')}</p>;
  }

  const dirty = !sameValue(value, saved);
  const contextWindow = parseContextWindow(value.agent_context_window);
  const inheritLabel = formatTemplate(t('agent.settings.modelInherit'), { model: mainModel || '-' });

  const save = async () => {
    if (!dirty || contextWindow === null || !onSaveStart()) return;
    try {
      await parseJsonResponse<unknown>(await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...value, agent_model: value.agent_model.trim(), agent_context_window: contextWindow }),
      }));
      const next = { ...value, agent_model: value.agent_model.trim(), agent_context_window: String(contextWindow) };
      onStateChange(prev => ({
        saved: next,
        value: prev.value && sameValue(prev.value, value) ? next : prev.value,
      }));
      showToast(t('agent.settings.saved'), 'success');
      onSaved();
    } catch (error) {
      showToast(`${t('common.operationFailed')}: ${getErrorMessage(error)}`, 'error');
    } finally {
      onSaveEnd();
    }
  };

  return (
    <div className="space-y-4 px-5 py-5">
      <div>
        <label htmlFor="agent-provider" className="mb-1.5 block text-sm font-medium text-text-secondary">
          {t('agent.settings.provider')}
        </label>
        <select
          id="agent-provider"
          value={value.agent_provider_id}
          onChange={event => setValue({ ...value, agent_provider_id: event.target.value })}
          className="select-rich w-full"
        >
          <option value="">{t('agent.settings.providerInherit')}</option>
          {providers.map(provider => (
            <option key={provider.id} value={provider.id}>
              {provider.name}{provider.model ? ` (${provider.model})` : ''}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="agent-model" className="mb-1.5 block text-sm font-medium text-text-secondary">
          {t('agent.settings.model')}
        </label>
        {modelOptions.length > 0 ? (
          <select
            id="agent-model"
            value={value.agent_model.trim()}
            onChange={event => setValue({ ...value, agent_model: event.target.value })}
            className="select-rich w-full"
          >
            <option value="">{inheritLabel}</option>
            {modelOptions.map(model => <option key={model} value={model}>{model}</option>)}
          </select>
        ) : (
          <input
            id="agent-model"
            value={value.agent_model}
            onChange={event => setValue({ ...value, agent_model: event.target.value })}
            placeholder={inheritLabel}
            className="input-rich w-full"
          />
        )}
        <p className="mt-1.5 text-xs leading-relaxed text-text-muted">{t('agent.settings.modelHint')}</p>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void loadModels(true)}
            disabled={modelsLoading}
            className="soft-button soft-button-secondary min-h-9 px-3 text-xs disabled:cursor-not-allowed disabled:opacity-50"
          >
            {modelsLoading ? t('common.loading') : t('settings.fetchModels')}
          </button>
          {modelsError && <p className="min-w-0 text-xs text-danger [overflow-wrap:anywhere]">{modelsError}</p>}
        </div>
      </div>

      <div>
        <label htmlFor="agent-effort" className="mb-1.5 block text-sm font-medium text-text-secondary">
          {t('input.reasoningEffort')}
        </label>
        <select
          id="agent-effort"
          value={value.agent_reasoning_effort}
          onChange={event => setValue({ ...value, agent_reasoning_effort: event.target.value as ReasoningEffort })}
          className="select-rich w-full"
        >
          {EFFORTS.map(effort => (
            <option key={effort} value={effort}>
              {effort === 'default' ? t('input.reasoningEffortDefault') : effort}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="agent-context-window" className="mb-1.5 block text-sm font-medium text-text-secondary">
          {t('agent.settings.contextWindow')}
        </label>
        <input
          id="agent-context-window"
          type="number"
          inputMode="numeric"
          min={1}
          max={MAX_CONTEXT_WINDOW}
          step={1}
          value={value.agent_context_window}
          onChange={event => setValue({ ...value, agent_context_window: event.target.value })}
          aria-invalid={contextWindow === null}
          aria-describedby="agent-context-window-hint"
          className="input-rich w-full"
        />
        <p id="agent-context-window-hint" className="mt-1.5 text-xs leading-relaxed text-text-muted">
          {t('agent.settings.contextWindowHint')}
        </p>
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void save()}
          disabled={!dirty || saving || contextWindow === null}
          className="soft-button soft-button-primary min-h-10 px-5 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? t('common.loading') : t('common.save')}
        </button>
      </div>
    </div>
  );
}
