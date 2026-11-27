'use client';

import type React from 'react';
import type {
  PresetEntryAfter,
  PresetEntryBefore,
  PresetEntryCreateAfter,
  PresetEntryCreationBefore,
  PresetEntryDeletionBefore,
  PresetScriptAfter,
  PresetScriptBefore,
  PresetSettingsAfter,
  PresetSettingsBefore,
  PresetTextEdit,
  ProposalCandidateTask,
  ProposalCandidateTarget,
  ProposalEvidenceMemory,
  ProposalEvidenceMessage,
  ProposalItemView,
  ProposalMemoryFields,
  ProposalMemoryTarget,
  ProposalRepairAfter,
  ProposalWorkFields,
} from '@/lib/agent/proposals';
import { NO_EVIDENCE_NOTE, type ProposalItemFlags } from '@/lib/agent/proposal-flags';
import { diffText } from '@/lib/text-diff';
import { useTranslation } from '@/lib/i18n-context';
import { formatTemplate } from '@/lib/i18n';
import { getMemorySourceAttribution } from '@/lib/metadata';
import type { CharacterCardField, CharacterCardSnapshot, ProposalCharacterFields } from '@/lib/agent/character-card';
import type { WorkType } from '@/types';

type WorkField = keyof ProposalWorkFields;
/** 片单条目快照与提案字段都按这个形状读。 */
type WorkLike = Partial<Record<WorkField, unknown>>;
const WORK_FIELD_ORDER: readonly WorkField[] = ['work_type', 'title', 'aliases', 'status', 'rating', 'progress', 'note', 'first_seen_at'];
/** 条目概览里逐行显示的字段；类型和名称在标题行 */
const WORK_DETAIL_FIELDS: readonly WorkField[] = ['aliases', 'status', 'rating', 'progress', 'note'];

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

function idList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

/**
 * 来源列表按集合比较：新列表完整列出（新增的高亮），移除的旧来源折叠。
 * 批次来源可能上百条，细化成逐条后整列删除线会把卡片撑得很长。
 */
function SourceDiff({ before, after }: { before: unknown; after: unknown }) {
  const { t } = useTranslation();
  const beforeIds = idList(before);
  const afterIds = idList(after);
  const beforeSet = new Set(beforeIds);
  const afterSet = new Set(afterIds);
  const removed = beforeIds.filter(id => !afterSet.has(id));
  return (
    <div className="space-y-1 leading-relaxed [overflow-wrap:anywhere]">
      {afterIds.length > 0 ? (
        <ul data-sources="after">
          {afterIds.map(id => (
            <li key={id}>
              {beforeSet.has(id)
                ? id
                : <ins className="font-medium text-emerald-800 no-underline dark:text-emerald-200">{id}</ins>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="font-medium text-emerald-800 dark:text-emerald-200">{t('agent.proposal.noSources')}</p>
      )}
      {removed.length > 0 && (
        <details>
          <summary className="inline-flex min-h-8 cursor-pointer list-none items-center text-[11px] font-medium text-accent-dark [&::-webkit-details-marker]:hidden">
            {formatTemplate(t('agent.proposal.sourcesRemoved'), { count: removed.length })}
          </summary>
          <ul data-sources="removed">
            {removed.map(id => <li key={id}><del className="text-text-muted decoration-danger/60">{id}</del></li>)}
          </ul>
        </details>
      )}
    </div>
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
            : field === 'source_msg_ids'
            ? <SourceDiff before={before.source_msg_ids} after={changes.source_msg_ids} />
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

function useWorkFieldValue() {
  const { t } = useTranslation();
  return (field: WorkField, value: unknown, type: WorkType): string => {
    if (value === undefined || value === null || value === '') return '—';
    if (field === 'work_type') return t(`agent.works.type.${String(value)}`);
    if (field === 'status') return t(`agent.works.status.${type}.${String(value)}`);
    if (Array.isArray(value)) return value.length > 0 ? value.join(' / ') : '—';
    if (field === 'first_seen_at') {
      const date = new Date(String(value));
      return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString();
    }
    return String(value);
  };
}

function workTypeOf(value: unknown): WorkType {
  return value === 'series' || value === 'book' || value === 'game' ? value : 'movie';
}

function WorkTitle({ work }: { work: WorkLike }) {
  const { t } = useTranslation();
  return (
    <p className="font-medium [overflow-wrap:anywhere]" data-work-title="">
      {formatTemplate(t('agent.works.entry'), {
        type: t(`agent.works.type.${workTypeOf(work.work_type)}`),
        title: typeof work.title === 'string' ? work.title : '',
      })}
    </p>
  );
}

/** 条目概览：标题行加非空字段。 */
function WorkBox({ work, muted = false }: { work: WorkLike; muted?: boolean }) {
  const { t } = useTranslation();
  const fieldValue = useWorkFieldValue();
  const type = workTypeOf(work.work_type);
  const parts = WORK_DETAIL_FIELDS
    .filter(field => fieldValue(field, work[field], type) !== '—')
    .map(field => `${t(`agent.works.field.${field}`)}：${fieldValue(field, work[field], type)}`);
  return (
    <div className={`space-y-1 rounded-lg border border-border-light px-2.5 py-2 ${muted ? 'bg-surface-2/40 text-text-secondary' : 'bg-surface'}`}>
      <WorkTitle work={work} />
      {parts.length > 0 && <p className="text-[11px] leading-relaxed text-text-muted [overflow-wrap:anywhere]">{parts.join(' · ')}</p>}
    </div>
  );
}

/** 片单项：新增显示完整条目，修改逐字段对照修改前后，移除显示被移除的条目。 */
function WorkChange({ item }: { item: ProposalItemView }) {
  const { t } = useTranslation();
  const fieldValue = useWorkFieldValue();
  const before = item.before;
  if (before && 'work_creation' in before) {
    return <Labeled label={t('agent.works.new')}><WorkBox work={(item.after ?? {}) as WorkLike} /></Labeled>;
  }
  if (!before || !('work' in before)) return null;
  const entry = before.work as WorkLike & { dismissed_at: string | null };
  if (item.op === 'retire') {
    return (
      <div className="space-y-1">
        <WorkBox work={entry} muted />
        <p className="text-[11px] text-text-muted">{t('agent.works.retireHint')}</p>
      </div>
    );
  }
  const changes = (item.after ?? {}) as WorkLike;
  const fields = WORK_FIELD_ORDER.filter(field => field in changes);
  const beforeType = workTypeOf(entry.work_type);
  const afterType = workTypeOf(changes.work_type ?? entry.work_type);
  return (
    <div className="space-y-2">
      {fields.length > 0 ? <WorkTitle work={entry} /> : <WorkBox work={entry} muted />}
      {entry.dismissed_at !== null && <p className="text-[11px] text-text-muted" data-work-restore="">{t('agent.works.restoreHint')}</p>}
      {fields.map(field => (
        <Labeled key={field} label={t(`agent.works.field.${field}`)}>
          <p className="whitespace-pre-wrap leading-relaxed [overflow-wrap:anywhere]" data-work-field={field}>
            <del className="text-text-muted decoration-danger/60">{fieldValue(field, entry[field], beforeType)}</del>
            <span className="px-1.5 text-text-muted" aria-hidden="true">→</span>
            <ins className="font-medium text-emerald-800 no-underline dark:text-emerald-200">{fieldValue(field, changes[field], afterType)}</ins>
          </p>
        </Labeled>
      ))}
    </div>
  );
}

/** 片单项的操作名：对已移除条目的修改就是恢复。不是片单项时返回 null。 */
function workOpKey(item: ProposalItemView): string | null {
  if (!item.before) return null;
  if ('work_creation' in item.before) return 'agent.works.op.create';
  if (!('work' in item.before)) return null;
  if (item.op === 'retire') return 'agent.works.op.retire';
  return item.before.work.dismissed_at !== null ? 'agent.works.op.restore' : 'agent.works.op.update';
}

function presetOpKey(item: ProposalItemView): string | null {
  if (!item.before) return null;
  if ('preset_entry_creation' in item.before) return 'agent.proposal.op.presetEntryCreate';
  if ('preset_entry_deletion' in item.before) return 'agent.proposal.op.presetEntryDelete';
  if ('preset_entry' in item.before) return 'agent.proposal.op.presetEntryUpdate';
  if ('preset_settings' in item.before) return 'agent.proposal.op.presetSettingsUpdate';
  if ('preset_script' in item.before) return 'agent.proposal.op.presetScriptUpdate';
  return null;
}

const PRESET_DELETE_PREVIEW_LIMIT = 600;

/** 逐处渲染定位替换：不对整段长条目或脚本做整篇 diffText，避免中间十几万字撑爆卡片。 */
function PresetEdits({ edits }: { edits: readonly PresetTextEdit[] }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      {edits.map((edit, index) => (
        <Labeled key={index} label={formatTemplate(t('agent.proposal.presetEditIndex'), { index: index + 1 })}>
          <div data-preset-edit={index + 1}>
            <ContentDiff before={edit.old_text} after={edit.new_text} />
          </div>
        </Labeled>
      ))}
    </div>
  );
}

function PresetScalarDiff({ field, label, before, after }: { field: string; label: string; before: string; after: string }) {
  return (
    <Labeled label={label}>
      <p className="whitespace-pre-wrap leading-relaxed [overflow-wrap:anywhere]" data-preset-field={field}>
        <del className="text-text-muted decoration-danger/60">{before}</del>
        <span className="px-1.5 text-text-muted" aria-hidden="true">→</span>
        <ins className="font-medium text-emerald-800 no-underline dark:text-emerald-200">{after}</ins>
      </p>
    </Labeled>
  );
}

function PresetEntryChange({ before, after }: { before: PresetEntryBefore; after: PresetEntryAfter }) {
  const { t } = useTranslation();
  const enabledText = (value: boolean) => (value ? t('agent.proposal.presetEnabledOn') : t('agent.proposal.presetEnabledOff'));
  const yesNoText = (value: boolean) => (value ? t('agent.proposal.yes') : t('agent.proposal.no'));
  const posText = (value: number | undefined) => (
    value === 1 ? t('agent.proposal.presetPosInChat') : value === 0 ? t('agent.proposal.presetPosRelative') : '—'
  );
  return (
    <div className="space-y-2">
      <p className="font-medium [overflow-wrap:anywhere]">
        {formatTemplate(t('agent.proposal.preset'), { name: before.preset_name })}
        {' · '}
        {formatTemplate(t('agent.proposal.presetEntry'), { name: before.entry.name })}
      </p>
      {'name' in after && typeof after.name === 'string' && (
        <PresetScalarDiff field="name" label={t('agent.proposal.field.name')} before={before.entry.name} after={after.name} />
      )}
      {'enabled' in after && typeof after.enabled === 'boolean' && (
        <PresetScalarDiff field="enabled" label={t('agent.proposal.presetEnabled')} before={enabledText(before.entry.enabled)} after={enabledText(after.enabled)} />
      )}
      {'role' in after && typeof after.role === 'string' && (
        <PresetScalarDiff field="role" label={t('agent.proposal.presetRole')} before={before.entry.role ?? '—'} after={after.role} />
      )}
      {'sort_order' in after && typeof after.sort_order === 'number' && (
        <PresetScalarDiff field="sort_order" label={t('agent.proposal.presetSortOrder')} before={before.entry.sort_order !== undefined ? String(before.entry.sort_order) : '—'} after={String(after.sort_order)} />
      )}
      {'injection_position' in after && typeof after.injection_position === 'number' && (
        <PresetScalarDiff field="injection_position" label={t('agent.proposal.presetInjectionPosition')} before={posText(before.entry.injection_position)} after={posText(after.injection_position)} />
      )}
      {'injection_depth' in after && typeof after.injection_depth === 'number' && (
        <PresetScalarDiff field="injection_depth" label={t('agent.proposal.presetInjectionDepth')} before={before.entry.injection_depth !== undefined ? String(before.entry.injection_depth) : '—'} after={String(after.injection_depth)} />
      )}
      {'injection_order' in after && typeof after.injection_order === 'number' && (
        <PresetScalarDiff field="injection_order" label={t('agent.proposal.presetInjectionOrder')} before={before.entry.injection_order !== undefined ? String(before.entry.injection_order) : '—'} after={String(after.injection_order)} />
      )}
      {'is_marker' in after && typeof after.is_marker === 'boolean' && (
        <PresetScalarDiff field="is_marker" label={t('agent.proposal.presetMarker')} before={yesNoText(before.entry.is_marker)} after={yesNoText(after.is_marker)} />
      )}
      {'marker_key' in after && (
        <PresetScalarDiff field="marker_key" label={t('agent.proposal.presetMarkerKey')} before={before.entry.marker_key ?? '—'} after={after.marker_key ?? '—'} />
      )}
      {Array.isArray(after.edits) && after.edits.length > 0 ? (
        <PresetEdits edits={after.edits} />
      ) : (
        typeof after.content === 'string' && (
          <Labeled label={t('agent.proposal.field.content')}>
            <ContentDiff before={before.entry.content} after={after.content} />
          </Labeled>
        )
      )}
    </div>
  );
}

function PresetEntryCreation({ before, after }: { before: PresetEntryCreationBefore; after: PresetEntryCreateAfter }) {
  const { t } = useTranslation();
  const metaParts = [
    `${t('agent.proposal.presetRole')}：${after.role}`,
    `${t('agent.proposal.presetEnabled')}：${after.enabled ? t('agent.proposal.presetEnabledOn') : t('agent.proposal.presetEnabledOff')}`,
    `${t('agent.proposal.presetSortOrder')}：#${after.sort_order}`,
    `${t('agent.proposal.presetInjectionPosition')}：${after.injection_position === 1 ? t('agent.proposal.presetPosInChat') : t('agent.proposal.presetPosRelative')}`,
  ];
  if (after.injection_position === 1) {
    metaParts.push(`${t('agent.proposal.presetInjectionDepth')}：${after.injection_depth}`);
    metaParts.push(`${t('agent.proposal.presetInjectionOrder')}：${after.injection_order}`);
  }
  if (after.is_marker) {
    metaParts.push(`${t('agent.proposal.presetMarkerKey')}：${after.marker_key ?? '—'}`);
  }
  return (
    <div className="space-y-2" data-preset-entry-create="">
      <p className="font-medium [overflow-wrap:anywhere]">
        {formatTemplate(t('agent.proposal.preset'), { name: before.preset_name })}
        {' · '}
        {formatTemplate(t('agent.proposal.presetEntry'), { name: after.name })}
      </p>
      <p className="text-[11px] leading-relaxed text-text-muted">{metaParts.join(' · ')}</p>
      {!after.is_marker && (
        <Labeled label={t('agent.proposal.field.content')}>
          <p className="whitespace-pre-wrap rounded-lg border border-border-light bg-surface px-2.5 py-2 leading-relaxed [overflow-wrap:anywhere]">
            {after.content || '—'}
          </p>
        </Labeled>
      )}
    </div>
  );
}

function PresetEntryDeletion({ before }: { before: PresetEntryDeletionBefore }) {
  const { t } = useTranslation();
  const { entry } = before;
  const metaParts = [
    `${t('agent.proposal.presetRole')}：${entry.role}`,
    `${t('agent.proposal.presetEnabled')}：${entry.enabled ? t('agent.proposal.presetEnabledOn') : t('agent.proposal.presetEnabledOff')}`,
    `${t('agent.proposal.presetSortOrder')}：#${entry.sort_order}`,
    `${t('agent.proposal.presetInjectionPosition')}：${entry.injection_position === 1 ? t('agent.proposal.presetPosInChat') : t('agent.proposal.presetPosRelative')}`,
  ];
  if (entry.is_marker) {
    metaParts.push(`${t('agent.proposal.presetMarkerKey')}：${entry.marker_key ?? '—'}`);
  } else {
    metaParts.push(formatTemplate(t('agent.proposal.presetContentLength'), { length: entry.content.length }));
  }
  const preview = entry.content.length > PRESET_DELETE_PREVIEW_LIMIT
    ? `${entry.content.slice(0, PRESET_DELETE_PREVIEW_LIMIT)}…`
    : entry.content;
  return (
    <div className="space-y-1.5" data-preset-entry-delete="">
      <div className="space-y-1 rounded-lg border border-border-light bg-surface-2/40 px-2.5 py-2 text-text-secondary">
        <p className="font-medium text-text-primary [overflow-wrap:anywhere]">
          {formatTemplate(t('agent.proposal.preset'), { name: before.preset_name })}
          {' · '}
          {formatTemplate(t('agent.proposal.presetEntry'), { name: entry.name })}
        </p>
        <p className="text-[11px] leading-relaxed text-text-muted">{metaParts.join(' · ')}</p>
        {!entry.is_marker && preview && (
          <p className="whitespace-pre-wrap leading-relaxed [overflow-wrap:anywhere]">{preview}</p>
        )}
      </div>
      <p className="text-[11px] text-text-muted">{t('agent.proposal.presetDeleteHint')}</p>
    </div>
  );
}

function PresetSettingsChange({ before, after }: { before: PresetSettingsBefore; after: PresetSettingsAfter }) {
  const { t } = useTranslation();
  const enabledText = (value: boolean) => (value ? t('agent.proposal.presetEnabledOn') : t('agent.proposal.presetEnabledOff'));
  const formatTags = (tags: readonly string[]) => (tags.length > 0 ? tags.join(', ') : t('agent.proposal.presetStripTagsEmpty'));
  return (
    <div className="space-y-2">
      <p className="font-medium [overflow-wrap:anywhere]">
        {formatTemplate(t('agent.proposal.preset'), { name: before.preset_name })}
      </p>
      {'story_plot_strip' in after && typeof after.story_plot_strip === 'boolean' && (
        <Labeled label={t('agent.proposal.presetStoryPlotStrip')}>
          <p className="leading-relaxed" data-preset-field="story_plot_strip">
            <del className="text-text-muted decoration-danger/60">{enabledText(before.story_plot_strip)}</del>
            <span className="px-1.5 text-text-muted" aria-hidden="true">→</span>
            <ins className="font-medium text-emerald-800 no-underline dark:text-emerald-200">{enabledText(after.story_plot_strip)}</ins>
          </p>
        </Labeled>
      )}
      {'strip_tags' in after && Array.isArray(after.strip_tags) && (
        <Labeled label={t('agent.proposal.presetStripTags')}>
          <p className="whitespace-pre-wrap leading-relaxed [overflow-wrap:anywhere]" data-preset-field="strip_tags">
            <del className="text-text-muted decoration-danger/60">{formatTags(before.strip_tags)}</del>
            <span className="px-1.5 text-text-muted" aria-hidden="true">→</span>
            <ins className="font-medium text-emerald-800 no-underline dark:text-emerald-200">{formatTags(after.strip_tags)}</ins>
          </p>
        </Labeled>
      )}
    </div>
  );
}

function PresetScriptChange({ before, after }: { before: PresetScriptBefore; after: PresetScriptAfter }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <p className="font-medium [overflow-wrap:anywhere]">
        {formatTemplate(t('agent.proposal.preset'), { name: before.preset_name })}
        {' · '}
        {formatTemplate(t('agent.proposal.presetScript'), { label: before.label })}
      </p>
      <p className="text-[11px] leading-relaxed text-amber-800 dark:text-amber-200" data-preset-script-hint="">
        {t('agent.proposal.presetScriptHint')}
      </p>
      {Array.isArray(after.edits) && after.edits.length > 0 && <PresetEdits edits={after.edits} />}
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
  if (workOpKey(item)) return <WorkChange item={item} />;
  switch (item.op) {
    case 'create':
      if (item.before && 'character_creation' in item.before) {
        return <CharacterCreation fields={(item.after ?? {}) as ProposalCharacterFields} />;
      }
      if (item.before && 'preset_entry_creation' in item.before) {
        return <PresetEntryCreation before={item.before.preset_entry_creation} after={(item.after ?? {}) as PresetEntryCreateAfter} />;
      }
      return <Labeled label={t('agent.proposal.new')}><MemoryBox memory={after} /></Labeled>;
    case 'update':
      if (item.before && 'character' in item.before) {
        return <CharacterUpdateDiff before={item.before.character.snapshot} changes={(item.after ?? {}) as ProposalCharacterFields} id={item.before.character.id} />;
      }
      if (item.before && 'message' in item.before) {
        const { role, content } = item.before.message;
        return (
          <Labeled label={role === 'user' ? t('agent.proposal.roleUser') : t('agent.proposal.roleAssistant')}>
            <ContentDiff before={content} after={String(after.content ?? '')} />
          </Labeled>
        );
      }
      if (item.before && 'preset_entry' in item.before) {
        return <PresetEntryChange before={item.before.preset_entry} after={(item.after ?? {}) as PresetEntryAfter} />;
      }
      if (item.before && 'preset_settings' in item.before) {
        return <PresetSettingsChange before={item.before.preset_settings} after={(item.after ?? {}) as PresetSettingsAfter} />;
      }
      if (item.before && 'preset_script' in item.before) {
        return <PresetScriptChange before={item.before.preset_script} after={(item.after ?? {}) as PresetScriptAfter} />;
      }
      return <UpdateDiff before={before[0] ?? {}} changes={after} />;
    case 'retire':
      if (item.before && 'preset_entry_deletion' in item.before) {
        return <PresetEntryDeletion before={item.before.preset_entry_deletion} />;
      }
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

function Evidence({ item, messages, memories }: {
  item: ProposalItemView;
  messages: Map<string, ProposalEvidenceMessage>;
  memories: Map<string, ProposalEvidenceMemory>;
}) {
  const { t } = useTranslation();
  const ids = item.evidence.message_ids;
  const memoryIds = item.evidence.memory_ids ?? [];
  const note = item.evidence.note;
  const ownerQuote = item.evidence.owner_quote;
  if (ids.length === 0 && memoryIds.length === 0 && !ownerQuote && (!note || note === NO_EVIDENCE_NOTE)) return null;
  return (
    <div className="space-y-1.5">
      {memoryIds.length > 0 && (
        <details className="group" data-evidence="memories">
          <summary className="inline-flex min-h-8 cursor-pointer list-none items-center text-[11px] font-medium text-accent-dark [&::-webkit-details-marker]:hidden">
            {formatTemplate(t('agent.works.evidenceMemories'), { count: memoryIds.length })}
          </summary>
          <div className="mt-1 space-y-1.5">
            {memoryIds.map(id => {
              const memory = memories.get(id);
              if (!memory) {
                return (
                  <p key={id} className="rounded-lg border border-dashed border-border-light px-2.5 py-1.5 text-text-muted [overflow-wrap:anywhere]">
                    {formatTemplate(t('agent.works.evidenceMemoryMissing'), { id })}
                  </p>
                );
              }
              return (
                <blockquote key={id} className="rounded-lg border-l-2 border-accent/40 bg-surface-2/40 px-2.5 py-1.5" data-evidence-memory={id}>
                  <p className="mb-0.5 text-[11px] text-text-muted">
                    {t(`memory.status.${memory.status}`)}
                    {memory.no_longer_true && <span className="text-amber-700 dark:text-amber-300"> · {t('agent.works.evidenceMemoryNoLongerTrue')}</span>}
                  </p>
                  <p className="whitespace-pre-wrap leading-relaxed">{memory.content}</p>
                </blockquote>
              );
            })}
          </div>
        </details>
      )}
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
  /** 片单提案的依据记忆；其他提案没有 */
  memories?: Map<string, ProposalEvidenceMemory>;
  /** 有值时显示复选框；矛盾发现和已决定的项没有 */
  selection?: { checked: boolean; disabled: boolean; onChange: (checked: boolean) => void };
  undo?: { busy: boolean; disabled: boolean; error: string | null; onUndo: () => void };
}

const NO_MEMORIES = new Map<string, ProposalEvidenceMemory>();

export default function ProposalCardItem({ item, flags, messages, memories = NO_MEMORIES, selection, undo }: Props) {
  const { t } = useTranslation();
  const checkboxId = `proposal-item-${item.id}`;
  const opLabel = t(workOpKey(item) ?? presetOpKey(item) ?? (item.before && 'character_creation' in item.before
    ? 'agent.proposal.op.characterCreate'
    : item.before && 'character' in item.before ? 'agent.proposal.op.characterUpdate'
    : item.before && 'message' in item.before ? 'agent.proposal.op.messageUpdate' : `agent.proposal.op.${item.op}`));
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
      {flags.invalidEvidenceMemoryIds.length > 0 && (
        <p className={`text-[11px] ${WARNING_CHIP} [overflow-wrap:anywhere]`} data-flag="invalid-evidence">
          {formatTemplate(t('agent.works.flag.invalidEvidence'), { ids: flags.invalidEvidenceMemoryIds.join('、') })}
        </p>
      )}
      {flags.presetScript && (
        <p className={`text-[11px] ${WARNING_CHIP}`} data-flag="preset-script">
          {t('agent.proposal.flag.presetScript')}
        </p>
      )}
      {flags.disablesMarker && (
        <p className={`text-[11px] ${WARNING_CHIP}`} data-flag="disables-marker">
          {t('agent.proposal.flag.disablesMarker')}
        </p>
      )}

      <p className="whitespace-pre-wrap leading-relaxed text-text-primary">{item.reason}</p>
      <ItemChange item={item} />
      <Evidence item={item} messages={messages} memories={memories} />
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
