'use client';

import { useState } from 'react';
import Modal from '@/components/ui/Modal';
import MemoryList from '@/components/memories/MemoryList';
import { XIcon } from '@/components/ui/icons';
import { useTranslation } from '@/lib/i18n-context';
import { formatTemplate } from '@/lib/i18n';

interface Props {
  characterId: string;
  characterName: string;
  onClose: () => void;
}

/**
 * 聊天页内的「当前角色记忆」弹窗：直接复用记忆管理页的 MemoryList（搜索/筛选/编辑/增删），
 * 角色固定为当前聊天角色，省去去记忆管理页再切角色的步骤。
 * 由调用方条件挂载，关闭即卸载，下次打开重新拉取。
 */
export default function CharacterMemoriesModal({ characterId, characterName, onClose }: Props) {
  const { t } = useTranslation();
  // MemoryList 内的批量删除确认框打开时挂起本层，避免 ESC 连带关掉整个弹窗、焦点陷阱抢焦点。
  const [nestedModalOpen, setNestedModalOpen] = useState(false);
  const title = formatTemplate(t('chat.characterMemoriesTitle'), { name: characterName });

  return (
    <Modal
      open
      onClose={onClose}
      ariaLabel={title}
      suspended={nestedModalOpen}
      padded={false}
      // MemoryList 的筛选栏按视口 lg 断点横排，弹窗需与记忆管理页在 lg 最窄时的宽度相当，否则搜索框被挤成 0 宽
      dialogClassName="surface-panel flex w-full max-w-5xl flex-col overflow-hidden outline-none"
    >
      <div style={{ maxHeight: '90dvh' }} className="flex flex-col">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border-light px-5 py-3">
          <h3 className="section-title min-w-0 truncate text-lg">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-xl text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
            aria-label={t('common.close')}
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3 md:p-4">
          <MemoryList characterId={characterId} onNestedModalChange={setNestedModalOpen} />
        </div>
      </div>
    </Modal>
  );
}
