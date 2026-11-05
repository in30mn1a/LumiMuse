'use client';

import { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import type { AgentSession } from '@/lib/agent/store';
import { useTranslation } from '@/lib/i18n-context';
import { getErrorMessage } from '@/lib/http';
import { useToast } from '@/components/ui/Toast';
import { ArrowLeftIcon, ChatIcon, MenuIcon, SettingsIcon, SparkIcon } from '@/components/ui/icons';
import ContentState from '@/components/ui/ContentState';
import ConfirmModal from '@/components/ui/ConfirmModal';
import Modal from '@/components/ui/Modal';
import AgentComposer from '@/components/agent/AgentComposer';
import AgentMessageList from '@/components/agent/AgentMessageList';
import AgentSessionList from '@/components/agent/AgentSessionList';
import AgentSettingsDrawer from '@/components/agent/AgentSettingsDrawer';
import AgentStatusBar from '@/components/agent/AgentStatusBar';
import AgentTaskPlan from '@/components/agent/AgentTaskPlan';
import { useAgentChat } from '@/hooks/agent/useAgentChat';
import { useAgentModel } from '@/hooks/agent/useAgentModel';
import { useAgentSessions } from '@/hooks/agent/useAgentSessions';

const DESKTOP_LAYOUT_QUERY = '(min-width: 1024px)';

function sessionHref(id: string | null): string {
  return id ? `/agent?session=${encodeURIComponent(id)}` : '/agent';
}

interface SessionTarget {
  id: string;
  revision: number;
}

function AgentPageInner() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeId = searchParams.get('session');
  const conversationParam = searchParams.get('conversation');

  const sessions = useAgentSessions();
  const { create: createSession, refresh: refreshSessions } = sessions;
  const [statusKey, setStatusKey] = useState(0);
  const [modelKey, setModelKey] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<AgentSession | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [sendPending, setSendPending] = useState(false);
  const sendPendingRef = useRef(false);
  const mountedRef = useRef(true);
  const locationRef = useRef({ sessionId: activeId, conversationId: conversationParam, revision: 0 });
  const creationRef = useRef<{ revision: number; promise: Promise<SessionTarget | null> } | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useLayoutEffect(() => {
    const current = locationRef.current;
    if (current.sessionId !== activeId || current.conversationId !== conversationParam) {
      locationRef.current = { sessionId: activeId, conversationId: conversationParam, revision: current.revision + 1 };
    }
  }, [activeId, conversationParam]);

  const navigateSession = useCallback((id: string | null) => {
    locationRef.current = { sessionId: id, conversationId: null, revision: locationRef.current.revision + 1 };
    router.replace(sessionHref(id));
  }, [router]);

  // 入口自动关联与首次发送复用同一个创建请求；用户切走后，旧请求仅完成创建，不再导航或发送。
  const ensureSession = useCallback((): Promise<SessionTarget | null> => {
    const current = locationRef.current;
    if (current.sessionId) return Promise.resolve({ id: current.sessionId, revision: current.revision });
    if (creationRef.current?.revision === current.revision) return creationRef.current.promise;
    const promise = createSession(current.conversationId ? { conversation_id: current.conversationId } : {})
      .then(session => {
        if (!mountedRef.current || locationRef.current.revision !== current.revision) return null;
        navigateSession(session.id);
        return { id: session.id, revision: locationRef.current.revision };
      })
      .catch(error => {
        if (!mountedRef.current || locationRef.current.revision !== current.revision) return null;
        showToast(`${t('agent.createFailed')}: ${getErrorMessage(error)}`, 'error');
        if (current.conversationId) navigateSession(null);
        return null;
      })
      .finally(() => {
        if (creationRef.current?.promise === promise) creationRef.current = null;
      });
    creationRef.current = { revision: current.revision, promise };
    return promise;
  }, [createSession, navigateSession, showToast, t]);

  const handleTurnFinished = useCallback(() => {
    void refreshSessions();
    setStatusKey(key => key + 1);
  }, [refreshSessions]);
  const chat = useAgentChat(activeId, { onTurnFinished: handleTurnFinished });
  // 输入框里换模型后刷新状态和占用；正在运行时保持本轮的实时数值。
  const refreshStatus = () => {
    setStatusKey(key => key + 1);
    if (!chat.sending) void chat.reload();
  };
  const agentModel = useAgentModel(modelKey, refreshStatus);

  useEffect(() => {
    if (conversationParam && locationRef.current.conversationId === conversationParam) void ensureSession();
  }, [conversationParam, ensureSession]);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(DESKTOP_LAYOUT_QUERY);
    const closeIfDesktop = () => {
      if (mq.matches) setDrawerOpen(false);
    };
    closeIfDesktop();
    mq.addEventListener('change', closeIfDesktop);
    return () => mq.removeEventListener('change', closeIfDesktop);
  }, []);

  const selectSession = (id: string | null) => {
    setDrawerOpen(false);
    navigateSession(id);
  };

  const handleSend = async (content: string): Promise<boolean> => {
    if (sendPendingRef.current) return false;
    sendPendingRef.current = true;
    setSendPending(true);
    try {
      const sessionReady = ensureSession();
      const [target, modelSaved] = await Promise.all([sessionReady, agentModel.waitForModelWrites(sessionReady)]);
      if (!modelSaved || !target || !mountedRef.current || locationRef.current.revision !== target.revision) return false;
      const failure = await chat.send(target.id, content);
      if (failure?.kind === 'busy') showToast(t('agent.busy'), 'error');
      else if (failure) {
        const label = t(failure.kind === 'interrupted' ? 'agent.streamInterrupted' : 'agent.sendFailed');
        showToast(failure.message ? `${label}: ${failure.message}` : label, 'error');
      }
      return failure === null || failure.kind === 'interrupted';
    } finally {
      sendPendingRef.current = false;
      if (mountedRef.current) setSendPending(false);
    }
  };

  const handleCompact = async () => {
    const target = locationRef.current;
    if (!target.sessionId || sendPendingRef.current) return;
    sendPendingRef.current = true;
    setSendPending(true);
    try {
      if (!await agentModel.waitForModelWrites(Promise.resolve({ id: target.sessionId, revision: target.revision }))) return;
      if (!mountedRef.current || locationRef.current.revision !== target.revision) return;
      const compacted = await chat.compact(target.sessionId);
      if (compacted !== null && mountedRef.current && locationRef.current.revision === target.revision) {
        showToast(t(compacted ? 'agent.context.compacted' : 'agent.context.nothingToCompact'), 'success');
      }
    } catch (error) {
      if (mountedRef.current && locationRef.current.revision === target.revision) {
        showToast(`${t('agent.context.compactFailed')}: ${getErrorMessage(error)}`, 'error');
      }
    } finally {
      sendPendingRef.current = false;
      if (mountedRef.current) setSendPending(false);
    }
  };

  // 决定结果已作为事件写入会话；「批准并继续」接着开始下一轮
  const handleProposalDecided = async (continueNext: boolean) => {
    const target = locationRef.current;
    await chat.reload();
    if (
      continueNext
      && mountedRef.current
      && locationRef.current.sessionId === target.sessionId
      && locationRef.current.revision === target.revision
    ) {
      void handleSend(t('agent.proposal.continuePrompt'));
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await sessions.remove(pendingDelete.id);
      if (pendingDelete.id === activeId) router.replace(sessionHref(null));
      setPendingDelete(null);
    } catch (error) {
      showToast(`${t('common.operationFailed')}: ${getErrorMessage(error)}`, 'error');
    } finally {
      setDeleting(false);
    }
  };

  const sessionList = (
    <AgentSessionList
      sessions={sessions.sessions}
      activeId={activeId}
      loading={sessions.loading}
      error={sessions.error}
      hasMore={sessions.hasMore}
      loadingMore={sessions.loadingMore}
      onSelect={selectSession}
      onNew={() => selectSession(null)}
      onDelete={setPendingDelete}
      onLoadMore={() => void sessions.loadMore()}
      onRetry={() => void sessions.refresh()}
    />
  );

  const boundToConversation = Boolean(chat.detail?.session.conversation_id);
  const quickPrompts = [
    ...(boundToConversation ? [t('agent.quick.suggestReply')] : []),
    t('agent.quick.recentErrors'),
    t('agent.quick.memoryHealth'),
    t('agent.quick.memoryReview'),
  ];
  const emptyState = (
    <div className="mx-auto flex max-w-xl flex-col items-center px-6 py-12 text-center">
      <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-surface-2 text-accent-dark" aria-hidden="true">
        <SparkIcon className="h-6 w-6" />
      </span>
      <p className="text-sm font-medium text-text-primary">{t('agent.emptyTitle')}</p>
      <p className="mt-2 text-sm leading-relaxed text-text-muted">{t('agent.emptyBody')}</p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        {quickPrompts.map(prompt => (
          <button
            key={prompt}
            type="button"
            disabled={sendPending || chat.sending || chat.serverRunning}
            onClick={() => void handleSend(prompt)}
            className="chip min-h-9 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {prompt}
          </button>
        ))}
      </div>
    </div>
  );

  let body: ReactNode;
  if (activeId && chat.loadError) {
    body = (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ContentState
          mode="error"
          title={chat.loadError.notFound ? t('agent.sessionNotFound') : t('agent.loadSessionFailed')}
          description={chat.loadError.notFound ? undefined : chat.loadError.message}
          action={chat.loadError.notFound
            ? <button type="button" onClick={() => selectSession(null)} className="soft-button soft-button-secondary px-4 py-2">{t('agent.newSession')}</button>
            : <button type="button" onClick={() => void chat.reload()} className="soft-button soft-button-secondary px-4 py-2">{t('common.retry')}</button>}
        />
      </div>
    );
  } else if (activeId && !chat.detail && !chat.live) {
    body = <div className="min-h-0 flex-1"><ContentState mode="loading" title={t('common.loading')} /></div>;
  } else {
    // 按会话重新挂载，切换会话时滚动位置不沿用上一个会话
    body = (
      <AgentMessageList
        key={activeId ?? ''}
        messages={chat.detail?.messages ?? []}
        live={chat.live}
        emptyState={emptyState}
        proposalBusy={sendPending || chat.sending || chat.serverRunning}
        onProposalDecided={continueNext => void handleProposalDecided(continueNext)}
      />
    );
  }

  return (
    <div className="app-shell flex h-dvh">
      <aside className="hidden h-full w-72 shrink-0 flex-col border-r border-border-light bg-surface lg:flex">
        <div className="flex h-14 items-center gap-2 border-b border-border-light px-3">
          <Link href="/" className="soft-button soft-button-ghost min-h-10 px-2.5" aria-label={t('common.back')}>
            <ArrowLeftIcon className="h-4 w-4" />
          </Link>
          <p className="section-title text-base">{t('agent.sessions')}</p>
        </div>
        {sessionList}
      </aside>

      <Modal
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        ariaLabel={t('agent.sessions')}
        padded={false}
        initialFocus="dialog"
        overlayClassName="fixed inset-0 z-30 bg-black/35 animate-fadeIn lg:hidden"
        dialogClassName="fixed left-0 top-0 z-40 flex h-full w-[min(20rem,85vw)] flex-col bg-surface pt-[env(safe-area-inset-top)] outline-none lg:hidden"
      >
        <div className="flex h-14 items-center border-b border-border-light px-4">
          <p className="section-title text-base">{t('agent.sessions')}</p>
        </div>
        {sessionList}
      </Modal>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex h-14 flex-none items-center gap-1 border-b border-border-light bg-surface px-1 lg:px-4">
          <Link href="/" className="flex min-h-11 min-w-11 items-center justify-center rounded-xl text-text-secondary hover:bg-surface-2 lg:hidden" aria-label={t('common.back')}>
            <ArrowLeftIcon className="h-5 w-5" />
          </Link>
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="flex min-h-11 min-w-11 items-center justify-center rounded-xl text-text-secondary hover:bg-surface-2 lg:hidden"
            aria-label={t('agent.openSessions')}
          >
            <MenuIcon className="h-5 w-5" />
          </button>
          <div className="min-w-0 flex-1 px-1">
            <h1 className="truncate text-base font-semibold text-text-primary">
              {chat.detail?.session.title || t('agent.title')}
            </h1>
            {boundToConversation && (
              <p className="flex items-center gap-1 text-xs text-text-muted">
                <ChatIcon className="h-3 w-3 shrink-0" />
                <span className="truncate">{t('agent.boundConversation')}</span>
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-xl text-text-secondary hover:bg-surface-2"
            aria-label={t('agent.openSettings')}
            title={t('agent.settings.title')}
          >
            <SettingsIcon className="h-5 w-5" />
          </button>
        </header>

        <AgentStatusBar refreshKey={statusKey} />

        {chat.detail?.task_plan && <AgentTaskPlan plan={chat.detail.task_plan} />}

        {chat.compacting && (
          <p className="border-b border-border-light bg-surface-2/50 px-4 py-2 text-xs text-text-muted" role="status">
            {t('agent.context.compacting')}
          </p>
        )}

        {chat.serverRunning && (
          <p className="border-b border-border-light bg-surface-2/50 px-4 py-2 text-xs text-text-muted" role="status">
            {t('agent.runningOnServer')}
          </p>
        )}

        {body}

        <AgentComposer
          busy={sendPending || chat.sending || chat.serverRunning}
          canStop={chat.live !== null || chat.serverRunning || chat.compacting}
          onSend={handleSend}
          onStop={chat.stop}
          model={agentModel}
          context={chat.context}
          onCompact={() => void handleCompact()}
          compacting={chat.compacting}
          compactDisabled={sendPending || chat.sending || chat.serverRunning || !chat.detail?.messages.some(message => message.role !== 'event')}
        />
      </main>

      <AgentSettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onModelSaved={() => {
          setStatusKey(key => key + 1);
          setModelKey(key => key + 1);
          // 窗口或模型变了，占用和阈值要重新算；正在运行时等本轮结束后的刷新
          if (!chat.sending) void chat.reload();
        }}
        characterId={chat.detail?.session.character_id ?? null}
      />

      <ConfirmModal
        open={pendingDelete !== null}
        title={t('agent.deleteSession')}
        message={t('agent.deleteSessionConfirm')}
        confirmLabel={t('common.delete')}
        danger
        busy={deleting}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}

// useSearchParams 需要包在 Suspense 里
export default function AgentPage() {
  const { t } = useTranslation();
  return (
    <Suspense fallback={<ContentState mode="loading" title={t('common.loading')} />}>
      <AgentPageInner />
    </Suspense>
  );
}
