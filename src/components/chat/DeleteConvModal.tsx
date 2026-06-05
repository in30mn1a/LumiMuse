'use client';

import { useTranslation } from '@/lib/i18n-context';
import Modal from '@/components/ui/Modal';

interface Props {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
}

/**
 * 删除对话确认弹窗
 * 视觉外壳统一使用通用 <Modal> 组件，复用焦点陷阱 / ESC / Portal / aria-modal / 焦点恢复，
 * 同时通过 padded=false + dialogClassName 保留原有外观（surface-panel + p-5）。
 */
export default function DeleteConvModal({ open, onClose, onConfirm }: Props) {
  const { t } = useTranslation();
  return (
    <Modal
      open={open}
      onClose={onClose}
      padded={false}
      closeOnBackdrop={false}
      dialogClassName="surface-panel w-full max-w-md p-5"
    >
      <h3 className="section-title text-xl">{t('chat.deleteTitle')}</h3>
      <p className="mt-3 section-copy">{t('chat.deleteConfirm')}</p>
      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onClose} className="soft-button soft-button-secondary">
          {t('chat.cancel')}
        </button>
        <button onClick={() => void onConfirm()} className="soft-button soft-button-danger">
          {t('chat.deleteAction')}
        </button>
      </div>
    </Modal>
  );
}
