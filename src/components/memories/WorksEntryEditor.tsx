'use client';

import { useState, type FormEvent } from 'react';
import { WORK_STATUSES, WORK_TYPES, type WorkEntry, type WorkStatus, type WorkType } from '@/types';
import { useTranslation } from '@/lib/i18n-context';
import { formatTemplate } from '@/lib/i18n';
// 只能用客户端安全的 works-catalog-text：works-catalog.ts 依赖 Node 的 crypto 和数据库类型。
// 超长、无效名称接口也会拒绝，这里只是用同一套规则提前拦住。
import { isUsableWorkTitle, WORK_FIELD_LIMITS } from '@/lib/works-catalog-text';
import Modal from '@/components/ui/Modal';

/** 状态的说法随类型变化：电影、剧集是看过/在看/想看，书是读过…，游戏是玩过… */
const STATUS_WORDING: Record<WorkType, 'watch' | 'read' | 'play'> = {
  movie: 'watch',
  series: 'watch',
  book: 'read',
  game: 'play',
};

export function workStatusLabelKey(type: WorkType, status: WorkStatus): string {
  return `works.status.${STATUS_WORDING[type]}.${status}`;
}

export interface WorkEditorValues {
  work_type: WorkType;
  title: string;
  aliases: string[];
  status: WorkStatus;
  rating: string;
  progress: string;
  note: string;
}

interface Props {
  /** null 表示新增 */
  entry: WorkEntry | null;
  onClose: () => void;
  /** 返回要显示的错误文案；返回 null 表示成功，由调用方关闭弹窗 */
  onSave: (values: WorkEditorValues) => Promise<string | null>;
  /** 移除（写墓碑，可在「已移除」里恢复）；只在编辑已有条目时提供 */
  onRemove?: () => Promise<string | null>;
}

function charCount(value: string): number {
  return Array.from(value).length;
}

// 别名一行一个：片名里常有逗号（如 Love, Death & Robots），不能按逗号拆
function parseAliases(text: string): string[] {
  return text.split('\n').map(line => line.trim()).filter(Boolean);
}

function sameAliases(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((alias, index) => alias === b[index]);
}

/**
 * 编辑结果里与打开弹窗时的条目不同的字段。保存时只发这些：接口按给出的字段原样写入，
 * 把没改的字段一起发回去，会悄悄覆盖弹窗开着期间自动更新或批准的提案写入的进度、别名。
 */
export function changedWorkFields(entry: WorkEntry, values: WorkEditorValues): Partial<WorkEditorValues> {
  const changed: Partial<WorkEditorValues> = {};
  if (values.work_type !== entry.work_type) changed.work_type = values.work_type;
  if (values.title !== entry.title) changed.title = values.title;
  if (!sameAliases(values.aliases, entry.aliases)) changed.aliases = values.aliases;
  if (values.status !== entry.status) changed.status = values.status;
  if (values.rating !== entry.rating) changed.rating = values.rating;
  if (values.progress !== entry.progress) changed.progress = values.progress;
  if (values.note !== entry.note) changed.note = values.note;
  return changed;
}

export default function WorksEntryEditor({ entry, onClose, onSave, onRemove }: Props) {
  const { t } = useTranslation();
  const [workType, setWorkType] = useState<WorkType>(entry?.work_type ?? 'movie');
  const [title, setTitle] = useState(entry?.title ?? '');
  const [status, setStatus] = useState<WorkStatus>(entry?.status ?? 'watched');
  const [aliasesText, setAliasesText] = useState(entry?.aliases.join('\n') ?? '');
  const [rating, setRating] = useState(entry?.rating ?? '');
  const [progress, setProgress] = useState(entry?.progress ?? '');
  const [note, setNote] = useState(entry?.note ?? '');
  const [pending, setPending] = useState<'save' | 'remove' | null>(null);
  const [error, setError] = useState('');

  const close = () => {
    if (!pending) onClose();
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const aliases = parseAliases(aliasesText);
    const values: WorkEditorValues = {
      work_type: workType,
      title: title.trim(),
      aliases,
      status,
      rating: rating.trim(),
      progress: progress.trim(),
      note: note.trim(),
    };
    // 「《》」「?!」这类去掉书名号和标点后什么都不剩的名称，接口同样不收
    if (!isUsableWorkTitle(values.title)) {
      setError(t('works.titleRequired'));
      return;
    }
    if (aliases.length > WORK_FIELD_LIMITS.aliases) {
      setError(formatTemplate(t('works.tooManyAliases'), { max: WORK_FIELD_LIMITS.aliases }));
      return;
    }
    if (aliases.some(alias => charCount(alias) > WORK_FIELD_LIMITS.alias)) {
      setError(formatTemplate(t('works.aliasTooLong'), { max: WORK_FIELD_LIMITS.alias }));
      return;
    }
    // 没改任何字段就不写库：写入会刷新 updated_at，让基于旧快照的 Agent 提案无谓过期
    if (entry && Object.keys(changedWorkFields(entry, values)).length === 0) {
      onClose();
      return;
    }
    setPending('save');
    setError('');
    const failure = await onSave(values);
    if (failure !== null) {
      setError(failure);
      setPending(null);
    }
  };

  const handleRemove = async () => {
    if (pending || !onRemove) return;
    setPending('remove');
    setError('');
    const failure = await onRemove();
    if (failure !== null) {
      setError(failure);
      setPending(null);
    }
  };

  return (
    <Modal
      open
      onClose={close}
      title={entry ? t('works.editorEdit') : t('works.editorAdd')}
      dialogClassName="w-full max-w-lg max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-2xl bg-surface shadow-xl outline-none dark:bg-zinc-900"
    >
      <form onSubmit={event => void handleSubmit(event)} noValidate className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-text-muted">
            <span className="mb-1 block">{t('works.field.type')}</span>
            <select value={workType} onChange={event => setWorkType(event.target.value as WorkType)} className="select-rich">
              {WORK_TYPES.map(type => (
                <option key={type} value={type}>{t(`works.type.${type}`)}</option>
              ))}
            </select>
          </label>
          <label className="text-xs text-text-muted">
            <span className="mb-1 block">{t('works.field.status')}</span>
            <select value={status} onChange={event => setStatus(event.target.value as WorkStatus)} className="select-rich">
              {WORK_STATUSES.map(option => (
                <option key={option} value={option}>{t(workStatusLabelKey(workType, option))}</option>
              ))}
            </select>
          </label>
        </div>

        <label className="block text-xs text-text-muted">
          <span className="mb-1 block">{t('works.field.title')}</span>
          <input
            value={title}
            onChange={event => setTitle(event.target.value)}
            maxLength={WORK_FIELD_LIMITS.title}
            required
            className="input-rich"
          />
        </label>

        <label className="block text-xs text-text-muted">
          <span className="mb-1 block">{t('works.field.aliases')}</span>
          <textarea
            value={aliasesText}
            onChange={event => setAliasesText(event.target.value)}
            rows={2}
            placeholder={formatTemplate(t('works.field.aliasesHint'), { max: WORK_FIELD_LIMITS.aliases })}
            className="textarea-rich min-h-[4.5rem]"
          />
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-text-muted">
            <span className="mb-1 block">{t('works.field.rating')}</span>
            <input
              value={rating}
              onChange={event => setRating(event.target.value)}
              maxLength={WORK_FIELD_LIMITS.rating}
              placeholder={t('works.field.ratingPlaceholder')}
              className="input-rich"
            />
          </label>
          <label className="text-xs text-text-muted">
            <span className="mb-1 block">{t('works.field.progress')}</span>
            <input
              value={progress}
              onChange={event => setProgress(event.target.value)}
              maxLength={WORK_FIELD_LIMITS.progress}
              placeholder={t('works.field.progressPlaceholder')}
              className="input-rich"
            />
          </label>
        </div>

        <label className="block text-xs text-text-muted">
          <span className="mb-1 block">{t('works.field.note')}</span>
          <input
            value={note}
            onChange={event => setNote(event.target.value)}
            maxLength={WORK_FIELD_LIMITS.note}
            className="input-rich"
          />
        </label>

        {error && <p role="alert" className="text-xs text-danger [overflow-wrap:anywhere]">{error}</p>}

        <div className="flex flex-wrap items-center gap-2 pt-2">
          {entry && onRemove && (
            <button
              type="button"
              onClick={() => void handleRemove()}
              disabled={pending !== null}
              className="soft-button soft-button-danger disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pending === 'remove' ? t('works.removing') : t('works.remove')}
            </button>
          )}
          <div className="ml-auto flex gap-2">
            <button type="button" onClick={close} disabled={pending !== null} className="soft-button soft-button-secondary">
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={pending !== null}
              aria-busy={pending === 'save'}
              className="soft-button soft-button-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pending === 'save' ? t('works.saving') : t('common.save')}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
