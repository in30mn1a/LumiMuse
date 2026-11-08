'use client';

import type React from 'react';
import type {
  ProposalCandidateTask,
  ProposalCandidateTarget,
  ProposalEvidenceMessage,
  ProposalItemView,
  ProposalMemoryFields,
  ProposalMemoryTarget,
  ProposalRepairAfter,
} from '@/lib/agent/proposals';
import { NO_EVIDENCE_NOTE, type ProposalItemFlags } from '@/lib/agent/proposal-flags';
import { diffText } from '@/lib/text-diff';
import { useTranslation } from '@/lib/i18n-context';
import { formatTemplate } from '@/lib/i18n';
import { getMemorySourceAttribution } from '@/lib/metadata';
import type { CharacterCardField, CharacterCardSnapshot, ProposalCharacterFields } from '@/lib/agent/character-card';

type MemoryField = keyof ProposalMemoryFields;
/** 快照与提案字段都按这个形状读；值来自 JSON，逐个判断类型再显示。 */
type MemoryLike = Partial<Record<MemoryField, unknown>> & { metadata?: unknown };

const META_FIELDS: readonly MemoryField[] = ['category', 'memory_kind', 'importance', 'emotional_weight', 'tags', 'pinned'];
const FIELD_ORDER: readonly MemoryField[] = ['content', ...META_FIELDS, 'source_msg_ids'];
const CHARACTER_FIELD_ORDER: readonly CharacterCardField[] = [
  'name', 'basic_info', 'personality', 'scenario', 'greeting', 'example_dialogue',
  'system_prompt', 'other_info', 'image_tags', 'user_image_tags', 'image_prompt_other_requirements',
];

const STATE_STYLE: Record<ProposalItemView['state'], string> = {
  pending: 'border-border-light text-text-muted',
  applied: 'border-emerald-500/40 text-emerald-700 dark:text-emerald-300',
  rejected: 'border-border-light text-text-muted',
  stale: 'border-amber-500/40 text-amber-700 dark:text-amber-300',
  failed: 'border-danger/40 text-danger',
  undone: 'border-border-light text-text-muted',
  reported: 'border-accent/40 text-accent-dark',
};

const WARNING_CHIP = 'rounded-md border border-amber-500/40 bg-amber-50 px-1.5 py-0.5 text-amber-800 dark:bg-amber-950/30 dark:text-amber-200';

function useFieldValue() {
  const { t } = useTranslation();
  return (field: MemoryField, value: unknown): string => {
    if (value === undefined || value === null) return '—';
    if (field === 'pinned') return value ? t('agent.proposal.yes') : t('agent.proposal.no');
    if (field === 'source_msg_ids' && Array.isArray(value)) return value.length > 0 ? value.join('\n') : t('agent.proposal.noSources');
    if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : '—';
    if (typeof value === 'number') return String(Math.round(value * 100) / 100);
    return String(value);
  };
}

function MemoryMeta({ memory }: { memory: MemoryLike }) {
  const { t } = useTranslation();
  const fieldValue = useFieldValue();
  const parts = META_FIELDS
    .filter(field => memory[field] !== undefined && !(Array.isArray(memory[field]) && (memory[field] as unknown[]).length === 0))
    .map(field => `${t(`agent.proposal.field.${field}`)}：${fieldValue(field, memory[field])}`);
  if (parts.length === 0) return null;
  return <p className="mt-1 text-[11px] leading-relaxed text-text-muted">{parts.join(' · ')}</p>;
}

function MemoryBox({ memory, muted = false }: { memory: MemoryLike; muted?: boolean }) {
  return (
    <div className={`rounded-lg border border-border-light px-2.5 py-2 ${muted ? 'bg-surface-2/40 text-text-secondary' : 'bg-surface'}`}>
      <p className="whitespace-pre-wrap leading-relaxed">{typeof memory.content === 'string' ? memory.content : '—'}</p>
      <MemoryMeta memory={memory} />
    </div>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-[11px] font-medium text-text-muted">{label}</p>
      {children}
    </div>
  );
}

function MemoryList({ label, memories }: { label: string; memories: MemoryLike[] }) {
  return (
    <Labeled label={label}>
      <div className="space-y-1.5">
        {memories.map((memory, index) => <MemoryBox key={index} memory={memory} muted />)}
      </div>
    </Labeled>
  );
}

function ContentDiff({ before, after }: { before: string; after: string }) {
  const diff = diffText(before, after);
  return (
    <p className="whitespace-pre-wrap rounded-lg border border-border-light bg-surface px-2.5 py-2 leading-relaxed">
      {diff.prefix}
      {diff.removed && <del className="rounded-sm bg-danger/10 text-danger decoration-danger/60">{diff.removed}</del>}
      {diff.added && <ins className="rounded-sm bg-emerald-500/15 text-emerald-800 no-underline dark:text-emerald-200">{diff.added}</ins>}
      {diff.suffix}
    </p>
  );
}

function UpdateDiff({ before, changes }: { before: MemoryLike; changes: MemoryLike }) {
  const { t } = useTranslation();
  const fieldValue = useFieldValue();
  return (
    <div className="space-y-2">
      {'source_msg_ids' in changes && !('content' in changes) && <MemoryBox memory={before} muted />}
      {FIELD_ORDER.filter(field => field in changes).map(field => (
        <Labeled key={field} label={t(`agent.proposal.field.${field}`)}>
          {field === 'content'
            ? <ContentDiff before={String(before.content ?? '')} after={String(changes.content ?? '')} />
            : (
              <p className="whitespace-pre-wrap leading-relaxed [overflow-wrap:anywhere]">
                <del className="text-text-muted decoration-danger/60">{fieldValue(field, before[field])}</del>
                <span className="px-1.5 text-text-muted" aria-hidden="true">→</span>
                <ins className="font-medium text-emerald-800 no-underline dark:text-emerald-200">{fieldValue(field, changes[field])}</ins>
              </p>
            )}
        </Labeled>
      ))}
      {'source_msg_ids' in changes && (
        <Labeled label={t('agent.proposal.sourceAttribution')}>
          <p className="leading-relaxed">
            <del className="text-text-muted decoration-danger/60">{t(`agent.proposal.attribution.${getMemorySourceAttribution(before.metadata).granularity}`)}</del>
            <span className="px-1.5 text-text-muted" aria-hidden="true">→</span>
            <ins className="font-medium text-emerald-800 no-underline dark:text-emerald-200">{t(`agent.proposal.attribution.${Array.isArray(changes.source_msg_ids) && changes.source_msg_ids.length > 0 ? 'message' : 'unknown'}`)}</ins>
          </p>
        </Labeled>
      )}
    </div>
  );
}

function CharacterUpdateDiff({ before, changes, id }: { before: CharacterCardSnapshot; changes: ProposalCharacterFields; id: string }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <p className="font-medium">{formatTemplate(t('agent.proposal.character'), { name: before.name || id })}</p>
      {CHARACTER_FIELD_ORDER.filter(field => field in changes).map(field => (
        <Labeled key={field} label={t(`agent.proposal.field.${field}`)}>
          <ContentDiff before={before[field]} after={changes[field] ?? ''} />
        </Labeled>
      ))}
    </div>
  );
}

function CharacterCreation({ fields }: { fields: ProposalCharacterFields }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <p className="font-medium [overflow-wrap:anywhere]">{formatTemplate(t('agent.proposal.character'), { name: fields.name ?? '' })}</p>
      <p className="text-[11px] leading-relaxed text-text-muted">{t('agent.proposal.characterCreateHint')}</p>
      {CHARACTER_FIELD_ORDER.map(field => (
        <Labeled key={field} label={t(`agent.proposal.field.${field}`)}>
          <p className="whitespace-pre-wrap rounded-lg border border-border-light bg-surface px-2.5 py-2 leading-relaxed [overflow-wrap:anywhere]">
            {fields[field] || '—'}
          </p>
        </Labeled>
      ))}
    </div>
  );
}

function CandidateInfo({ candidate, currentTask }: { candidate: ProposalCandidateTarget; currentTask?: ProposalCandidateTask | null }) {
  const { t } = useTranslation();
  const task = candidate.task;
  const taskChanged = currentTask !== undefined
    && (task
      ? currentTask === null
        || currentTask.status !== task.status
        || currentTask.result_committed !== task.result_committed
        || currentTask.result_insert_count !== task.result_insert_count
      : currentTask !== null);
  return (
    <div className="space-y-1 rounded-lg border border-border-light bg-surface-2/40 px-2.5 py-2">
      <p className="font-medium">{formatTemplate(t('agent.proposal.candidate'), { id: candidate.id })}</p>
      {candidate.error_reason && <p className="whitespace-pre-wrap text-text-secondary">{candidate.error_reason}</p>}
      <p className="text-[11px] text-text-muted">
        {task
          ? formatTemplate(t('agent.proposal.taskInfo'), {
            id: candidate.task_id ?? '',
            status: t(`agent.proposal.task.${task.status}`),
            count: task.result_insert_count,
          })
          : t('agent.proposal.noTask')}
      </p>
      {taskChanged && (
        <p className="text-[11px] text-text-muted">
          {currentTask
            ? formatTemplate(t('agent.proposal.taskCurrentInfo'), {
              status: t(`agent.proposal.task.${currentTask.status}`),
              count: currentTask.result_insert_count,
            })
            : t('agent.proposal.taskCurrentMissing')}
        </p>
      )}
    </div>
  );
}

function memoriesOf(item: ProposalItemView): ProposalMemoryTarget[] {
  return item.before && 'memories' in item.before ? item.before.memories : [];
}

function candidateOf(item: ProposalItemView): ProposalCandidateTarget | null {
  return item.before && 'candidate' in item.before ? item.before.candidate : null;
}

/** 按操作类型显示修改前后。「修改前」都来自服务端读出的快照。 */
function ItemChange({ item }: { item: ProposalItemView }) {
  const { t } = useTranslation();
  const before = memoriesOf(item).map(target => target.snapshot as MemoryLike);
  const after = (item.after ?? {}) as MemoryLike;
  const candidate = candidateOf(item);
  switch (item.op) {
    case 'create':
      if (item.before && 'character_creation' in item.before) {
        return <CharacterCreation fields={(item.after ?? {}) as ProposalCharacterFields} />;
      }
      return <Labeled label={t('agent.proposal.new')}><MemoryBox memory={after} /></Labeled>;
    case 'update':
      if (item.before && 'character' in item.before) {
        return <CharacterUpdateDiff before={item.before.character.snapshot} changes={(item.after ?? {}) as ProposalCharacterFields} id={item.before.character.id} />;
      }
      return <UpdateDiff before={before[0] ?? {}} changes={after} />;
    case 'retire':
      return (
        <div className="space-y-1">
          <MemoryBox memory={before[0] ?? {}} muted />
          <p className="text-[11px] text-text-muted">{t('agent.proposal.retireHint')}</p>
        </div>
      );
    case 'merge':
      return (
        <div className="space-y-2">
          <MemoryList label={formatTemplate(t('agent.proposal.members'), { count: before.length })} memories={before} />
          <Labeled label={t('agent.proposal.mergeResult')}><MemoryBox memory={after} /></Labeled>
        </div>
      );
    case 'archive':
      return (
        <div className="space-y-2">
          <MemoryList label={formatTemplate(t('agent.proposal.archiveMembers'), { count: before.length })} memories={before} />
          <Labeled label={t('agent.proposal.archiveResult')}><MemoryBox memory={after} /></Labeled>
        </div>
      );
    case 'repair_candidate': {
      const memories = ((item.after ?? { memories: [] }) as ProposalRepairAfter).memories as MemoryLike[];
      return (
        <div className="space-y-2">
          {candidate && <CandidateInfo candidate={candidate} currentTask={item.current_candidate_task} />}
          <MemoryList label={formatTemplate(t('agent.proposal.repairMemories'), { count: memories.length })} memories={memories} />
        </div>
      );
    }
    case 'discard_candidate':
      return (
        <div className="space-y-1">
          {candidate && <CandidateInfo candidate={candidate} />}
          <p className="text-[11px] text-text-muted">{t('agent.proposal.discardHint')}</p>
        </div>
      );
    case 'report_conflict':
      return <MemoryList label={formatTemplate(t('agent.proposal.conflictMembers'), { count: before.length })} memories={before} />;
  }
}

function Evidence({ item, messages }: { item: ProposalItemView; messages: Map<string, ProposalEvidenceMessage> }) {
  const { t } = useTranslation();
  const ids = item.evidence.message_ids;
  const note = item.evidence.note;
  const ownerQuote = item.evidence.owner_quote;
  if (ids.length === 0 && !ownerQuote && (!note || note === NO_EVIDENCE_NOTE)) return null;
  return (
    <div className="space-y-1.5">
      {ownerQuote && (
        <blockquote className="rounded-lg border-l-2 border-accent/40 bg-surface-2/40 px-2.5 py-1.5" data-owner-quote="">
          <p className="mb-0.5 text-[11px] text-text-muted">{t('agent.proposal.ownerQuote')}</p>
          <p className="whitespace-pre-wrap leading-relaxed">{ownerQuote}</p>
        </blockquote>
      )}
      {ids.length > 0 && (
        <details className="group">
          <summary className="inline-flex min-h-8 cursor-pointer list-none items-center text-[11px] font-medium text-accent-dark [&::-webkit-details-marker]:hidden">
            {formatTemplate(t('agent.proposal.evidence'), { count: ids.length })}
          </summary>
          <div className="mt-1 space-y-1.5">
            {ids.map(id => {
              const message = messages.get(id);
              if (!message) {
                return (
                  <p key={id} className="rounded-lg border border-dashed border-border-light px-2.5 py-1.5 text-text-muted [overflow-wrap:anywhere]">
                    {formatTemplate(t('agent.proposal.evidenceMissing'), { id })}
                  </p>
                );
              }
              const role = message.role === 'user'
                ? t('agent.proposal.roleUser')
                : message.role === 'assistant' ? t('agent.proposal.roleAssistant') : message.role;
              return (
                <blockquote key={id} className="rounded-lg border-l-2 border-accent/40 bg-surface-2/40 px-2.5 py-1.5">
                  <p className="mb-0.5 text-[11px] text-text-muted">{role}</p>
                  <p className="whitespace-pre-wrap leading-relaxed">{message.content}</p>
                </blockquote>
              );
            })}
          </div>
        </details>
      )}
      {note && note !== NO_EVIDENCE_NOTE && (
        <p className="whitespace-pre-wrap text-text-secondary">
          <span className="text-text-muted">{t('agent.proposal.evidenceNote')}</span>
          {note}
        </p>
      )}
    </div>
  );
}

/** 已决定项的结果说明：拒绝原因、过期或失败的原因。 */
function ItemOutcome({ item }: { item: ProposalItemView }) {
  const { t } = useTranslation();
  if (item.state === 'rejected' && item.reject_reason) {
    return <p className="text-text-muted">{formatTemplate(t('agent.proposal.rejectedWith'), { reason: item.reject_reason })}</p>;
  }
  if (item.state === 'stale' || item.state === 'failed') {
    const detail = item.result && typeof item.result === 'object' && 'detail' in item.result
      ? String((item.result as { detail: unknown }).detail)
      : '';
    if (detail) return <p className={item.state === 'failed' ? 'text-danger' : 'text-amber-700 dark:text-amber-300'}>{detail}</p>;
  }
  return null;
}

interface Props {
  item: ProposalItemView;
  flags: ProposalItemFlags;
  messages: Map<string, ProposalEvidenceMessage>;
  /** 有值时显示复选框；矛盾发现和已决定的项没有 */
  selection?: { checked: boolean; disabled: boolean; onChange: (checked: boolean) => void };
  undo?: { busy: boolean; disabled: boolean; error: string | null; onUndo: () => void };
}

export default function ProposalCardItem({ item, flags, messages, selection, undo }: Props) {
  const { t } = useTranslation();
  const checkboxId = `proposal-item-${item.id}`;
  const opLabel = t(item.before && 'character_creation' in item.before
    ? 'agent.proposal.op.characterCreate'
    : item.before && 'character' in item.before ? 'agent.proposal.op.characterUpdate' : `agent.proposal.op.${item.op}`);
  return (
    <li className="min-w-0 space-y-2 rounded-xl border border-border-light bg-surface-raised px-3 py-2.5" data-proposal-item={item.id}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {selection ? (
          <label htmlFor={checkboxId} className="-my-1 -ml-1 flex min-h-9 cursor-pointer items-center gap-2 pl-1 pr-1">
            <input
              id={checkboxId}
              type="checkbox"
              checked={selection.checked}
              disabled={selection.disabled}
              onChange={event => selection.onChange(event.target.checked)}
              className="h-4 w-4 shrink-0 accent-[var(--color-accent)]"
            />
            <span className="font-medium text-text-primary">{opLabel}</span>
          </label>
        ) : (
          <span className="font-medium text-text-primary">{opLabel}</span>
        )}
        <span className={`text-[11px] ${flags.lowConfidence ? WARNING_CHIP : 'text-text-muted'}`}>
          {formatTemplate(t('agent.proposal.confidence'), { value: Math.round(item.confidence * 100) })}
          {flags.lowConfidence && ` · ${t('agent.proposal.flag.lowConfidence')}`}
        </span>
        {flags.noEvidence && <span className={`text-[11px] ${WARNING_CHIP}`}>{t('agent.proposal.flag.noEvidence')}</span>}
        {flags.conflictRetire && <span className={`text-[11px] ${WARNING_CHIP}`} data-flag="conflict-retire">{t('agent.proposal.flag.conflictRetire')}</span>}
        {item.state !== 'pending' && (
          <span className={`ml-auto rounded-md border px-1.5 py-0.5 text-[11px] ${STATE_STYLE[item.state]}`} data-proposal-state={item.state}>
            {t(`agent.proposal.state.${item.state}`)}
          </span>
        )}
      </div>

      {flags.duplicateRiskCount !== null && (
        <p className={`text-[11px] ${WARNING_CHIP}`}>
          {formatTemplate(t('agent.proposal.flag.duplicateRisk'), { count: flags.duplicateRiskCount })}
        </p>
      )}
      {flags.shrink && (
        <p className={`text-[11px] ${WARNING_CHIP}`} data-flag="shrink">
          {formatTemplate(t('agent.proposal.flag.shrink'), { percent: flags.shrink.percent, before: flags.shrink.before, after: flags.shrink.after })}
        </p>
      )}
      {flags.missingQuotes.length > 0 && (
        <p className={`text-[11px] ${WARNING_CHIP}`} data-flag="missing-quotes">
          {formatTemplate(t('agent.proposal.flag.missingQuotes'), { quotes: flags.missingQuotes.map(quote => `「${quote}」`).join('') })}
        </p>
      )}
      {flags.unfamiliarChars.length > 0 && (
        <p className={`text-[11px] ${WARNING_CHIP}`} data-flag="unfamiliar-chars">
          {formatTemplate(t('agent.proposal.flag.unfamiliarChars'), { chars: flags.unfamiliarChars.join('、') })}
        </p>
      )}

      <p className="whitespace-pre-wrap leading-relaxed text-text-primary">{item.reason}</p>
      <ItemChange item={item} />
      <Evidence item={item} messages={messages} />
      <ItemOutcome item={item} />

      {undo && (
        <div className="space-y-1">
          <button
            type="button"
            onClick={undo.onUndo}
            disabled={undo.disabled || undo.busy}
            className="soft-button soft-button-ghost min-h-9 px-2.5 text-xs"
          >
            {undo.busy ? t('agent.proposal.undoing') : t('agent.proposal.undo')}
          </button>
          {undo.error && (
            <p className="text-danger" role="alert">{formatTemplate(t('agent.proposal.undoFailed'), { reason: undo.error })}</p>
          )}
        </div>
      )}
    </li>
  );
}
