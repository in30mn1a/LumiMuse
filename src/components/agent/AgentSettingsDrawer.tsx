'use client';

import { useRef, useState } from 'react';
import type { AgentDocumentKey } from '@/lib/agent/documents';
import { useTranslation } from '@/lib/i18n-context';
import Modal from '@/components/ui/Modal';
import { XIcon } from '@/components/ui/icons';
import AgentDocumentEditor, { type AgentDocumentState } from './AgentDocumentEditor';
import AgentModelSettings, { type AgentModelState } from './AgentModelSettings';
import AgentProposalHistory from './AgentProposalHistory';

/** 会写入的页签，各有一把保存锁 */
type WriteTab = 'model' | AgentDocumentKey;
type SettingsTab = WriteTab | 'history';
/** save 或正在恢复的版本 ID；锁随抽屉保留，不随编辑器卸载。 */
type PendingWrite = 'save' | number | null;

interface Props {
  open: boolean;
  onClose: () => void;
  /** 模型设置保存后调用 */
  onModelSaved: () => void;
  /** 当前会话关联的角色，修改历史默认显示它 */
  characterId: string | null;
}

/** Agent 设置：接口和模型、`Agents.md`、`memory.md`、记忆修改历史。未保存的文档修改在关掉抽屉后仍保留。 */
export default function AgentSettingsDrawer({ open, onClose, onModelSaved, characterId }: Props) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<SettingsTab>('model');
  const [agentsState, setAgentsState] = useState<AgentDocumentState>({ document: null, draft: undefined, versions: [], hasMore: false });
  const [memoryState, setMemoryState] = useState<AgentDocumentState>({ document: null, draft: undefined, versions: [], hasMore: false });
  const [modelState, setModelState] = useState<AgentModelState>({ saved: null, value: null });
  const [pendingWrites, setPendingWrites] = useState<Record<WriteTab, PendingWrite>>({ model: null, agents: null, memory: null });
  const pendingWritesRef = useRef(pendingWrites);

  const startWrite = (key: WriteTab, operation: Exclude<PendingWrite, null>): boolean => {
    if (pendingWritesRef.current[key] !== null) return false;
    const next = { ...pendingWritesRef.current, [key]: operation };
    pendingWritesRef.current = next;
    setPendingWrites(next);
    return true;
  };
  const finishWrite = (key: WriteTab) => {
    const next = { ...pendingWritesRef.current, [key]: null };
    pendingWritesRef.current = next;
    setPendingWrites(next);
  };

  const tabs: Array<{ id: SettingsTab; label: string }> = [
    { id: 'model', label: t('agent.settings.tabModel') },
    { id: 'agents', label: 'Agents.md' },
    { id: 'memory', label: 'memory.md' },
    { id: 'history', label: t('agent.settings.tabHistory') },
  ];

  return (
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel={t('agent.settings.title')}
      padded={false}
      overlayClassName="fixed inset-0 z-30 bg-black/35 animate-fadeIn"
      dialogClassName="fixed right-0 top-0 z-40 flex h-full w-[min(34rem,100vw)] flex-col bg-surface pt-[env(safe-area-inset-top)] outline-none"
    >
      <div className="flex h-14 flex-none items-center gap-2 border-b border-border-light pl-5 pr-2">
        <h2 className="section-title min-w-0 flex-1 truncate text-base">{t('agent.settings.title')}</h2>
        <button
          type="button"
          onClick={onClose}
          className="flex min-h-11 min-w-11 items-center justify-center rounded-xl text-text-secondary hover:bg-surface-2"
          aria-label={t('common.close')}
        >
          <XIcon className="h-5 w-5" />
        </button>
      </div>
      <div role="tablist" className="flex flex-none gap-1 overflow-x-auto border-b border-border-light px-3">
        {tabs.map(item => {
          const documentState = item.id === 'agents' ? agentsState : item.id === 'memory' ? memoryState : undefined;
          const unsaved = documentState?.draft !== undefined && documentState.draft !== documentState.document?.content;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`agent-settings-tab-${item.id}`}
              aria-selected={tab === item.id}
              aria-controls={`agent-settings-panel-${item.id}`}
              onClick={() => setTab(item.id)}
              className={`flex min-h-11 shrink-0 items-center gap-1.5 border-b-2 px-3 text-sm transition-colors ${
                tab === item.id
                  ? 'border-accent font-medium text-accent-dark'
                  : 'border-transparent text-text-secondary hover:text-text-primary'
              }`}
            >
              {item.label}
              {unsaved && (
                <span className="h-1.5 w-1.5 rounded-full bg-accent" title={t('agent.settings.unsaved')}>
                  <span className="sr-only">{t('agent.settings.unsaved')}</span>
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={`agent-settings-panel-${tab}`}
        aria-labelledby={`agent-settings-tab-${tab}`}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]"
      >
        {tab === 'model'
          ? <AgentModelSettings
            state={modelState}
            onStateChange={setModelState}
            onSaved={onModelSaved}
            saving={pendingWrites.model !== null}
            onSaveStart={() => startWrite('model', 'save')}
            onSaveEnd={() => finishWrite('model')}
          />
          : tab === 'history'
            ? <AgentProposalHistory defaultCharacterId={characterId} />
            : <AgentDocumentEditor
              key={tab}
              docKey={tab}
              state={tab === 'agents' ? agentsState : memoryState}
              onStateChange={tab === 'agents' ? setAgentsState : setMemoryState}
              pendingWrite={pendingWrites[tab]}
              onWriteStart={operation => startWrite(tab, operation)}
              onWriteEnd={() => finishWrite(tab)}
            />}
      </div>
    </Modal>
  );
}
