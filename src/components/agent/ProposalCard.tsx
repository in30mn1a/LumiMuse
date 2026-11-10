'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProposalEvidenceMessage, ProposalItemView, ProposalView } from '@/lib/agent/proposals';
import { conflictMemoryIds, isCheckedByDefault, proposalItemFlags } from '@/lib/agent/proposal-flags';
import { getErrorMessage, HttpResponseError, parseJsonResponse } from '@/lib/http';
import { useTranslation } from '@/lib/i18n-context';
import { formatTemplate } from '@/lib/i18n';
import { refreshCharacterList } from '@/lib/character-list-cache';
import { clearCachedMessages } from '@/lib/chat-message-cache';
import ProposalCardItem from './ProposalCardItem';

type DecideMode = 'apply' | 'continue' | 'reject';

function isPendingDecision(item: ProposalItemView): boolean {
  return item.state === 'pending' && item.op !== 'report_conflict';
}

function defaultSelection(view: ProposalView): Set<number> {
  const conflicts = conflictMemoryIds(view.items);
  return new Set(view.items
    .filter(item => isPendingDecision(item) && isCheckedByDefault(proposalItemFlags(item, { conflictMemoryIds: conflicts })))
    .map(item => item.id));
}

function refreshChangedCharacters(previous: ProposalView, next: ProposalView): void {
  const changed = next.items.some(item => {
    if (!item.before || !('character' in item.before || 'character_creation' in item.before)) return false;
    const previousState = previous.items.find(before => before.id === item.id)?.state;
    return (previousState === 'pending' && item.state === 'applied')
      || (previousState === 'applied' && item.state === 'undone');
  });
  // 决定已成功，列表刷新失败不应把它显示为批准或撤销失败。
  if (changed) void refreshCharacterList().catch(() => {});
  // 消息正文变了：子对话会继承父对话的消息，无法只清一个对话，整个客户端消息缓存作废后重新读取。
  const messageChanged = next.items.some(item => item.before && 'message' in item.before
    && previous.items.find(before => before.id === item.id)?.state !== item.state
    && (item.state === 'applied' || item.state === 'undone'));
  if (messageChanged) clearCachedMessages();
}

async function postDecision(proposalId: number, body: unknown): Promise<ProposalView> {
  return parseJsonResponse<ProposalView>(await fetch(`/api/agent/proposals/${proposalId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

interface Props {
  proposalId: number;
  /** 修改历史已经拿到完整视图，不必再请求 */
  initialView?: ProposalView;
  /** 会话正在运行：决定会写入会话，要等运行结束 */
  busy?: boolean;
  /** false 时只能查看和撤销，待批准的项回到会话里处理 */
  decidable?: boolean;
  /** 批准或拒绝成功后调用；continueNext 表示主人点了「批准并继续」 */
  onDecided?: (continueNext: boolean) => void;
}

/** 修改提案卡片：逐项勾选后统一批准，已生效的项可以撤销。 */
export default function ProposalCard({ proposalId, initialView, busy = false, decidable = true, onDecided }: Props) {
  const { t } = useTranslation();
  const [view, setView] = useState<ProposalView | null>(initialView ?? null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(() => (initialView ? defaultSelection(initialView) : new Set()));
  const [rejectReason, setRejectReason] = useState('');
  const [submitting, setSubmitting] = useState<DecideMode | null>(null);
  const [decideError, setDecideError] = useState<string | null>(null);
  const [undoing, setUndoing] = useState<number | null>(null);
  const [undoErrors, setUndoErrors] = useState<Record<number, string>>({});
  const mountedRef = useRef(true);
  // 连点时 state 还没更新，用 ref 挡住第二次请求
  const actionRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const load = useCallback(async (resetSelection: boolean) => {
    try {
      const next = await parseJsonResponse<ProposalView>(await fetch(`/api/agent/proposals/${proposalId}`));
      if (!mountedRef.current) return;
      setView(next);
      if (resetSelection) setSelected(defaultSelection(next));
      setLoadError(null);
    } catch (error) {
      if (mountedRef.current) setLoadError(getErrorMessage(error));
    }
  }, [proposalId]);

  // 没有现成视图时取一次；之后以批准、撤销接口返回的视图为准
  useEffect(() => {
    if (!initialView) void load(true);
  }, [initialView, load]);

  const messages = useMemo(
    () => new Map<string, ProposalEvidenceMessage>((view?.evidence_messages ?? []).map(message => [message.id, message])),
    [view],
  );

  if (!view) {
    return (
      <section className="min-w-0 rounded-2xl border border-accent/25 bg-surface px-3 py-3 text-xs" data-proposal-id={proposalId}>
        {loadError ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 flex-1 text-danger [overflow-wrap:anywhere]" role="alert">
              {formatTemplate(t('agent.proposal.loadFailed'), { reason: loadError })}
            </p>
            <button type="button" onClick={() => void load(true)} className="soft-button soft-button-secondary min-h-9 px-3 text-xs">
              {t('common.retry')}
            </button>
          </div>
        ) : (
          <p className="text-text-muted" role="status">{t('agent.proposal.loading')}</p>
        )}
      </section>
    );
  }

  const changes = view.items.filter(item => item.op !== 'report_conflict');
  const conflicts = view.items.filter(item => item.op === 'report_conflict');
  const pendingIds = changes.filter(isPendingDecision).map(item => item.id);
  const selectedCount = pendingIds.filter(id => selected.has(id)).length;
  const locked = submitting !== null || undoing !== null;

  const decide = async (mode: DecideMode) => {
    if (actionRef.current || pendingIds.length === 0) return;
    actionRef.current = true;
    const approved = mode === 'reject' ? [] : pendingIds.filter(id => selected.has(id));
    const reason = rejectReason.trim();
    const rejected = reason ? pendingIds.filter(id => !approved.includes(id)).map(id => ({ id, reason })) : [];
    setSubmitting(mode);
    setDecideError(null);
    try {
      const next = await postDecision(proposalId, { action: 'apply', approved_item_ids: approved, rejected_items: rejected });
      refreshChangedCharacters(view, next);
      if (!mountedRef.current) return;
      setView(next);
      setRejectReason('');
      onDecided?.(mode === 'continue');
    } catch (error) {
      if (!mountedRef.current) return;
      setDecideError(getErrorMessage(error));
      // 别处已经处理过这份提案时，重新读取以显示真实状态
      const data = error instanceof HttpResponseError ? error.data as { code?: unknown } | null : null;
      if (error instanceof HttpResponseError && error.status === 409 && data?.code !== 'agent_busy') void load(false);
    } finally {
      actionRef.current = false;
      if (mountedRef.current) setSubmitting(null);
    }
  };

  const undoItem = async (itemId: number) => {
    if (actionRef.current) return;
    actionRef.current = true;
    setUndoing(itemId);
    setUndoErrors(current => {
      const next = { ...current };
      delete next[itemId];
      return next;
    });
    try {
      const next = await postDecision(proposalId, { action: 'undo', item_id: itemId });
      refreshChangedCharacters(view, next);
      if (mountedRef.current) setView(next);
    } catch (error) {
      if (mountedRef.current) setUndoErrors(current => ({ ...current, [itemId]: getErrorMessage(error) }));
    } finally {
      actionRef.current = false;
      if (mountedRef.current) setUndoing(null);
    }
  };

  const conflictTargets = conflictMemoryIds(conflicts);
  const renderItem = (item: ProposalItemView) => {
    const flags = proposalItemFlags(item, { conflictMemoryIds: conflictTargets });
    const selectable = decidable && isPendingDecision(item);
    return (
      <ProposalCardItem
        key={item.id}
        item={item}
        flags={flags}
        messages={messages}
        selection={selectable ? {
          checked: selected.has(item.id),
          disabled: locked,
          onChange: checked => setSelected(current => {
            const next = new Set(current);
            if (checked) next.add(item.id);
            else next.delete(item.id);
            return next;
          }),
        } : undefined}
        undo={item.state === 'applied' ? {
          busy: undoing === item.id,
          disabled: locked,
          error: undoErrors[item.id] ?? null,
          onUndo: () => void undoItem(item.id),
        } : undefined}
      />
    );
  };

  return (
    <section
      className="min-w-0 rounded-2xl border border-accent/25 bg-surface px-3 py-3 text-xs text-text-primary [overflow-wrap:anywhere] sm:px-4"
      aria-label={t('agent.proposal.title')}
      data-proposal-id={view.id}
    >
      <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        <h3 className="text-sm font-semibold">{t('agent.proposal.title')}</h3>
        <span className="rounded-md border border-border-light px-1.5 py-0.5 text-[11px] text-text-muted">
          {view.status === 'pending' ? t('agent.proposal.statusPending') : t('agent.proposal.statusDecided')}
        </span>
        {view.session_id === null && <span className="text-[11px] text-text-muted">{t('agent.proposal.sessionDeleted')}</span>}
        <time dateTime={view.created_at} className="ml-auto text-[11px] text-text-muted">
          {new Date(view.created_at).toLocaleString()}
        </time>
      </div>
      {view.summary && <p className="mb-3 whitespace-pre-wrap text-sm leading-relaxed">{view.summary}</p>}

      {changes.length > 0 && <ul className="space-y-2">{changes.map(renderItem)}</ul>}

      {conflicts.length > 0 && (
        <div className={changes.length > 0 ? 'mt-3' : undefined}>
          <p className="mb-1.5 text-[11px] font-medium text-text-muted">
            {formatTemplate(t('agent.proposal.conflicts'), { count: conflicts.length })}
          </p>
          <ul className="space-y-2">{conflicts.map(renderItem)}</ul>
        </div>
      )}

      {pendingIds.length > 0 && (decidable ? (
        <div className="mt-3 space-y-2 border-t border-border-light pt-3">
          <label htmlFor={`proposal-reason-${view.id}`} className="block text-[11px] text-text-muted">
            {t('agent.proposal.rejectReason')}
          </label>
          <textarea
            id={`proposal-reason-${view.id}`}
            value={rejectReason}
            onChange={event => setRejectReason(event.target.value)}
            rows={2}
            maxLength={2000}
            disabled={locked}
            className="textarea-rich w-full resize-y text-xs"
          />
          {busy && <p className="text-[11px] text-text-muted" role="status">{t('agent.proposal.busy')}</p>}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void decide('apply')}
              disabled={busy || locked || selectedCount === 0}
              className="soft-button soft-button-primary min-h-10 px-3 text-xs"
            >
              {formatTemplate(t('agent.proposal.approveSelected'), { count: selectedCount })}
            </button>
            <button
              type="button"
              onClick={() => void decide('continue')}
              disabled={busy || locked || selectedCount === 0}
              className="soft-button soft-button-secondary min-h-10 px-3 text-xs"
            >
              {t('agent.proposal.approveContinue')}
            </button>
            <button
              type="button"
              onClick={() => void decide('reject')}
              disabled={busy || locked}
              className="soft-button soft-button-ghost min-h-10 px-3 text-xs"
            >
              {t('agent.proposal.rejectAll')}
            </button>
          </div>
        </div>
      ) : (
        <p className="mt-3 text-[11px] text-text-muted">{t('agent.proposal.decideInSession')}</p>
      ))}
      {/* 放在操作区外：别处已处理时重新读取后操作区消失，原因仍要留着 */}
      {decideError && (
        <p className="mt-2 text-danger" role="alert">{formatTemplate(t('agent.proposal.decideFailed'), { reason: decideError })}</p>
      )}
    </section>
  );
}
