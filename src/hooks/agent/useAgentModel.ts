'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from '@/lib/i18n-context';
import { getErrorMessage, parseJsonResponse } from '@/lib/http';
import { sanitizePinnedModels, togglePinnedModel as togglePinnedInList } from '@/lib/pinned-models';
import { useToast } from '@/components/ui/Toast';
import type { ReasoningEffort, Settings } from '@/types';

export interface AgentModelControls {
  /** 设置读到之前为 false，输入框先不显示选择器，免得闪出一个不对的模型名 */
  ready: boolean;
  /** Agent 用的接口；空字符串表示跟随主接口 */
  providerId: string;
  /** 实际生效的模型：Agent 模型留空时跟随主聊天模型 */
  currentModel: string;
  reasoningEffort: ReasoningEffort;
  pinnedModels: string[];
  selectModel: (model: string) => void;
  selectReasoningEffort: (effort: ReasoningEffort) => void;
  /** 置顶 / 取消置顶模型（与聊天页共用同一份全局列表） */
  togglePinnedModel: (model: string) => void;
  /** 读取 Agent 所用接口的模型列表 */
  loadModels: () => Promise<string[]>;
}

interface AgentModelChoice {
  /** 已保存的 `agent_model`，空字符串表示跟随主聊天模型 */
  agentModel: string;
  effort: ReasoningEffort;
}

type AgentModelWrite =
  | { agent_model: string }
  | { agent_reasoning_effort: ReasoningEffort }
  | { pinned_models: string[] };

/**
 * 输入框里的 Agent 模型与思考强度，读写设置抽屉里的同一组全局键。
 *
 * 写入按操作顺序串行落库；排空后若期间有写入失败，界面对齐到服务端最后确认的值（同聊天页的写队列）。
 * @param refreshKey 变化时重新读取，例如抽屉里保存了模型设置
 * @param onSaved 每次写入成功后调用
 */
export function useAgentModel(refreshKey: number, onSaved?: () => void): AgentModelControls {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [ready, setReady] = useState(false);
  const [providerId, setProviderId] = useState('');
  const [mainModel, setMainModel] = useState('');
  const [choice, setChoice] = useState<AgentModelChoice>({ agentModel: '', effort: 'default' });
  const [pinnedModels, setPinnedModels] = useState<string[]>([]);
  const onSavedRef = useRef(onSaved);
  useLayoutEffect(() => { onSavedRef.current = onSaved; }, [onSaved]);
  const writesRef = useRef<{
    chain: Promise<void>;
    pending: number;
    failed: boolean;
    /** 每排入一次写入加一，用来判断读取期间有没有写入 */
    revision: number;
    confirmed: AgentModelChoice;
    /** 服务端最后确认的置顶列表 */
    confirmedPinned: string[];
  }>({
    chain: Promise.resolve(),
    pending: 0,
    failed: false,
    revision: 0,
    confirmed: { agentModel: '', effort: 'default' },
    confirmedPinned: [],
  });

  useEffect(() => {
    let cancelled = false;
    const writes = writesRef.current;
    // 读取开始时有写入未落库、或读取期间又有写入时，读到的可能是旧值，不能覆盖界面上的选择
    const writesSettled = writes.pending === 0;
    const revisionAtLoad = writes.revision;
    fetch('/api/settings')
      .then(response => parseJsonResponse<Partial<Settings>>(response))
      .then(settings => {
        if (cancelled) return;
        setProviderId(settings.agent_provider_id?.trim() ?? '');
        setMainModel(settings.model?.trim() ?? '');
        if (writesSettled && writes.revision === revisionAtLoad) {
          const loaded: AgentModelChoice = {
            agentModel: settings.agent_model?.trim() ?? '',
            effort: settings.agent_reasoning_effort ?? 'default',
          };
          const loadedPinned = sanitizePinnedModels(settings.pinned_models);
          writes.confirmed = loaded;
          writes.confirmedPinned = loadedPinned;
          setChoice(loaded);
          setPinnedModels(loadedPinned);
        }
        setReady(true);
      })
      .catch(() => {
        // 读不到设置时不显示选择器；状态条和设置抽屉会各自报错
      });
    return () => { cancelled = true; };
  }, [refreshKey]);

  const queueWrite = useCallback((body: AgentModelWrite) => {
    const writes = writesRef.current;
    writes.pending += 1;
    writes.revision += 1;
    writes.chain = writes.chain.then(async () => {
      try {
        await parseJsonResponse<unknown>(await fetch('/api/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }));
        if ('pinned_models' in body) {
          writes.confirmedPinned = body.pinned_models;
        } else {
          writes.confirmed = 'agent_model' in body
            ? { ...writes.confirmed, agentModel: body.agent_model }
            : { ...writes.confirmed, effort: body.agent_reasoning_effort };
        }
        onSavedRef.current?.();
      } catch (error) {
        writes.failed = true;
        showToast(`${t('settings.saveFailed')}: ${getErrorMessage(error)}`, 'error');
      }
      writes.pending -= 1;
      // 后面还排着更新的选择时不动界面；排空后若期间失败过，界面上的乐观值已不可信
      if (writes.pending > 0 || !writes.failed) return;
      writes.failed = false;
      setChoice(writes.confirmed);
      setPinnedModels(writes.confirmedPinned);
    });
  }, [showToast, t]);

  const loadModels = useCallback(async (): Promise<string[]> => {
    const body: Record<string, string> = {};
    if (providerId) body.provider_id = providerId;
    const data = await parseJsonResponse<{ models?: string[]; error?: string | null }>(await fetch('/api/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));
    const models = Array.isArray(data.models) ? data.models : [];
    if (models.length === 0 && data.error) throw new Error(data.error);
    return models;
  }, [providerId]);

  const currentModel = choice.agentModel || mainModel;

  const selectModel = (model: string) => {
    // 点的就是当前生效的模型时不写库：留空表示跟随主聊天模型，不能因为这一下被固定下来
    if (!model || model === currentModel) return;
    setChoice(prev => ({ ...prev, agentModel: model }));
    queueWrite({ agent_model: model });
  };

  const selectReasoningEffort = (effort: ReasoningEffort) => {
    if (effort === choice.effort) return;
    setChoice(prev => ({ ...prev, effort }));
    queueWrite({ agent_reasoning_effort: effort });
  };

  // 置顶列表每次写完整值，与聊天页共用同一份全局列表
  const togglePinnedModel = (model: string) => {
    const next = togglePinnedInList(pinnedModels, model);
    setPinnedModels(next);
    queueWrite({ pinned_models: next });
  };

  return {
    ready,
    providerId,
    currentModel,
    reasoningEffort: choice.effort,
    pinnedModels,
    selectModel,
    selectReasoningEffort,
    togglePinnedModel,
    loadModels,
  };
}
