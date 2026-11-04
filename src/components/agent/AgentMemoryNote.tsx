'use client';

import { useRef, useState } from 'react';
import { useTranslation } from '@/lib/i18n-context';

export interface AgentMemoryNoteData {
  versionId: number;
  content: string;
  sessionId: string;
}

/** 记笔记结果始终可见；撤销由主人操作，服务端核对最新版本。 */
export default function AgentMemoryNote({ note, undone, disabled }: {
  note: AgentMemoryNoteData;
  undone: boolean;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const [locallyUndone, setLocallyUndone] = useState(false);
  const [error, setError] = useState('');
  const pendingRef = useRef(false);
  const isUndone = undone || locallyUndone;

  const undo = async () => {
    if (pendingRef.current || disabled || isUndone) return;
    pendingRef.current = true;
    setPending(true);
    setError('');
    try {
      const response = await fetch('/api/agent/documents/memory', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ undo_version_id: note.versionId, session_id: note.sessionId }),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(result.error || t('agent.memory.undoFailed'));
      }
      setLocallyUndone(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('agent.memory.undoFailed'));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  return (
    <section className="min-w-0 rounded-xl border border-accent/20 bg-accent/5 p-3" aria-busy={pending} data-agent-memory-note={note.versionId}>
      <p className="text-xs font-medium text-accent-dark">{t('agent.memory.saved')}</p>
      <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-text-primary [overflow-wrap:anywhere]">{note.content}</p>
      <button
        type="button"
        onClick={() => void undo()}
        disabled={disabled || pending || isUndone}
        className="soft-button soft-button-secondary mt-2 min-h-11 px-3 text-xs disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isUndone ? t('agent.memory.undone') : pending ? t('common.loading') : t('agent.memory.undo')}
      </button>
      {error && <p className="mt-2 text-xs text-danger [overflow-wrap:anywhere]" role="alert">{error}</p>}
    </section>
  );
}
