'use client';

import { useState, useEffect, use, useRef, type ChangeEvent } from 'react';
import { Character } from '@/types';
import { useRouter } from 'next/navigation';
import { useTranslation } from '@/lib/i18n-context';
import { useToast } from '@/components/ui/Toast';
import { ArrowLeftIcon, CameraIcon } from '@/components/ui/icons';
import Modal from '@/components/ui/Modal';
import ConfirmModal from '@/components/ui/ConfirmModal';
import TagChipInput from '@/components/ui/TagChipInput';
import PresetSelectField from '@/components/ui/PresetSelectField';
import ModelPresetBindingsField from '@/components/ui/ModelPresetBindingsField';
import CharacterTaskModelsField from '@/components/ui/CharacterTaskModelsField';
import { CharacterExportDialog } from '@/components/characters/CharacterExportDialog';
import { CharacterAiGeneratorPanel } from '@/components/characters/CharacterAiGeneratorPanel';
import { getErrorMessage, parseJsonResponse } from '@/lib/http';
import { clearCharacterContext } from '@/lib/character-context-cache';
import { getCharacterListCache, setCharacterListCache } from '@/lib/character-list-cache';
import { forgetImageBlobs } from '@/lib/image-blob-cache';
import { dismissVirtualKeyboard } from '@/lib/virtual-keyboard';

interface Props {
  params: Promise<{ id: string }>;
}

type EditorTab = 'identity' | 'world' | 'prompt' | 'models' | 'image';

const EDITOR_TABS: Array<{ id: EditorTab; label: string }> = [
  { id: 'identity', label: 'editor.tabIdentity' },
  { id: 'world', label: 'editor.tabWorld' },
  { id: 'prompt', label: 'editor.tabPrompt' },
  { id: 'models', label: 'editor.tabModels' },
  { id: 'image', label: 'editor.tabImage' },
];

const ICON_BUTTON = 'flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-xl text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50';
const MENU_ITEM = 'flex min-h-11 w-full items-center px-4 text-left text-sm text-text-primary transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50';
const FIELD_LABEL = 'mb-2 block text-sm font-medium text-text-secondary';
const PANEL = 'surface-panel space-y-5 p-4 sm:p-5';

interface ImportResponse {
  ok?: boolean;
  error?: string;
  memoriesImported?: number;
  conversationsImported?: number;
  profilesImported?: number;
  profileVersionsImported?: number;
  embeddingsImported?: number;
  characterDraft?: Partial<Character>;
  warnings?: Array<{ message?: string }>;
}

function ImportDialog({
  fileName,
  onCancel,
  onConfirm,
}: {
  fileName: string;
  onCancel: () => void;
  onConfirm: (options: {
    includeCharacter: boolean;
    includeMemories: boolean;
    includeConversations: boolean;
    includeProfiles: boolean;
    includeEmbeddings: boolean;
  }) => void;
}) {
  const { t } = useTranslation();
  const [includeCharacter, setIncludeCharacter] = useState(true);
  const [includeMemories, setIncludeMemories] = useState(true);
  const [includeConversations, setIncludeConversations] = useState(true);
  const [includeProfiles, setIncludeProfiles] = useState(true);
  // embedding 默认关闭，与 ExportDialog 对称
  const [includeEmbeddings, setIncludeEmbeddings] = useState(false);
  const nothingSelected = !includeCharacter && !includeMemories && !includeConversations && !includeProfiles && !includeEmbeddings;

  return (
    <Modal open onClose={onCancel} title={t('import.characterTitle')} maxWidth="max-w-sm">
      <p className="mb-3 text-sm text-text-muted">{t('import.characterHint')}</p>
      <p className="mb-3 rounded-2xl border border-amber-200/70 bg-amber-50/70 px-4 py-3 text-xs leading-relaxed text-amber-800 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-200">
        {t('import.characterMemoryRisk')}
      </p>
      <p className="mb-5 truncate rounded-2xl border border-border-light bg-surface/70 px-4 py-3 text-xs text-text-muted">{fileName}</p>
      <div className="space-y-2">
        <label className="flex cursor-pointer items-center gap-3 rounded-2xl border border-border-light bg-surface/70 px-4 py-3 text-sm text-text-secondary">
          <input type="checkbox" checked={includeCharacter} onChange={e => setIncludeCharacter(e.target.checked)} />
          {t('export.includeCharacters')}
        </label>
        <label className="flex cursor-pointer items-center gap-3 rounded-2xl border border-border-light bg-surface/70 px-4 py-3 text-sm text-text-secondary">
          <input type="checkbox" checked={includeMemories} onChange={e => setIncludeMemories(e.target.checked)} />
          {t('export.includeMemories')}
        </label>
        <label className="flex cursor-pointer items-center gap-3 rounded-2xl border border-border-light bg-surface/70 px-4 py-3 text-sm text-text-secondary">
          <input type="checkbox" checked={includeConversations} onChange={e => setIncludeConversations(e.target.checked)} />
          {t('export.includeConversations')}
        </label>
        <label className="flex cursor-pointer items-center gap-3 rounded-2xl border border-border-light bg-surface/70 px-4 py-3 text-sm text-text-secondary">
          <input type="checkbox" checked={includeProfiles} onChange={e => setIncludeProfiles(e.target.checked)} />
          {t('export.includeProfiles')}
        </label>
        <label className={`flex items-center gap-3 rounded-2xl border border-border-light bg-surface/70 px-4 py-3 text-sm ${includeMemories ? 'cursor-pointer text-text-secondary' : 'cursor-not-allowed opacity-50'}`}>
          <input
            type="checkbox"
            checked={includeMemories && includeEmbeddings}
            disabled={!includeMemories}
            onChange={e => setIncludeEmbeddings(e.target.checked)}
          />
          {t('export.includeEmbeddings')}
        </label>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onCancel} className="soft-button soft-button-secondary px-4 py-2 text-sm">{t('common.cancel')}</button>
        <button
          onClick={() => onConfirm({ includeCharacter, includeMemories, includeConversations, includeProfiles, includeEmbeddings })}
          disabled={nothingSelected}
          className="soft-button soft-button-primary px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('import.apply')}
        </button>
      </div>
    </Modal>
  );
}


export default function CharacterEditor({ params }: Props) {
  const { id } = use(params);
  const router = useRouter();
  const [character, setCharacter] = useState<Character | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [showAiGenerator, setShowAiGenerator] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [aiRequirement, setAiRequirement] = useState('');
  const [aiGenerating, setAiGenerating] = useState(false);
  const [aiError, setAiError] = useState('');
  const [importMsg, setImportMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [pendingImport, setPendingImport] = useState<{ fileName: string; file: File } | null>(null);
  const [presetRefreshKey, setPresetRefreshKey] = useState(0);
  const characterImportRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const deleteInFlightRef = useRef(false);
  const operationRef = useRef(false);
  const [leaving, setLeaving] = useState(false);
  const [creationMarker] = useState(() => typeof window !== 'undefined'
    ? window.sessionStorage.getItem('lumimuse_new_character_id') : null);
  const cleanupEligibleRef = useRef<string | null>(null);
  const creationFlowEndedRef = useRef(false);
  const characterRef = useRef<Character | null>(null);
  const [tagDrafts, setTagDrafts] = useState({ image_tags: '', user_image_tags: '' });
  const { t } = useTranslation();
  const { showToast } = useToast();
  // dirty 标记：表单是否存在未保存的修改。
  // - update() 会置为 true
  // - handleSave() 成功后置为 false
  // 用于：取消按钮二次确认 + beforeunload 浏览器关闭/刷新拦截
  const [dirty, setDirty] = useState(false);
  const [confirmAction, setConfirmAction] = useState<'discard' | 'delete' | 'duplicate' | null>(null);
  const [tab, setTab] = useState<EditorTab>('identity');
  const [moreOpen, setMoreOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const moreTriggerRef = useRef<HTMLButtonElement>(null);
  const hasUnsavedChanges = dirty || Boolean(tagDrafts.image_tags || tagDrafts.user_image_tags);

  useEffect(() => {
    characterRef.current = character;
  }, [character]);

  useEffect(() => {
    // 将一次性创建标记转移到本次编辑流程；离开后再进入不能复用资格。
    if (creationMarker !== id) creationFlowEndedRef.current = true;
    cleanupEligibleRef.current = !creationFlowEndedRef.current && creationMarker === id ? id : null;
    if (window.sessionStorage.getItem('lumimuse_new_character_id') === id) {
      window.sessionStorage.removeItem('lumimuse_new_character_id');
    }
    return () => { cleanupEligibleRef.current = null; };
  }, [creationMarker, id]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loadedCharacter = await parseJsonResponse<Character>(await fetch(`/api/characters/${id}`));
        if (!cancelled) {
          characterRef.current = loadedCharacter;
          setCharacter(loadedCharacter);
        }
      } catch (error) {
        if (!cancelled) {
          showToast(`${t('common.loadFailed')}: ${getErrorMessage(error)}`, 'error');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, showToast, t]);

  useEffect(() => {
    if (!moreOpen) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) setMoreOpen(false);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMoreOpen(false);
        moreTriggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [moreOpen]);

  // beforeunload：dirty 时拦截浏览器关闭/刷新/前进后退，避免误丢修改。
  // 注意：现代浏览器会忽略我们设置的提示文案，统一显示其原生提示，但仍需调用以触发拦截。
  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasUnsavedChanges]);

  // 必须先收起软键盘再跳：iOS 带着键盘切回首页，键盘收起时视口/触摸区域会错位，
  // 而首页抽屉锁住了文档滚动，错位无法被纠正，角色列表就滑不动（长按拖拽触发重绘才恢复）。
  const returnToSidebar = async () => {
    await dismissVirtualKeyboard();
    sessionStorage.setItem('lumimuse_open_sidebar', '1');
    router.push('/');
  };

  // 若当前角色是刚刚新建且从未保存过的空白角色，取消离开时自动删除，避免残留孤儿角色。
  const discardAndLeave = async () => {
    if (operationRef.current || !character) return;
    operationRef.current = true;
    setLeaving(true);
    setConfirmAction(null);
    try {
      if (cleanupEligibleRef.current === id) {
        const response = await fetch(`/api/characters/${id}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json', 'X-Character-Cleanup': character.created_at },
        });
        const data = await parseJsonResponse<{ ok: boolean; deleted?: boolean; deletedUrls?: string[] }>(response);
        if (data.deleted) {
          await forgetImageBlobs(data.deletedUrls ?? []).catch(() => {});
          const cached = getCharacterListCache();
          if (cached) setCharacterListCache(cached.filter(c => c.id !== id));
          clearCharacterContext(id);
        }
      }
      cleanupEligibleRef.current = null;
      creationFlowEndedRef.current = true;
      setDirty(false);
      setTagDrafts({ image_tags: '', user_image_tags: '' });
      await returnToSidebar();
    } catch (error) {
      showToast(`${t('editor.deleteFailed')}: ${getErrorMessage(error)}`, 'error');
    } finally {
      operationRef.current = false;
      setLeaving(false);
    }
  };

  // 取消按钮：若存在未保存修改，先弹 ConfirmModal，确认后才离开（若为未保存新建角色则自动清理）。
  const handleCancel = () => {
    if (operationRef.current) return;
    if (hasUnsavedChanges) {
      setConfirmAction('discard');
      return;
    }
    void discardAndLeave();
  };

  const handleSave = async () => {
    if (operationRef.current || !characterRef.current) return;
    // blur 可能先提交标签，读取同步快照，避免点击保存时使用旧渲染闭包。
    const snapshot = characterRef.current;
    const bindings = snapshot.model_preset_bindings ?? [];
    if (bindings.some(row => !row.model.trim())) {
      setTab('prompt');
      showToast(t('preset.modelBindEmptyModel'), 'error');
      return;
    }
    const models = bindings.map(row => row.model.trim());
    if (new Set(models).size !== models.length) {
      setTab('prompt');
      showToast(t('preset.modelBindDuplicate'), 'error');
      return;
    }
    operationRef.current = true;
    setSaving(true);
    try {
      const response = await fetch(`/api/characters/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...snapshot,
          model_preset_bindings: bindings.map(row => ({
            model: row.model.trim(),
            preset_id: row.preset_id || '__none__',
          })),
        }),
      });
      // 非 2xx 视为失败
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || `HTTP ${response.status}`);
      }
      if (sessionStorage.getItem('lumimuse_new_character_id') === id) {
        sessionStorage.removeItem('lumimuse_new_character_id');
      }
      setDirty(false);
      cleanupEligibleRef.current = null;
      creationFlowEndedRef.current = true;
      setTagDrafts({ image_tags: '', user_image_tags: '' });
      showToast(t('editor.saveSuccess'), 'success');
      // await：等键盘收起期间保持 saving，避免重复点保存
      await returnToSidebar();
    } catch (err) {
      showToast(`${t('editor.saveFailed')}: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      operationRef.current = false;
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (deleteInFlightRef.current) return;
    if (operationRef.current) return;
    if (confirmAction !== 'delete') {
      setConfirmAction('delete');
      return;
    }
    setConfirmAction(null);
    deleteInFlightRef.current = true;
    operationRef.current = true;
    setDeleting(true);
    try {
      // 注意：proxy.ts 的 CSRF 校验要求写方法（含 DELETE）带 application/json 头
      const response = await fetch(`/api/characters/${id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await parseJsonResponse<{ ok: boolean; deletedUrls?: string[] }>(response);
      try {
        await forgetImageBlobs(data.deletedUrls ?? []);
      } catch (error) {
        console.warn('[image-cache] 角色删除已成功，但本地图片缓存失效失败：', error);
      }
      if (sessionStorage.getItem('lumimuse_new_character_id') === id) {
        sessionStorage.removeItem('lumimuse_new_character_id');
      }
      const cached = getCharacterListCache();
      if (cached) {
        setCharacterListCache(cached.filter(c => c.id !== id));
      }
      // 删除成功后清掉该角色的本地上下文缓存（内存 + IndexedDB），避免同 id 重建/导入时闪幽灵快照
      clearCharacterContext(id);
      // 删除成功后离开页面前清除 dirty，避免触发 beforeunload
      setDirty(false);
      setTagDrafts({ image_tags: '', user_image_tags: '' });
      cleanupEligibleRef.current = null;
      creationFlowEndedRef.current = true;
      router.push('/');
    } catch (err) {
      operationRef.current = false;
      deleteInFlightRef.current = false;
      setDeleting(false);
      showToast(`${t('editor.deleteFailed')}: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  };

  const handleDuplicate = async () => {
    if (operationRef.current) return;
    if (confirmAction !== 'duplicate') {
      setConfirmAction('duplicate');
      return;
    }
    setConfirmAction(null);
    operationRef.current = true;
    setDuplicating(true);
    try {
      // 注意：proxy.ts 的 CSRF 校验要求写方法带 application/json 头
      const response = await fetch(`/api/characters/${id}/duplicate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || t('editor.duplicateError'));
      router.push(`/characters/${data.id}`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('editor.duplicateError'), 'error');
    } finally {
      operationRef.current = false;
      setDuplicating(false);
    }
  };

  const handleAvatarUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !character) return;
    const formData = new FormData();
    formData.append('avatar', file);
    const response = await fetch('/api/upload', { method: 'POST', body: formData });
    if (response.ok) {
      const { url } = await response.json();
      setDirty(true);
      setCharacter({ ...character, avatar_url: url });
    }
  };

  const handleImportCharacterCard = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !character) return;

    setImportMsg(null);
    setPendingImport({ fileName: file.name, file });
    if (characterImportRef.current) characterImportRef.current.value = '';
  };

  const applyPendingImport = async (options: {
    includeCharacter: boolean;
    includeMemories: boolean;
    includeConversations: boolean;
    includeProfiles: boolean;
    includeEmbeddings: boolean;
  }) => {
    if (!pendingImport || !character) return;

    try {
      const params = new URLSearchParams({
        target_character_id: character.id,
        include_character: options.includeCharacter ? '1' : '0',
        include_memories: options.includeMemories ? '1' : '0',
        include_conversations: options.includeConversations ? '1' : '0',
        include_profiles: options.includeProfiles ? '1' : '0',
        // embedding 默认关闭，仅在勾选时传 1，不传 0（与导出端语义对称：默认关）
        ...(options.includeEmbeddings ? { include_embeddings: '1' } : {}),
      });
      const response = await fetch('/api/import?' + params.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: pendingImport.file,
      });
      const data = await response.json() as ImportResponse;
      if (!response.ok || !data.ok) throw new Error(data.error || t('editor.importError'));

      if (options.includeCharacter && data.characterDraft) {
        setDirty(true);
        setCharacter({ ...character, ...data.characterDraft });
      }
      setPresetRefreshKey(value => value + 1);

      // 拼接导入成功提示，包含记忆/对话/画像/向量索引的数量
      const parts: string[] = [];
      if (data.memoriesImported) parts.push(`${data.memoriesImported} ${t('import.memoriesUnit')}`);
      if (data.conversationsImported) parts.push(`${data.conversationsImported} ${t('import.conversationsUnit')}`);
      if (data.profilesImported) parts.push(`${data.profilesImported} ${t('import.profilesUnit')}`);
      if (data.profileVersionsImported) parts.push(`${data.profileVersionsImported} ${t('import.profileVersionsUnit')}`);
      if (data.embeddingsImported) parts.push(`${data.embeddingsImported} ${t('import.embeddingsUnit')}`);
      const summary = parts.length > 0 ? parts.join('，') : t('import.nothingImported');
      const warnings = data.warnings?.flatMap(warning => warning.message ? [warning.message] : []) ?? [];
      setImportMsg({ type: 'ok', text: `${t('import.successPrefix')}${summary}。${t('import.characterFormHint')}${warnings.length ? ` ${warnings.join(' ')}` : ''}` });
    } catch (err) {
      setImportMsg({ type: 'err', text: err instanceof Error ? err.message : t('editor.importError') });
    } finally {
      setPendingImport(null);
      if (characterImportRef.current) characterImportRef.current.value = '';
      setTimeout(() => setImportMsg(null), 5000);
    }
  };
  const handleGenerateCharacter = async () => {
    if (!character || !aiRequirement.trim()) return;
    setAiGenerating(true);
    setAiError('');

    try {
      const response = await fetch('/api/characters/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requirement: aiRequirement,
          current_character: character,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || t('editor.aiGenerateError'));
      }

      setDirty(true);
      setCharacter({
        ...character,
        name: data.name ?? character.name,
        basic_info: data.basic_info ?? character.basic_info,
        personality: data.personality ?? character.personality,
        scenario: data.scenario ?? character.scenario,
        greeting: data.greeting ?? character.greeting,
        example_dialogue: data.example_dialogue ?? character.example_dialogue,
        system_prompt: data.system_prompt ?? character.system_prompt,
        other_info: data.other_info ?? character.other_info,
        image_tags: data.image_tags ?? character.image_tags,
      });
    } catch (err) {
      setAiError(err instanceof Error ? err.message : t('editor.aiGenerateError'));
    } finally {
      setAiGenerating(false);
    }
  };

  const update = (field: keyof Character, value: string) => {
    if (!character) return;
    // 任意字段被修改即标记为 dirty，触发未保存提示
    setDirty(true);
    const next = { ...(characterRef.current ?? character), [field]: value };
    characterRef.current = next;
    setCharacter(next);
  };

  if (!character) {
    return <div className="px-6 py-10 text-text-muted">{t('editor.loading')}</div>;
  }

  const memoryChatInjectionMode = character.memory_chat_injection_mode ?? 'full';
  const memoryChatInjectionModeHint = {
    full: t('editor.memoryChatInjectionModeFullHint'),
    local: t('editor.memoryChatInjectionModeLocalHint'),
    hybrid: t('editor.memoryChatInjectionModeHybridHint'),
    vector: t('editor.memoryChatInjectionModeVectorHint'),
  }[memoryChatInjectionMode];

  return (
    <div className="app-shell flex min-h-dvh flex-col">
      {exportOpen && <CharacterExportDialog characterId={id} onClose={() => setExportOpen(false)} />}
      {pendingImport && (
        <ImportDialog
          fileName={pendingImport.fileName}
          onCancel={() => setPendingImport(null)}
          onConfirm={applyPendingImport}
        />
      )}
      <ConfirmModal
        open={confirmAction !== null}
        title={
          confirmAction === 'delete'
            ? t('editor.delete')
            : confirmAction === 'duplicate'
            ? t('editor.duplicate')
            : t('editor.cancel')
        }
        message={
          confirmAction === 'delete'
            ? t('editor.deleteConfirm')
            : confirmAction === 'duplicate'
            ? t('editor.duplicateConfirm')
            : t('editor.confirmDiscard')
        }
        danger={confirmAction === 'delete' || confirmAction === 'discard'}
        busy={saving || deleting || duplicating || leaving}
        confirmLabel={
          confirmAction === 'delete'
            ? t('editor.delete')
            : confirmAction === 'duplicate'
            ? t('editor.duplicate')
            : t('common.confirm')
        }
        onConfirm={() => {
          if (confirmAction === 'delete') {
            void handleDelete();
          } else if (confirmAction === 'duplicate') {
            void handleDuplicate();
          } else if (confirmAction === 'discard') {
            void discardAndLeave();
          }
        }}
        onCancel={() => setConfirmAction(null)}
      />
      <header className="sticky top-0 z-20 border-b border-border-light bg-surface">
        <div className="mx-auto flex h-14 max-w-3xl items-center gap-1 px-1 sm:px-3">
          <button
            onClick={handleCancel}
            disabled={saving || deleting || duplicating || leaving}
            className={`${ICON_BUTTON} gap-1.5 sm:px-2.5`}
          >
            <ArrowLeftIcon className="h-5 w-5 sm:h-4 sm:w-4" />
            <span className="sr-only text-sm sm:not-sr-only">{t('editor.cancel')}</span>
          </button>
          <div className="min-w-0 flex-1 px-1">
            <h1 className="truncate text-base font-semibold leading-tight text-text-primary">{t('editor.title')}</h1>
            <p className="truncate text-xs text-text-muted">{character.name}</p>
          </div>
          <input ref={characterImportRef} type="file" accept=".json,application/json" onChange={handleImportCharacterCard} className="hidden" />
          <div ref={moreMenuRef} data-role="headerActions" className="relative">
            <button
              ref={moreTriggerRef}
              type="button"
              onClick={() => setMoreOpen(prev => !prev)}
              className={ICON_BUTTON}
              title={t('common.more')}
              aria-label={t('common.more')}
              aria-haspopup="menu"
              aria-expanded={moreOpen}
            >
              <span aria-hidden="true" className="text-xl leading-none">⋯</span>
            </button>
            {moreOpen && (
              <div
                role="menu"
                // 菜单项点完即卸载：先把焦点交还触发按钮，随后打开的弹窗才有可恢复的焦点目标。
                onClickCapture={() => moreTriggerRef.current?.focus()}
                onClick={() => setMoreOpen(false)}
                className="absolute right-0 top-full z-50 mt-1 min-w-[12rem] overflow-hidden rounded-2xl border border-border-light bg-surface py-1 shadow-lg"
              >
                <button type="button" role="menuitem" onClick={() => setShowAiGenerator(value => !value)} className={MENU_ITEM}>
                  {t('editor.aiGenerate')}
                </button>
                <button type="button" role="menuitem" onClick={handleDuplicate} disabled={duplicating} className={MENU_ITEM}>
                  {duplicating ? t('editor.duplicating') : t('editor.duplicate')}
                </button>
                <button type="button" role="menuitem" onClick={() => characterImportRef.current?.click()} className={MENU_ITEM}>
                  {t('editor.importTitle')}
                </button>
                <button type="button" role="menuitem" onClick={() => setExportOpen(true)} className={MENU_ITEM}>
                  {t('editor.export')}
                </button>
                <div role="separator" className="my-1 border-t border-border-light" />
                <button type="button" role="menuitem" onClick={handleDelete} disabled={deleting} className={`${MENU_ITEM} !text-danger`}>
                  {deleting ? t('editor.deleting') : t('editor.delete')}
                </button>
              </div>
            )}
          </div>
        </div>
        <div role="tablist" className="mx-auto flex max-w-3xl gap-1 overflow-x-auto px-2 sm:px-4">
          {EDITOR_TABS.map(item => (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`editor-tab-${item.id}`}
              aria-selected={tab === item.id}
              aria-controls={`editor-panel-${item.id}`}
              onClick={() => setTab(item.id)}
              className={`min-h-11 shrink-0 border-b-2 px-3 text-sm transition-colors ${
                tab === item.id
                  ? 'border-accent font-medium text-accent-dark'
                  : 'border-transparent text-text-secondary hover:text-text-primary'
              }`}
            >
              {t(item.label)}
            </button>
          ))}
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-3 py-4 sm:px-4 sm:py-5">
        {importMsg && (
          <div className={`mb-4 rounded-2xl px-4 py-3 text-sm ${importMsg.type === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
            {importMsg.text}
          </div>
        )}
        {showAiGenerator && (
          <div className="mb-4">
            <CharacterAiGeneratorPanel
              aiRequirement={aiRequirement}
              aiGenerating={aiGenerating}
              aiError={aiError}
              onChangeRequirement={setAiRequirement}
              onGenerate={handleGenerateCharacter}
            />
          </div>
        )}

        {/* 非当前页签只隐藏不卸载：标签输入框的草稿、预设下拉的加载状态都留在原处 */}
        <section role="tabpanel" id="editor-panel-identity" aria-labelledby="editor-tab-identity" hidden={tab !== 'identity'} className={PANEL}>
          <div className="flex items-center gap-4">
            <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-3xl bg-accent/12">
              {character.avatar_url ? (
                <img src={character.avatar_url} alt={character.name} className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-3xl font-semibold text-accent-dark">
                  {character.name[0]}
                </div>
              )}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="absolute inset-0 flex items-center justify-center bg-black/20 text-white opacity-0 transition hover:opacity-100 focus-visible:opacity-100"
                title={t('editor.changeAvatar')}
                aria-label={t('editor.changeAvatar')}
              >
                <CameraIcon className="h-6 w-6" />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleAvatarUpload}
                className="hidden"
              />
            </div>

            <div className="min-w-0 flex-1">
              <label className={FIELD_LABEL}>{t('editor.name')}</label>
              <input
                value={character.name}
                onChange={e => update('name', e.target.value)}
                className="input-rich"
                placeholder={t('editor.namePlaceholder')}
              />
            </div>
          </div>
          <div>
            <label className={FIELD_LABEL}>{t('editor.basicInfo')}</label>
            <textarea
              value={character.basic_info || ''}
              onChange={e => update('basic_info', e.target.value)}
              rows={6}
              placeholder={t('editor.basicInfoPlaceholder')}
              className="textarea-rich"
            />
          </div>
          <div>
            <label className={FIELD_LABEL}>{t('editor.personality')}</label>
            <textarea
              value={character.personality}
              onChange={e => update('personality', e.target.value)}
              rows={6}
              placeholder={t('editor.personalityPlaceholder')}
              className="textarea-rich"
            />
          </div>
        </section>

        <section role="tabpanel" id="editor-panel-world" aria-labelledby="editor-tab-world" hidden={tab !== 'world'} className={PANEL}>
          <div>
            <label className={FIELD_LABEL}>{t('editor.scenario')}</label>
            <textarea
              value={character.scenario}
              onChange={e => update('scenario', e.target.value)}
              rows={6}
              placeholder={t('editor.scenarioPlaceholder')}
              className="textarea-rich"
            />
          </div>
          <div>
            <label className={FIELD_LABEL}>{t('editor.greeting')}</label>
            <textarea
              value={character.greeting}
              onChange={e => update('greeting', e.target.value)}
              rows={5}
              placeholder={t('editor.greetingPlaceholder')}
              className="textarea-rich"
            />
          </div>
          <div>
            <label className={FIELD_LABEL}>{t('editor.other')}</label>
            <textarea
              value={character.other_info || ''}
              onChange={e => update('other_info', e.target.value)}
              rows={6}
              placeholder={t('editor.otherPlaceholder')}
              className="textarea-rich"
            />
          </div>
          <div>
            <label className={FIELD_LABEL}>{t('editor.exampleDialogue')}</label>
            <textarea
              value={character.example_dialogue}
              onChange={e => update('example_dialogue', e.target.value)}
              rows={8}
              placeholder={t('editor.dialoguePlaceholder')}
              className="textarea-rich font-mono"
            />
          </div>
        </section>

        <section role="tabpanel" id="editor-panel-prompt" aria-labelledby="editor-tab-prompt" hidden={tab !== 'prompt'} className={PANEL}>
          <div>
            <label className={FIELD_LABEL}>{t('editor.systemPrompt')}</label>
            <textarea
              value={character.system_prompt}
              onChange={e => update('system_prompt', e.target.value)}
              rows={8}
              placeholder={t('editor.systemPromptPlaceholder')}
              className="textarea-rich font-mono"
            />
          </div>
          <div className="grid gap-5 sm:grid-cols-2 sm:items-start">
            <PresetSelectField
              value={character.active_preset_id ?? null}
              refreshKey={presetRefreshKey}
              onChange={(v) => {
                if (!character) return;
                setDirty(true);
                setCharacter({ ...character, active_preset_id: v });
              }}
            />
            <div>
              <label htmlFor="character-memory-chat-injection-mode" className={FIELD_LABEL}>
                {t('editor.memoryChatInjectionMode')}
              </label>
              <p className="mb-2 text-xs leading-relaxed text-text-muted">
                {t('editor.memoryChatInjectionModeHint')}
              </p>
              <select
                id="character-memory-chat-injection-mode"
                className="select-rich w-full"
                value={memoryChatInjectionMode}
                onChange={(event) => {
                  setDirty(true);
                  setCharacter({
                    ...character,
                    memory_chat_injection_mode: event.target.value as Character['memory_chat_injection_mode'],
                  });
                }}
              >
                <option value="full">{t('editor.memoryChatInjectionModeFull')}</option>
                <option value="local">{t('editor.memoryChatInjectionModeLocal')}</option>
                <option value="hybrid">{t('editor.memoryChatInjectionModeHybrid')}</option>
                <option value="vector">{t('editor.memoryChatInjectionModeVector')}</option>
              </select>
              <p className="mt-1.5 text-xs leading-relaxed text-text-muted">
                {memoryChatInjectionModeHint}
              </p>
            </div>
          </div>
          <ModelPresetBindingsField
            value={character.model_preset_bindings ?? []}
            refreshKey={presetRefreshKey}
            onChange={(bindings) => {
              if (!character) return;
              setDirty(true);
              setCharacter({ ...character, model_preset_bindings: bindings });
            }}
          />
        </section>

        <section role="tabpanel" id="editor-panel-models" aria-labelledby="editor-tab-models" hidden={tab !== 'models'} className={PANEL}>
          <CharacterTaskModelsField
            value={{
              background_provider_id: character.background_provider_id ?? '',
              background_model: character.background_model ?? '',
              image_prompt_model: character.image_prompt_model ?? '',
              background_reasoning_by_model: character.background_reasoning_by_model ?? {},
              image_prompt_reasoning_by_model: character.image_prompt_reasoning_by_model ?? {},
              background_system_prompt_by_model: character.background_system_prompt_by_model ?? {},
              image_prompt_system_prompt_by_model: character.image_prompt_system_prompt_by_model ?? {},
            }}
            onChange={(next) => {
              setDirty(true);
              setCharacter({ ...character, ...next });
            }}
          />
        </section>

        <section role="tabpanel" id="editor-panel-image" aria-labelledby="editor-tab-image" hidden={tab !== 'image'} className={PANEL}>
          <div>
            <label className={FIELD_LABEL}>{t('editor.imageTags')}</label>
            <p className="mb-2 text-xs leading-relaxed text-text-muted">{t('editor.imageTagsHint')}</p>
            <TagChipInput
              value={character.image_tags || ''}
              onChange={val => update('image_tags', val)}
              onDraftChange={value => setTagDrafts(prev => ({ ...prev, image_tags: value }))}
              placeholder="1girl, silver hair, short hair, orange eyes, slender..."
            />
          </div>
          <div>
            <label className={FIELD_LABEL}>{t('editor.userImageTags')}</label>
            <p className="mb-2 text-xs leading-relaxed text-text-muted">{t('editor.userImageTagsHint')}</p>
            <TagChipInput
              value={character.user_image_tags || ''}
              onChange={val => update('user_image_tags', val)}
              onDraftChange={value => setTagDrafts(prev => ({ ...prev, user_image_tags: value }))}
              placeholder="1boy, black hair, brown eyes, glasses..."
            />
          </div>
        </section>
      </main>

      <div className="sticky bottom-0 z-20 border-t border-border-light bg-surface">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 pb-[max(0.625rem,env(safe-area-inset-bottom))] pt-2.5">
          <p className="flex min-w-0 flex-1 items-center gap-2 text-sm text-text-secondary" aria-live="polite">
            {hasUnsavedChanges && <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-accent" />}
            <span className={`truncate ${hasUnsavedChanges ? '' : 'text-text-muted'}`}>
              {hasUnsavedChanges ? t('common.unsavedChanges') : t('common.noUnsavedChanges')}
            </span>
          </p>
          <button onClick={handleSave} disabled={saving || deleting || duplicating || leaving} className="soft-button soft-button-primary shrink-0 disabled:cursor-not-allowed disabled:opacity-50">
            {saving ? t('editor.saving') : t('editor.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
